"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.quotaRepository = exports.QuotaRepository = void 0;
const supabase_1 = require("../config/supabase");
const logger_1 = require("../middleware/logger");
class QuotaRepository {
    constructor() {
        this.PROFILES_TABLE = 'quota_profiles';
        this.OVERRIDES_TABLE = 'user_quota_overrides';
    }
    /**
     * Fetch a quota profile by plan type
     */
    async getProfile(planType) {
        try {
            const { data, error } = await supabase_1.supabase
                .from(this.PROFILES_TABLE)
                .select('*')
                .eq('plan_type', planType)
                .maybeSingle();
            if (error) {
                logger_1.winstonLogger.error(`[QUOTA_REPOSITORY] Failed to get profile for plan ${planType}: ${error.message}`);
                return null;
            }
            return data;
        }
        catch (err) {
            logger_1.winstonLogger.error(`[QUOTA_REPOSITORY] Error in getProfile: ${err.message}`);
            return null;
        }
    }
    /**
     * Fetch all quota profiles
     */
    async getAllProfiles() {
        try {
            const { data, error } = await supabase_1.supabase
                .from(this.PROFILES_TABLE)
                .select('*');
            if (error) {
                logger_1.winstonLogger.error(`[QUOTA_REPOSITORY] Failed to get all profiles: ${error.message}`);
                return [];
            }
            return (data || []);
        }
        catch (err) {
            logger_1.winstonLogger.error(`[QUOTA_REPOSITORY] Error in getAllProfiles: ${err.message}`);
            return [];
        }
    }
    /**
     * Fetch an active user override by user_id
     */
    async getOverride(userId) {
        try {
            const { data, error } = await supabase_1.supabase
                .from(this.OVERRIDES_TABLE)
                .select('*')
                .eq('user_id', userId)
                .maybeSingle();
            if (error) {
                logger_1.winstonLogger.error(`[QUOTA_REPOSITORY] Failed to get override for user ${userId}: ${error.message}`);
                return null;
            }
            // Check expiry if set
            if (data && data.expires_at && new Date(data.expires_at) < new Date()) {
                // Logically expired, delete in background
                this.deleteOverride(userId).catch(() => { });
                return null;
            }
            return data;
        }
        catch (err) {
            logger_1.winstonLogger.error(`[QUOTA_REPOSITORY] Error in getOverride: ${err.message}`);
            return null;
        }
    }
    /**
     * Delete user override
     */
    async deleteOverride(userId) {
        try {
            const { error } = await supabase_1.supabase
                .from(this.OVERRIDES_TABLE)
                .delete()
                .eq('user_id', userId);
            if (error) {
                logger_1.winstonLogger.error(`[QUOTA_REPOSITORY] Failed to delete override for user ${userId}: ${error.message}`);
                return false;
            }
            return true;
        }
        catch (err) {
            logger_1.winstonLogger.error(`[QUOTA_REPOSITORY] Error in deleteOverride: ${err.message}`);
            return false;
        }
    }
}
exports.QuotaRepository = QuotaRepository;
exports.quotaRepository = new QuotaRepository();
