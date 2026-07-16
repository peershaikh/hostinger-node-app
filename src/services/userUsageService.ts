import { supabase } from '../config/supabase';
import { winstonLogger } from '../middleware/logger';
import { analyticsService } from './analyticsService';
import { cacheService } from './cacheService';

export interface UserUsage {
  id?: string;
  session_id: string;
  referral_code: string;
  pnr_count: number;
  search_count?: number;
  referral_count?: number;
  pro_expires_at?: string;
  created_at?: string;
  updated_at?: string;
}

export class UserUsageService {
  private readonly TABLE_NAME = 'user_usage';
  private readonly FREE_PNR_LIMIT = 20;
  private readonly FREE_SEARCH_LIMIT = 50; // per day or session - adjust as needed

  /**
   * Get or Create Usage Record for a session
   */
  async getUsage(sessionId: string): Promise<UserUsage | null> {
    const cacheKey = `usage_${sessionId}`;
    const cached = cacheService.get<UserUsage>(cacheKey);
    if (cached) return cached;

    try {
      let { data, error } = await supabase
        .from(this.TABLE_NAME)
        .select('*')
        .eq('session_id', sessionId)
        .single();

      if (error && error.code !== 'PGRST116') throw error; // PGRST116 = no rows

      if (!data) {
        const refCode = `RAIL-${Math.random().toString(36).substring(2, 7).toUpperCase()}`;

        const { data: newData, error: createError } = await supabase
          .from(this.TABLE_NAME)
          .insert([{
            session_id: sessionId,
            referral_code: refCode,
            pnr_count: 0,
            search_count: 0
          }])
          .select()
          .single();

        if (createError) throw createError;
        data = newData;
      }

      cacheService.set(cacheKey, data, 300); // 5 min cache
      return data as UserUsage;
    } catch (err: any) {
      winstonLogger.error(`[USAGE_SERVICE] getUsage failed for session ${sessionId}: ${err.message}`);
      return null;
    }
  }

  /**
   * Check quota and increment usage
   */
  async checkAndIncrement(
    sessionId: string,
    type: 'PNR' | 'SEARCH'
  ): Promise<{ allowed: boolean; reason?: string; remaining?: number }> {
    const usage = await this.getUsage(sessionId);
    if (!usage) return { allowed: true };

    // PRO users have unlimited access
    if (usage.pro_expires_at && new Date(usage.pro_expires_at) > new Date()) {
      return { allowed: true };
    }

    let currentCount = 0;
    let limit = 0;
    let fieldToUpdate: 'pnr_count' | 'search_count' = 'pnr_count';

    if (type === 'PNR') {
      currentCount = usage.pnr_count || 0;
      limit = this.FREE_PNR_LIMIT;
      fieldToUpdate = 'pnr_count';
    } else {
      currentCount = usage.search_count || 0;
      limit = this.FREE_SEARCH_LIMIT;
      fieldToUpdate = 'search_count';
    }

    if (currentCount >= limit) {
      await analyticsService.trackEvent('QUOTA_HIT', null, {
        session_id: sessionId,
        type,
        current: currentCount,
        limit
      });

      return {
        allowed: false,
        reason: `FREE_${type}_LIMIT_REACHED`,
        remaining: 0
      };
    }

    // Increment usage
    const newCount = currentCount + 1;
    const updateData: any = { [fieldToUpdate]: newCount };

    try {
      await supabase
        .from(this.TABLE_NAME)
        .update(updateData)
        .eq('session_id', sessionId);

      // Invalidate cache
      cacheService.del(`usage_${sessionId}`);

      winstonLogger.debug(`[USAGE] ${type} count incremented for session ${sessionId} (${newCount}/${limit})`);
      return { allowed: true, remaining: limit - newCount };
    } catch (err: any) {
      winstonLogger.error(`[USAGE] Failed to increment ${type} for ${sessionId}: ${err.message}`);
      return { allowed: true }; // fail open
    }
  }

  /**
   * Claim referral code — supports both guest (user_usage) and registered user (users table) codes.
   */
  async claimReferral(inviteeSessionId: string, refCode: string) {
    try {
      const cleanRefCode = refCode.toUpperCase().trim();

      // Validate format: accept 5-char (guest) or 6-char (registered) codes
      if (!/^RAIL-[A-Z0-9]{5,6}$/.test(cleanRefCode)) {
        return { success: false, message: 'Invalid referral code format' };
      }

      // ── Step 1: Find inviter ───────────────────────────────────────────────
      // First try user_usage (guest codes — 5 chars), then users table (registered — 6 chars)

      let inviter: any = null;
      let inviterType: 'guest' | 'registered' = 'guest';
      let inviterIdentifier: string = '';

      const { data: guestInviter, error: guestFetchError } = await supabase
        .from(this.TABLE_NAME)
        .select('*')
        .eq('referral_code', cleanRefCode)
        .single();

      if (!guestFetchError && guestInviter) {
        inviter = guestInviter;
        inviterType = 'guest';
        inviterIdentifier = guestInviter.session_id;
      } else {
        // Try registered users table
        const { data: regInviter, error: regFetchError } = await supabase
          .from('users')
          .select('id, referral_code')
          .eq('referral_code', cleanRefCode)
          .single();

        if (!regFetchError && regInviter) {
          inviter = regInviter;
          inviterType = 'registered';
          inviterIdentifier = regInviter.id;
          winstonLogger.info(`[REFERRAL_CLAIM] Resolved registered user code ${cleanRefCode} to user ${regInviter.id}`);
        }
      }

      if (!inviter) {
        return { success: false, message: 'Invalid referral code' };
      }

      // ── Step 2: Self-referral check ────────────────────────────────────────
      if (inviterIdentifier === inviteeSessionId) {
        return { success: false, message: 'Cannot use your own referral code' };
      }

      // ── Step 3: Prevent duplicate referrals ───────────────────────────────
      const { data: existing } = await supabase
        .from('referrals')
        .select('id')
        .eq('invited_user_id', inviteeSessionId)
        .single();

      if (existing) {
        return { success: false, message: 'You have already been referred' };
      }

      // ── Step 4: Log referral (best-effort) ─────────────────────────────────
      try {
        const { error: logError } = await supabase
          .from('referrals')
          .insert([{
            inviter_id: inviterIdentifier,
            invited_user_id: inviteeSessionId,
            referral_code: cleanRefCode
          }]);

        if (logError && logError.code !== '23505') {
          winstonLogger.warn(`[REFERRAL_CLAIM] Database log failed: ${logError.message}. Proceeding with reward.`);
        }
      } catch (dbErr: any) {
        winstonLogger.warn(`[REFERRAL_CLAIM] Database log exception: ${dbErr.message}. Proceeding with reward.`);
      }


      await analyticsService.trackEvent('referral_code_redeemed', null, {
        inviter: inviterIdentifier,
        inviterType,
        invitee: inviteeSessionId,
        ref_code: cleanRefCode
      });

      // ── Step 5: Reward inviter ─────────────────────────────────────────────

      if (inviterType === 'guest') {
        // Guest inviter: compute milestone and give 1 free PNR + possible PRO
        const { count: referralCount } = await supabase
          .from('referrals')
          .select('id', { count: 'exact', head: true })
          .eq('inviter_id', inviterIdentifier);

        const newRefCount = (referralCount || 0) + 1;
        const updateData: any = {};

        // 1 referral = 1 free PNR check
        updateData.pnr_count = Math.max(0, (inviter.pnr_count || 0) - 1);

        // 5 referrals = 3 days PRO
        if (newRefCount >= 5 && (!inviter.pro_expires_at || new Date(inviter.pro_expires_at) < new Date())) {
          const expiry = new Date();
          expiry.setDate(expiry.getDate() + 3);
          updateData.pro_expires_at = expiry.toISOString();

          await analyticsService.trackEvent('referral_signup_reward', null, {
            session_id: inviterIdentifier,
            source: 'REFERRAL_MILESTONE_5',
            referrals: newRefCount
          });
        }

        await supabase
          .from(this.TABLE_NAME)
          .update(updateData)
          .eq('session_id', inviterIdentifier);

        cacheService.del(`usage_${inviterIdentifier}`);
      } else {
        // Registered inviter: push into referralService memory store and check milestones
        const { referralService: rs } = await import('./referralService');
        const existingRecord = rs.getUserStats(inviterIdentifier);
        winstonLogger.info(`[REFERRAL_CLAIM] Notifying referralService of invite for registered user ${inviterIdentifier} (current count: ${existingRecord.inviteCount})`);

        // Add synthetic entry to rewardedReferrals so milestone check works
        (rs as any).store.rewardedReferrals.push({
          referrerUserId: inviterIdentifier,
          referredUserId: inviteeSessionId,
          createdAt: new Date().toISOString()
        });

        // Trigger milestone check
        await (rs as any)._checkAndGrantMilestonesAsync(inviterIdentifier);

        await analyticsService.trackEvent('referral_signup_reward', null, {
          userId: inviterIdentifier,
          inviterType: 'registered',
          invitee: inviteeSessionId,
          ref_code: cleanRefCode
        });
      }

      return { success: true, message: 'Referral claimed successfully!' };
    } catch (err: any) {
      winstonLogger.error(`[REFERRAL] Claim failed: ${err.message}`);
      return { success: false, message: 'Failed to process referral' };
    }
  }

  async addBonusCheck(sessionId: string): Promise<boolean> {
    try {
      const usage = await this.getUsage(sessionId);
      if (!usage) return false;
      const currentCount = usage.pnr_count || 0;
      const newCount = Math.max(0, currentCount - 1);

      await supabase
        .from(this.TABLE_NAME)
        .update({ pnr_count: newCount })
        .eq('session_id', sessionId);

      cacheService.del(`usage_${sessionId}`);
      winstonLogger.info(`[USAGE] Added bonus check for session ${sessionId} (${currentCount} -> ${newCount})`);
      return true;
    } catch (err: any) {
      winstonLogger.error(`[USAGE] Failed to add bonus check for ${sessionId}: ${err.message}`);
      return false;
    }
  }

  /**
   * Reset daily limits (can be called by cron job)
   */
  async resetDailyLimits() {
    try {
      await supabase
        .from(this.TABLE_NAME)
        .update({ search_count: 0 })
        .neq('pro_expires_at', null); // only reset non-pro if you want

      winstonLogger.info('[USAGE] Daily search limits reset');
    } catch (err: any) {
      winstonLogger.error(`[USAGE] Failed to reset limits: ${err.message}`);
    }
  }
}

export const userUsageService = new UserUsageService();
