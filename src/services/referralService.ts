import crypto from 'crypto';
import fs from 'fs';
import path from 'path';

import { winstonLogger } from '../middleware/logger';
import { analyticsService } from './analyticsService';
import { authService } from './authService';


const REFERRAL_PREFIX = 'RAIL-';
const CODE_LENGTH = 6;
const REFERRAL_COOLDOWN_HOURS = 24;
const ATTRIBUTION_FILE = path.join(__dirname, '../../data/purchase_attributions.json');

// Regex accepts both 5-char (guest) and 6-char (registered) codes
const REFERRAL_CODE_REGEX = /^RAIL-[A-Z0-9]{5,6}$/;

interface ReferralRecord {
  userId: string;
  referralCode: string;
  referredBy?: string;
  rewardGranted: boolean;
  welcomeCreditsGranted: boolean;
  createdAt: string;
}

interface UsedDeviceFingerprint {
  fingerprint: string;
  appliedByUserId: string;
  createdAt: string;
}

interface ReferralCooldown {
  ipAddress: string;
  lastAttemptAt: string;
  attempts: number;
}

interface ReferralStore {
  records: ReferralRecord[];
  rewardedReferrals: { referrerUserId: string; referredUserId: string; createdAt: string }[];
  usedDeviceFingerprints: UsedDeviceFingerprint[];
  cooldowns: ReferralCooldown[];
}

interface AttributionRecord {
  userId: string;          // referred user (buyer)
  referrerId: string;      // who gets the reward
  orderId: string;
  planId: string;
  amount: number;
  rewardGranted: boolean;
  createdAt: string;
}

class ReferralService {
  private store: ReferralStore = {
    records: [],
    rewardedReferrals: [],
    usedDeviceFingerprints: [],
    cooldowns: []
  };

  private attributionStore: AttributionRecord[] = [];

  constructor() {
    this.loadFromSupabase();
    this.loadAttributionStore();
  }

  // ── Attribution Store Helpers ──────────────────────────────────────────────

  private loadAttributionStore() {
    try {
      if (fs.existsSync(ATTRIBUTION_FILE)) {
        const raw = fs.readFileSync(ATTRIBUTION_FILE, 'utf-8');
        this.attributionStore = JSON.parse(raw);
      } else {
        this.attributionStore = [];
        this.saveAttributionStore();
      }
    } catch (e: any) {
      winstonLogger.error(`[REFERRAL_ATTR] Failed to load attribution store: ${e.message}`);
      this.attributionStore = [];
    }
  }

  private saveAttributionStore() {
    try {
      fs.writeFileSync(ATTRIBUTION_FILE, JSON.stringify(this.attributionStore, null, 2));
    } catch (e: any) {
      winstonLogger.error(`[REFERRAL_ATTR] Failed to save attribution store: ${e.message}`);
    }
  }

  private async loadFromSupabase() {
    try {
      const { supabase, isSupabaseConfigured } = require('../config/supabase');
      if (!isSupabaseConfigured()) {
        winstonLogger.warn('[REFERRAL_SYNC] Supabase is not configured. Using local JSON store.');
        return;
      }

      winstonLogger.info('[REFERRAL_SYNC] Syncing from Supabase...');

      const { data: dbUsers, error: usersError } = await supabase
        .from('users')
        .select('id, referral_code, referred_by, created_at')
        .not('referral_code', 'is', null);

      if (usersError) throw usersError;

      const records: ReferralRecord[] = (dbUsers || []).map((u: any) => ({
        userId: u.id,
        referralCode: u.referral_code,
        referredBy: u.referred_by || undefined,
        rewardGranted: false,
        welcomeCreditsGranted: false,
        createdAt: u.created_at
      }));

      const { data: dbRefs, error: refsError } = await supabase
        .from('referrals')
        .select('inviter_id, invited_user_id, referral_code, reward_granted, device_fingerprint, created_at');

      if (refsError) throw refsError;

      const rewardedReferrals = [];
      const usedDeviceFingerprints = [];

      for (const ref of dbRefs || []) {
        rewardedReferrals.push({
          referrerUserId: ref.inviter_id,
          referredUserId: ref.invited_user_id,
          createdAt: ref.created_at
        });

        if (ref.device_fingerprint) {
          usedDeviceFingerprints.push({
            fingerprint: ref.device_fingerprint,
            appliedByUserId: ref.invited_user_id,
            createdAt: ref.created_at
          });
        }

        const rec = records.find(r => r.userId === ref.invited_user_id);
        if (rec) {
          rec.referredBy = ref.inviter_id;
          rec.rewardGranted = ref.reward_granted;
        }
      }

      this.store.records = records;
      this.store.rewardedReferrals = rewardedReferrals;
      this.store.usedDeviceFingerprints = usedDeviceFingerprints;

      winstonLogger.info(`[REFERRAL_SYNC] Successfully synced ${records.length} codes and ${rewardedReferrals.length} links from Supabase.`);
    } catch (e: any) {
      winstonLogger.error(`[REFERRAL_SYNC] Failed to load from Supabase: ${e.message}`);
    }
  }

  private asyncSyncUserReferralCode(userId: string, code: string) {
    const { supabase, isSupabaseConfigured } = require('../config/supabase');
    if (!isSupabaseConfigured()) return;

    Promise.resolve().then(async () => {
      try {
        const { error } = await supabase
          .from('users')
          .update({ referral_code: code })
          .eq('id', userId);
        if (error) throw error;
        winstonLogger.info(`[REFERRAL_SYNC] Saved referral code ${code} for user ${userId} to Supabase.`);
      } catch (err: any) {
        winstonLogger.error(`[REFERRAL_SYNC] Failed to save referral code for user ${userId}: ${err.message}`);
      }
    });
  }

  private asyncSyncReferralRelation(
    inviterId: string,
    invitedUserId: string,
    referralCode: string,
    deviceFingerprint?: string,
    rewardGranted: boolean = false
  ) {
    const { supabase, isSupabaseConfigured } = require('../config/supabase');
    if (!isSupabaseConfigured()) return;

    Promise.resolve().then(async () => {
      try {
        const { error } = await supabase
          .from('referrals')
          .insert([{
            inviter_id: inviterId,
            invited_user_id: invitedUserId,
            referral_code: referralCode,
            device_fingerprint: deviceFingerprint || null,
            reward_granted: rewardGranted
          }]);
        if (error && error.code !== '23505') throw error;

        const { error: userUpdateError } = await supabase
          .from('users')
          .update({ referred_by: inviterId })
          .eq('id', invitedUserId);
        if (userUpdateError) throw userUpdateError;

        winstonLogger.info(`[REFERRAL_SYNC] Synced referral relation (inviter: ${inviterId}, invited: ${invitedUserId}) to Supabase.`);
      } catch (err: any) {
        winstonLogger.error(`[REFERRAL_SYNC] Failed to sync referral relation to Supabase: ${err.message}`);
      }
    });
  }

  // TODO: Implement actual DB methods for Supabase (e.g. SELECT COUNT(*))
  // Currently relies on local JSON which mimics the old behavior but adds safety.
  private async _dbVerifyUniqueness(code: string): Promise<boolean> {
    // Stub implementation - assuming unique if not in memory
    return !this.store.records.some(r => r.referralCode === code);
  }

  private _dbVerifyUniquenessSync(code: string): boolean {
    return !this.store.records.some(r => r.referralCode === code);
  }

  private generateCodeValue(): string {
    const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
    let code = '';
    for (let i = 0; i < CODE_LENGTH; i++) {
      const idx = crypto.randomInt(0, alphabet.length);
      code += alphabet[idx];
    }
    return `${REFERRAL_PREFIX}${code}`;
  }

  private async createUniqueCode(): Promise<string> {
    let attempts = 0;
    while (attempts < 5) {
      const code = this.generateCodeValue();
      const isUnique = await this._dbVerifyUniqueness(code);
      if (isUnique) {
        return code;
      }
      attempts++;
      winstonLogger.warn(`[REFERRAL_SECURITY] Collision detected, retrying generation (${attempts}/5)`);
    }
    winstonLogger.error('[REFERRAL_SECURITY] Failed to generate unique referral code after 5 attempts.');
    throw new Error('Failed to generate unique referral code.');
  }

  private createUniqueCodeSync(): string {
    let attempts = 0;
    while (attempts < 5) {
      const code = this.generateCodeValue();
      const isUnique = this._dbVerifyUniquenessSync(code);
      if (isUnique) {
        return code;
      }
      attempts++;
      winstonLogger.warn(`[REFERRAL_SECURITY] Collision detected (sync), retrying generation (${attempts}/5)`);
    }
    winstonLogger.error('[REFERRAL_SECURITY] Failed to generate unique referral code sync after 5 attempts.');
    throw new Error('Failed to generate unique referral code.');
  }

  private getRecordByUserId(userId: string) {
    return this.store.records.find(r => r.userId === userId);
  }

  private getRecordByCode(referralCode: string) {
    return this.store.records.find(r => r.referralCode === referralCode.toUpperCase());
  }

  generateReferralCodeSync(userId: string): string {
    const existing = this.getRecordByUserId(userId);
    if (existing) return existing.referralCode;

    try {
      const code = this.createUniqueCodeSync();
      const record: ReferralRecord = {
        userId,
        referralCode: code,
        rewardGranted: false,
        welcomeCreditsGranted: false,
        createdAt: new Date().toISOString()
      };

      this.store.records.push(record);
      this.asyncSyncUserReferralCode(userId, code);

      winstonLogger.info(`[REFERRAL] Generated code ${code} for user ${userId} (sync)`);
      analyticsService.trackEvent('referral_generated', null, { userId, code, sync: true });
      return record.referralCode;
    } catch (err: any) {
      analyticsService.trackEvent('referral_failed', null, { userId, reason: err.message, sync: true });
      throw err;
    }
  }

  async generateReferralCode(userId: string): Promise<string> {
    const existing = this.getRecordByUserId(userId);
    if (existing) return existing.referralCode;

    try {
      const code = await this.createUniqueCode();
      const record: ReferralRecord = {
        userId,
        referralCode: code,
        rewardGranted: false,
        welcomeCreditsGranted: false,
        createdAt: new Date().toISOString()
      };

      this.store.records.push(record);
      this.asyncSyncUserReferralCode(userId, code);

      winstonLogger.info(`[REFERRAL] Generated code ${code} for user ${userId}`);
      analyticsService.trackEvent('referral_generated', null, { userId, code });
      return record.referralCode;
    } catch (err: any) {
      analyticsService.trackEvent('referral_failed', null, { userId, reason: err.message });
      throw err;
    }
  }

  async getUserReferralCode(userId: string): Promise<string> {
    return this.generateReferralCode(userId);
  }

  async applyReferralCode(userId: string, referralCode: string, deviceFingerprint?: string, ipAddress?: string) {
    const normalizedCode = (referralCode || '').trim().toUpperCase();
    
    // IP Cooldown check
    if (ipAddress) {
      const cooldown = this.store.cooldowns.find(c => c.ipAddress === ipAddress);
      if (cooldown) {
        const lastAttemptTime = new Date(cooldown.lastAttemptAt).getTime();
        const now = Date.now();
        if (now - lastAttemptTime < REFERRAL_COOLDOWN_HOURS * 3600000 && cooldown.attempts > 10) {
           winstonLogger.warn(`[REFERRAL_SECURITY] IP rate limit hit for ${ipAddress}`);
           analyticsService.trackEvent('suspicious_referral_attempt', null, { ipAddress, userId });
           return { success: false, message: 'Too many attempts. Try again later.' };
        }
        cooldown.attempts++;
        cooldown.lastAttemptAt = new Date().toISOString();
      } else {
        this.store.cooldowns.push({ ipAddress, attempts: 1, lastAttemptAt: new Date().toISOString() });
      }
    }

    if (!REFERRAL_CODE_REGEX.test(normalizedCode)) {
      analyticsService.trackEvent('referral_failed', null, { userId, code: normalizedCode, reason: 'invalid_format' });
      return { success: false, message: 'Invalid referral code format.' };
    }

    const referred = this.getRecordByUserId(userId) || {
      userId,
      referralCode: await this.createUniqueCode(),
      rewardGranted: false,
      welcomeCreditsGranted: false,
      createdAt: new Date().toISOString()
    };

    if (!this.getRecordByUserId(userId)) {
      this.store.records.push(referred);
    }

    if (referred.referredBy) {
      analyticsService.trackEvent('referral_failed', null, { userId, reason: 'already_applied' });
      return { success: false, message: 'Referral code already applied for this user.' };
    }

    let referrer = this.getRecordByCode(normalizedCode);

    // If not in memory store, check Supabase for guest codes (user_usage table)
    if (!referrer) {
      try {
        const { supabase: sb, isSupabaseConfigured: isConf } = require('../config/supabase');
        if (isConf()) {
          const { data: guestRow } = await sb
            .from('user_usage')
            .select('session_id, referral_code')
            .eq('referral_code', normalizedCode)
            .single();

          if (guestRow) {
            // Synthesize a record so the rest of the flow works
            const syntheticRecord: ReferralRecord = {
              userId: guestRow.session_id,
              referralCode: guestRow.referral_code,
              rewardGranted: false,
              welcomeCreditsGranted: false,
              createdAt: new Date().toISOString()
            };
            this.store.records.push(syntheticRecord);
            referrer = syntheticRecord;
            winstonLogger.info(`[REFERRAL] Resolved guest code ${normalizedCode} to session ${guestRow.session_id}`);
          }
        }
      } catch (lookupErr: any) {
        winstonLogger.warn(`[REFERRAL] Guest code lookup failed for ${normalizedCode}: ${lookupErr.message}`);
      }
    }

    if (!referrer) {
      analyticsService.trackEvent('referral_failed', null, { userId, code: normalizedCode, reason: 'not_found' });
      return { success: false, message: 'Referral code not found.' };
    }

    if (referrer.userId === userId) {
      winstonLogger.warn(`[REFERRAL_SECURITY] Self-referral attempt blocked for user ${userId}`);
      analyticsService.trackEvent('suspicious_referral_attempt', null, { userId, reason: 'self_referral' });
      return { success: false, message: 'Self-referral is not allowed.' };
    }

    if (deviceFingerprint) {
      const fingerprint = deviceFingerprint.trim();
      if (fingerprint) {
        const alreadyUsed = this.store.usedDeviceFingerprints.find(d => d.fingerprint === fingerprint);
        if (alreadyUsed) {
          winstonLogger.warn(`[REFERRAL_SECURITY] Device fingerprint reuse blocked for user ${userId}`);
          analyticsService.trackEvent('suspicious_referral_attempt', null, { userId, fingerprint, reason: 'device_reuse' });
          return { success: false, message: 'This device fingerprint has already used a referral.' };
        }
        this.store.usedDeviceFingerprints.push({
          fingerprint,
          appliedByUserId: userId,
          createdAt: new Date().toISOString()
        });
      }
    }

    const duplicateReward = this.store.rewardedReferrals.find(
      rr => rr.referrerUserId === referrer.userId && rr.referredUserId === userId
    );
    if (duplicateReward) {
      return { success: false, message: 'Duplicate referral reward blocked.' };
    }

    referred.referredBy = referrer.userId;

    winstonLogger.info(`[REFERRAL] User ${userId} successfully applied referral code ${normalizedCode}`);
    analyticsService.trackEvent('referral_applied', null, { userId, referrerUserId: referrer.userId, code: normalizedCode });

    // Grant rewards async
    this._grantRewardsAsync(referrer.userId, userId, normalizedCode, deviceFingerprint);

    return {
      success: true,
      message: 'Referral applied successfully.',
      data: {
        referredBy: referrer.userId,
        referralCodeApplied: normalizedCode,
        rewardGranted: true
      }
    };
  }

  private async _grantRewardsAsync(referrerUserId: string, referredUserId: string, code: string, deviceFingerprint?: string) {
    try {
      // Non-blocking async reward flow
      await new Promise(resolve => setTimeout(resolve, 50));
      
      const referred = this.getRecordByUserId(referredUserId);
      if (referred) {
        referred.rewardGranted = true;
        this.store.rewardedReferrals.push({
          referrerUserId: referrerUserId,
          referredUserId: referredUserId,
          createdAt: new Date().toISOString()
        });

        winstonLogger.info(`[REFERRAL_REWARD] Reward granted to ${referrerUserId} for referring ${referredUserId}`);
        analyticsService.trackEvent('referral_rewarded', null, { referrerUserId, referredUserId, code });

        // If referrer is a guest, credit them with a free PNR check
        try {
          const { supabase: sb, isSupabaseConfigured: isConf } = require('../config/supabase');
          if (isConf()) {
            const { data: usage } = await sb
              .from('user_usage')
              .select('pnr_count')
              .eq('session_id', referrerUserId)
              .maybeSingle();

            if (usage) {
              const newPnrCount = Math.max(0, (usage.pnr_count || 0) - 1);
              await sb
                .from('user_usage')
                .update({ pnr_count: newPnrCount })
                .eq('session_id', referrerUserId);
              winstonLogger.info(`[REFERRAL_REWARD] Credited guest referrer ${referrerUserId} with 1 free check (new PNR count: ${newPnrCount})`);
            }
          }
        } catch (usageErr: any) {
          winstonLogger.warn(`[REFERRAL_REWARD] Failed to update guest usage for referrer ${referrerUserId}: ${usageErr.message}`);
        }

        // Sync relation to DB
        this.asyncSyncReferralRelation(referrerUserId, referredUserId, code, deviceFingerprint, true);
        
        // Trigger milestone rewards
        this._checkAndGrantMilestonesAsync(referrerUserId);
      }
    } catch (e: any) {
      winstonLogger.error(`[REFERRAL_REWARD] Failed to grant reward async: ${e.message}`);
    }
  }

  private async _checkAndGrantMilestonesAsync(userId: string) {
    const inviteCount = this.store.rewardedReferrals.filter(rr => rr.referrerUserId === userId).length;
    
    const milestones = [
      { count: 5, days: 1 },
      { count: 10, days: 3 },
      { count: 25, days: 15 }
    ];

    const { supabase, isSupabaseConfigured } = require('../config/supabase');
    if (!isSupabaseConfigured()) return;

    for (const m of milestones) {
      if (inviteCount >= m.count) {
        const milestone = m.count;
        const grantedProDays = m.days;
        
        try {
          const { data, error } = await supabase
            .from('referral_rewards')
            .insert([{ user_id: userId, milestone }])
            .select('id');
            
          if (error) {
            if (error.code === '23505') {
              winstonLogger.debug(`[REFERRAL_MILESTONE] Milestone ${milestone} already claimed for user ${userId}`);
            } else {
              throw error;
            }
          } else if (data && data.length > 0) {
            // Idempotent insertion succeeded
            winstonLogger.info(`[REFERRAL_MILESTONE] Unlocked milestone ${milestone} for user ${userId}. Granting ${grantedProDays} PRO days.`);
            await authService.upgradeToPro(userId, 'safar_pro_1d', grantedProDays * 1440);
            analyticsService.trackEvent('referral_milestone_unlocked', null, { userId, milestone, grantedProDays });
          }
        } catch (e: any) {
          winstonLogger.error(`[REFERRAL_MILESTONE] Failed to grant milestone ${milestone} to user ${userId}: ${e.message}`);
        }
      }
    }
  }

  /**
   * Called after a successful payment to reward the referrer with 7 days of PRO.
   * Duplicate protection: checks both local JSON store and Supabase referral_purchase_rewards table.
   */
  public async attributePurchase(userId: string, orderId: string, planId: string, amount: number) {
    const PRO_REWARD_MINUTES = 7 * 24 * 60; // 7 days
    try {
      // 1. Find referrer — look in memory store first, then Supabase users table
      let referrerId: string | undefined;

      const userRecord = this.getRecordByUserId(userId);
      if (userRecord?.referredBy) {
        referrerId = userRecord.referredBy;
      } else {
        // Try Supabase
        try {
          const { supabase: sb, isSupabaseConfigured: isConf } = require('../config/supabase');
          if (isConf()) {
            const { data: dbUser } = await sb
              .from('users')
              .select('referred_by')
              .eq('id', userId)
              .single();
            if (dbUser?.referred_by) referrerId = dbUser.referred_by;
          }
        } catch (lookupErr: any) {
          winstonLogger.warn(`[REFERRAL_ATTR] Supabase referrer lookup failed for ${userId}: ${lookupErr.message}`);
        }
      }

      if (!referrerId) {
        winstonLogger.info(`[REFERRAL_ATTR] No referrer found for user ${userId} — skipping purchase attribution`);
        return { rewarded: false, reason: 'no_referrer' };
      }

      // 2. Duplicate protection — local JSON store
      const existingLocal = this.attributionStore.find(
        a => a.userId === userId && a.rewardGranted
      );
      if (existingLocal) {
        winstonLogger.info(`[REFERRAL_ATTR] Duplicate reward blocked (local) for user ${userId} referrer ${referrerId}`);
        return { rewarded: false, reason: 'already_rewarded' };
      }

      // 3. Duplicate protection — Supabase referral_purchase_rewards table
      try {
        const { supabase: sb, isSupabaseConfigured: isConf } = require('../config/supabase');
        if (isConf()) {
          const { data: existing } = await sb
            .from('referral_purchase_rewards')
            .select('id')
            .eq('referred_user_id', userId)
            .maybeSingle();

          if (existing) {
            winstonLogger.info(`[REFERRAL_ATTR] Duplicate reward blocked (DB) for user ${userId}`);
            // Sync local store too
            this.attributionStore.push({
              userId, referrerId, orderId, planId, amount,
              rewardGranted: true, createdAt: existing.created_at || new Date().toISOString()
            });
            this.saveAttributionStore();
            return { rewarded: false, reason: 'already_rewarded' };
          }
        }
      } catch (dbErr: any) {
        winstonLogger.warn(`[REFERRAL_ATTR] DB duplicate check failed: ${dbErr.message} — proceeding with local check only`);
      }

      // 4. Persist attribution record
      const attrRecord: AttributionRecord = {
        userId, referrerId, orderId, planId, amount,
        rewardGranted: false,
        createdAt: new Date().toISOString()
      };
      this.attributionStore.push(attrRecord);
      this.saveAttributionStore();

      // 5. Grant 7-day PRO to referrer
      const rewardResult = await authService.upgradeToPro(referrerId, 'safar_pro_7d', PRO_REWARD_MINUTES, 'referral');

      // 6. Mark reward granted
      attrRecord.rewardGranted = rewardResult;
      this.saveAttributionStore();

      // 7. Persist to Supabase referral_purchase_rewards (best-effort)
      try {
        const { supabase: sb, isSupabaseConfigured: isConf } = require('../config/supabase');
        if (isConf()) {
          await sb.from('referral_purchase_rewards').insert([{
            referrer_user_id: referrerId,
            referred_user_id: userId,
            order_id: orderId,
            plan_id: planId,
            amount,
            reward_granted: rewardResult,
            reward_days: 7
          }]);
        }
      } catch (persistErr: any) {
        winstonLogger.warn(`[REFERRAL_ATTR] Failed to persist purchase reward to DB: ${persistErr.message}`);
      }

      if (rewardResult) {
        winstonLogger.info(`[REFERRAL_ATTR] ✅ Referrer ${referrerId} rewarded 7 PRO days for purchase by ${userId} (order: ${orderId})`);
        analyticsService.trackEvent('referral_purchase_rewarded', null, {
          referrerId,
          referredUserId: userId,
          orderId,
          planId,
          amount,
          rewardDays: 7
        });
      }

      return { rewarded: rewardResult, referrerId };
    } catch (e: any) {
      winstonLogger.error(`[REFERRAL_ATTR] attributePurchase failed for user ${userId}: ${e.message}`);
      return { rewarded: false, reason: 'error', error: e.message };
    }
  }

  /** Returns dashboard stats for a user: their code, invite count, rewards, progress. */
  getUserStats(userId: string) {
    const record = this.getRecordByUserId(userId);
    const referralCode = record?.referralCode ?? null;

    // Count how many users were referred BY this user
    const successfulReferrals = this.store.rewardedReferrals.filter(
      rr => rr.referrerUserId === userId
    );

    const inviteCount = successfulReferrals.length;
    
    let nextMilestone = 5;
    if (inviteCount >= 25) nextMilestone = 25;
    else if (inviteCount >= 10) nextMilestone = 25;
    else if (inviteCount >= 5) nextMilestone = 10;

    const creditsEarned = inviteCount;
    const progressPct = inviteCount >= 25 ? 100 : Math.min(100, Math.round((inviteCount / nextMilestone) * 100));
    const rewardStatus = inviteCount >= 5 ? 'unlocked' : 'pending';

    return {
      referralCode,
      inviteCount,
      creditsEarned,
      nextMilestone,
      progressPct,
      rewardStatus,
      recentReferrals: successfulReferrals.slice(-5).map(rr => ({
        referredUserId: rr.referredUserId,
        createdAt: rr.createdAt
      }))
    };
  }

  getLeaderboard() {
    const counts = new Map<string, number>();
    for (const rr of this.store.rewardedReferrals) {
      counts.set(rr.referrerUserId, (counts.get(rr.referrerUserId) || 0) + 1);
    }
    const sorted = Array.from(counts.entries()).sort((a, b) => b[1] - a[1]).slice(0, 10);
    return sorted.map(([userId, count], index) => {
      const maskedName = userId.substring(0, 4) + '****';
      return {
        rank: index + 1,
        maskedName,
        inviteCount: count
      };
    });
  }

  getHistory(userId: string) {
    const records = this.store.records.filter(r => r.referredBy === userId);
    return records.map(r => ({
      referredUser: r.userId.substring(0, 4) + '****',
      status: r.rewardGranted ? 'Completed' : 'Pending',
      createdAt: r.createdAt
    })).sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());
  }
}

export const referralService = new ReferralService();
export const generateReferralCode = async (userId: string) => await referralService.generateReferralCode(userId);
export const applyReferralCode = async (userId: string, referralCode: string, deviceFingerprint?: string, ipAddress?: string) =>
  await referralService.applyReferralCode(userId, referralCode, deviceFingerprint, ipAddress);
export const getUserReferralCode = async (userId: string) => await referralService.getUserReferralCode(userId);
export const generateReferralCodeSync = (userId: string) => referralService.generateReferralCodeSync(userId);
export const attributePurchase = async (userId: string, orderId: string, planId: string, amount: number) =>
  await referralService.attributePurchase(userId, orderId, planId, amount);
