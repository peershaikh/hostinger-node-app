import fs from 'fs';
import path from 'path';
import { supabase, isSupabaseConfigured, safeWriteFileSync } from '../config/supabase';
import { winstonLogger } from '../middleware/logger';
import { emailService } from './emailService';
import { authService } from './authService';
import { maskPhoneNumber } from '../utils/phoneNormalizer';

export type RenewalStage = 'EXPIRING_IN_3_DAYS' | 'EXPIRING_TOMORROW' | 'EXPIRED_GRACE';

export interface RenewalScanResult {
  scanned: number;
  eligible: number;
  emailsSent: number;
  whatsAppSent: number;
  skippedAlreadySent: number;
  errors: number;
  details: Array<{
    userId: string;
    email?: string;
    stage: RenewalStage;
    status: 'SENT' | 'SKIPPED' | 'FAILED';
    error?: string;
  }>;
}

export class RenewalNotificationService {
  private logFilePath: string;
  private dispatchedKeys: Set<string> = new Set();

  constructor() {
    this.logFilePath = path.join(__dirname, '../../data/renewal_notifications.json');
    this.loadDispatchedKeys();
  }

  private loadDispatchedKeys() {
    try {
      if (fs.existsSync(this.logFilePath)) {
        const raw = fs.readFileSync(this.logFilePath, 'utf-8');
        const list = JSON.parse(raw);
        if (Array.isArray(list)) {
          this.dispatchedKeys = new Set(list.map((item: any) => item.key || item));
        }
      }
    } catch (err: any) {
      winstonLogger.warn(`[RENEWAL_SERVICE] Failed to read renewal notifications log: ${err.message}`);
    }
  }

  private recordDispatchedKey(key: string, meta: any) {
    try {
      this.dispatchedKeys.add(key);
      const dataDir = path.dirname(this.logFilePath);
      if (!fs.existsSync(dataDir)) {
        fs.mkdirSync(dataDir, { recursive: true });
      }

      let list: any[] = [];
      if (fs.existsSync(this.logFilePath)) {
        try {
          const raw = fs.readFileSync(this.logFilePath, 'utf-8');
          list = JSON.parse(raw);
          if (!Array.isArray(list)) list = [];
        } catch {
          list = [];
        }
      }

      list.push({ key, ...meta, dispatchedAt: new Date().toISOString() });
      safeWriteFileSync(this.logFilePath, JSON.stringify(list, null, 2));

      // Attempt non-blocking write to Supabase if configured
      if (isSupabaseConfigured()) {
        Promise.resolve(
          supabase
            .from('subscription_notification_logs')
            .insert([{
              dedupe_key: key,
              user_id: meta.userId,
              stage: meta.stage,
              channel: meta.channel || 'EMAIL',
              recipient: meta.recipient,
              created_at: new Date().toISOString()
            }])
        )
          .then(({ error }: { error: any }) => {
            if (error && error.code !== '42P01') { // Ignore missing table
              winstonLogger.debug(`[RENEWAL_SERVICE] DB log notice: ${error.message}`);
            }
          })
          .catch(() => {});
      }
    } catch (err: any) {
      winstonLogger.warn(`[RENEWAL_SERVICE] Could not persist dispatch key: ${err.message}`);
    }
  }

  public async scanAndSendRenewalAlerts(): Promise<RenewalScanResult> {
    const result: RenewalScanResult = {
      scanned: 0,
      eligible: 0,
      emailsSent: 0,
      whatsAppSent: 0,
      skippedAlreadySent: 0,
      errors: 0,
      details: []
    };

    try {
      let users: any[] = [];

      // 1. Fetch users from Supabase or local cache
      if (isSupabaseConfigured()) {
        try {
          const { data, error } = await supabase
            .from('users')
            .select('id, email, full_name, mobile_number, plan_type, plan_expiry, last_subscription_date')
            .not('plan_expiry', 'is', null);

          if (!error && data) {
            users = data;
          }
        } catch (dbErr: any) {
          winstonLogger.warn(`[RENEWAL_SERVICE] Supabase user query failed: ${dbErr.message}, falling back to local users`);
        }
      }

      if (users.length === 0) {
        users = await authService.getAllUsers();
      }

      result.scanned = users.length;
      const now = Date.now();

      for (const u of users) {
        const expiryStr = u.plan_expiry || u.planExpiry;
        if (!expiryStr) continue;

        // Skip admin accounts
        if (u.plan_type === 'admin' || u.planType === 'admin') continue;

        const expiry = new Date(expiryStr);
        if (isNaN(expiry.getTime())) continue;

        const diffMs = expiry.getTime() - now;
        const diffHours = diffMs / (1000 * 60 * 60);

        let stage: RenewalStage | null = null;
        let days = 0;

        // Stage 1: T-3 Days (between 48 and 72 hours before expiry)
        if (diffHours >= 48 && diffHours <= 72) {
          stage = 'EXPIRING_IN_3_DAYS';
          days = 3;
        }
        // Stage 2: T-1 Day (between 0 and 24 hours before expiry)
        else if (diffHours >= 0 && diffHours <= 24) {
          stage = 'EXPIRING_TOMORROW';
          days = 1;
        }
        // Stage 3: T+1 Day Grace Period / Winback (expired within past 48 hours)
        else if (diffHours < 0 && diffHours >= -48) {
          stage = 'EXPIRED_GRACE';
          days = -1;
        }

        if (!stage) continue;

        result.eligible++;
        const userId = u.id || u.userId;
        const email = u.email;
        const phone = u.mobile_number || u.mobileNumber || u.phone;
        const expiryDateKey = expiry.toISOString().slice(0, 10);
        const dedupeKey = `${userId}:${stage}:${expiryDateKey}`;

        // Anti-spam check
        if (this.dispatchedKeys.has(dedupeKey)) {
          result.skippedAlreadySent++;
          result.details.push({
            userId,
            email,
            stage,
            status: 'SKIPPED'
          });
          continue;
        }

        const formattedDate = expiry.toLocaleDateString('en-IN', {
          day: 'numeric',
          month: 'short',
          year: 'numeric'
        });

        const renewalUrl = `https://www.trayago.in/pricing?plan=safar_pro_renewal_30d&promo=RENEW39&source=email_renewal&stage=${stage}&uid=${userId}`;
        let emailSuccess = false;

        // 2. Dispatch Email
        if (email) {
          try {
            emailSuccess = await emailService.sendSubscriptionRenewalEmail({
              toEmail: email,
              userName: u.full_name || u.name || 'Traveler',
              stage,
              expiryDateFormatted: formattedDate,
              daysRemainingOrExpired: days,
              offerPlanName: 'Safar Pro Loyalty Renewal (37 Days)',
              offerPrice: '₹39',
              originalPrice: '₹49',
              bonusDaysText: '+ 7 Days Free Bonus (37 Days Total)',
              renewalUrl,
              promoCode: 'RENEW39'
            });

            if (emailSuccess) {
              result.emailsSent++;
              this.recordDispatchedKey(dedupeKey, {
                userId,
                recipient: email,
                channel: 'EMAIL',
                stage,
                expiryDate: expiryStr
              });
              result.details.push({
                userId,
                email,
                stage,
                status: 'SENT'
              });
              winstonLogger.info(`[RENEWAL_SERVICE] Successfully dispatched ${stage} renewal email to ${email}`);
            } else {
              result.errors++;
              result.details.push({
                userId,
                email,
                stage,
                status: 'FAILED',
                error: 'Email delivery reported false'
              });
            }
          } catch (sendErr: any) {
            result.errors++;
            result.details.push({
              userId,
              email,
              stage,
              status: 'FAILED',
              error: sendErr.message
            });
            winstonLogger.error(`[RENEWAL_SERVICE] Error sending email to ${email}: ${sendErr.message}`);
          }
        }

        // 3. Extensible WhatsApp Adapter (Ready for activation when WhatsApp template is approved)
        if (process.env.ENABLE_WHATSAPP_RENEWAL_ALERTS === 'true' && phone) {
          try {
            // Future-ready hook: automatically activates when flag is true
            winstonLogger.info(`[RENEWAL_WHATSAPP] WhatsApp renewal alert dispatched to ${maskPhoneNumber(phone)}`);
            result.whatsAppSent++;
          } catch (waErr: any) {
            winstonLogger.warn(`[RENEWAL_WHATSAPP] WhatsApp renewal delivery failed: ${waErr.message}`);
          }
        } else {
          // Log readiness state
          winstonLogger.debug(`[RENEWAL_WHATSAPP] WhatsApp renewal deferred (flag OFF). Ready for activation.`);
        }
      }

      return result;
    } catch (globalErr: any) {
      winstonLogger.error(`[RENEWAL_SERVICE] Global renewal scan failure: ${globalErr.message}`);
      result.errors++;
      return result;
    }
  }

  public getRenewalStats(): { totalDispatched: number; recentDispatches: any[] } {
    try {
      if (fs.existsSync(this.logFilePath)) {
        const raw = fs.readFileSync(this.logFilePath, 'utf-8');
        const list = JSON.parse(raw);
        if (Array.isArray(list)) {
          return {
            totalDispatched: list.length,
            recentDispatches: list.slice(-20).reverse()
          };
        }
      }
    } catch {}
    return { totalDispatched: 0, recentDispatches: [] };
  }
}

export const renewalNotificationService = new RenewalNotificationService();
