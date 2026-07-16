"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
Object.defineProperty(exports, "__esModule", { value: true });
exports.userUsageService = exports.UserUsageService = void 0;
const supabase_1 = require("../config/supabase");
const logger_1 = require("../middleware/logger");
const analyticsService_1 = require("./analyticsService");
const cacheService_1 = require("./cacheService");
class UserUsageService {
    constructor() {
        this.TABLE_NAME = 'user_usage';
        this.FREE_PNR_LIMIT = 20;
        this.FREE_SEARCH_LIMIT = 50; // per day or session - adjust as needed
    }
    /**
     * Get or Create Usage Record for a session
     */
    async getUsage(sessionId) {
        const cacheKey = `usage_${sessionId}`;
        const cached = cacheService_1.cacheService.get(cacheKey);
        if (cached)
            return cached;
        try {
            let { data, error } = await supabase_1.supabase
                .from(this.TABLE_NAME)
                .select('*')
                .eq('session_id', sessionId)
                .single();
            if (error && error.code !== 'PGRST116')
                throw error; // PGRST116 = no rows
            if (!data) {
                const refCode = `RAIL-${Math.random().toString(36).substring(2, 7).toUpperCase()}`;
                const { data: newData, error: createError } = await supabase_1.supabase
                    .from(this.TABLE_NAME)
                    .insert([{
                        session_id: sessionId,
                        referral_code: refCode,
                        pnr_count: 0,
                        search_count: 0
                    }])
                    .select()
                    .single();
                if (createError)
                    throw createError;
                data = newData;
            }
            cacheService_1.cacheService.set(cacheKey, data, 300); // 5 min cache
            return data;
        }
        catch (err) {
            logger_1.winstonLogger.error(`[USAGE_SERVICE] getUsage failed for session ${sessionId}: ${err.message}`);
            return null;
        }
    }
    /**
     * Check quota and increment usage
     */
    async checkAndIncrement(sessionId, type) {
        const usage = await this.getUsage(sessionId);
        if (!usage)
            return { allowed: true };
        // PRO users have unlimited access
        if (usage.pro_expires_at && new Date(usage.pro_expires_at) > new Date()) {
            return { allowed: true };
        }
        let currentCount = 0;
        let limit = 0;
        let fieldToUpdate = 'pnr_count';
        if (type === 'PNR') {
            currentCount = usage.pnr_count || 0;
            limit = this.FREE_PNR_LIMIT;
            fieldToUpdate = 'pnr_count';
        }
        else {
            currentCount = usage.search_count || 0;
            limit = this.FREE_SEARCH_LIMIT;
            fieldToUpdate = 'search_count';
        }
        if (currentCount >= limit) {
            await analyticsService_1.analyticsService.trackEvent('QUOTA_HIT', null, {
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
        const updateData = { [fieldToUpdate]: newCount };
        try {
            await supabase_1.supabase
                .from(this.TABLE_NAME)
                .update(updateData)
                .eq('session_id', sessionId);
            // Invalidate cache
            cacheService_1.cacheService.del(`usage_${sessionId}`);
            logger_1.winstonLogger.debug(`[USAGE] ${type} count incremented for session ${sessionId} (${newCount}/${limit})`);
            return { allowed: true, remaining: limit - newCount };
        }
        catch (err) {
            logger_1.winstonLogger.error(`[USAGE] Failed to increment ${type} for ${sessionId}: ${err.message}`);
            return { allowed: true }; // fail open
        }
    }
    /**
     * Claim referral code — supports both guest (user_usage) and registered user (users table) codes.
     */
    async claimReferral(inviteeSessionId, refCode) {
        try {
            const cleanRefCode = refCode.toUpperCase().trim();
            // Validate format: accept 5-char (guest) or 6-char (registered) codes
            if (!/^RAIL-[A-Z0-9]{5,6}$/.test(cleanRefCode)) {
                return { success: false, message: 'Invalid referral code format' };
            }
            // ── Step 1: Find inviter ───────────────────────────────────────────────
            // First try user_usage (guest codes — 5 chars), then users table (registered — 6 chars)
            let inviter = null;
            let inviterType = 'guest';
            let inviterIdentifier = '';
            const { data: guestInviter, error: guestFetchError } = await supabase_1.supabase
                .from(this.TABLE_NAME)
                .select('*')
                .eq('referral_code', cleanRefCode)
                .single();
            if (!guestFetchError && guestInviter) {
                inviter = guestInviter;
                inviterType = 'guest';
                inviterIdentifier = guestInviter.session_id;
            }
            else {
                // Try registered users table
                const { data: regInviter, error: regFetchError } = await supabase_1.supabase
                    .from('users')
                    .select('id, referral_code')
                    .eq('referral_code', cleanRefCode)
                    .single();
                if (!regFetchError && regInviter) {
                    inviter = regInviter;
                    inviterType = 'registered';
                    inviterIdentifier = regInviter.id;
                    logger_1.winstonLogger.info(`[REFERRAL_CLAIM] Resolved registered user code ${cleanRefCode} to user ${regInviter.id}`);
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
            const { data: existing } = await supabase_1.supabase
                .from('referrals')
                .select('id')
                .eq('invited_user_id', inviteeSessionId)
                .single();
            if (existing) {
                return { success: false, message: 'You have already been referred' };
            }
            // ── Step 4: Log referral (best-effort) ─────────────────────────────────
            try {
                const { error: logError } = await supabase_1.supabase
                    .from('referrals')
                    .insert([{
                        inviter_id: inviterIdentifier,
                        invited_user_id: inviteeSessionId,
                        referral_code: cleanRefCode
                    }]);
                if (logError && logError.code !== '23505') {
                    logger_1.winstonLogger.warn(`[REFERRAL_CLAIM] Database log failed: ${logError.message}. Proceeding with reward.`);
                }
            }
            catch (dbErr) {
                logger_1.winstonLogger.warn(`[REFERRAL_CLAIM] Database log exception: ${dbErr.message}. Proceeding with reward.`);
            }
            await analyticsService_1.analyticsService.trackEvent('referral_code_redeemed', null, {
                inviter: inviterIdentifier,
                inviterType,
                invitee: inviteeSessionId,
                ref_code: cleanRefCode
            });
            // ── Step 5: Reward inviter ─────────────────────────────────────────────
            if (inviterType === 'guest') {
                // Guest inviter: compute milestone and give 1 free PNR + possible PRO
                const { count: referralCount } = await supabase_1.supabase
                    .from('referrals')
                    .select('id', { count: 'exact', head: true })
                    .eq('inviter_id', inviterIdentifier);
                const newRefCount = (referralCount || 0) + 1;
                const updateData = {};
                // 1 referral = 1 free PNR check
                updateData.pnr_count = Math.max(0, (inviter.pnr_count || 0) - 1);
                // 5 referrals = 3 days PRO
                if (newRefCount >= 5 && (!inviter.pro_expires_at || new Date(inviter.pro_expires_at) < new Date())) {
                    const expiry = new Date();
                    expiry.setDate(expiry.getDate() + 3);
                    updateData.pro_expires_at = expiry.toISOString();
                    await analyticsService_1.analyticsService.trackEvent('referral_signup_reward', null, {
                        session_id: inviterIdentifier,
                        source: 'REFERRAL_MILESTONE_5',
                        referrals: newRefCount
                    });
                }
                await supabase_1.supabase
                    .from(this.TABLE_NAME)
                    .update(updateData)
                    .eq('session_id', inviterIdentifier);
                cacheService_1.cacheService.del(`usage_${inviterIdentifier}`);
            }
            else {
                // Registered inviter: push into referralService memory store and check milestones
                const { referralService: rs } = await Promise.resolve().then(() => __importStar(require('./referralService')));
                const existingRecord = rs.getUserStats(inviterIdentifier);
                logger_1.winstonLogger.info(`[REFERRAL_CLAIM] Notifying referralService of invite for registered user ${inviterIdentifier} (current count: ${existingRecord.inviteCount})`);
                // Add synthetic entry to rewardedReferrals so milestone check works
                rs.store.rewardedReferrals.push({
                    referrerUserId: inviterIdentifier,
                    referredUserId: inviteeSessionId,
                    createdAt: new Date().toISOString()
                });
                // Trigger milestone check
                await rs._checkAndGrantMilestonesAsync(inviterIdentifier);
                await analyticsService_1.analyticsService.trackEvent('referral_signup_reward', null, {
                    userId: inviterIdentifier,
                    inviterType: 'registered',
                    invitee: inviteeSessionId,
                    ref_code: cleanRefCode
                });
            }
            return { success: true, message: 'Referral claimed successfully!' };
        }
        catch (err) {
            logger_1.winstonLogger.error(`[REFERRAL] Claim failed: ${err.message}`);
            return { success: false, message: 'Failed to process referral' };
        }
    }
    async addBonusCheck(sessionId) {
        try {
            const usage = await this.getUsage(sessionId);
            if (!usage)
                return false;
            const currentCount = usage.pnr_count || 0;
            const newCount = Math.max(0, currentCount - 1);
            await supabase_1.supabase
                .from(this.TABLE_NAME)
                .update({ pnr_count: newCount })
                .eq('session_id', sessionId);
            cacheService_1.cacheService.del(`usage_${sessionId}`);
            logger_1.winstonLogger.info(`[USAGE] Added bonus check for session ${sessionId} (${currentCount} -> ${newCount})`);
            return true;
        }
        catch (err) {
            logger_1.winstonLogger.error(`[USAGE] Failed to add bonus check for ${sessionId}: ${err.message}`);
            return false;
        }
    }
    /**
     * Reset daily limits (can be called by cron job)
     */
    async resetDailyLimits() {
        try {
            await supabase_1.supabase
                .from(this.TABLE_NAME)
                .update({ search_count: 0 })
                .neq('pro_expires_at', null); // only reset non-pro if you want
            logger_1.winstonLogger.info('[USAGE] Daily search limits reset');
        }
        catch (err) {
            logger_1.winstonLogger.error(`[USAGE] Failed to reset limits: ${err.message}`);
        }
    }
}
exports.UserUsageService = UserUsageService;
exports.userUsageService = new UserUsageService();
