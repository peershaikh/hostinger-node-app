"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.attributePurchase = exports.generateReferralCodeSync = exports.getUserReferralCode = exports.applyReferralCode = exports.generateReferralCode = exports.referralService = void 0;
const crypto_1 = __importDefault(require("crypto"));
const fs_1 = __importDefault(require("fs"));
const path_1 = __importDefault(require("path"));
const logger_1 = require("../middleware/logger");
const analyticsService_1 = require("./analyticsService");
const authService_1 = require("./authService");
const REFERRAL_PREFIX = 'RAIL-';
const CODE_LENGTH = 6;
const REFERRAL_COOLDOWN_HOURS = 24;
const ATTRIBUTION_FILE = path_1.default.join(__dirname, '../../data/purchase_attributions.json');
// Regex accepts both 5-char (guest) and 6-char (registered) codes
const REFERRAL_CODE_REGEX = /^RAIL-[A-Z0-9]{5,6}$/;
class ReferralService {
    constructor() {
        this.store = {
            records: [],
            rewardedReferrals: [],
            usedDeviceFingerprints: [],
            cooldowns: []
        };
        this.attributionStore = [];
        this.loadFromSupabase();
        this.loadAttributionStore();
    }
    // ── Attribution Store Helpers ──────────────────────────────────────────────
    loadAttributionStore() {
        try {
            if (fs_1.default.existsSync(ATTRIBUTION_FILE)) {
                const raw = fs_1.default.readFileSync(ATTRIBUTION_FILE, 'utf-8');
                this.attributionStore = JSON.parse(raw);
            }
            else {
                this.attributionStore = [];
                this.saveAttributionStore();
            }
        }
        catch (e) {
            logger_1.winstonLogger.error(`[REFERRAL_ATTR] Failed to load attribution store: ${e.message}`);
            this.attributionStore = [];
        }
    }
    saveAttributionStore() {
        try {
            fs_1.default.writeFileSync(ATTRIBUTION_FILE, JSON.stringify(this.attributionStore, null, 2));
        }
        catch (e) {
            logger_1.winstonLogger.error(`[REFERRAL_ATTR] Failed to save attribution store: ${e.message}`);
        }
    }
    async loadFromSupabase() {
        try {
            const { supabase, isSupabaseConfigured } = require('../config/supabase');
            if (!isSupabaseConfigured()) {
                logger_1.winstonLogger.warn('[REFERRAL_SYNC] Supabase is not configured. Using local JSON store.');
                return;
            }
            logger_1.winstonLogger.info('[REFERRAL_SYNC] Syncing from Supabase...');
            const { data: dbUsers, error: usersError } = await supabase
                .from('users')
                .select('id, referral_code, referred_by, created_at')
                .not('referral_code', 'is', null);
            if (usersError)
                throw usersError;
            const records = (dbUsers || []).map((u) => ({
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
            if (refsError)
                throw refsError;
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
            logger_1.winstonLogger.info(`[REFERRAL_SYNC] Successfully synced ${records.length} codes and ${rewardedReferrals.length} links from Supabase.`);
        }
        catch (e) {
            logger_1.winstonLogger.error(`[REFERRAL_SYNC] Failed to load from Supabase: ${e.message}`);
        }
    }
    asyncSyncUserReferralCode(userId, code) {
        const { supabase, isSupabaseConfigured } = require('../config/supabase');
        if (!isSupabaseConfigured())
            return;
        Promise.resolve().then(async () => {
            try {
                const { error } = await supabase
                    .from('users')
                    .update({ referral_code: code })
                    .eq('id', userId);
                if (error)
                    throw error;
                logger_1.winstonLogger.info(`[REFERRAL_SYNC] Saved referral code ${code} for user ${userId} to Supabase.`);
            }
            catch (err) {
                logger_1.winstonLogger.error(`[REFERRAL_SYNC] Failed to save referral code for user ${userId}: ${err.message}`);
            }
        });
    }
    asyncSyncReferralRelation(inviterId, invitedUserId, referralCode, deviceFingerprint, rewardGranted = false) {
        const { supabase, isSupabaseConfigured } = require('../config/supabase');
        if (!isSupabaseConfigured())
            return;
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
                if (error && error.code !== '23505')
                    throw error;
                const { error: userUpdateError } = await supabase
                    .from('users')
                    .update({ referred_by: inviterId })
                    .eq('id', invitedUserId);
                if (userUpdateError)
                    throw userUpdateError;
                logger_1.winstonLogger.info(`[REFERRAL_SYNC] Synced referral relation (inviter: ${inviterId}, invited: ${invitedUserId}) to Supabase.`);
            }
            catch (err) {
                logger_1.winstonLogger.error(`[REFERRAL_SYNC] Failed to sync referral relation to Supabase: ${err.message}`);
            }
        });
    }
    // TODO: Implement actual DB methods for Supabase (e.g. SELECT COUNT(*))
    // Currently relies on local JSON which mimics the old behavior but adds safety.
    async _dbVerifyUniqueness(code) {
        // Stub implementation - assuming unique if not in memory
        return !this.store.records.some(r => r.referralCode === code);
    }
    _dbVerifyUniquenessSync(code) {
        return !this.store.records.some(r => r.referralCode === code);
    }
    generateCodeValue() {
        const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
        let code = '';
        for (let i = 0; i < CODE_LENGTH; i++) {
            const idx = crypto_1.default.randomInt(0, alphabet.length);
            code += alphabet[idx];
        }
        return `${REFERRAL_PREFIX}${code}`;
    }
    async createUniqueCode() {
        let attempts = 0;
        while (attempts < 5) {
            const code = this.generateCodeValue();
            const isUnique = await this._dbVerifyUniqueness(code);
            if (isUnique) {
                return code;
            }
            attempts++;
            logger_1.winstonLogger.warn(`[REFERRAL_SECURITY] Collision detected, retrying generation (${attempts}/5)`);
        }
        logger_1.winstonLogger.error('[REFERRAL_SECURITY] Failed to generate unique referral code after 5 attempts.');
        throw new Error('Failed to generate unique referral code.');
    }
    createUniqueCodeSync() {
        let attempts = 0;
        while (attempts < 5) {
            const code = this.generateCodeValue();
            const isUnique = this._dbVerifyUniquenessSync(code);
            if (isUnique) {
                return code;
            }
            attempts++;
            logger_1.winstonLogger.warn(`[REFERRAL_SECURITY] Collision detected (sync), retrying generation (${attempts}/5)`);
        }
        logger_1.winstonLogger.error('[REFERRAL_SECURITY] Failed to generate unique referral code sync after 5 attempts.');
        throw new Error('Failed to generate unique referral code.');
    }
    getRecordByUserId(userId) {
        return this.store.records.find(r => r.userId === userId);
    }
    getRecordByCode(referralCode) {
        return this.store.records.find(r => r.referralCode === referralCode.toUpperCase());
    }
    generateReferralCodeSync(userId) {
        const existing = this.getRecordByUserId(userId);
        if (existing)
            return existing.referralCode;
        try {
            const code = this.createUniqueCodeSync();
            const record = {
                userId,
                referralCode: code,
                rewardGranted: false,
                welcomeCreditsGranted: false,
                createdAt: new Date().toISOString()
            };
            this.store.records.push(record);
            this.asyncSyncUserReferralCode(userId, code);
            logger_1.winstonLogger.info(`[REFERRAL] Generated code ${code} for user ${userId} (sync)`);
            analyticsService_1.analyticsService.trackEvent('referral_generated', null, { userId, code, sync: true });
            return record.referralCode;
        }
        catch (err) {
            analyticsService_1.analyticsService.trackEvent('referral_failed', null, { userId, reason: err.message, sync: true });
            throw err;
        }
    }
    async generateReferralCode(userId) {
        const existing = this.getRecordByUserId(userId);
        if (existing)
            return existing.referralCode;
        try {
            const code = await this.createUniqueCode();
            const record = {
                userId,
                referralCode: code,
                rewardGranted: false,
                welcomeCreditsGranted: false,
                createdAt: new Date().toISOString()
            };
            this.store.records.push(record);
            this.asyncSyncUserReferralCode(userId, code);
            logger_1.winstonLogger.info(`[REFERRAL] Generated code ${code} for user ${userId}`);
            analyticsService_1.analyticsService.trackEvent('referral_generated', null, { userId, code });
            return record.referralCode;
        }
        catch (err) {
            analyticsService_1.analyticsService.trackEvent('referral_failed', null, { userId, reason: err.message });
            throw err;
        }
    }
    async getUserReferralCode(userId) {
        return this.generateReferralCode(userId);
    }
    async applyReferralCode(userId, referralCode, deviceFingerprint, ipAddress) {
        const normalizedCode = (referralCode || '').trim().toUpperCase();
        // IP Cooldown check
        if (ipAddress) {
            const cooldown = this.store.cooldowns.find(c => c.ipAddress === ipAddress);
            if (cooldown) {
                const lastAttemptTime = new Date(cooldown.lastAttemptAt).getTime();
                const now = Date.now();
                if (now - lastAttemptTime < REFERRAL_COOLDOWN_HOURS * 3600000 && cooldown.attempts > 10) {
                    logger_1.winstonLogger.warn(`[REFERRAL_SECURITY] IP rate limit hit for ${ipAddress}`);
                    analyticsService_1.analyticsService.trackEvent('suspicious_referral_attempt', null, { ipAddress, userId });
                    return { success: false, message: 'Too many attempts. Try again later.' };
                }
                cooldown.attempts++;
                cooldown.lastAttemptAt = new Date().toISOString();
            }
            else {
                this.store.cooldowns.push({ ipAddress, attempts: 1, lastAttemptAt: new Date().toISOString() });
            }
        }
        if (!REFERRAL_CODE_REGEX.test(normalizedCode)) {
            analyticsService_1.analyticsService.trackEvent('referral_failed', null, { userId, code: normalizedCode, reason: 'invalid_format' });
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
            analyticsService_1.analyticsService.trackEvent('referral_failed', null, { userId, reason: 'already_applied' });
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
                        const syntheticRecord = {
                            userId: guestRow.session_id,
                            referralCode: guestRow.referral_code,
                            rewardGranted: false,
                            welcomeCreditsGranted: false,
                            createdAt: new Date().toISOString()
                        };
                        this.store.records.push(syntheticRecord);
                        referrer = syntheticRecord;
                        logger_1.winstonLogger.info(`[REFERRAL] Resolved guest code ${normalizedCode} to session ${guestRow.session_id}`);
                    }
                }
            }
            catch (lookupErr) {
                logger_1.winstonLogger.warn(`[REFERRAL] Guest code lookup failed for ${normalizedCode}: ${lookupErr.message}`);
            }
        }
        if (!referrer) {
            analyticsService_1.analyticsService.trackEvent('referral_failed', null, { userId, code: normalizedCode, reason: 'not_found' });
            return { success: false, message: 'Referral code not found.' };
        }
        if (referrer.userId === userId) {
            logger_1.winstonLogger.warn(`[REFERRAL_SECURITY] Self-referral attempt blocked for user ${userId}`);
            analyticsService_1.analyticsService.trackEvent('suspicious_referral_attempt', null, { userId, reason: 'self_referral' });
            return { success: false, message: 'Self-referral is not allowed.' };
        }
        if (deviceFingerprint) {
            const fingerprint = deviceFingerprint.trim();
            if (fingerprint) {
                const alreadyUsed = this.store.usedDeviceFingerprints.find(d => d.fingerprint === fingerprint);
                if (alreadyUsed) {
                    logger_1.winstonLogger.warn(`[REFERRAL_SECURITY] Device fingerprint reuse blocked for user ${userId}`);
                    analyticsService_1.analyticsService.trackEvent('suspicious_referral_attempt', null, { userId, fingerprint, reason: 'device_reuse' });
                    return { success: false, message: 'This device fingerprint has already used a referral.' };
                }
                this.store.usedDeviceFingerprints.push({
                    fingerprint,
                    appliedByUserId: userId,
                    createdAt: new Date().toISOString()
                });
            }
        }
        const duplicateReward = this.store.rewardedReferrals.find(rr => rr.referrerUserId === referrer.userId && rr.referredUserId === userId);
        if (duplicateReward) {
            return { success: false, message: 'Duplicate referral reward blocked.' };
        }
        referred.referredBy = referrer.userId;
        logger_1.winstonLogger.info(`[REFERRAL] User ${userId} successfully applied referral code ${normalizedCode}`);
        analyticsService_1.analyticsService.trackEvent('referral_applied', null, { userId, referrerUserId: referrer.userId, code: normalizedCode });
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
    async _grantRewardsAsync(referrerUserId, referredUserId, code, deviceFingerprint) {
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
                logger_1.winstonLogger.info(`[REFERRAL_REWARD] Reward granted to ${referrerUserId} for referring ${referredUserId}`);
                analyticsService_1.analyticsService.trackEvent('referral_rewarded', null, { referrerUserId, referredUserId, code });
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
                            logger_1.winstonLogger.info(`[REFERRAL_REWARD] Credited guest referrer ${referrerUserId} with 1 free check (new PNR count: ${newPnrCount})`);
                        }
                    }
                }
                catch (usageErr) {
                    logger_1.winstonLogger.warn(`[REFERRAL_REWARD] Failed to update guest usage for referrer ${referrerUserId}: ${usageErr.message}`);
                }
                // Sync relation to DB
                this.asyncSyncReferralRelation(referrerUserId, referredUserId, code, deviceFingerprint, true);
                // Trigger milestone rewards
                this._checkAndGrantMilestonesAsync(referrerUserId);
            }
        }
        catch (e) {
            logger_1.winstonLogger.error(`[REFERRAL_REWARD] Failed to grant reward async: ${e.message}`);
        }
    }
    async _checkAndGrantMilestonesAsync(userId) {
        const inviteCount = this.store.rewardedReferrals.filter(rr => rr.referrerUserId === userId).length;
        const milestones = [
            { count: 5, days: 1 },
            { count: 10, days: 3 },
            { count: 25, days: 15 }
        ];
        const { supabase, isSupabaseConfigured } = require('../config/supabase');
        if (!isSupabaseConfigured())
            return;
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
                            logger_1.winstonLogger.debug(`[REFERRAL_MILESTONE] Milestone ${milestone} already claimed for user ${userId}`);
                        }
                        else {
                            throw error;
                        }
                    }
                    else if (data && data.length > 0) {
                        // Idempotent insertion succeeded
                        logger_1.winstonLogger.info(`[REFERRAL_MILESTONE] Unlocked milestone ${milestone} for user ${userId}. Granting ${grantedProDays} PRO days.`);
                        await authService_1.authService.upgradeToPro(userId, 'safar_pro_1d', grantedProDays * 1440);
                        analyticsService_1.analyticsService.trackEvent('referral_milestone_unlocked', null, { userId, milestone, grantedProDays });
                    }
                }
                catch (e) {
                    logger_1.winstonLogger.error(`[REFERRAL_MILESTONE] Failed to grant milestone ${milestone} to user ${userId}: ${e.message}`);
                }
            }
        }
    }
    /**
     * Called after a successful payment to reward the referrer with 7 days of PRO.
     * Duplicate protection: checks both local JSON store and Supabase referral_purchase_rewards table.
     */
    async attributePurchase(userId, orderId, planId, amount) {
        const PRO_REWARD_MINUTES = 7 * 24 * 60; // 7 days
        try {
            // 1. Find referrer — look in memory store first, then Supabase users table
            let referrerId;
            const userRecord = this.getRecordByUserId(userId);
            if (userRecord?.referredBy) {
                referrerId = userRecord.referredBy;
            }
            else {
                // Try Supabase
                try {
                    const { supabase: sb, isSupabaseConfigured: isConf } = require('../config/supabase');
                    if (isConf()) {
                        const { data: dbUser } = await sb
                            .from('users')
                            .select('referred_by')
                            .eq('id', userId)
                            .single();
                        if (dbUser?.referred_by)
                            referrerId = dbUser.referred_by;
                    }
                }
                catch (lookupErr) {
                    logger_1.winstonLogger.warn(`[REFERRAL_ATTR] Supabase referrer lookup failed for ${userId}: ${lookupErr.message}`);
                }
            }
            if (!referrerId) {
                logger_1.winstonLogger.info(`[REFERRAL_ATTR] No referrer found for user ${userId} — skipping purchase attribution`);
                return { rewarded: false, reason: 'no_referrer' };
            }
            // 2. Duplicate protection — local JSON store
            const existingLocal = this.attributionStore.find(a => a.userId === userId && a.rewardGranted);
            if (existingLocal) {
                logger_1.winstonLogger.info(`[REFERRAL_ATTR] Duplicate reward blocked (local) for user ${userId} referrer ${referrerId}`);
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
                        logger_1.winstonLogger.info(`[REFERRAL_ATTR] Duplicate reward blocked (DB) for user ${userId}`);
                        // Sync local store too
                        this.attributionStore.push({
                            userId, referrerId, orderId, planId, amount,
                            rewardGranted: true, createdAt: existing.created_at || new Date().toISOString()
                        });
                        this.saveAttributionStore();
                        return { rewarded: false, reason: 'already_rewarded' };
                    }
                }
            }
            catch (dbErr) {
                logger_1.winstonLogger.warn(`[REFERRAL_ATTR] DB duplicate check failed: ${dbErr.message} — proceeding with local check only`);
            }
            // 4. Persist attribution record
            const attrRecord = {
                userId, referrerId, orderId, planId, amount,
                rewardGranted: false,
                createdAt: new Date().toISOString()
            };
            this.attributionStore.push(attrRecord);
            this.saveAttributionStore();
            // 5. Grant 7-day PRO to referrer
            const rewardResult = await authService_1.authService.upgradeToPro(referrerId, 'safar_pro_7d', PRO_REWARD_MINUTES, 'referral');
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
            }
            catch (persistErr) {
                logger_1.winstonLogger.warn(`[REFERRAL_ATTR] Failed to persist purchase reward to DB: ${persistErr.message}`);
            }
            if (rewardResult) {
                logger_1.winstonLogger.info(`[REFERRAL_ATTR] ✅ Referrer ${referrerId} rewarded 7 PRO days for purchase by ${userId} (order: ${orderId})`);
                analyticsService_1.analyticsService.trackEvent('referral_purchase_rewarded', null, {
                    referrerId,
                    referredUserId: userId,
                    orderId,
                    planId,
                    amount,
                    rewardDays: 7
                });
            }
            return { rewarded: rewardResult, referrerId };
        }
        catch (e) {
            logger_1.winstonLogger.error(`[REFERRAL_ATTR] attributePurchase failed for user ${userId}: ${e.message}`);
            return { rewarded: false, reason: 'error', error: e.message };
        }
    }
    /** Returns dashboard stats for a user: their code, invite count, rewards, progress. */
    getUserStats(userId) {
        const record = this.getRecordByUserId(userId);
        const referralCode = record?.referralCode ?? null;
        // Count how many users were referred BY this user
        const successfulReferrals = this.store.rewardedReferrals.filter(rr => rr.referrerUserId === userId);
        const inviteCount = successfulReferrals.length;
        let nextMilestone = 5;
        if (inviteCount >= 25)
            nextMilestone = 25;
        else if (inviteCount >= 10)
            nextMilestone = 25;
        else if (inviteCount >= 5)
            nextMilestone = 10;
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
        const counts = new Map();
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
    getHistory(userId) {
        const records = this.store.records.filter(r => r.referredBy === userId);
        return records.map(r => ({
            referredUser: r.userId.substring(0, 4) + '****',
            status: r.rewardGranted ? 'Completed' : 'Pending',
            createdAt: r.createdAt
        })).sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());
    }
}
exports.referralService = new ReferralService();
const generateReferralCode = async (userId) => await exports.referralService.generateReferralCode(userId);
exports.generateReferralCode = generateReferralCode;
const applyReferralCode = async (userId, referralCode, deviceFingerprint, ipAddress) => await exports.referralService.applyReferralCode(userId, referralCode, deviceFingerprint, ipAddress);
exports.applyReferralCode = applyReferralCode;
const getUserReferralCode = async (userId) => await exports.referralService.getUserReferralCode(userId);
exports.getUserReferralCode = getUserReferralCode;
const generateReferralCodeSync = (userId) => exports.referralService.generateReferralCodeSync(userId);
exports.generateReferralCodeSync = generateReferralCodeSync;
const attributePurchase = async (userId, orderId, planId, amount) => await exports.referralService.attributePurchase(userId, orderId, planId, amount);
exports.attributePurchase = attributePurchase;
