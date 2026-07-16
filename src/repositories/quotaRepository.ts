import { supabase } from '../config/supabase';
import { winstonLogger } from '../middleware/logger';

export interface QuotaProfile {
  id?: string;
  plan_type: string;
  searches_limit: number;
  pnr_limit: number;
  live_limit: number;
  ad_reward_searches: number;
  warning_threshold: number;
  created_at?: string;
  updated_at?: string;
}

export interface UserQuotaOverride {
  id?: string;
  user_id: string;
  custom_searches_limit: number | null;
  custom_pnr_limit: number | null;
  custom_live_limit: number | null;
  expires_at: string | null;
  created_at?: string;
  updated_at?: string;
}

export class QuotaRepository {
  private readonly PROFILES_TABLE = 'quota_profiles';
  private readonly OVERRIDES_TABLE = 'user_quota_overrides';

  /**
   * Fetch a quota profile by plan type
   */
  async getProfile(planType: string): Promise<QuotaProfile | null> {
    try {
      const { data, error } = await supabase
        .from(this.PROFILES_TABLE)
        .select('*')
        .eq('plan_type', planType)
        .maybeSingle();

      if (error) {
        winstonLogger.error(`[QUOTA_REPOSITORY] Failed to get profile for plan ${planType}: ${error.message}`);
        return null;
      }

      return data as QuotaProfile;
    } catch (err: any) {
      winstonLogger.error(`[QUOTA_REPOSITORY] Error in getProfile: ${err.message}`);
      return null;
    }
  }

  /**
   * Fetch all quota profiles
   */
  async getAllProfiles(): Promise<QuotaProfile[]> {
    try {
      const { data, error } = await supabase
        .from(this.PROFILES_TABLE)
        .select('*');

      if (error) {
        winstonLogger.error(`[QUOTA_REPOSITORY] Failed to get all profiles: ${error.message}`);
        return [];
      }

      return (data || []) as QuotaProfile[];
    } catch (err: any) {
      winstonLogger.error(`[QUOTA_REPOSITORY] Error in getAllProfiles: ${err.message}`);
      return [];
    }
  }

  /**
   * Fetch an active user override by user_id
   */
  async getOverride(userId: string): Promise<UserQuotaOverride | null> {
    try {
      const { data, error } = await supabase
        .from(this.OVERRIDES_TABLE)
        .select('*')
        .eq('user_id', userId)
        .maybeSingle();

      if (error) {
        winstonLogger.error(`[QUOTA_REPOSITORY] Failed to get override for user ${userId}: ${error.message}`);
        return null;
      }

      // Check expiry if set
      if (data && data.expires_at && new Date(data.expires_at) < new Date()) {
        // Logically expired, delete in background
        this.deleteOverride(userId).catch(() => {});
        return null;
      }

      return data as UserQuotaOverride;
    } catch (err: any) {
      winstonLogger.error(`[QUOTA_REPOSITORY] Error in getOverride: ${err.message}`);
      return null;
    }
  }

  /**
   * Delete user override
   */
  async deleteOverride(userId: string): Promise<boolean> {
    try {
      const { error } = await supabase
        .from(this.OVERRIDES_TABLE)
        .delete()
        .eq('user_id', userId);

      if (error) {
        winstonLogger.error(`[QUOTA_REPOSITORY] Failed to delete override for user ${userId}: ${error.message}`);
        return false;
      }

      return true;
    } catch (err: any) {
      winstonLogger.error(`[QUOTA_REPOSITORY] Error in deleteOverride: ${err.message}`);
      return false;
    }
  }
}

export const quotaRepository = new QuotaRepository();
