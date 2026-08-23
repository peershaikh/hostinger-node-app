"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.userRepository = exports.DatabaseError = void 0;
const supabase_1 = require("../config/supabase");
const logger_1 = require("../middleware/logger");
class DatabaseError extends Error {
    constructor(code, message) {
        super(message);
        this.code = code;
        this.name = 'DatabaseError';
    }
}
exports.DatabaseError = DatabaseError;
const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
class UserRepository {
    mapToDB(user) {
        const payload = {};
        if (user.email !== undefined)
            payload.email = user.email;
        if (user.password !== undefined)
            payload.password = user.password;
        if (user.fullName !== undefined)
            payload.full_name = user.fullName;
        if (user.mobileNumber !== undefined)
            payload.phone = user.mobileNumber;
        if (user.referralCode !== undefined)
            payload.referral_code = user.referralCode;
        if (user.referredBy !== undefined)
            payload.referred_by = user.referredBy;
        if (user.tokenVersion !== undefined)
            payload.token_version = user.tokenVersion;
        if (user.isAdmin !== undefined)
            payload.role = user.isAdmin ? 'admin' : 'user';
        if (user.mobileVerified !== undefined)
            payload.is_verified = user.mobileVerified;
        return payload;
    }
    mapToApp(dbUser) {
        const isAdmin = dbUser.role === 'admin' || dbUser.is_admin === true || dbUser.isAdmin === true;
        const planType = isAdmin ? 'admin' : (dbUser.plan_type || dbUser.planType || 'free');
        return {
            id: dbUser.id,
            email: dbUser.email,
            password: dbUser.password,
            referralCode: dbUser.referral_code || dbUser.referralCode,
            referredBy: dbUser.referred_by || dbUser.referredBy,
            deviceId: dbUser.device_id || dbUser.deviceId,
            createdAt: dbUser.created_at || dbUser.createdAt,
            dailySearchCount: dbUser.daily_search_count ?? dbUser.dailySearchCount ?? 0,
            dailyPnrCount: dbUser.daily_pnr_count ?? dbUser.dailyPnrCount ?? 0,
            dailyLiveCount: dbUser.daily_live_count ?? dbUser.dailyLiveCount ?? 0,
            lastUsageReset: dbUser.last_usage_reset || dbUser.lastUsageReset,
            splitAccessUntil: dbUser.split_access_until || dbUser.splitAccessUntil || null,
            planType: planType,
            planExpiry: dbUser.plan_expiry || dbUser.planExpiry || null,
            lastSubscriptionDate: dbUser.last_subscription_date || dbUser.lastSubscriptionDate || null,
            credits: dbUser.credits ?? 0,
            aiSplitSearches: dbUser.ai_split_searches ?? dbUser.aiSplitSearches ?? 0,
            adsWatchedToday: dbUser.ads_watched_today ?? dbUser.adsWatchedToday ?? 0,
            lastAdWatchTime: dbUser.last_ad_watch_time ?? dbUser.lastAdWatchTime ?? 0,
            isAdmin: isAdmin,
            isBlocked: dbUser.is_blocked ?? dbUser.isBlocked ?? false,
            tokenVersion: dbUser.token_version ?? dbUser.tokenVersion ?? 1,
            sessionEpoch: dbUser.session_epoch ?? dbUser.sessionEpoch ?? 1,
            fullName: dbUser.full_name || dbUser.fullName || '',
            mobileNumber: dbUser.mobile_number || dbUser.mobileNumber || '',
            dob: dbUser.dob || dbUser.dob || '',
            avatarUrl: dbUser.avatar_url || dbUser.avatarUrl || '',
            notifyEmail: dbUser.notify_email ?? dbUser.notifyEmail ?? true,
            notifyBirthday: dbUser.notify_birthday ?? dbUser.notifyBirthday ?? true,
            notifyMarketing: dbUser.notify_marketing ?? dbUser.notifyMarketing ?? true,
            mobileVerified: dbUser.mobile_verified ?? dbUser.mobileVerified ?? false,
            mobileVerificationMethod: dbUser.mobile_verification_method || dbUser.mobileVerificationMethod || null,
            mobileVerifiedAt: dbUser.mobile_verified_at || dbUser.mobileVerifiedAt || null,
            birthdayRewardLastClaimedYear: dbUser.birthday_reward_last_claimed_year || dbUser.birthdayRewardLastClaimedYear || null
        };
    }
    async findById(id) {
        if (!(0, supabase_1.isSupabaseConfigured)())
            return null;
        if (!id || !UUID_REGEX.test(id))
            return null;
        try {
            const { data, error } = await supabase_1.supabase.from('users').select('*').eq('id', id).single();
            if (error) {
                if (error.code === 'PGRST116')
                    return null; // Not found
                throw new DatabaseError(error.code, error.message);
            }
            return data ? this.mapToApp(data) : null;
        }
        catch (err) {
            if (err instanceof DatabaseError)
                throw err;
            throw new DatabaseError('UNKNOWN', err.message || 'Failed to fetch user by ID');
        }
    }
    async findByEmail(email) {
        if (!(0, supabase_1.isSupabaseConfigured)())
            return null;
        try {
            const { data, error } = await supabase_1.supabase.from('users').select('*').eq('email', email).single();
            if (error) {
                if (error.code === 'PGRST116')
                    return null; // Not found
                throw new DatabaseError(error.code, error.message);
            }
            return data ? this.mapToApp(data) : null;
        }
        catch (err) {
            if (err instanceof DatabaseError)
                throw err;
            throw new DatabaseError('UNKNOWN', err.message || 'Failed to fetch user by Email');
        }
    }
    async create(user) {
        if (!(0, supabase_1.isSupabaseConfigured)()) {
            throw new DatabaseError('NOT_CONFIGURED', 'Supabase not configured');
        }
        try {
            const payload = this.mapToDB(user);
            const { data, error } = await supabase_1.supabase.from('users').insert(payload).select().single();
            if (error)
                throw new DatabaseError(error.code, error.message);
            return this.mapToApp(data);
        }
        catch (err) {
            if (err instanceof DatabaseError)
                throw err;
            throw new DatabaseError('UNKNOWN', err.message || 'Failed to create user');
        }
    }
    async update(id, updates) {
        if (!(0, supabase_1.isSupabaseConfigured)()) {
            throw new DatabaseError('NOT_CONFIGURED', 'Supabase not configured');
        }
        if (!id || !UUID_REGEX.test(id)) {
            throw new DatabaseError('INVALID_UUID', 'Invalid user ID format');
        }
        try {
            const payload = this.mapToDB(updates);
            const { data, error } = await supabase_1.supabase.from('users').update(payload).eq('id', id).select().single();
            if (error) {
                const isMissingColumn = error.message?.includes('column') && (error.message?.includes('avatar_url') ||
                    error.message?.includes('mobile_number') ||
                    error.message?.includes('mobile_verified') ||
                    error.message?.includes('mobile_verification_method') ||
                    error.message?.includes('mobile_verified_at'));
                if (isMissingColumn) {
                    logger_1.winstonLogger.warn(`[AUTH_SUPABASE] Resilient Column Warning: Column does not exist on remote database: ${error.message}. Proceeding with local file persistence fallback.`);
                    return { id, ...updates };
                }
                throw new DatabaseError(error.code, error.message);
            }
            return this.mapToApp(data);
        }
        catch (err) {
            if (err instanceof DatabaseError)
                throw err;
            throw new DatabaseError('UNKNOWN', err.message || 'Failed to update user');
        }
    }
    async incrementUsage(id, feature) {
        if (!(0, supabase_1.isSupabaseConfigured)()) {
            throw new DatabaseError('NOT_CONFIGURED', 'Supabase not configured');
        }
        if (!id || !UUID_REGEX.test(id))
            return;
        try {
            let column = '';
            if (feature === 'searches')
                column = 'daily_search_count';
            else if (feature === 'pnr')
                column = 'daily_pnr_count';
            else if (feature === 'live')
                column = 'daily_live_count';
            const { data: user, error: fetchErr } = await supabase_1.supabase.from('users').select(column).eq('id', id).single();
            if (fetchErr)
                throw new DatabaseError(fetchErr.code, fetchErr.message);
            const payload = { [column]: (user[column] || 0) + 1 };
            const { error: updateErr } = await supabase_1.supabase.from('users').update(payload).eq('id', id);
            if (updateErr)
                throw new DatabaseError(updateErr.code, updateErr.message);
        }
        catch (err) {
            if (err instanceof DatabaseError)
                throw err;
            throw new DatabaseError('UNKNOWN', err.message || 'Failed to increment usage');
        }
    }
    async getAllUsers() {
        if (!(0, supabase_1.isSupabaseConfigured)()) {
            throw new DatabaseError('NOT_CONFIGURED', 'Supabase not configured');
        }
        try {
            const { data, error } = await supabase_1.supabase.from('users').select('*');
            if (error)
                throw new DatabaseError(error.code, error.message);
            return data ? data.map(dbUser => this.mapToApp(dbUser)) : [];
        }
        catch (err) {
            if (err instanceof DatabaseError)
                throw err;
            throw new DatabaseError('UNKNOWN', err.message || 'Failed to fetch all users');
        }
    }
    async getUsersCount() {
        if (!(0, supabase_1.isSupabaseConfigured)()) {
            throw new DatabaseError('NOT_CONFIGURED', 'Supabase not configured');
        }
        try {
            const { count, error } = await supabase_1.supabase.from('users').select('*', { count: 'exact', head: true });
            if (error)
                throw new DatabaseError(error.code, error.message);
            return count || 0;
        }
        catch (err) {
            if (err instanceof DatabaseError)
                throw err;
            throw new DatabaseError('UNKNOWN', err.message || 'Failed to fetch users count');
        }
    }
    async getActiveUsersToday() {
        if (!(0, supabase_1.isSupabaseConfigured)()) {
            throw new DatabaseError('NOT_CONFIGURED', 'Supabase not configured');
        }
        try {
            const today = new Date().toISOString().split('T')[0];
            const { count, error } = await supabase_1.supabase.from('users').select('*', { count: 'exact', head: true })
                .gte('last_usage_reset', today);
            if (error)
                throw new DatabaseError(error.code, error.message);
            return count || 0;
        }
        catch (err) {
            if (err instanceof DatabaseError)
                throw err;
            throw new DatabaseError('UNKNOWN', err.message || 'Failed to fetch active users today');
        }
    }
    async updateTokenVersion(id, newVersion) {
        if (!(0, supabase_1.isSupabaseConfigured)()) {
            throw new DatabaseError('NOT_CONFIGURED', 'Supabase not configured');
        }
        if (!id || !UUID_REGEX.test(id))
            return;
        try {
            const { error } = await supabase_1.supabase.from('users').update({ token_version: newVersion }).eq('id', id);
            if (error)
                throw new DatabaseError(error.code, error.message);
        }
        catch (err) {
            if (err instanceof DatabaseError)
                throw err;
            throw new DatabaseError('UNKNOWN', err.message || 'Failed to update token version');
        }
    }
    async resetAllLimits() {
        if (!(0, supabase_1.isSupabaseConfigured)()) {
            throw new DatabaseError('NOT_CONFIGURED', 'Supabase not configured');
        }
        try {
            const today = new Date().toISOString().split('T')[0];
            const payload = {
                daily_search_count: 0,
                daily_pnr_count: 0,
                daily_live_count: 0,
                last_usage_reset: today
            };
            const { error } = await supabase_1.supabase.from('users').update(payload).neq('id', 'placeholder-avoid-full-table-error-if-needed');
            if (error)
                throw new DatabaseError(error.code, error.message);
        }
        catch (err) {
            if (err instanceof DatabaseError)
                throw err;
            throw new DatabaseError('UNKNOWN', err.message || 'Failed to reset all limits');
        }
    }
    async batchUpsert(users) {
        if (!(0, supabase_1.isSupabaseConfigured)()) {
            throw new DatabaseError('NOT_CONFIGURED', 'Supabase not configured');
        }
        try {
            const payload = users.map(u => this.mapToDB(u));
            const { error } = await supabase_1.supabase.from('users').upsert(payload);
            if (error)
                throw new DatabaseError(error.code, error.message);
        }
        catch (err) {
            if (err instanceof DatabaseError)
                throw err;
            throw new DatabaseError('UNKNOWN', err.message || 'Failed to batch upsert users');
        }
    }
    async deleteUser(id) {
        if (!(0, supabase_1.isSupabaseConfigured)()) {
            throw new DatabaseError('NOT_CONFIGURED', 'Supabase not configured');
        }
        if (!id || !UUID_REGEX.test(id)) {
            throw new DatabaseError('INVALID_UUID', 'Invalid user ID format');
        }
        try {
            const { error } = await supabase_1.supabase.from('users').delete().eq('id', id);
            if (error)
                throw new DatabaseError(error.code, error.message);
        }
        catch (err) {
            if (err instanceof DatabaseError)
                throw err;
            throw new DatabaseError('UNKNOWN', err.message || 'Failed to delete user');
        }
    }
}
exports.userRepository = new UserRepository();
