import cron from 'node-cron';
import crypto from 'crypto';
import { supabase } from '../config/supabase';
import { winstonLogger } from '../middleware/logger';
import { emailService } from '../services/emailService';
import { pushService } from '../services/pushService';
import * as firebaseService from '../services/firebaseService';
import { decryptToken } from '../controllers/notificationController';

export class AlertDispatcher {
  private isProcessing = false;

  start() {
    winstonLogger.info('[ALERT_DISPATCHER] Starting background worker...');
    
    // Run every minute
    cron.schedule('* * * * *', async () => {
      if (this.isProcessing) return;
      this.isProcessing = true;
      try {
        await this.processPendingAlerts();
      } catch (err: any) {
        winstonLogger.error(`[ALERT_DISPATCHER] Error: ${err.message}`);
      } finally {
        this.isProcessing = false;
      }
    });
  }

  private async processPendingAlerts() {
    // 1. Fetch pending alerts
    const { data: alerts, error: fetchErr } = await supabase
      .from('smart_alerts')
      .select(`
        id, 
        user_id, 
        alert_type, 
        metadata
      `)
      .eq('status', 'PENDING')
      .limit(50); // Batch size

    if (fetchErr) {
      throw new Error(`Failed to fetch pending alerts: ${fetchErr.message}`);
    }

    if (!alerts || alerts.length === 0) {
      return; // Nothing to do
    }

    winstonLogger.info(`[ALERT_DISPATCHER] Processing ${alerts.length} pending alerts.`);

    for (const alert of alerts) {
      try {
        let userEmail: string | null = null;
        
        if (alert.user_id) {
          const { data: userData } = await supabase.from('users').select('email').eq('id', alert.user_id).single();
          if (userData) {
            userEmail = userData.email;
          }
        }
        
        const metadata = alert.metadata || {};
        const title = metadata.title || `Trayago: ${alert.alert_type} Alert`;
        const message = metadata.message || 'You have a new update regarding your train journey.';

        // 2. Validate preferences (skip if disabled)
        let isCategoryEnabled = true;
        if (alert.user_id) {
          const { data: prefs, error: prefsErr } = await supabase
            .from('user_notification_preferences')
            .select('*')
            .eq('user_id', alert.user_id)
            .maybeSingle();

          if (!prefsErr && prefs) {
            if (alert.alert_type === 'DELAY' && !prefs.delay_alerts_enabled) {
              isCategoryEnabled = false;
            } else if ((alert.alert_type === 'WL_CONFIRM' || alert.alert_type === 'CHART_PREPARED') && !prefs.waitlist_alerts_enabled) {
              isCategoryEnabled = false;
            } else if (alert.alert_type === 'PLATFORM_CHANGE' && !prefs.platform_alerts_enabled) {
              isCategoryEnabled = false;
            }
          }
        }

        if (!isCategoryEnabled) {
          winstonLogger.info(`[ALERT_DISPATCHER] Skipping alert ${alert.id} of type ${alert.alert_type} due to user preferences.`);
          await supabase
            .from('smart_alerts')
            .update({ 
              status: 'DELIVERED',
              updated_at: new Date().toISOString(),
              metadata: { ...metadata, dispatch_skipped_reason: 'user_preference_disabled' }
            })
            .eq('id', alert.id);
          continue;
        }

        let delivered = false;

        // 3. Dispatch via Email
        if (userEmail) {
          const emailSent = await emailService.sendAlertEmail(userEmail, title, message);
          if (emailSent) delivered = true;
        }

        // 4. Fetch matched push tokens (FCM)
        let tokens: any[] = [];
        if (alert.user_id) {
          const { data: userTokens, error: tokensErr } = await supabase
            .from('user_push_tokens')
            .select('id, fcm_token, device_type')
            .eq('user_id', alert.user_id);
          if (!tokensErr && userTokens) {
            tokens = userTokens;
          }
        } else if (metadata.device_id) {
          const { data: guestTokens, error: tokensErr } = await supabase
            .from('user_push_tokens')
            .select('id, fcm_token, device_type')
            .eq('device_id', metadata.device_id);
          if (!tokensErr && guestTokens) {
            tokens = guestTokens;
          }
        }

        // 5. Dispatch via FCM in parallel
        let fcmDelivered = false;
        if (tokens.length > 0) {
          const stringifiedData: Record<string, string> = {};
          for (const [key, val] of Object.entries(metadata)) {
            if (val !== null && val !== undefined) {
              stringifiedData[key] = typeof val === 'object' ? JSON.stringify(val) : String(val);
            }
          }
          stringifiedData.alert_type = alert.alert_type;
          stringifiedData.alert_id = alert.id;

          const sendPromises = tokens.map(async (t: any) => {
            try {
              const decryptedToken = decryptToken(t.fcm_token);
              const success = await firebaseService.sendPushNotification(
                decryptedToken,
                title,
                message,
                stringifiedData
              );
              return success;
            } catch (err: any) {
              winstonLogger.error(`[ALERT_DISPATCHER] Firebase send failed for token id ${t.id}: ${err.message}`);
              const isInvalidTokenError = 
                err.code === 'messaging/registration-token-not-registered' || 
                err.code === 'messaging/invalid-argument' || 
                (err.message && (
                  err.message.includes('registration-token-not-registered') || 
                  err.message.includes('not-registered') || 
                  err.message.includes('invalid-argument')
                ));
                
              if (isInvalidTokenError) {
                winstonLogger.info(`[ALERT_DISPATCHER] Pruning invalid token row: ${t.id}`);
                await supabase.from('user_push_tokens').delete().eq('id', t.id);
              }
              return false;
            }
          });

          const results = await Promise.allSettled(sendPromises);
          fcmDelivered = results.some(r => r.status === 'fulfilled' && r.value === true);
          if (fcmDelivered) delivered = true;
        }

        // 6. Dispatch via OneSignal (fallback only if FCM not delivered)
        const pushDelivered = fcmDelivered;
        if (!pushDelivered && alert.user_id) {
          winstonLogger.info(`[ALERT_DISPATCHER] FCM delivery unavailable. Falling back to OneSignal for user: ${alert.user_id}`);
          const pushSent = await pushService.sendToUsers([alert.user_id], title, message);
          if (pushSent) delivered = true;
        }

        // 6B. Log successful delivery to user notification history
        if (delivered) {
          try {
            const { error: histError } = await supabase
              .from('user_notification_history')
              .insert({
                user_id: alert.user_id,
                device_id: metadata.device_id || null,
                title,
                body: message,
                category: alert.alert_type,
                metadata: metadata,
                is_read: false,
                created_at: new Date().toISOString(),
                updated_at: new Date().toISOString()
              });
            if (histError) throw histError;
          } catch (histDbErr: any) {
            winstonLogger.info(`[ALERT_DISPATCHER] Failed to write notification history to DB, writing to memory: ${histDbErr.message}`);
            const { MEMORY_NOTIFICATION_HISTORY } = require('../controllers/notificationController');
            MEMORY_NOTIFICATION_HISTORY.push({
              id: crypto.randomUUID(),
              user_id: alert.user_id,
              device_id: metadata.device_id || null,
              title,
              body: message,
              category: alert.alert_type,
              metadata: metadata,
              is_read: false,
              created_at: new Date(),
              updated_at: new Date()
            });
          }
        }

        // 7. Update status
        const newStatus = delivered ? 'DELIVERED' : 'FAILED';
        await supabase
          .from('smart_alerts')
          .update({ 
            status: newStatus,
            updated_at: new Date().toISOString()
          })
          .eq('id', alert.id);

        winstonLogger.debug(`[ALERT_DISPATCHER] Alert ${alert.id} marked as ${newStatus}.`);

      } catch (err: any) {
        winstonLogger.error(`[ALERT_DISPATCHER] Failed to process alert ${alert.id}: ${err.message}`);
        await supabase.from('smart_alerts').update({ status: 'FAILED' }).eq('id', alert.id);
      }
    }
  }
}

export const alertDispatcher = new AlertDispatcher();
