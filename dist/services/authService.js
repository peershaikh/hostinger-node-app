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
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.authService = exports.AuthService = void 0;
const crypto_1 = __importDefault(require("crypto"));
const bcryptjs_1 = __importDefault(require("bcryptjs"));
const jsonwebtoken_1 = __importDefault(require("jsonwebtoken"));
const fs_1 = __importDefault(require("fs"));
const path_1 = __importDefault(require("path"));
const referralService_1 = require("./referralService");
const supabase_1 = require("../config/supabase");
const logger_1 = require("../middleware/logger");
const userRepository_1 = require("../repositories/userRepository");
const userCache_1 = require("../cache/userCache");
const quotaRepository_1 = require("../repositories/quotaRepository");
const cacheService_1 = require("./cacheService");
const betaService_1 = require("./betaService");
const USERS_FILE = path_1.default.join(__dirname, '../../data/users.json');
const GUESTS_FILE = path_1.default.join(__dirname, '../../data/guests.json');
class AuthService {
    constructor() {
        this.users = [];
        this.guests = [];
        this.otps = {};
        this.passwordResetOtps = {};
        this.mobileOtps = {};
        // PHASE_4C759 Fix #3 (P1-AUTH-001): OTP Rate Limiting
        this.otpRateLimits = new Map();
        this.OTP_LIMIT_PER_EMAIL = 3;
        this.OTP_LIMIT_WINDOW_MS = 60 * 60 * 1000; // 1 hour
        this.ipGuestDevices = new Map();
        this.ipGuestDevicesDate = new Date().toISOString().split('T')[0];
        this.IP_DEVICE_LIMIT = 15;
        /** P0-010: Serialize concurrent refresh for the same user to prevent rotation races. */
        this.refreshLocks = new Map();
        this.loadUsers();
        this.loadGuests();
        // ensureAdmin is now async (persists to DB); fire-and-forget from constructor
        this.ensureAdmin().catch(e => console.warn('[AuthService] ensureAdmin error:', e));
        this.syncWithSupabase();
    }
    async getAllUsers() {
        try {
            logger_1.winstonLogger.info(`[AUTH_PHASE2A] getAllUsers querying repository`);
            return await userRepository_1.userRepository.getAllUsers();
        }
        catch (err) {
            logger_1.winstonLogger.error(`[AUTH_PHASE2A] getAllUsers repository fallback: ${err.message}`);
            return this.users;
        }
    }
    async getUserById(userId) {
        try {
            let user = await userCache_1.userCache.getUser(userId);
            if (user) {
                logger_1.winstonLogger.info(`[AUTH_PHASE2A] Cache hit for ${userId}`);
                return user;
            }
            logger_1.winstonLogger.info(`[AUTH_PHASE2A] Cache miss for ${userId}, querying repository`);
            user = await userRepository_1.userRepository.findById(userId);
            if (user) {
                const localUser = this.users.find(u => u.id === userId);
                if (localUser) {
                    user = {
                        ...localUser,
                        ...user,
                        avatarUrl: user.avatarUrl || localUser.avatarUrl || '',
                        mobileNumber: user.mobileNumber || localUser.mobileNumber || '',
                        mobileVerified: user.mobileVerified || localUser.mobileVerified || false,
                        mobileVerificationMethod: user.mobileVerificationMethod || localUser.mobileVerificationMethod || null,
                        mobileVerifiedAt: user.mobileVerifiedAt || localUser.mobileVerifiedAt || null
                    };
                }
                await userCache_1.userCache.setUser(user);
                return user;
            }
            // If null, it means it's not in DB yet. Fallback to legacy array.
            logger_1.winstonLogger.warn(`[AUTH_PHASE2A] getUserById null response, falling back to legacy array for ${userId}`);
            return this.users.find(u => u.id === userId) || null;
        }
        catch (err) {
            logger_1.winstonLogger.error(`[AUTH_PHASE2A] getUserById repository fallback: ${err.message}`);
            return this.users.find(u => u.id === userId) || null;
        }
    }
    async getUserByEmail(email) {
        try {
            let user = await userRepository_1.userRepository.findByEmail(email);
            if (user) {
                const localUser = this.users.find(u => u.email === email);
                if (localUser) {
                    user = {
                        ...localUser,
                        ...user,
                        avatarUrl: user.avatarUrl || localUser.avatarUrl || '',
                        mobileNumber: user.mobileNumber || localUser.mobileNumber || '',
                        mobileVerified: user.mobileVerified || localUser.mobileVerified || false,
                        mobileVerificationMethod: user.mobileVerificationMethod || localUser.mobileVerificationMethod || null,
                        mobileVerifiedAt: user.mobileVerifiedAt || localUser.mobileVerifiedAt || null
                    };
                }
                await userCache_1.userCache.setUser(user);
                return user;
            }
            // If null, fallback to legacy array
            logger_1.winstonLogger.warn(`[AUTH_PHASE2A] getUserByEmail null response, falling back to legacy array for ${email}`);
            return this.users.find(u => u.email === email) || null;
        }
        catch (err) {
            logger_1.winstonLogger.error(`[AUTH_PHASE2A] getUserByEmail repository fallback: ${err.message}`);
            return this.users.find(u => u.email === email) || null;
        }
    }
    // ─── Admin User Management ───────────────────────────────────────────────
    async deleteUserAccount(userId) {
        logger_1.winstonLogger.info(`[AUTH_DELETE] Initiating deletion process for user: ${userId}`);
        // Invalidate caches immediately
        await userCache_1.userCache.invalidate(userId);
        cacheService_1.cacheService.del(`quota_status:${userId}`);
        // Delete local user array entry and save local JSON state
        const localUserIndex = this.users.findIndex(u => u.id === userId);
        if (localUserIndex !== -1) {
            this.users.splice(localUserIndex, 1);
            this.saveUsers();
            logger_1.winstonLogger.info(`[AUTH_DELETE] Purged local JSON user registry entry`);
        }
        // Delete related beta redemptions
        try {
            await betaService_1.betaService.deleteRedemptionsForUser(userId);
            logger_1.winstonLogger.info(`[AUTH_DELETE] Purged user beta redemptions`);
        }
        catch (err) {
            logger_1.winstonLogger.error(`[AUTH_DELETE] Exception while deleting beta redemptions: ${err.message}`);
        }
        if ((0, supabase_1.isSupabaseConfigured)()) {
            // Delete user push tokens
            try {
                const { error: tokenErr } = await supabase_1.supabase.from('user_push_tokens').delete().eq('user_id', userId);
                if (tokenErr)
                    logger_1.winstonLogger.warn(`[AUTH_DELETE] Failed user_push_tokens deletion: ${tokenErr.message}`);
            }
            catch (err) {
                logger_1.winstonLogger.error(`[AUTH_DELETE] Exception in user_push_tokens deletion: ${err.message}`);
            }
            // Delete user notification preferences
            try {
                const { error: prefErr } = await supabase_1.supabase.from('user_notification_preferences').delete().eq('user_id', userId);
                if (prefErr)
                    logger_1.winstonLogger.warn(`[AUTH_DELETE] Failed user_notification_preferences deletion: ${prefErr.message}`);
            }
            catch (err) {
                logger_1.winstonLogger.error(`[AUTH_DELETE] Exception in user_notification_preferences deletion: ${err.message}`);
            }
            // Delete user notification history
            try {
                const { error: histErr } = await supabase_1.supabase.from('user_notification_history').delete().eq('user_id', userId);
                if (histErr)
                    logger_1.winstonLogger.warn(`[AUTH_DELETE] Failed user_notification_history deletion: ${histErr.message}`);
            }
            catch (err) {
                logger_1.winstonLogger.error(`[AUTH_DELETE] Exception in user_notification_history deletion: ${err.message}`);
            }
            // Delete other optional related records if tables exist: user_expenses, search_history, pnr_history
            const optionalTables = ['user_expenses', 'search_history', 'pnr_history', 'user_usage'];
            for (const table of optionalTables) {
                try {
                    const { error } = await supabase_1.supabase.from(table).delete().eq('user_id', userId);
                    if (error && error.code !== 'PGRST116') {
                        logger_1.winstonLogger.warn(`[AUTH_DELETE] Failed ${table} deletion: ${error.message}`);
                    }
                }
                catch (err) {
                    // Ignore table-not-exist errors safely
                }
            }
            // Delete primary database user record
            try {
                await userRepository_1.userRepository.deleteUser(userId);
                logger_1.winstonLogger.info(`[AUTH_DELETE] Purged database user record`);
            }
            catch (err) {
                logger_1.winstonLogger.error(`[AUTH_DELETE] Failed to delete user from repository: ${err.message}`);
                throw err;
            }
            // Finally delete the Supabase Auth user via Admin API (requires service role key)
            try {
                const { error: authErr } = await supabase_1.supabase.auth.admin.deleteUser(userId);
                if (authErr) {
                    logger_1.winstonLogger.warn(`[AUTH_DELETE] Supabase Auth Admin deletion warning: ${authErr.message}. User database records were still purged.`);
                }
                else {
                    logger_1.winstonLogger.info(`[AUTH_DELETE] Successfully deleted user credential from Supabase Auth`);
                }
            }
            catch (err) {
                logger_1.winstonLogger.warn(`[AUTH_DELETE] Supabase Auth Admin API not available/failed: ${err.message}. Database records were successfully purged.`);
            }
        }
    }
    async blockUser(userId) {
        const user = await this.getUserById(userId);
        if (!user || user.isAdmin)
            return false; // Cannot block admins
        user.isBlocked = true;
        user.tokenVersion = (user.tokenVersion || 0) + 1; // Invalidate refresh tokens
        user.sessionEpoch = (user.sessionEpoch || 1) + 1; // PHASE_4C965: bump access epoch (E) alongside R
        // Phase 1: Dual-write hook
        if ((0, supabase_1.isSupabaseConfigured)()) {
            userRepository_1.userRepository.update(userId, { isBlocked: true, tokenVersion: user.tokenVersion, sessionEpoch: user.sessionEpoch }).catch(err => logger_1.winstonLogger.error(`[AUTH_PHASE1] Failed to sync blockUser to Supabase: ${err.message}`));
            await userCache_1.userCache.invalidate(userId);
        }
        this.updateLocalUser(user);
        this.saveUsers();
        return true;
    }
    async unblockUser(userId) {
        const user = await this.getUserById(userId);
        if (!user)
            return false;
        user.isBlocked = false;
        // Phase 1: Dual-write hook
        if ((0, supabase_1.isSupabaseConfigured)()) {
            userRepository_1.userRepository.update(userId, { isBlocked: false }).catch(err => logger_1.winstonLogger.error(`[AUTH_PHASE1] Failed to sync unblockUser to Supabase: ${err.message}`));
            await userCache_1.userCache.invalidate(userId);
        }
        this.updateLocalUser(user);
        this.saveUsers();
        return true;
    }
    async resetUserLimits(userId) {
        const user = await this.getUserById(userId);
        if (!user)
            return false;
        const today = new Date().toISOString().split('T')[0];
        user.dailySearchCount = 0;
        user.dailyPnrCount = 0;
        user.dailyLiveCount = 0;
        user.adsWatchedToday = 0;
        user.lastUsageReset = today;
        if ((0, supabase_1.isSupabaseConfigured)()) {
            userRepository_1.userRepository.update(userId, {
                dailySearchCount: 0,
                dailyPnrCount: 0,
                dailyLiveCount: 0,
                adsWatchedToday: 0,
                lastUsageReset: today
            }).catch(err => logger_1.winstonLogger.error(`[AUTH_PHASE1] Failed to sync resetUserLimits to Supabase: ${err.message}`));
            await userCache_1.userCache.invalidate(userId);
        }
        this.updateLocalUser(user);
        this.saveUsers();
        return true;
    }
    async changeUserPlan(userId, planType, durationDays) {
        const user = await this.getUserById(userId);
        if (!user)
            return false;
        user.planType = planType;
        let planExpiry = null;
        let lastSubscriptionDate = null;
        if (planType === 'free') {
            user.planExpiry = null;
        }
        else if (durationDays) {
            const expiry = new Date();
            expiry.setDate(expiry.getDate() + durationDays);
            user.planExpiry = expiry.toISOString();
            user.lastSubscriptionDate = new Date().toISOString();
            planExpiry = user.planExpiry;
            lastSubscriptionDate = user.lastSubscriptionDate;
        }
        if ((0, supabase_1.isSupabaseConfigured)()) {
            userRepository_1.userRepository.update(userId, { planType, planExpiry, lastSubscriptionDate }).catch(err => logger_1.winstonLogger.error(`[AUTH_PHASE1] Failed to sync changeUserPlan to Supabase: ${err.message}`));
            await userCache_1.userCache.invalidate(userId);
        }
        this.updateLocalUser(user);
        this.saveUsers();
        return true;
    }
    async terminateUserSessions(userId) {
        const user = await this.getUserById(userId);
        if (!user || user.isAdmin)
            return false;
        user.tokenVersion = (user.tokenVersion || 0) + 1;
        user.sessionEpoch = (user.sessionEpoch || 1) + 1; // PHASE_4C965: bump access epoch (E) alongside R
        if ((0, supabase_1.isSupabaseConfigured)()) {
            try {
                await userRepository_1.userRepository.update(userId, { tokenVersion: user.tokenVersion, sessionEpoch: user.sessionEpoch });
            }
            catch (err) {
                logger_1.winstonLogger.error(`[AUTH_PHASE1] Failed to sync terminateUserSessions to Supabase: ${err.message}`);
                throw err;
            }
        }
        await userCache_1.userCache.invalidate(userId);
        this.updateLocalUser(user);
        this.saveUsers();
        return true;
    }
    async adjustUserCredits(userId, creditsChange) {
        const user = await this.getUserById(userId);
        if (!user || user.isAdmin)
            return false;
        const newCredits = Math.max(0, (user.credits || 0) + creditsChange);
        if (newCredits > 1000000) {
            throw new Error('Credits allocation exceeds maximum cap of 1,000,000.');
        }
        user.credits = newCredits;
        if ((0, supabase_1.isSupabaseConfigured)()) {
            try {
                await userRepository_1.userRepository.update(userId, { credits: user.credits });
            }
            catch (err) {
                logger_1.winstonLogger.error(`[AUTH_PHASE1] Failed to sync adjustUserCredits to Supabase: ${err.message}`);
                throw err;
            }
        }
        await userCache_1.userCache.invalidate(userId);
        this.updateLocalUser(user);
        this.saveUsers();
        return true;
    }
    // ─── Forgot Password Flow ─────────────────────────────────────────────────
    async sendPasswordResetOtp(email) {
        const user = await this.getUserByEmail(email);
        if (!user)
            throw new Error('No account found with this email address');
        if (user.isBlocked)
            throw new Error('Account has been blocked');
        // PHASE_4C759 Fix #3 (P1-AUTH-001): Rate limit enforcement
        const now = Date.now();
        const emailLower = email.toLowerCase();
        // Clean up expired entries periodically
        for (const [key, limit] of this.otpRateLimits.entries()) {
            if (now > limit.resetAt) {
                this.otpRateLimits.delete(key);
            }
        }
        // Check current rate limit
        let rateLimit = this.otpRateLimits.get(emailLower);
        if (!rateLimit || now > rateLimit.resetAt) {
            // Initialize or reset rate limit window
            rateLimit = {
                count: 0,
                resetAt: now + this.OTP_LIMIT_WINDOW_MS
            };
            this.otpRateLimits.set(emailLower, rateLimit);
        }
        // Enforce limit
        if (rateLimit.count >= this.OTP_LIMIT_PER_EMAIL) {
            const minutesLeft = Math.ceil((rateLimit.resetAt - now) / 60000);
            throw new Error(`Too many OTP requests. Please try again in ${minutesLeft} minute(s).`);
        }
        // Increment counter
        rateLimit.count++;
        const otp = Math.floor(100000 + Math.random() * 900000).toString();
        this.passwordResetOtps[email] = {
            otp,
            expiresAt: Date.now() + 10 * 60 * 1000 // 10 min expiry
        };
        try {
            const { emailService } = await Promise.resolve().then(() => __importStar(require('./emailService')));
            await emailService.sendPasswordResetEmail(email, otp);
        }
        catch (err) {
            logger_1.winstonLogger.error(`[AUTH_RESET_OTP] Exception while sending password reset email to ${email}: ${err.message}.`);
            throw new Error('Failed to send password reset email. Please try again later.');
        }
        return true;
    }
    async resetPassword(email, otp, newPassword) {
        const record = this.passwordResetOtps[email];
        if (!record || record.otp !== otp || Date.now() > record.expiresAt) {
            throw new Error('Invalid or expired OTP');
        }
        const user = await this.getUserByEmail(email);
        if (!user)
            throw new Error('User not found');
        user.password = bcryptjs_1.default.hashSync(newPassword, 10);
        delete this.passwordResetOtps[email];
        // Phase 1: Dual-write hook
        if ((0, supabase_1.isSupabaseConfigured)()) {
            userRepository_1.userRepository.update(user.id, { password: user.password }).catch(err => logger_1.winstonLogger.error(`[AUTH_PHASE1] Failed to sync resetPassword to Supabase: ${err.message}`));
            await userCache_1.userCache.invalidate(user.id);
        }
        this.updateLocalUser(user);
        this.saveUsers();
        return true;
    }
    loadUsers() {
        try {
            if (fs_1.default.existsSync(USERS_FILE)) {
                const data = fs_1.default.readFileSync(USERS_FILE, 'utf-8');
                this.users = JSON.parse(data);
            }
            else {
                this.saveUsers();
            }
        }
        catch (e) {
            // Silent - users file will be created on first save
        }
    }
    async syncWithSupabase() {
        if (!(0, supabase_1.isSupabaseConfigured)()) {
            logger_1.winstonLogger.info('[AUTH_FALLBACK] Supabase not configured. Using users.json strictly.');
            return;
        }
        try {
            const { data: remoteUsers, error } = await supabase_1.supabase.from('users').select('*');
            if (error) {
                logger_1.winstonLogger.warn(`[AUTH_FALLBACK] Supabase fetch failed: ${error.message}. Using users.json`);
                return;
            }
            if (remoteUsers) {
                logger_1.winstonLogger.info(`[AUTH_SUPABASE] User loaded: ${remoteUsers.length} users from Supabase`);
                const remoteDict = new Map();
                remoteUsers.forEach(u => remoteDict.set(u.email, u));
                for (const localUser of this.users) {
                    if (!remoteDict.has(localUser.email)) {
                        // Auto-create missing users in Supabase
                        const { error: insertErr } = await supabase_1.supabase.from('users').insert({
                            id: localUser.id,
                            email: localUser.email,
                            password: localUser.password,
                            referral_code: localUser.referralCode,
                            referred_by: localUser.referredBy,
                            device_id: localUser.deviceId,
                            created_at: localUser.createdAt,
                            daily_search_count: localUser.dailySearchCount,
                            daily_pnr_count: localUser.dailyPnrCount,
                            daily_live_count: localUser.dailyLiveCount,
                            last_usage_reset: localUser.lastUsageReset,
                            split_access_until: localUser.splitAccessUntil,
                            plan_type: localUser.planType,
                            plan_expiry: localUser.planExpiry,
                            last_subscription_date: localUser.lastSubscriptionDate,
                            credits: localUser.credits,
                            ai_split_searches: localUser.aiSplitSearches,
                            ads_watched_today: localUser.adsWatchedToday,
                            last_ad_watch_time: localUser.lastAdWatchTime,
                            is_admin: localUser.isAdmin,
                            is_blocked: localUser.isBlocked || false
                        });
                        if (!insertErr) {
                            logger_1.winstonLogger.info(`[AUTH_MIGRATION] User migrated: ${localUser.email}`);
                            remoteDict.set(localUser.email, localUser);
                        }
                        else {
                            logger_1.winstonLogger.error(`[AUTH_MIGRATION] Failed to migrate user ${localUser.email}: ${insertErr.message}`);
                        }
                    }
                }
                // Combine remote truth and local migrations
                this.users = Array.from(remoteDict.values()).map(row => {
                    const localUser = this.users.find(u => u.email === row.email) || {};
                    return {
                        id: row.id,
                        email: row.email,
                        password: row.password,
                        referralCode: row.referral_code || row.referralCode,
                        referredBy: row.referred_by || row.referredBy,
                        deviceId: row.device_id || row.deviceId,
                        createdAt: row.created_at || row.createdAt,
                        dailySearchCount: row.daily_search_count ?? row.dailySearchCount ?? 0,
                        dailyPnrCount: row.daily_pnr_count ?? row.dailyPnrCount ?? 0,
                        dailyLiveCount: row.daily_live_count ?? row.dailyLiveCount ?? 0,
                        lastUsageReset: row.last_usage_reset || row.lastUsageReset,
                        splitAccessUntil: row.split_access_until || row.splitAccessUntil || null,
                        planType: row.plan_type || row.planType || 'free',
                        planExpiry: row.plan_expiry || row.planExpiry || null,
                        lastSubscriptionDate: row.last_subscription_date || row.lastSubscriptionDate || null,
                        credits: row.credits ?? row.credits ?? 0,
                        aiSplitSearches: row.ai_split_searches ?? row.aiSplitSearches ?? 0,
                        adsWatchedToday: row.ads_watched_today ?? row.adsWatchedToday ?? 0,
                        lastAdWatchTime: row.last_ad_watch_time ?? row.lastAdWatchTime ?? 0,
                        isAdmin: row.is_admin ?? row.isAdmin ?? false,
                        isBlocked: row.is_blocked ?? row.isBlocked ?? false,
                        fullName: row.full_name || row.fullName || localUser.fullName || '',
                        mobileNumber: row.mobile_number || row.mobileNumber || localUser.mobileNumber || '',
                        dob: row.dob || row.dob || localUser.dob || '',
                        avatarUrl: row.avatar_url || row.avatarUrl || localUser.avatarUrl || '',
                        notifyEmail: row.notify_email ?? row.notifyEmail ?? localUser.notifyEmail ?? true,
                        notifyBirthday: row.notify_birthday ?? row.notifyBirthday ?? localUser.notifyBirthday ?? true,
                        notifyMarketing: row.notify_marketing ?? row.notifyMarketing ?? localUser.notifyMarketing ?? true,
                        mobileVerified: row.mobile_verified ?? row.mobileVerified ?? localUser.mobileVerified ?? false,
                        mobileVerificationMethod: row.mobile_verification_method || row.mobileVerificationMethod || localUser.mobileVerificationMethod || null,
                        mobileVerifiedAt: row.mobile_verified_at || row.mobileVerifiedAt || localUser.mobileVerifiedAt || null,
                        birthdayRewardLastClaimedYear: row.birthday_reward_last_claimed_year || row.birthdayRewardLastClaimedYear || localUser.birthdayRewardLastClaimedYear || null
                    };
                });
                // Flush back to users.json to ensure hybrid fallback is perfectly synced
                if (!fs_1.default.existsSync(path_1.default.dirname(USERS_FILE))) {
                    fs_1.default.mkdirSync(path_1.default.dirname(USERS_FILE), { recursive: true });
                }
                fs_1.default.writeFileSync(USERS_FILE, JSON.stringify(this.users, null, 2));
            }
        }
        catch (e) {
            logger_1.winstonLogger.error(`[AUTH_SUPABASE] Sync error: ${e.message}`);
        }
    }
    updateLocalUser(user) {
        const idx = this.users.findIndex(u => u.id === user.id);
        if (idx !== -1) {
            this.users[idx] = { ...user };
        }
        else {
            this.users.push({ ...user });
        }
    }
    saveUsers() {
        try {
            if (!fs_1.default.existsSync(path_1.default.dirname(USERS_FILE))) {
                fs_1.default.mkdirSync(path_1.default.dirname(USERS_FILE), { recursive: true });
            }
            fs_1.default.writeFileSync(USERS_FILE, JSON.stringify(this.users, null, 2));
            // Async Supabase sync
            if ((0, supabase_1.isSupabaseConfigured)()) {
                const dbPayload = this.users.map(localUser => ({
                    id: localUser.id,
                    email: localUser.email,
                    password: localUser.password,
                    referral_code: localUser.referralCode,
                    referred_by: localUser.referredBy,
                    device_id: localUser.deviceId,
                    created_at: localUser.createdAt,
                    daily_search_count: localUser.dailySearchCount,
                    daily_pnr_count: localUser.dailyPnrCount,
                    daily_live_count: localUser.dailyLiveCount,
                    last_usage_reset: localUser.lastUsageReset,
                    split_access_until: localUser.splitAccessUntil,
                    plan_type: localUser.planType,
                    plan_expiry: localUser.planExpiry,
                    last_subscription_date: localUser.lastSubscriptionDate,
                    credits: localUser.credits,
                    ai_split_searches: localUser.aiSplitSearches,
                    ads_watched_today: localUser.adsWatchedToday,
                    last_ad_watch_time: localUser.lastAdWatchTime,
                    is_admin: localUser.isAdmin,
                    is_blocked: localUser.isBlocked || false,
                    full_name: localUser.fullName || null,
                    mobile_number: localUser.mobileNumber || null,
                    dob: localUser.dob || null,
                    avatar_url: localUser.avatarUrl || null,
                    notify_email: localUser.notifyEmail ?? true,
                    notify_birthday: localUser.notifyBirthday ?? true,
                    notify_marketing: localUser.notifyMarketing ?? true,
                    mobile_verified: localUser.mobileVerified ?? false,
                    mobile_verification_method: localUser.mobileVerificationMethod || null,
                    mobile_verified_at: localUser.mobileVerifiedAt || null,
                    birthday_reward_last_claimed_year: localUser.birthdayRewardLastClaimedYear || null
                }));
                supabase_1.supabase.from('users').upsert(dbPayload).then(({ error }) => {
                    if (error && error.code !== 'PGRST116') {
                        logger_1.winstonLogger.error(`[AUTH_SUPABASE] Upsert error: ${error.message}`);
                    }
                });
            }
        }
        catch (e) {
            // Silent - non-critical persistence error
        }
    }
    loadGuests() {
        try {
            if (fs_1.default.existsSync(GUESTS_FILE)) {
                const data = fs_1.default.readFileSync(GUESTS_FILE, 'utf-8');
                this.guests = JSON.parse(data);
            }
            else {
                this.saveGuests();
            }
        }
        catch (e) {
            // Silent
        }
    }
    saveGuests() {
        try {
            if (!fs_1.default.existsSync(path_1.default.dirname(GUESTS_FILE))) {
                fs_1.default.mkdirSync(path_1.default.dirname(GUESTS_FILE), { recursive: true });
            }
            fs_1.default.writeFileSync(GUESTS_FILE, JSON.stringify(this.guests, null, 2));
        }
        catch (e) {
            // Silent
        }
    }
    async ensureAdmin() {
        const adminPassword = (process.env.ADMIN_PASSWORD || '').trim();
        if (!adminPassword)
            return;
        // Support multiple admins: ADMIN_EMAILS=a@b.com,c@d.com
        // Falls back to legacy ADMIN_EMAIL for single-email setups
        const rawEmails = process.env.ADMIN_EMAILS || process.env.ADMIN_EMAIL || '';
        const adminEmails = rawEmails.split(',').map((e) => e.trim()).filter(Boolean);
        if (adminEmails.length === 0)
            return;
        for (const adminEmail of adminEmails) {
            const existingAdmin = this.users.find(u => u.email === adminEmail);
            if (existingAdmin) {
                existingAdmin.isAdmin = true;
                existingAdmin.planType = 'admin';
                if ((0, supabase_1.isSupabaseConfigured)()) {
                    try {
                        await userRepository_1.userRepository.update(existingAdmin.id, { isAdmin: true, planType: 'admin' });
                    }
                    catch (e) {
                        logger_1.winstonLogger.warn(`[ensureAdmin] Failed to persist admin flag for ${adminEmail}:`, e);
                    }
                }
            }
            else {
                const today = new Date().toISOString().split('T')[0];
                const adminUser = {
                    id: crypto_1.default.randomUUID(),
                    email: adminEmail,
                    password: bcryptjs_1.default.hashSync(adminPassword, 10),
                    referralCode: '',
                    deviceId: undefined,
                    createdAt: new Date().toISOString(),
                    dailySearchCount: 0,
                    dailyPnrCount: 0,
                    dailyLiveCount: 0,
                    lastUsageReset: today,
                    splitAccessUntil: null,
                    planType: 'admin',
                    planExpiry: null,
                    isAdmin: true,
                    credits: 0,
                    aiSplitSearches: 0,
                    adsWatchedToday: 0,
                    lastAdWatchTime: 0,
                    tokenVersion: 1,
                    sessionEpoch: 1,
                    fullName: 'Admin',
                    mobileNumber: '',
                    dob: ''
                };
                adminUser.referralCode = (0, referralService_1.generateReferralCodeSync)(adminUser.id);
                this.users.push(adminUser);
                this.saveUsers();
            }
        }
    }
    resetDailyUsage(entity) {
        const today = new Date().toISOString().split('T')[0];
        if (entity.lastUsageReset !== today) {
            entity.dailySearchCount = 0;
            entity.dailyPnrCount = 0;
            entity.dailyLiveCount = 0;
            entity.adsWatchedToday = 0;
            entity.lastUsageReset = today;
        }
    }
    async resetDailyUsageExplicit(userId, deviceId) {
        const today = new Date().toISOString().split('T')[0];
        let modified = false;
        if (userId) {
            const user = await this.getUserById(userId);
            if (user) {
                if (user.lastUsageReset !== today) {
                    user.dailySearchCount = 0;
                    user.dailyPnrCount = 0;
                    user.dailyLiveCount = 0;
                    user.adsWatchedToday = 0;
                    user.lastUsageReset = today;
                    modified = true;
                    if ((0, supabase_1.isSupabaseConfigured)()) {
                        try {
                            await userRepository_1.userRepository.update(userId, {
                                dailySearchCount: 0,
                                dailyPnrCount: 0,
                                dailyLiveCount: 0,
                                adsWatchedToday: 0,
                                lastUsageReset: today
                            });
                        }
                        catch (err) {
                            logger_1.winstonLogger.error(`[AUTH_EXPLICIT_RESET] Failed to sync reset to Supabase: ${err.message}`);
                        }
                        await userCache_1.userCache.invalidate(userId);
                    }
                    this.updateLocalUser(user);
                    this.saveUsers();
                }
            }
        }
        if (deviceId) {
            const guest = this.guests.find(g => g.deviceId === deviceId);
            if (guest) {
                if (guest.lastUsageReset !== today) {
                    guest.dailySearchCount = 0;
                    guest.dailyPnrCount = 0;
                    guest.dailyLiveCount = 0;
                    guest.adsWatchedToday = 0;
                    guest.lastUsageReset = today;
                    modified = true;
                    this.saveGuests();
                }
            }
            else {
                // Create guest usage
                this.getOrCreateGuest(deviceId);
                modified = true;
            }
        }
        return modified;
    }
    getOrCreateGuest(deviceId) {
        let guest = this.guests.find(g => g.deviceId === deviceId);
        if (!guest) {
            guest = {
                deviceId,
                dailySearchCount: 0,
                dailyPnrCount: 0,
                dailyLiveCount: 0,
                adsWatchedToday: 0,
                lastAdWatchTime: 0,
                lastUsageReset: new Date().toISOString().split('T')[0]
            };
            this.guests.push(guest);
            this.saveGuests();
        }
        return guest;
    }
    async sendOtp(email) {
        const existingUser = this.users.find(u => u.email === email);
        if (existingUser) {
            if (existingUser.isBlocked)
                throw new Error('Account has been blocked');
            throw new Error('Email already exists');
        }
        const otp = Math.floor(100000 + Math.random() * 900000).toString();
        this.otps[email] = {
            otp,
            expiresAt: Date.now() + 15 * 60 * 1000 // 15 mins expiry
        };
        try {
            const { emailService } = await Promise.resolve().then(() => __importStar(require('./emailService')));
            const sent = await emailService.sendOtpEmail(email, otp);
            if (!sent) {
                logger_1.winstonLogger.error(`[AUTH_OTP] Failed to send OTP email to ${email}.`);
                throw new Error('Failed to send verification email. Please try again later.');
            }
        }
        catch (err) {
            logger_1.winstonLogger.error(`[AUTH_OTP] Exception while sending OTP email to ${email}: ${err.message}.`);
            throw new Error(err.message || 'Failed to send verification email. Please try again later.');
        }
        return true;
    }
    async signup(email, password, referredByCode, deviceId, otp, fullName, mobileNumber, dob) {
        if (await this.getUserByEmail(email)) {
            throw new Error('Email already exists');
        }
        if (!otp) {
            throw new Error('OTP is required for signup');
        }
        const record = this.otps[email];
        if (!record || record.otp !== otp || Date.now() > record.expiresAt) {
            throw new Error('Invalid or expired OTP');
        }
        // OTP verified, consume it
        delete this.otps[email];
        const today = new Date().toISOString().split('T')[0];
        const newUser = {
            id: crypto_1.default.randomUUID(),
            email,
            password: await bcryptjs_1.default.hash(password, 10),
            referralCode: '',
            deviceId,
            createdAt: new Date().toISOString(),
            dailySearchCount: 0,
            dailyPnrCount: 0,
            dailyLiveCount: 0,
            lastUsageReset: today,
            splitAccessUntil: null,
            planType: 'free',
            planExpiry: null,
            isAdmin: false,
            credits: 0,
            aiSplitSearches: 0,
            adsWatchedToday: 0,
            lastAdWatchTime: 0,
            tokenVersion: 1,
            sessionEpoch: 1,
            fullName: fullName || '',
            mobileNumber: mobileNumber || '',
            dob: dob || ''
        };
        newUser.referralCode = await (0, referralService_1.generateReferralCode)(newUser.id);
        let referralMeta;
        const normalizedReferralCode = (referredByCode || '').trim().toUpperCase();
        if (normalizedReferralCode) {
            const referralResult = await (0, referralService_1.applyReferralCode)(newUser.id, normalizedReferralCode, deviceId);
            if (referralResult.success) {
                const thirtyMinutesFromNow = new Date(Date.now() + 30 * 60000).toISOString();
                newUser.splitAccessUntil = thirtyMinutesFromNow;
                newUser.referredBy = referralResult.data?.referredBy;
                const referrer = await this.getUserById(referralResult.data?.referredBy);
                if (referrer) {
                    referrer.splitAccessUntil = thirtyMinutesFromNow;
                    this.updateLocalUser(referrer);
                    if ((0, supabase_1.isSupabaseConfigured)()) {
                        userRepository_1.userRepository.update(referrer.id, { splitAccessUntil: thirtyMinutesFromNow }).catch(err => logger_1.winstonLogger.error(`[AUTH_PHASE1] Failed to sync referrer splitAccessUntil to Supabase: ${err.message}`));
                        userCache_1.userCache.setUser(referrer).catch(err => logger_1.winstonLogger.error(`[AUTH_PHASE1] Failed to cache referrer: ${err.message}`));
                    }
                }
                referralMeta = { applied: true, referredBy: referralResult.data?.referredBy };
            }
            else {
                referralMeta = { applied: false, message: referralResult.message };
            }
        }
        this.users.push(newUser);
        // Phase 1: Dual-write hook
        if ((0, supabase_1.isSupabaseConfigured)()) {
            userRepository_1.userRepository.create(newUser).catch(err => logger_1.winstonLogger.error(`[AUTH_PHASE1] Failed to sync create user to Supabase: ${err.message}`));
            await userCache_1.userCache.setUser(newUser);
        }
        this.saveUsers();
        // Fire-and-forget: migrate any guest alarms created before signup to this user
        if (deviceId && (0, supabase_1.isSupabaseConfigured)()) {
            this.migrateGuestAlarms(newUser.id, deviceId).catch(err => logger_1.winstonLogger.warn(`[AUTH_MIGRATION] Guest alarm migration failed for ${newUser.id}: ${err.message}`));
        }
        return {
            user: this.sanitizeUser(newUser),
            tokens: this.generateTokens(newUser),
            ...(referralMeta ? { referralMeta } : {})
        };
    }
    async login(email, password, deviceId, referralCode) {
        const user = await this.getUserByEmail(email);
        if (!user)
            throw new Error('User not found');
        if (user.isBlocked)
            throw new Error('Account has been blocked');
        let isMatch = false;
        if (user.password.startsWith('$2a$') || user.password.startsWith('$2b$') || user.password.startsWith('$2y$')) {
            isMatch = await bcryptjs_1.default.compare(password, user.password);
        }
        else {
            // Legacy plaintext
            isMatch = (user.password === password);
            if (isMatch) {
                // Lazy Migration
                user.password = await bcryptjs_1.default.hash(password, 10);
                // Will be saved later in login flow
            }
        }
        if (!isMatch)
            throw new Error('Invalid credentials');
        // Store device ID for abuse prevention
        if (deviceId) {
            user.deviceId = deviceId;
        }
        // Apply referral code if provided and user doesn't already have a referrer
        let referralMeta;
        const normalizedReferralCode = (referralCode || '').trim().toUpperCase();
        if (normalizedReferralCode && !user.referredBy) {
            const referralResult = await (0, referralService_1.applyReferralCode)(user.id, normalizedReferralCode, deviceId);
            if (referralResult.success) {
                const thirtyMinutesFromNow = new Date(Date.now() + 30 * 60000).toISOString();
                user.splitAccessUntil = thirtyMinutesFromNow;
                user.referredBy = referralResult.data?.referredBy;
                const referrer = await this.getUserById(referralResult.data?.referredBy);
                if (referrer) {
                    referrer.splitAccessUntil = thirtyMinutesFromNow;
                }
                referralMeta = { applied: true, referredBy: referralResult.data?.referredBy };
            }
            else {
                referralMeta = { applied: false, message: referralResult.message };
            }
        }
        // Reset daily usage if needed
        this.resetDailyUsage(user);
        if (isMatch && !user.tokenVersion) {
            user.tokenVersion = 1;
            if ((0, supabase_1.isSupabaseConfigured)()) {
                userRepository_1.userRepository.updateTokenVersion(user.id, 1).catch(err => logger_1.winstonLogger.error(`[AUTH_PHASE1] Failed to sync tokenVersion to Supabase: ${err.message}`));
                await userCache_1.userCache.invalidate(user.id);
            }
        }
        this.updateLocalUser(user);
        this.saveUsers();
        // Fire-and-forget: migrate any guest alarms created before this login to this user
        if (deviceId && (0, supabase_1.isSupabaseConfigured)()) {
            this.migrateGuestAlarms(user.id, deviceId).catch(err => logger_1.winstonLogger.warn(`[AUTH_MIGRATION] Guest alarm migration failed for ${user.id}: ${err.message}`));
        }
        const sanitizedUser = this.sanitizeUser(user);
        return {
            user: sanitizedUser,
            tokens: this.generateTokens(user),
            ...(referralMeta ? { referralMeta } : {})
        };
    }
    async googleLogin(email, fullName, avatarUrl, deviceId, referralCode) {
        let user = await this.getUserByEmail(email);
        let referralMeta;
        if (!user) {
            // Register new user automatically
            const newUserId = crypto_1.default.randomUUID();
            const secureRandomPassword = crypto_1.default.randomBytes(32).toString('hex');
            const hashedPassword = await bcryptjs_1.default.hash(secureRandomPassword, 10);
            const newReferralCode = (0, referralService_1.generateReferralCodeSync)(newUserId);
            const now = new Date().toISOString();
            user = {
                id: newUserId,
                email: email,
                password: hashedPassword,
                referralCode: newReferralCode,
                deviceId: deviceId,
                createdAt: now,
                // Limits
                dailySearchCount: 0,
                dailyPnrCount: 0,
                dailyLiveCount: 0,
                lastUsageReset: now,
                // Monetization
                splitAccessUntil: null,
                planType: 'free',
                planExpiry: null,
                credits: 0,
                aiSplitSearches: 0,
                // Ads
                adsWatchedToday: 0,
                lastAdWatchTime: 0,
                isAdmin: false,
                isBlocked: false,
                tokenVersion: 1,
                fullName: fullName || '',
                avatarUrl: avatarUrl || '',
                mobileVerified: false
            };
            // Referral logic
            const normalizedReferralCode = (referralCode || '').trim().toUpperCase();
            if (normalizedReferralCode) {
                const referralResult = await (0, referralService_1.applyReferralCode)(newUserId, normalizedReferralCode, deviceId);
                if (referralResult.success) {
                    const thirtyMinutesFromNow = new Date(Date.now() + 30 * 60000).toISOString();
                    user.splitAccessUntil = thirtyMinutesFromNow;
                    user.referredBy = referralResult.data?.referredBy;
                    const referrer = await this.getUserById(referralResult.data?.referredBy);
                    if (referrer) {
                        referrer.splitAccessUntil = thirtyMinutesFromNow;
                        this.updateLocalUser(referrer);
                    }
                    referralMeta = { applied: true, referredBy: referralResult.data?.referredBy };
                }
                else {
                    referralMeta = { applied: false, message: referralResult.message };
                }
            }
            this.users.push(user);
            this.saveUsers();
            if ((0, supabase_1.isSupabaseConfigured)()) {
                try {
                    await userRepository_1.userRepository.create(user);
                    await userCache_1.userCache.setUser(user);
                }
                catch (err) {
                    logger_1.winstonLogger.error(`[AUTH_SUPABASE] Failed to create Google user in Supabase: ${err.message}`);
                }
            }
        }
        else {
            if (user.isBlocked)
                throw new Error('Account has been blocked');
            let updated = false;
            if (!user.fullName && fullName) {
                user.fullName = fullName;
                updated = true;
            }
            if (!user.avatarUrl && avatarUrl) {
                user.avatarUrl = avatarUrl;
                updated = true;
            }
            if (deviceId && user.deviceId !== deviceId) {
                user.deviceId = deviceId;
                updated = true;
            }
            if (updated) {
                this.updateLocalUser(user);
                this.saveUsers();
                if ((0, supabase_1.isSupabaseConfigured)()) {
                    userRepository_1.userRepository.update(user.id, {
                        fullName: user.fullName,
                        avatarUrl: user.avatarUrl,
                        deviceId: user.deviceId
                    }).catch(err => logger_1.winstonLogger.error(`[AUTH_SUPABASE] Failed to update Google user info: ${err.message}`));
                    await userCache_1.userCache.invalidate(user.id);
                }
            }
        }
        this.resetDailyUsage(user);
        if (!user.tokenVersion) {
            user.tokenVersion = 1;
            if ((0, supabase_1.isSupabaseConfigured)()) {
                userRepository_1.userRepository.updateTokenVersion(user.id, 1).catch(err => logger_1.winstonLogger.error(`[AUTH_PHASE1] Failed to sync tokenVersion to Supabase: ${err.message}`));
                await userCache_1.userCache.invalidate(user.id);
            }
            this.updateLocalUser(user);
            this.saveUsers();
        }
        if (deviceId && (0, supabase_1.isSupabaseConfigured)()) {
            this.migrateGuestAlarms(user.id, deviceId).catch(err => logger_1.winstonLogger.warn(`[AUTH_MIGRATION] Guest alarm migration failed for ${user.id}: ${err.message}`));
        }
        const sanitizedUser = this.sanitizeUser(user);
        return {
            user: sanitizedUser,
            tokens: this.generateTokens(user),
            ...(referralMeta ? { referralMeta } : {})
        };
    }
    // ─── Guest Alarm Migration ───────────────────────────────────────────────
    // Called non-blocking after every successful login/signup.
    // Moves device-scoped alarms (user_id IS NULL) to the authenticated user_id.
    // Enforces the 3-alarm ceiling: oldest excess alarms are auto-disabled.
    async migrateGuestAlarms(userId, deviceId) {
        try {
            // Step 1: Claim all orphaned device alarms that have no user_id yet
            const { data: migrated, error: migrateErr } = await supabase_1.supabase
                .from('user_station_alarms')
                .update({ user_id: userId, updated_at: new Date().toISOString() })
                .eq('device_id', deviceId)
                .is('user_id', null)
                .select('id, enabled, created_at');
            if (migrateErr) {
                // Table might not exist yet — log at debug and exit silently
                logger_1.winstonLogger.debug(`[AUTH_MIGRATION] user_station_alarms not accessible: ${migrateErr.message}`);
                return;
            }
            const count = migrated?.length ?? 0;
            if (count === 0) {
                return; // Nothing to migrate
            }
            logger_1.winstonLogger.info(`[AUTH_MIGRATION] Migrated ${count} guest alarm(s) from device ${deviceId} to user ${userId}`);
            // Step 2: Enforce 3-alarm ceiling — find all enabled alarms for this user now
            const { data: enabledAlarms, error: fetchErr } = await supabase_1.supabase
                .from('user_station_alarms')
                .select('id, created_at')
                .eq('user_id', userId)
                .eq('enabled', true)
                .order('created_at', { ascending: false }); // Newest first
            if (fetchErr || !enabledAlarms)
                return;
            if (enabledAlarms.length > 3) {
                // Keep the 3 newest; disable the rest
                const toDisable = enabledAlarms.slice(3).map((a) => a.id);
                const { error: disableErr } = await supabase_1.supabase
                    .from('user_station_alarms')
                    .update({ enabled: false, updated_at: new Date().toISOString() })
                    .in('id', toDisable);
                if (disableErr) {
                    logger_1.winstonLogger.warn(`[AUTH_MIGRATION] Could not enforce ceiling for user ${userId}: ${disableErr.message}`);
                }
                else {
                    logger_1.winstonLogger.info(`[AUTH_MIGRATION] Ceiling enforced: disabled ${toDisable.length} excess alarm(s) for user ${userId}`);
                }
            }
        }
        catch (err) {
            // Never throw — migration errors must not break authentication
            logger_1.winstonLogger.warn(`[AUTH_MIGRATION] Unexpected error during guest alarm migration: ${err.message}`);
        }
    }
    generateTokens(user) {
        const jwtSecret = process.env.JWT_SECRET;
        const refreshSecret = process.env.REFRESH_TOKEN_SECRET;
        const payload = {
            userId: user.id,
            email: user.email,
            isAdmin: user.isAdmin,
            tokenVersion: user.tokenVersion || 1,
        };
        // PHASE_4C965 Stage 1: emit sessionEpoch (E) in ACCESS tokens only.
        // Refresh token payload is unchanged (rotation still keyed on tokenVersion/R).
        const accessPayload = { ...payload, sessionEpoch: user.sessionEpoch || 1 };
        // PHASE_4C970 LOGOUT FIX: Access token: 24h (was 2h — still caused silent refresh failures
        // on cross-domain when cookie was missing, leading to 10-15 min logout UX).
        // Refresh token: 30d (unchanged).
        // With refreshToken stored in localStorage (fallback for .com/.online), the interceptor
        // can always recover the session silently without triggering OTP re-login.
        const accessToken = jsonwebtoken_1.default.sign(accessPayload, jwtSecret, { expiresIn: '24h' });
        const refreshToken = jsonwebtoken_1.default.sign(payload, refreshSecret, { expiresIn: '30d' });
        return { accessToken, refreshToken };
    }
    async verifyRefreshToken(token) {
        let decoded;
        try {
            decoded = jsonwebtoken_1.default.verify(token, process.env.REFRESH_TOKEN_SECRET);
        }
        catch {
            throw new Error('Invalid refresh token');
        }
        const userId = decoded.userId;
        if (!userId)
            throw new Error('Invalid refresh token');
        const inFlight = this.refreshLocks.get(userId);
        if (inFlight)
            return inFlight;
        const operation = this.performRefreshRotation(decoded);
        this.refreshLocks.set(userId, operation);
        try {
            return await operation;
        }
        finally {
            if (this.refreshLocks.get(userId) === operation) {
                this.refreshLocks.delete(userId);
            }
        }
    }
    /** P0-010: Validate refresh JWT, rotate tokenVersion, issue new token pair. */
    async performRefreshRotation(decoded) {
        const userId = decoded.userId;
        const user = await this.getUserById(userId);
        if (!user)
            throw new Error('Invalid refresh token');
        if (user.isBlocked)
            throw new Error('Invalid refresh token');
        if ((user.tokenVersion || 1) !== decoded.tokenVersion)
            throw new Error('Invalid refresh token');
        user.tokenVersion = (user.tokenVersion || 1) + 1;
        if ((0, supabase_1.isSupabaseConfigured)()) {
            try {
                await userRepository_1.userRepository.update(userId, { tokenVersion: user.tokenVersion });
            }
            catch (err) {
                logger_1.winstonLogger.error(`[AUTH] verifyRefreshToken: Supabase sync failed for ${userId}: ${err.message}`);
            }
        }
        await userCache_1.userCache.invalidate(userId).catch(() => { });
        this.updateLocalUser(user);
        this.saveUsers();
        return this.generateTokens(user);
    }
    /**
     * Invalidate all tokens for a user by incrementing tokenVersion.
     * Called on logout so existing access tokens are immediately rejected
     * by usageMiddleware (which checks x-token-version on quota-gated routes).
     *
     * Unlike terminateUserSessions(), this applies to ALL users including admins,
     * and returns void (callers don't need a success boolean for logout).
     */
    async invalidateUserTokens(userId) {
        const user = await this.getUserById(userId);
        if (!user)
            return;
        user.tokenVersion = (user.tokenVersion || 1) + 1;
        user.sessionEpoch = (user.sessionEpoch || 1) + 1; // PHASE_4C965: bump access epoch (E) alongside R
        if ((0, supabase_1.isSupabaseConfigured)()) {
            try {
                await userRepository_1.userRepository.update(userId, { tokenVersion: user.tokenVersion, sessionEpoch: user.sessionEpoch });
            }
            catch (err) {
                logger_1.winstonLogger.error(`[AUTH] invalidateUserTokens: Supabase sync failed for ${userId}: ${err.message}`);
                // Non-fatal — in-memory state is updated; Supabase will sync on next user load
            }
        }
        await userCache_1.userCache.invalidate(userId).catch(() => { });
        this.updateLocalUser(user);
        this.saveUsers();
    }
    verifyBetaCode(code) {
        const validCodes = (process.env.BETA_CODES || 'TRAYAGO-BETA,TESTER-PRO,FOUNDING-USER').split(',').map(c => c.trim().toUpperCase());
        return !!code && validCodes.includes(code.trim().toUpperCase());
    }
    userBypassesQuota(user) {
        if (user.isAdmin === true || user.planType === 'admin') {
            // Self-heal: ensure planType is always 'admin' for admin users so the
            // frontend gate (planType === 'admin') also passes without an explicit DB fix.
            if (user.isAdmin === true && user.planType !== 'admin') {
                user.planType = 'admin';
                this.updateLocalUser(user);
                this.saveUsers();
            }
            return true;
        }
        return false;
    }
    isProPlanActive(user) {
        if (this.userBypassesQuota(user) || user.planType === 'paid')
            return true; // Legacy support
        if (user.planType === 'beta') {
            if (!user.planExpiry || new Date() < new Date(user.planExpiry)) {
                return true;
            }
            else {
                // Expired Beta Access
                user.planType = 'free';
                user.planExpiry = null;
                if ((0, supabase_1.isSupabaseConfigured)()) {
                    userRepository_1.userRepository.update(user.id, { planType: 'free', planExpiry: null }).catch(err => logger_1.winstonLogger.error(`[AUTH_PHASE1] Failed to sync expired beta downgrade to Supabase: ${err.message}`));
                    userCache_1.userCache.invalidate(user.id).catch(err => logger_1.winstonLogger.error(`[AUTH_PHASE2B] Failed to invalidate cache on expired beta: ${err.message}`));
                }
                this.updateLocalUser(user);
                this.saveUsers();
                return false;
            }
        }
        if (user.planType.startsWith('safar_pro') && user.planExpiry) {
            if (new Date() < new Date(user.planExpiry)) {
                return true;
            }
            else {
                // Expired
                user.planType = 'free';
                user.planExpiry = null;
                if ((0, supabase_1.isSupabaseConfigured)()) {
                    userRepository_1.userRepository.update(user.id, { planType: 'free', planExpiry: null }).catch(err => logger_1.winstonLogger.error(`[AUTH_PHASE1] Failed to sync expired safar_pro downgrade to Supabase: ${err.message}`));
                    userCache_1.userCache.invalidate(user.id).catch(err => logger_1.winstonLogger.error(`[AUTH_PHASE2B] Failed to invalidate cache on expired safar_pro: ${err.message}`));
                }
                this.updateLocalUser(user);
                this.saveUsers();
                return false;
            }
        }
        return false;
    }
    async upgradeToPro(userId, planId, durationMinutes, source = 'admin') {
        const user = await this.getUserById(userId);
        if (!user)
            return false;
        const now = new Date();
        const activatedAt = now.toISOString();
        let baseDate = new Date();
        if (user.planExpiry) {
            const currentExpiry = new Date(user.planExpiry);
            if (currentExpiry > baseDate) {
                baseDate = currentExpiry;
            }
        }
        baseDate.setMinutes(baseDate.getMinutes() + durationMinutes);
        user.planType = planId;
        user.planExpiry = baseDate.toISOString();
        user.lastSubscriptionDate = activatedAt;
        // Phase 1: Dual-write hook
        if ((0, supabase_1.isSupabaseConfigured)()) {
            userRepository_1.userRepository.update(userId, { planType: planId, planExpiry: user.planExpiry, lastSubscriptionDate: user.lastSubscriptionDate }).catch(err => logger_1.winstonLogger.error(`[AUTH_PHASE1] Failed to sync upgradeToPro to Supabase: ${err.message}`));
            // Write to subscription_history
            supabase_1.supabase.from('subscription_history').insert([{
                    user_id: userId,
                    source: source,
                    plan_type: planId,
                    duration_days: Math.round(durationMinutes / 1440),
                    activated_at: activatedAt,
                    expires_at: user.planExpiry
                }]).then(({ error }) => {
                if (error) {
                    logger_1.winstonLogger.error(`[AUTH_PHASE1] Failed to persist subscription_history: ${error.message}`);
                }
            });
            await userCache_1.userCache.invalidate(userId);
        }
        this.updateLocalUser(user);
        this.saveUsers();
        return true;
    }
    async getEffectiveLimit(userId, planType, type) {
        // 1. Fallback if Supabase is down or not configured
        if (!(0, supabase_1.isSupabaseConfigured)()) {
            if (!userId) {
                if (type === 'search')
                    return 2;
                if (type === 'pnr')
                    return 2;
                return 1; // live
            }
            if (type === 'search')
                return 5;
            if (type === 'pnr')
                return 3;
            return 3; // live
        }
        try {
            // 2. Fetch User-Specific Override
            if (userId) {
                const cacheKey = `quota_override:${userId}`;
                let override = cacheService_1.cacheService.get(cacheKey);
                if (override === undefined) {
                    override = await quotaRepository_1.quotaRepository.getOverride(userId);
                    cacheService_1.cacheService.set(cacheKey, override || null, 300); // 5 minutes cache
                }
                if (override) {
                    if (type === 'search' && override.custom_searches_limit !== null) {
                        return override.custom_searches_limit;
                    }
                    if (type === 'pnr' && override.custom_pnr_limit !== null) {
                        return override.custom_pnr_limit;
                    }
                    if (type === 'live' && override.custom_live_limit !== null) {
                        return override.custom_live_limit;
                    }
                }
            }
            // 3. Fetch Plan Profile Default
            const profileCacheKey = `quota_profile:${planType}`;
            let profile = cacheService_1.cacheService.get(profileCacheKey);
            if (profile === undefined) {
                profile = await quotaRepository_1.quotaRepository.getProfile(planType);
                cacheService_1.cacheService.set(profileCacheKey, profile || null, 1800); // 30 minutes cache
            }
            if (profile) {
                if (type === 'search')
                    return profile.searches_limit;
                if (type === 'pnr')
                    return profile.pnr_limit;
                if (type === 'live')
                    return profile.live_limit;
            }
        }
        catch (err) {
            logger_1.winstonLogger.error(`[QUOTA_RESOLVER_ERROR] Failed to resolve dynamic limit: ${err.message}`);
        }
        // 4. Default Hardcoded Fallbacks
        if (!userId) {
            if (type === 'search')
                return 2;
            if (type === 'pnr')
                return 2;
            return 1; // live
        }
        if (type === 'search')
            return 5;
        if (type === 'pnr')
            return 3;
        return 3; // live
    }
    verifyDeviceIpBinding(ip, deviceId) {
        const today = new Date().toISOString().split('T')[0];
        if (this.ipGuestDevicesDate !== today) {
            this.ipGuestDevices.clear();
            this.ipGuestDevicesDate = today;
        }
        if (!this.ipGuestDevices.has(ip)) {
            this.ipGuestDevices.set(ip, new Set());
        }
        const devices = this.ipGuestDevices.get(ip);
        // Allow if already tracked
        if (devices.has(deviceId))
            return true;
        // Reject if at/over limit
        if (devices.size >= this.IP_DEVICE_LIMIT) {
            logger_1.winstonLogger.warn(`[GUEST_SECURITY] IP ${ip} exceeded guest device limit (${this.IP_DEVICE_LIMIT}). Rejected deviceId: ${deviceId}`);
            return false;
        }
        // Add new device
        devices.add(deviceId);
        return true;
    }
    betaHeaderGrantsUnlimited(userId, betaCode, feature) {
        if (!betaCode)
            return false;
        if (betaService_1.betaService.hasUnlimitedAccess(betaCode, feature))
            return true;
        if (userId && betaService_1.betaService.hasRedeemedCode(userId, betaCode)) {
            return betaService_1.betaService.hasUnlimitedAccess(betaCode, feature);
        }
        return false;
    }
    async userHasActiveProSubscription(userId) {
        const user = await this.getUserById(userId);
        if (!user)
            return false;
        return this.isProPlanActive(user);
    }
    async canUseFeature(userId, type, betaCode, deviceId) {
        if (userId && betaService_1.betaService.hasActiveRedemption(userId))
            return true;
        if (this.betaHeaderGrantsUnlimited(userId, betaCode, type))
            return true;
        // GUEST LOGIC
        if (!userId) {
            if (!deviceId)
                return false;
            const guest = this.getOrCreateGuest(deviceId);
            // implicit reset removed
            const limit = await this.getEffectiveLimit(null, 'guest', type);
            switch (type) {
                case 'search': return guest.dailySearchCount < limit;
                case 'pnr': return guest.dailyPnrCount < limit;
                case 'live': return guest.dailyLiveCount < limit;
                default: return false;
            }
        }
        // LOGGED IN USER LOGIC
        const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
        if (!userId || !UUID_REGEX.test(userId)) {
            return false; // Do not recover users under legacy non-UUID identifiers
        }
        let user = await this.getUserById(userId);
        if (!user) {
            // Ephemeral storage recovery: if Render restarts and wipes users.json,
            // but the frontend still has the valid userId in localStorage, recover them!
            user = {
                id: userId,
                email: 'recovered@trayago.in', // Placeholder since we lost the original email
                password: '',
                referralCode: '',
                createdAt: new Date().toISOString(),
                dailySearchCount: 0,
                dailyPnrCount: 0,
                dailyLiveCount: 0,
                lastUsageReset: new Date().toISOString().split('T')[0],
                splitAccessUntil: null,
                planType: 'free',
                planExpiry: null,
                isAdmin: false,
                credits: 0,
                aiSplitSearches: 0,
                adsWatchedToday: 0,
                lastAdWatchTime: 0
            };
            this.users.push(user);
            this.saveUsers();
        }
        if (user.isBlocked)
            return false;
        // Admin / beta / premium — never enforce daily caps
        if (this.userBypassesQuota(user) || this.isProPlanActive(user))
            return true;
        // implicit reset removed
        // Check limits
        const limit = await this.getEffectiveLimit(userId, user.planType, type);
        switch (type) {
            case 'search': return user.dailySearchCount < limit;
            case 'pnr': return user.dailyPnrCount < limit;
            case 'live': return user.dailyLiveCount < limit;
            default: return false;
        }
    }
    async canUseSplit(userId, betaCode) {
        if (userId && betaService_1.betaService.hasActiveRedemption(userId))
            return true;
        if (this.betaHeaderGrantsUnlimited(userId, betaCode, 'split'))
            return true;
        if (!userId)
            return false; // Guests cannot use split
        const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
        if (!UUID_REGEX.test(userId))
            return false;
        let user = await this.getUserById(userId);
        if (!user) {
            user = {
                id: userId,
                email: 'recovered@trayago.in',
                password: '',
                referralCode: '',
                createdAt: new Date().toISOString(),
                dailySearchCount: 0,
                dailyPnrCount: 0,
                dailyLiveCount: 0,
                lastUsageReset: new Date().toISOString().split('T')[0],
                splitAccessUntil: null,
                planType: 'free',
                planExpiry: null,
                isAdmin: false,
                credits: 0,
                aiSplitSearches: 0,
                adsWatchedToday: 0,
                lastAdWatchTime: 0
            };
            this.users.push(user);
            this.saveUsers();
        }
        if (user.isBlocked)
            return false;
        if (this.userBypassesQuota(user) || this.isProPlanActive(user))
            return true;
        // Check if user has temporary split access
        if (user.splitAccessUntil && new Date(user.splitAccessUntil).getTime() > Date.now()) {
            return true;
        }
        return false;
    }
    async incrementUsage(userId, type, betaCode) {
        if (userId && betaService_1.betaService.hasActiveRedemption(userId))
            return true;
        if (this.betaHeaderGrantsUnlimited(userId, betaCode, type))
            return true;
        if (!userId)
            return false; // Handled by incrementGuestUsage now
        const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
        if (!UUID_REGEX.test(userId))
            return false;
        let user = await this.getUserById(userId);
        if (!user) {
            user = {
                id: userId,
                email: 'recovered@trayago.in',
                password: '',
                referralCode: '',
                createdAt: new Date().toISOString(),
                dailySearchCount: 0,
                dailyPnrCount: 0,
                dailyLiveCount: 0,
                lastUsageReset: new Date().toISOString().split('T')[0],
                splitAccessUntil: null,
                planType: 'free',
                planExpiry: null,
                isAdmin: false,
                credits: 0,
                aiSplitSearches: 0,
                adsWatchedToday: 0,
                lastAdWatchTime: 0
            };
            this.users.push(user);
            this.saveUsers();
        }
        // Admins and Premium Users have unlimited access (do not increment capped usage)
        if (this.isProPlanActive(user))
            return true;
        // implicit reset removed
        // Increment usage
        const limit = await this.getEffectiveLimit(userId, user.planType, type);
        switch (type) {
            case 'search':
                if (user.dailySearchCount < limit) {
                    user.dailySearchCount++;
                    this.updateLocalUser(user);
                    if ((0, supabase_1.isSupabaseConfigured)()) {
                        userRepository_1.userRepository.incrementUsage(user.id, 'searches').catch(e => logger_1.winstonLogger.error(`[AUTH_PHASE1] Dual-write error: ${e.message}`));
                        await userCache_1.userCache.invalidate(user.id);
                    }
                    this.saveUsers();
                    return true;
                }
                break;
            case 'pnr':
                if (user.dailyPnrCount < limit) {
                    user.dailyPnrCount++;
                    this.updateLocalUser(user);
                    if ((0, supabase_1.isSupabaseConfigured)()) {
                        userRepository_1.userRepository.incrementUsage(user.id, 'pnr').catch(e => logger_1.winstonLogger.error(`[AUTH_PHASE1] Dual-write error: ${e.message}`));
                        await userCache_1.userCache.invalidate(user.id);
                    }
                    this.saveUsers();
                    return true;
                }
                break;
            case 'live':
                if (user.dailyLiveCount < limit) {
                    user.dailyLiveCount++;
                    this.updateLocalUser(user);
                    if ((0, supabase_1.isSupabaseConfigured)()) {
                        userRepository_1.userRepository.incrementUsage(user.id, 'live').catch(e => logger_1.winstonLogger.error(`[AUTH_PHASE1] Dual-write error: ${e.message}`));
                        await userCache_1.userCache.invalidate(user.id);
                    }
                    this.saveUsers();
                    return true;
                }
                break;
        }
        return false;
    }
    async incrementGuestUsage(deviceId, type) {
        const guest = this.getOrCreateGuest(deviceId);
        // implicit reset removed
        const limit = await this.getEffectiveLimit(null, 'guest', type);
        switch (type) {
            case 'search':
                if (guest.dailySearchCount < limit) {
                    guest.dailySearchCount++;
                    this.saveGuests();
                    return true;
                }
                break;
            case 'pnr':
                if (guest.dailyPnrCount < limit) {
                    guest.dailyPnrCount++;
                    this.saveGuests();
                    return true;
                }
                break;
            case 'live':
                if (guest.dailyLiveCount < limit) {
                    guest.dailyLiveCount++;
                    this.saveGuests();
                    return true;
                }
                break;
        }
        return false;
    }
    async watchAd(userId, deviceId) {
        const entity = userId ? await this.getUserById(userId) : this.getOrCreateGuest(deviceId);
        if (!entity)
            return { success: false, message: "Account not found" };
        this.resetDailyUsage(entity);
        if ((entity.adsWatchedToday || 0) >= 5) {
            return { success: false, message: "Daily ad limit reached (5/5). Please upgrade to PRO." };
        }
        const now = Date.now();
        const cooldownMinutes = 5;
        if (entity.lastAdWatchTime && (now - entity.lastAdWatchTime) < cooldownMinutes * 60000) {
            return { success: false, message: `Please wait ${cooldownMinutes} minutes between ads.` };
        }
        // Reward: -1 to daily search count to grant 1 extra search!
        entity.adsWatchedToday = (entity.adsWatchedToday || 0) + 1;
        entity.lastAdWatchTime = now;
        if (entity.dailySearchCount > 0) {
            entity.dailySearchCount--; // Effectively gives +1 search
        }
        if (userId)
            this.saveUsers();
        else
            this.saveGuests();
        return { success: true, message: "Ad watched successfully! +1 Search granted." };
    }
    async getUserStatus(userId, betaCode, deviceId) {
        const isBeta = betaCode ? betaService_1.betaService.isValidCode(betaCode) : false;
        if (!userId) {
            if (isBeta) {
                return {
                    id: 'beta-tester',
                    email: 'beta-tester@trayago.in',
                    isAdmin: false,
                    isBeta: true,
                    planType: 'beta',
                    hasSplitAccess: true,
                    splitMinutesLeft: 9999,
                    usage: { searches: 0, pnr: 0, live: 0 },
                    limits: { searches: 9999, pnr: 9999, live: 9999 },
                    warnings: { searches: false, pnr: false, live: false },
                    adsWatchedToday: 0
                };
            }
            if (deviceId) {
                const guest = this.getOrCreateGuest(deviceId);
                // implicit reset removed
                const searchLimit = await this.getEffectiveLimit(null, 'guest', 'search');
                const pnrLimit = await this.getEffectiveLimit(null, 'guest', 'pnr');
                const liveLimit = await this.getEffectiveLimit(null, 'guest', 'live');
                return {
                    id: 'guest',
                    email: 'Guest',
                    isGuest: true,
                    usage: {
                        searches: guest.dailySearchCount,
                        pnr: guest.dailyPnrCount,
                        live: guest.dailyLiveCount
                    },
                    limits: { searches: searchLimit, pnr: pnrLimit, live: liveLimit },
                    warnings: {
                        searches: (guest.dailySearchCount / searchLimit) >= 0.80,
                        pnr: (guest.dailyPnrCount / pnrLimit) >= 0.80,
                        live: (guest.dailyLiveCount / liveLimit) >= 0.80
                    },
                    adsWatchedToday: guest.adsWatchedToday,
                    hasSplitAccess: false
                };
            }
            return null;
        }
        const user = await this.getUserById(userId);
        if (!user)
            return null;
        // Check expiry
        this.isProPlanActive(user); // Triggers downgrade if expired
        // implicit reset removed
        const isBetaUser = isBeta ||
            user.planType === 'beta' ||
            betaService_1.betaService.hasActiveRedemption(userId);
        const isUnlimited = isBetaUser || this.userBypassesQuota(user);
        const hasSplitAccess = isUnlimited || (await this.canUseSplit(userId, betaCode));
        let splitMinutesLeft = 0;
        if (hasSplitAccess && user.splitAccessUntil && !isUnlimited && !this.isProPlanActive(user)) {
            splitMinutesLeft = Math.max(0, Math.floor((new Date(user.splitAccessUntil).getTime() - Date.now()) / 60000));
        }
        else if (isUnlimited || this.isProPlanActive(user)) {
            splitMinutesLeft = 9999;
        }
        const searchLimit = isUnlimited ? 9999 : await this.getEffectiveLimit(userId, user.planType, 'search');
        const pnrLimit = isUnlimited ? 9999 : await this.getEffectiveLimit(userId, user.planType, 'pnr');
        const liveLimit = isUnlimited ? 9999 : await this.getEffectiveLimit(userId, user.planType, 'live');
        let threshold = 0.80;
        if ((0, supabase_1.isSupabaseConfigured)() && !isBetaUser) {
            try {
                const profileCacheKey = `quota_profile:${user.planType}`;
                let profile = cacheService_1.cacheService.get(profileCacheKey);
                if (profile === undefined) {
                    profile = await quotaRepository_1.quotaRepository.getProfile(user.planType);
                    cacheService_1.cacheService.set(profileCacheKey, profile || null, 1800);
                }
                if (profile && profile.warning_threshold) {
                    threshold = Number(profile.warning_threshold);
                }
            }
            catch (e) { }
        }
        // Mathematical sanitization check: Math.max(0, count) prevents negative usage metrics display on UI
        const usageSearches = Math.max(0, user.dailySearchCount);
        const usagePnr = Math.max(0, user.dailyPnrCount);
        const usageLive = Math.max(0, user.dailyLiveCount);
        let profileCompletionPercentage = 40;
        if (user.fullName && user.fullName.trim().length >= 2 && /^[a-zA-Z\s]+$/.test(user.fullName)) {
            profileCompletionPercentage += 20;
        }
        if (user.mobileNumber && /^(?:\+91|91)?[6-9]\d{9}$/.test(user.mobileNumber)) {
            profileCompletionPercentage += 20;
        }
        if (user.dob && !isNaN(Date.parse(user.dob)) && new Date(user.dob) < new Date()) {
            profileCompletionPercentage += 20;
        }
        return {
            id: user.id,
            email: user.email,
            referralCode: user.referralCode,
            isAdmin: user.isAdmin,
            isBeta: isBetaUser,
            planType: user.planType,
            planExpiry: user.planExpiry,
            hasSplitAccess,
            splitMinutesLeft,
            usage: {
                searches: usageSearches,
                pnr: usagePnr,
                live: usageLive
            },
            limits: {
                searches: searchLimit,
                pnr: pnrLimit,
                live: liveLimit
            },
            warnings: {
                searches: !isUnlimited && (usageSearches / searchLimit) >= threshold,
                pnr: !isUnlimited && (usagePnr / pnrLimit) >= threshold,
                live: !isUnlimited && (usageLive / liveLimit) >= threshold
            },
            bypassQuota: isUnlimited,
            adsWatchedToday: user.adsWatchedToday,
            profileCompletionPercentage
        };
    }
    checkDeviceLock(deviceId, userId = null) {
        // Check if this device is already associated with another account
        const otherUser = this.users.find(u => u.deviceId === deviceId && u.id !== userId);
        return !!otherUser;
    }
    async updateUserProfile(userId, updates) {
        const user = await this.getUserById(userId);
        if (!user)
            throw new Error('User not found');
        if (updates.fullName !== undefined)
            user.fullName = updates.fullName;
        if (updates.dob !== undefined)
            user.dob = updates.dob;
        if (updates.preferences !== undefined) {
            if (updates.preferences.notifyEmail !== undefined)
                user.notifyEmail = !!updates.preferences.notifyEmail;
            if (updates.preferences.notifyBirthday !== undefined)
                user.notifyBirthday = !!updates.preferences.notifyBirthday;
            if (updates.preferences.notifyMarketing !== undefined)
                user.notifyMarketing = !!updates.preferences.notifyMarketing;
        }
        if (updates.mobileNumber !== undefined) {
            if (updates.mobileNumber !== user.mobileNumber) {
                user.mobileNumber = updates.mobileNumber;
                user.mobileVerified = false;
                user.mobileVerificationMethod = null;
                user.mobileVerifiedAt = null;
            }
        }
        if ((0, supabase_1.isSupabaseConfigured)()) {
            try {
                await userRepository_1.userRepository.update(userId, {
                    fullName: user.fullName,
                    dob: user.dob,
                    mobileNumber: user.mobileNumber,
                    mobileVerified: user.mobileVerified,
                    mobileVerificationMethod: user.mobileVerificationMethod,
                    mobileVerifiedAt: user.mobileVerifiedAt
                });
            }
            catch (err) {
                logger_1.winstonLogger.error(`[AUTH_SUPABASE] Failed to sync updateUserProfile to Supabase: ${err.message}`);
                throw new Error(`Profile persistence failed: ${err.message}`);
            }
            await userCache_1.userCache.invalidate(userId);
        }
        this.updateLocalUser(user);
        this.saveUsers();
        return user;
    }
    async sendMobileOtp(userId, mobileNumber) {
        const user = await this.getUserById(userId);
        if (!user)
            throw new Error('User not found');
        // Check if mobile number is already verified on another account
        const existing = this.users.find(u => u.mobileNumber === mobileNumber && u.mobileVerified && u.id !== userId);
        if (existing)
            throw new Error('Mobile number already verified on another account');
        // Generate 6-digit OTP code
        const otp = Math.floor(100000 + Math.random() * 900000).toString();
        this.mobileOtps[userId] = {
            otp,
            mobileNumber,
            expiresAt: Date.now() + 5 * 60 * 1000, // 5 minutes expiry
            attempts: 0
        };
        const { smsService } = await Promise.resolve().then(() => __importStar(require('./smsService')));
        const sent = await smsService.sendSmsOtp(mobileNumber, otp);
        if (!sent)
            throw new Error('Failed to send SMS OTP. Please try again.');
        return true;
    }
    async verifyMobileOtp(userId, otpCode) {
        const user = await this.getUserById(userId);
        if (!user)
            throw new Error('User not found');
        const record = this.mobileOtps[userId];
        if (!record)
            throw new Error('No OTP sent for this user');
        if (Date.now() > record.expiresAt) {
            delete this.mobileOtps[userId];
            throw new Error('OTP has expired. Please request a new one.');
        }
        record.attempts += 1;
        if (record.attempts > 5) {
            delete this.mobileOtps[userId];
            throw new Error('Too many failed attempts. Please request a new OTP.');
        }
        if (record.otp !== otpCode) {
            throw new Error('Invalid verification code');
        }
        // Success! Update user status
        user.mobileNumber = record.mobileNumber;
        user.mobileVerified = true;
        user.mobileVerificationMethod = 'SMS';
        user.mobileVerifiedAt = new Date().toISOString();
        // Consume OTP
        delete this.mobileOtps[userId];
        // Sync to Supabase & save locally
        if ((0, supabase_1.isSupabaseConfigured)()) {
            try {
                await userRepository_1.userRepository.update(userId, {
                    mobileNumber: user.mobileNumber,
                    mobileVerified: user.mobileVerified,
                    mobileVerificationMethod: user.mobileVerificationMethod,
                    mobileVerifiedAt: user.mobileVerifiedAt
                });
            }
            catch (err) {
                logger_1.winstonLogger.error(`[AUTH_SUPABASE] Failed to sync mobile verification to Supabase: ${err.message}`);
            }
            await userCache_1.userCache.invalidate(userId);
        }
        this.updateLocalUser(user);
        this.saveUsers();
        return true;
    }
    sanitizeUser(user) {
        const { password, ...rest } = user;
        return rest;
    }
}
exports.AuthService = AuthService;
exports.authService = new AuthService();
