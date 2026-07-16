import crypto from 'crypto';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import fs from 'fs';
import path from 'path';
import { applyReferralCode, generateReferralCode, generateReferralCodeSync } from './referralService';
import { supabase, isSupabaseConfigured } from '../config/supabase';
import { winstonLogger } from '../middleware/logger';
import { userRepository, DatabaseError } from '../repositories/userRepository';
import { userCache } from '../cache/userCache';
import { quotaRepository } from '../repositories/quotaRepository';
import { cacheService } from './cacheService';
import { betaService } from './betaService';

const USERS_FILE = path.join(__dirname, '../../data/users.json');
const GUESTS_FILE = path.join(__dirname, '../../data/guests.json');

export interface User {
  id: string;
  email: string;
  password: string;
  referralCode: string;
  referredBy?: string;
  deviceId?: string;
  createdAt: string;

  // limits
  dailySearchCount: number;
  dailyPnrCount: number;
  dailyLiveCount: number;
  lastUsageReset: string;

  // monetization
  splitAccessUntil: string | null;
  planType: 'free' | 'paid' | 'beta' | 'safar_pro' | 'safar_pro_30m' | 'safar_pro_1d' | 'safar_pro_7d' | 'safar_pro_30d' | 'safar_pro_90d' | 'admin';
  planExpiry: string | null;
  lastSubscriptionDate?: string | null;
  credits: number; // For free credits
  aiSplitSearches: number; // Extra AI split searches
  
  // ads
  adsWatchedToday: number;
  lastAdWatchTime: number;

  isAdmin: boolean;
  isBlocked?: boolean;
  tokenVersion?: number;
  // PHASE_4C965 — access-token revocation epoch (E), decoupled from refresh rotation (R)
  sessionEpoch?: number;

  fullName?: string;
  mobileNumber?: string;
  dob?: string;
  avatarUrl?: string;
  notifyEmail?: boolean;
  notifyBirthday?: boolean;
  notifyMarketing?: boolean;
  mobileVerified?: boolean;
  mobileVerificationMethod?: string | null;
  mobileVerifiedAt?: string | null;
  birthdayRewardLastClaimedYear?: number | null;
}

export interface GuestUsage {
  deviceId: string;
  dailySearchCount: number;
  dailyPnrCount: number;
  dailyLiveCount: number;
  lastUsageReset: string;
  adsWatchedToday: number;
  lastAdWatchTime: number;
}

export class AuthService {
  private users: User[] = [];
  private guests: GuestUsage[] = [];
  private otps: Record<string, { otp: string; expiresAt: number }> = {};
  private passwordResetOtps: Record<string, { otp: string; expiresAt: number }> = {};
  private mobileOtps: Record<string, { otp: string; mobileNumber: string; expiresAt: number; attempts: number }> = {};

  // PHASE_4C759 Fix #3 (P1-AUTH-001): OTP Rate Limiting
  private otpRateLimits: Map<string, { count: number; resetAt: number }> = new Map();
  private readonly OTP_LIMIT_PER_EMAIL = 3;
  private readonly OTP_LIMIT_WINDOW_MS = 60 * 60 * 1000; // 1 hour

  private ipGuestDevices: Map<string, Set<string>> = new Map();
  private ipGuestDevicesDate: string = new Date().toISOString().split('T')[0];
  private readonly IP_DEVICE_LIMIT = 15;

  /** P0-010: Serialize concurrent refresh for the same user to prevent rotation races. */
  private refreshLocks = new Map<string, Promise<{ accessToken: string; refreshToken: string }>>();

  constructor() {
    this.loadUsers();
    this.loadGuests();
    this.ensureAdmin();
    this.syncWithSupabase();
  }

  public async getAllUsers(): Promise<User[]> {
    try {
      winstonLogger.info(`[AUTH_PHASE2A] getAllUsers querying repository`);
      return await userRepository.getAllUsers();
    } catch (err: any) {
      winstonLogger.error(`[AUTH_PHASE2A] getAllUsers repository fallback: ${err.message}`);
      return this.users;
    }
  }

  public async getUserById(userId: string): Promise<User | null> {
    try {
      let user = await userCache.getUser(userId);
      if (user) {
        winstonLogger.info(`[AUTH_PHASE2A] Cache hit for ${userId}`);
        return user;
      }
      winstonLogger.info(`[AUTH_PHASE2A] Cache miss for ${userId}, querying repository`);
      user = await userRepository.findById(userId);
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
        await userCache.setUser(user);
        return user;
      }
      // If null, it means it's not in DB yet. Fallback to legacy array.
      winstonLogger.warn(`[AUTH_PHASE2A] getUserById null response, falling back to legacy array for ${userId}`);
      return this.users.find(u => u.id === userId) || null;
    } catch (err: any) {
      winstonLogger.error(`[AUTH_PHASE2A] getUserById repository fallback: ${err.message}`);
      return this.users.find(u => u.id === userId) || null;
    }
  }

  public async getUserByEmail(email: string): Promise<User | null> {
    try {
      let user = await userRepository.findByEmail(email);
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
        await userCache.setUser(user);
        return user;
      }
      // If null, fallback to legacy array
      winstonLogger.warn(`[AUTH_PHASE2A] getUserByEmail null response, falling back to legacy array for ${email}`);
      return this.users.find(u => u.email === email) || null;
    } catch (err: any) {
      winstonLogger.error(`[AUTH_PHASE2A] getUserByEmail repository fallback: ${err.message}`);
      return this.users.find(u => u.email === email) || null;
    }
  }

  // ─── Admin User Management ───────────────────────────────────────────────

  public async deleteUserAccount(userId: string): Promise<void> {
    winstonLogger.info(`[AUTH_DELETE] Initiating deletion process for user: ${userId}`);

    // Invalidate caches immediately
    await userCache.invalidate(userId);
    cacheService.del(`quota_status:${userId}`);

    // Delete local user array entry and save local JSON state
    const localUserIndex = this.users.findIndex(u => u.id === userId);
    if (localUserIndex !== -1) {
      this.users.splice(localUserIndex, 1);
      this.saveUsers();
      winstonLogger.info(`[AUTH_DELETE] Purged local JSON user registry entry`);
    }

    // Delete related beta redemptions
    try {
      await betaService.deleteRedemptionsForUser(userId);
      winstonLogger.info(`[AUTH_DELETE] Purged user beta redemptions`);
    } catch (err: any) {
      winstonLogger.error(`[AUTH_DELETE] Exception while deleting beta redemptions: ${err.message}`);
    }

    if (isSupabaseConfigured()) {
      // Delete user push tokens
      try {
        const { error: tokenErr } = await supabase.from('user_push_tokens').delete().eq('user_id', userId);
        if (tokenErr) winstonLogger.warn(`[AUTH_DELETE] Failed user_push_tokens deletion: ${tokenErr.message}`);
      } catch (err: any) {
        winstonLogger.error(`[AUTH_DELETE] Exception in user_push_tokens deletion: ${err.message}`);
      }

      // Delete user notification preferences
      try {
        const { error: prefErr } = await supabase.from('user_notification_preferences').delete().eq('user_id', userId);
        if (prefErr) winstonLogger.warn(`[AUTH_DELETE] Failed user_notification_preferences deletion: ${prefErr.message}`);
      } catch (err: any) {
        winstonLogger.error(`[AUTH_DELETE] Exception in user_notification_preferences deletion: ${err.message}`);
      }

      // Delete user notification history
      try {
        const { error: histErr } = await supabase.from('user_notification_history').delete().eq('user_id', userId);
        if (histErr) winstonLogger.warn(`[AUTH_DELETE] Failed user_notification_history deletion: ${histErr.message}`);
      } catch (err: any) {
        winstonLogger.error(`[AUTH_DELETE] Exception in user_notification_history deletion: ${err.message}`);
      }

      // Delete other optional related records if tables exist: user_expenses, search_history, pnr_history
      const optionalTables = ['user_expenses', 'search_history', 'pnr_history', 'user_usage'];
      for (const table of optionalTables) {
        try {
          const { error } = await supabase.from(table).delete().eq('user_id', userId);
          if (error && error.code !== 'PGRST116') {
            winstonLogger.warn(`[AUTH_DELETE] Failed ${table} deletion: ${error.message}`);
          }
        } catch (err: any) {
          // Ignore table-not-exist errors safely
        }
      }

      // Delete primary database user record
      try {
        await userRepository.deleteUser(userId);
        winstonLogger.info(`[AUTH_DELETE] Purged database user record`);
      } catch (err: any) {
        winstonLogger.error(`[AUTH_DELETE] Failed to delete user from repository: ${err.message}`);
        throw err;
      }

      // Finally delete the Supabase Auth user via Admin API (requires service role key)
      try {
        const { error: authErr } = await supabase.auth.admin.deleteUser(userId);
        if (authErr) {
          winstonLogger.warn(`[AUTH_DELETE] Supabase Auth Admin deletion warning: ${authErr.message}. User database records were still purged.`);
        } else {
          winstonLogger.info(`[AUTH_DELETE] Successfully deleted user credential from Supabase Auth`);
        }
      } catch (err: any) {
        winstonLogger.warn(`[AUTH_DELETE] Supabase Auth Admin API not available/failed: ${err.message}. Database records were successfully purged.`);
      }
    }
  }

  public async blockUser(userId: string): Promise<boolean> {
    const user = await this.getUserById(userId);
    if (!user || user.isAdmin) return false; // Cannot block admins
    user.isBlocked = true;
    user.tokenVersion = (user.tokenVersion || 0) + 1; // Invalidate refresh tokens
    user.sessionEpoch = (user.sessionEpoch || 1) + 1; // PHASE_4C965: bump access epoch (E) alongside R

    // Phase 1: Dual-write hook
    if (isSupabaseConfigured()) {
      userRepository.update(userId, { isBlocked: true, tokenVersion: user.tokenVersion, sessionEpoch: user.sessionEpoch }).catch(err =>
        winstonLogger.error(`[AUTH_PHASE1] Failed to sync blockUser to Supabase: ${err.message}`)
      );
      await userCache.invalidate(userId);
    }

    this.updateLocalUser(user);
    this.saveUsers();
    return true;
  }

  public async unblockUser(userId: string): Promise<boolean> {
    const user = await this.getUserById(userId);
    if (!user) return false;
    user.isBlocked = false;

    // Phase 1: Dual-write hook
    if (isSupabaseConfigured()) {
      userRepository.update(userId, { isBlocked: false }).catch(err => 
        winstonLogger.error(`[AUTH_PHASE1] Failed to sync unblockUser to Supabase: ${err.message}`)
      );
      await userCache.invalidate(userId);
    }

    this.updateLocalUser(user);
    this.saveUsers();
    return true;
  }

  public async resetUserLimits(userId: string): Promise<boolean> {
    const user = await this.getUserById(userId);
    if (!user) return false;
    const today = new Date().toISOString().split('T')[0];
    user.dailySearchCount = 0;
    user.dailyPnrCount = 0;
    user.dailyLiveCount = 0;
    user.adsWatchedToday = 0;
    user.lastUsageReset = today;

    if (isSupabaseConfigured()) {
      userRepository.update(userId, {
        dailySearchCount: 0,
        dailyPnrCount: 0,
        dailyLiveCount: 0,
        adsWatchedToday: 0,
        lastUsageReset: today
      }).catch(err => 
        winstonLogger.error(`[AUTH_PHASE1] Failed to sync resetUserLimits to Supabase: ${err.message}`)
      );
      await userCache.invalidate(userId);
    }

    this.updateLocalUser(user);
    this.saveUsers();
    return true;
  }

  public async changeUserPlan(userId: string, planType: User['planType'], durationDays?: number): Promise<boolean> {
    const user = await this.getUserById(userId);
    if (!user) return false;
    user.planType = planType;
    let planExpiry = null;
    let lastSubscriptionDate = null;
    if (planType === 'free') {
      user.planExpiry = null;
    } else if (durationDays) {
      const expiry = new Date();
      expiry.setDate(expiry.getDate() + durationDays);
      user.planExpiry = expiry.toISOString();
      user.lastSubscriptionDate = new Date().toISOString();
      planExpiry = user.planExpiry;
      lastSubscriptionDate = user.lastSubscriptionDate;
    }

    if (isSupabaseConfigured()) {
      userRepository.update(userId, { planType, planExpiry, lastSubscriptionDate }).catch(err => 
        winstonLogger.error(`[AUTH_PHASE1] Failed to sync changeUserPlan to Supabase: ${err.message}`)
      );
      await userCache.invalidate(userId);
    }

    this.updateLocalUser(user);
    this.saveUsers();
    return true;
  }

  public async terminateUserSessions(userId: string): Promise<boolean> {
    const user = await this.getUserById(userId);
    if (!user || user.isAdmin) return false;

    user.tokenVersion = (user.tokenVersion || 0) + 1;
    user.sessionEpoch = (user.sessionEpoch || 1) + 1; // PHASE_4C965: bump access epoch (E) alongside R

    if (isSupabaseConfigured()) {
      try {
        await userRepository.update(userId, { tokenVersion: user.tokenVersion, sessionEpoch: user.sessionEpoch });
      } catch (err: any) {
        winstonLogger.error(`[AUTH_PHASE1] Failed to sync terminateUserSessions to Supabase: ${err.message}`);
        throw err;
      }
    }
    await userCache.invalidate(userId);

    this.updateLocalUser(user);
    this.saveUsers();
    return true;
  }

  public async adjustUserCredits(userId: string, creditsChange: number): Promise<boolean> {
    const user = await this.getUserById(userId);
    if (!user || user.isAdmin) return false;

    const newCredits = Math.max(0, (user.credits || 0) + creditsChange);
    if (newCredits > 1000000) {
      throw new Error('Credits allocation exceeds maximum cap of 1,000,000.');
    }
    user.credits = newCredits;

    if (isSupabaseConfigured()) {
      try {
        await userRepository.update(userId, { credits: user.credits });
      } catch (err: any) {
        winstonLogger.error(`[AUTH_PHASE1] Failed to sync adjustUserCredits to Supabase: ${err.message}`);
        throw err;
      }
    }
    await userCache.invalidate(userId);

    this.updateLocalUser(user);
    this.saveUsers();
    return true;
  }

  // ─── Forgot Password Flow ─────────────────────────────────────────────────

  public async sendPasswordResetOtp(email: string): Promise<boolean> {
    const user = await this.getUserByEmail(email);
    if (!user) throw new Error('No account found with this email address');
    if (user.isBlocked) throw new Error('Account has been blocked');

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
      const { emailService } = await import('./emailService');
      await emailService.sendPasswordResetEmail(email, otp);
    } catch (err: any) {
      winstonLogger.error(`[AUTH_RESET_OTP] Exception while sending password reset email to ${email}: ${err.message}.`);
      throw new Error('Failed to send password reset email. Please try again later.');
    }
    return true;
  }

  public async resetPassword(email: string, otp: string, newPassword: string): Promise<boolean> {
    const record = this.passwordResetOtps[email];
    if (!record || record.otp !== otp || Date.now() > record.expiresAt) {
      throw new Error('Invalid or expired OTP');
    }

    const user = await this.getUserByEmail(email);
    if (!user) throw new Error('User not found');

    user.password = bcrypt.hashSync(newPassword, 10);
    delete this.passwordResetOtps[email];

    // Phase 1: Dual-write hook
    if (isSupabaseConfigured()) {
      userRepository.update(user.id, { password: user.password }).catch(err => 
        winstonLogger.error(`[AUTH_PHASE1] Failed to sync resetPassword to Supabase: ${err.message}`)
      );
      await userCache.invalidate(user.id);
    }

    this.updateLocalUser(user);
    this.saveUsers();
    return true;
  }

  private loadUsers() {
    try {
      if (fs.existsSync(USERS_FILE)) {
        const data = fs.readFileSync(USERS_FILE, 'utf-8');
        this.users = JSON.parse(data);
      } else {
        this.saveUsers();
      }
    } catch (e) {
      // Silent - users file will be created on first save
    }
  }

  private async syncWithSupabase() {
      if (!isSupabaseConfigured()) {
          winstonLogger.info('[AUTH_FALLBACK] Supabase not configured. Using users.json strictly.');
          return;
      }
      try {
          const { data: remoteUsers, error } = await supabase.from('users').select('*');
          if (error) {
              winstonLogger.warn(`[AUTH_FALLBACK] Supabase fetch failed: ${error.message}. Using users.json`);
              return;
          }
          if (remoteUsers) {
              winstonLogger.info(`[AUTH_SUPABASE] User loaded: ${remoteUsers.length} users from Supabase`);
              
              const remoteDict = new Map<string, any>();
              remoteUsers.forEach(u => remoteDict.set(u.email, u));
 
              for (const localUser of this.users) {
                  if (!remoteDict.has(localUser.email)) {
                      // Auto-create missing users in Supabase
                      const { error: insertErr } = await supabase.from('users').insert({
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
                          is_blocked: (localUser as any).isBlocked || false
                      });
                      if (!insertErr) {
                          winstonLogger.info(`[AUTH_MIGRATION] User migrated: ${localUser.email}`);
                          remoteDict.set(localUser.email, localUser);
                      } else {
                          winstonLogger.error(`[AUTH_MIGRATION] Failed to migrate user ${localUser.email}: ${insertErr.message}`);
                      }
                  }
              }
 
              // Combine remote truth and local migrations
              this.users = Array.from(remoteDict.values()).map(row => {
                  const localUser = this.users.find(u => u.email === row.email) || ({} as Partial<User>);
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
              if (!fs.existsSync(path.dirname(USERS_FILE))) {
                  fs.mkdirSync(path.dirname(USERS_FILE), { recursive: true });
              }
              fs.writeFileSync(USERS_FILE, JSON.stringify(this.users, null, 2));
          }
      } catch (e: any) {
          winstonLogger.error(`[AUTH_SUPABASE] Sync error: ${e.message}`);
      }
  }
 
  private updateLocalUser(user: User) {
    const idx = this.users.findIndex(u => u.id === user.id);
    if (idx !== -1) {
      this.users[idx] = { ...user };
    } else {
      this.users.push({ ...user });
    }
  }
 
  private saveUsers() {
    try {
      if (!fs.existsSync(path.dirname(USERS_FILE))) {
        fs.mkdirSync(path.dirname(USERS_FILE), { recursive: true });
      }
      fs.writeFileSync(USERS_FILE, JSON.stringify(this.users, null, 2));
 
      // Async Supabase sync
      if (isSupabaseConfigured()) {
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
                is_blocked: (localUser as any).isBlocked || false,
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
          
          supabase.from('users').upsert(dbPayload).then(({error}) => {
              if (error && error.code !== 'PGRST116') {
                  winstonLogger.error(`[AUTH_SUPABASE] Upsert error: ${error.message}`);
              }
          });
      }
    } catch (e) {
      // Silent - non-critical persistence error
    }
  }

  private loadGuests() {
    try {
      if (fs.existsSync(GUESTS_FILE)) {
        const data = fs.readFileSync(GUESTS_FILE, 'utf-8');
        this.guests = JSON.parse(data);
      } else {
        this.saveGuests();
      }
    } catch (e) {
      // Silent
    }
  }

  private saveGuests() {
    try {
      if (!fs.existsSync(path.dirname(GUESTS_FILE))) {
        fs.mkdirSync(path.dirname(GUESTS_FILE), { recursive: true });
      }
      fs.writeFileSync(GUESTS_FILE, JSON.stringify(this.guests, null, 2));
    } catch (e) {
      // Silent
    }
  }

  private ensureAdmin() {
    const adminEmail = (process.env.ADMIN_EMAIL || '').trim();
    const adminPassword = (process.env.ADMIN_PASSWORD || '').trim();
    if (!adminEmail || !adminPassword) {
      return;
    }

    const existingAdmin = this.users.find(u => u.email === adminEmail);
    if (existingAdmin) {
      existingAdmin.isAdmin = true;
      existingAdmin.planType = 'admin';
      return;
    }

    const today = new Date().toISOString().split('T')[0];
    const adminUser: User = {
      id: crypto.randomUUID(),
      email: adminEmail,
      password: bcrypt.hashSync(adminPassword, 10),
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
    adminUser.referralCode = generateReferralCodeSync(adminUser.id);
    this.users.push(adminUser);
    this.saveUsers();
  }

  private resetDailyUsage(entity: User | GuestUsage) {
    const today = new Date().toISOString().split('T')[0];
    if (entity.lastUsageReset !== today) {
      entity.dailySearchCount = 0;
      entity.dailyPnrCount = 0;
      entity.dailyLiveCount = 0;
      entity.adsWatchedToday = 0;
      entity.lastUsageReset = today;
    }
  }

  public async resetDailyUsageExplicit(userId: string | null, deviceId?: string): Promise<boolean> {
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

          if (isSupabaseConfigured()) {
            try {
              await userRepository.update(userId, {
                dailySearchCount: 0,
                dailyPnrCount: 0,
                dailyLiveCount: 0,
                adsWatchedToday: 0,
                lastUsageReset: today
              });
            } catch (err: any) {
              winstonLogger.error(`[AUTH_EXPLICIT_RESET] Failed to sync reset to Supabase: ${err.message}`);
            }
            await userCache.invalidate(userId);
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
      } else {
        // Create guest usage
        this.getOrCreateGuest(deviceId);
        modified = true;
      }
    }

    return modified;
  }

  private getOrCreateGuest(deviceId: string): GuestUsage {
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

  public async sendOtp(email: string) {
    const existingUser = this.users.find(u => u.email === email);
    if (existingUser) {
      if (existingUser.isBlocked) throw new Error('Account has been blocked');
      throw new Error('Email already exists');
    }

    const otp = Math.floor(100000 + Math.random() * 900000).toString();
    this.otps[email] = {
      otp,
      expiresAt: Date.now() + 15 * 60 * 1000 // 15 mins expiry
    };

    try {
      const { emailService } = await import('./emailService');
      const sent = await emailService.sendOtpEmail(email, otp);
      if (!sent) {
        winstonLogger.error(`[AUTH_OTP] Failed to send OTP email to ${email}.`);
        throw new Error('Failed to send verification email. Please try again later.');
      }
    } catch (err: any) {
      winstonLogger.error(`[AUTH_OTP] Exception while sending OTP email to ${email}: ${err.message}.`);
      throw new Error(err.message || 'Failed to send verification email. Please try again later.');
    }
    return true;
  }

  public async signup(email: string, password: string, referredByCode?: string, deviceId?: string, otp?: string, fullName?: string, mobileNumber?: string, dob?: string) {
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
    const newUser: User = {
      id: crypto.randomUUID(),
      email,
      password: await bcrypt.hash(password, 10),
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

    newUser.referralCode = await generateReferralCode(newUser.id);

    let referralMeta: { applied: boolean; message?: string; referredBy?: string } | undefined;
    const normalizedReferralCode = (referredByCode || '').trim().toUpperCase();

    if (normalizedReferralCode) {
      const referralResult = await applyReferralCode(newUser.id, normalizedReferralCode, deviceId);
      if (referralResult.success) {
        const thirtyMinutesFromNow = new Date(Date.now() + 30 * 60000).toISOString();
        newUser.splitAccessUntil = thirtyMinutesFromNow;
        newUser.referredBy = referralResult.data?.referredBy;

        const referrer = await this.getUserById(referralResult.data?.referredBy as string);
        if (referrer) {
          referrer.splitAccessUntil = thirtyMinutesFromNow;
          this.updateLocalUser(referrer);
          if (isSupabaseConfigured()) {
            userRepository.update(referrer.id, { splitAccessUntil: thirtyMinutesFromNow }).catch(err => 
              winstonLogger.error(`[AUTH_PHASE1] Failed to sync referrer splitAccessUntil to Supabase: ${err.message}`)
            );
            userCache.setUser(referrer).catch(err =>
              winstonLogger.error(`[AUTH_PHASE1] Failed to cache referrer: ${err.message}`)
            );
          }
        }

        referralMeta = { applied: true, referredBy: referralResult.data?.referredBy };
      } else {
        referralMeta = { applied: false, message: referralResult.message };
      }
    }

    this.users.push(newUser);

    // Phase 1: Dual-write hook
    if (isSupabaseConfigured()) {
      userRepository.create(newUser).catch(err => 
        winstonLogger.error(`[AUTH_PHASE1] Failed to sync create user to Supabase: ${err.message}`)
      );
      await userCache.setUser(newUser);
    }

    this.saveUsers();

    // Fire-and-forget: migrate any guest alarms created before signup to this user
    if (deviceId && isSupabaseConfigured()) {
      this.migrateGuestAlarms(newUser.id, deviceId).catch(err =>
        winstonLogger.warn(`[AUTH_MIGRATION] Guest alarm migration failed for ${newUser.id}: ${err.message}`)
      );
    }

    return {
      user: this.sanitizeUser(newUser),
      tokens: this.generateTokens(newUser),
      ...(referralMeta ? { referralMeta } : {})
    };
  }

  public async login(email: string, password: string, deviceId?: string, referralCode?: string) {
    const user = await this.getUserByEmail(email);
    if (!user) throw new Error('User not found');
    if (user.isBlocked) throw new Error('Account has been blocked');
    
    let isMatch = false;
    if (user.password.startsWith('$2a$') || user.password.startsWith('$2b$') || user.password.startsWith('$2y$')) {
        isMatch = await bcrypt.compare(password, user.password);
    } else {
        // Legacy plaintext
        isMatch = (user.password === password);
        if (isMatch) {
            // Lazy Migration
            user.password = await bcrypt.hash(password, 10);
            // Will be saved later in login flow
        }
    }
    
    if (!isMatch) throw new Error('Invalid credentials');

    // Store device ID for abuse prevention
    if (deviceId) {
      user.deviceId = deviceId;
    }

    // Apply referral code if provided and user doesn't already have a referrer
    let referralMeta: { applied: boolean; message?: string; referredBy?: string } | undefined;
    const normalizedReferralCode = (referralCode || '').trim().toUpperCase();

    if (normalizedReferralCode && !user.referredBy) {
      const referralResult = await applyReferralCode(user.id, normalizedReferralCode, deviceId);
      if (referralResult.success) {
        const thirtyMinutesFromNow = new Date(Date.now() + 30 * 60000).toISOString();
        user.splitAccessUntil = thirtyMinutesFromNow;
        user.referredBy = referralResult.data?.referredBy;

        const referrer = await this.getUserById(referralResult.data?.referredBy as string);
        if (referrer) {
          referrer.splitAccessUntil = thirtyMinutesFromNow;
        }

        referralMeta = { applied: true, referredBy: referralResult.data?.referredBy };
      } else {
        referralMeta = { applied: false, message: referralResult.message };
      }
    }

    // Reset daily usage if needed
    this.resetDailyUsage(user);

    if (isMatch && !user.tokenVersion) {
        user.tokenVersion = 1;
        if (isSupabaseConfigured()) {
          userRepository.updateTokenVersion(user.id, 1).catch(err => 
            winstonLogger.error(`[AUTH_PHASE1] Failed to sync tokenVersion to Supabase: ${err.message}`)
          );
          await userCache.invalidate(user.id);
        }
    }
    
    this.updateLocalUser(user);
    this.saveUsers();

    // Fire-and-forget: migrate any guest alarms created before this login to this user
    if (deviceId && isSupabaseConfigured()) {
      this.migrateGuestAlarms(user.id, deviceId).catch(err =>
        winstonLogger.warn(`[AUTH_MIGRATION] Guest alarm migration failed for ${user.id}: ${err.message}`)
      );
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
  private async migrateGuestAlarms(userId: string, deviceId: string): Promise<void> {
    try {
      // Step 1: Claim all orphaned device alarms that have no user_id yet
      const { data: migrated, error: migrateErr } = await supabase
        .from('user_station_alarms')
        .update({ user_id: userId, updated_at: new Date().toISOString() })
        .eq('device_id', deviceId)
        .is('user_id', null)
        .select('id, enabled, created_at');

      if (migrateErr) {
        // Table might not exist yet — log at debug and exit silently
        winstonLogger.debug(`[AUTH_MIGRATION] user_station_alarms not accessible: ${migrateErr.message}`);
        return;
      }

      const count = migrated?.length ?? 0;
      if (count === 0) {
        return; // Nothing to migrate
      }

      winstonLogger.info(`[AUTH_MIGRATION] Migrated ${count} guest alarm(s) from device ${deviceId} to user ${userId}`);

      // Step 2: Enforce 3-alarm ceiling — find all enabled alarms for this user now
      const { data: enabledAlarms, error: fetchErr } = await supabase
        .from('user_station_alarms')
        .select('id, created_at')
        .eq('user_id', userId)
        .eq('enabled', true)
        .order('created_at', { ascending: false }); // Newest first

      if (fetchErr || !enabledAlarms) return;

      if (enabledAlarms.length > 3) {
        // Keep the 3 newest; disable the rest
        const toDisable = enabledAlarms.slice(3).map((a: any) => a.id);
        const { error: disableErr } = await supabase
          .from('user_station_alarms')
          .update({ enabled: false, updated_at: new Date().toISOString() })
          .in('id', toDisable);

        if (disableErr) {
          winstonLogger.warn(`[AUTH_MIGRATION] Could not enforce ceiling for user ${userId}: ${disableErr.message}`);
        } else {
          winstonLogger.info(`[AUTH_MIGRATION] Ceiling enforced: disabled ${toDisable.length} excess alarm(s) for user ${userId}`);
        }
      }
    } catch (err: any) {
      // Never throw — migration errors must not break authentication
      winstonLogger.warn(`[AUTH_MIGRATION] Unexpected error during guest alarm migration: ${err.message}`);
    }
  }

  public generateTokens(user: User) {
    const jwtSecret = process.env.JWT_SECRET as string;
    const refreshSecret = process.env.REFRESH_TOKEN_SECRET as string;
    const payload = {
      userId: user.id,
      email: user.email,
      isAdmin: user.isAdmin,
      tokenVersion: user.tokenVersion || 1,
    };
    // PHASE_4C965 Stage 1: emit sessionEpoch (E) in ACCESS tokens only.
    // Refresh token payload is unchanged (rotation still keyed on tokenVersion/R).
    const accessPayload = { ...payload, sessionEpoch: user.sessionEpoch || 1 };
    const accessToken = jwt.sign(accessPayload, jwtSecret, { expiresIn: '15m' });
    const refreshToken = jwt.sign(payload, refreshSecret, { expiresIn: '7d' });
    return { accessToken, refreshToken };
  }

  public async verifyRefreshToken(token: string) {
    let decoded: { userId?: string; tokenVersion?: number };
    try {
      decoded = jwt.verify(token, process.env.REFRESH_TOKEN_SECRET as string) as {
        userId?: string;
        tokenVersion?: number;
      };
    } catch {
      throw new Error('Invalid refresh token');
    }

    const userId = decoded.userId;
    if (!userId) throw new Error('Invalid refresh token');

    const inFlight = this.refreshLocks.get(userId);
    if (inFlight) return inFlight;

    const operation = this.performRefreshRotation(decoded);
    this.refreshLocks.set(userId, operation);
    try {
      return await operation;
    } finally {
      if (this.refreshLocks.get(userId) === operation) {
        this.refreshLocks.delete(userId);
      }
    }
  }

  /** P0-010: Validate refresh JWT, rotate tokenVersion, issue new token pair. */
  private async performRefreshRotation(decoded: { userId?: string; tokenVersion?: number }) {
    const userId = decoded.userId as string;
    const user = await this.getUserById(userId);
    if (!user) throw new Error('Invalid refresh token');
    if (user.isBlocked) throw new Error('Invalid refresh token');
    if ((user.tokenVersion || 1) !== decoded.tokenVersion) throw new Error('Invalid refresh token');

    user.tokenVersion = (user.tokenVersion || 1) + 1;

    if (isSupabaseConfigured()) {
      try {
        await userRepository.update(userId, { tokenVersion: user.tokenVersion });
      } catch (err: any) {
        winstonLogger.error(
          `[AUTH] verifyRefreshToken: Supabase sync failed for ${userId}: ${err.message}`
        );
      }
    }

    await userCache.invalidate(userId).catch(() => {});
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
  public async invalidateUserTokens(userId: string): Promise<void> {
    const user = await this.getUserById(userId);
    if (!user) return;

    user.tokenVersion = (user.tokenVersion || 1) + 1;
    user.sessionEpoch = (user.sessionEpoch || 1) + 1; // PHASE_4C965: bump access epoch (E) alongside R

    if (isSupabaseConfigured()) {
      try {
        await userRepository.update(userId, { tokenVersion: user.tokenVersion, sessionEpoch: user.sessionEpoch });
      } catch (err: any) {
        winstonLogger.error(`[AUTH] invalidateUserTokens: Supabase sync failed for ${userId}: ${err.message}`);
        // Non-fatal — in-memory state is updated; Supabase will sync on next user load
      }
    }

    await userCache.invalidate(userId).catch(() => {});
    this.updateLocalUser(user);
    this.saveUsers();
  }

  public verifyBetaCode(code: string): boolean {
    const validCodes = (process.env.BETA_CODES || 'TRAYAGO-BETA,TESTER-PRO,FOUNDING-USER').split(',').map(c => c.trim().toUpperCase());
    return !!code && validCodes.includes(code.trim().toUpperCase());
  }

  private userBypassesQuota(user: User): boolean {
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

  private isProPlanActive(user: User): boolean {
    if (this.userBypassesQuota(user) || user.planType === 'paid') return true; // Legacy support
    if (user.planType === 'beta') {
        if (!user.planExpiry || new Date() < new Date(user.planExpiry)) {
            return true;
        } else {
            // Expired Beta Access
            user.planType = 'free';
            user.planExpiry = null;
            if (isSupabaseConfigured()) {
                userRepository.update(user.id, { planType: 'free', planExpiry: null }).catch(err =>
                    winstonLogger.error(`[AUTH_PHASE1] Failed to sync expired beta downgrade to Supabase: ${err.message}`)
                );
                userCache.invalidate(user.id).catch(err =>
                    winstonLogger.error(`[AUTH_PHASE2B] Failed to invalidate cache on expired beta: ${err.message}`)
                );
            }
            this.updateLocalUser(user);
            this.saveUsers();
            return false;
        }
    }
    if (user.planType.startsWith('safar_pro') && user.planExpiry) {
        if (new Date() < new Date(user.planExpiry)) {
            return true;
        } else {
            // Expired
            user.planType = 'free';
            user.planExpiry = null;
            if (isSupabaseConfigured()) {
                userRepository.update(user.id, { planType: 'free', planExpiry: null }).catch(err =>
                    winstonLogger.error(`[AUTH_PHASE1] Failed to sync expired safar_pro downgrade to Supabase: ${err.message}`)
                );
                userCache.invalidate(user.id).catch(err =>
                    winstonLogger.error(`[AUTH_PHASE2B] Failed to invalidate cache on expired safar_pro: ${err.message}`)
                );
            }
            this.updateLocalUser(user);
            this.saveUsers();
            return false;
        }
    }
    return false;
  }

  public async upgradeToPro(userId: string, planId: User['planType'], durationMinutes: number, source: 'payment' | 'referral' | 'admin' = 'admin') {
      const user = await this.getUserById(userId);
      if (!user) return false;

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
      if (isSupabaseConfigured()) {
        userRepository.update(userId, { planType: planId, planExpiry: user.planExpiry, lastSubscriptionDate: user.lastSubscriptionDate }).catch(err => 
          winstonLogger.error(`[AUTH_PHASE1] Failed to sync upgradeToPro to Supabase: ${err.message}`)
        );
        
        // Write to subscription_history
        supabase.from('subscription_history').insert([{
            user_id: userId,
            source: source,
            plan_type: planId,
            duration_days: Math.round(durationMinutes / 1440),
            activated_at: activatedAt,
            expires_at: user.planExpiry
        }]).then(({ error }) => {
            if (error) {
                winstonLogger.error(`[AUTH_PHASE1] Failed to persist subscription_history: ${error.message}`);
            }
        });

        await userCache.invalidate(userId);
      }

      this.updateLocalUser(user);
      this.saveUsers();
      return true;
  }

  public async getEffectiveLimit(
    userId: string | null,
    planType: string,
    type: 'search' | 'pnr' | 'live'
  ): Promise<number> {
    // 1. Fallback if Supabase is down or not configured
    if (!isSupabaseConfigured()) {
      if (!userId) {
        if (type === 'search') return 2;
        if (type === 'pnr') return 2;
        return 1; // live
      }
      if (type === 'search') return 5;
      if (type === 'pnr') return 3;
      return 3; // live
    }

    try {
      // 2. Fetch User-Specific Override
      if (userId) {
        const cacheKey = `quota_override:${userId}`;
        let override = cacheService.get<any>(cacheKey);
        
        if (override === undefined) {
          override = await quotaRepository.getOverride(userId);
          cacheService.set(cacheKey, override || null, 300); // 5 minutes cache
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
      let profile = cacheService.get<any>(profileCacheKey);
      
      if (profile === undefined) {
        profile = await quotaRepository.getProfile(planType);
        cacheService.set(profileCacheKey, profile || null, 1800); // 30 minutes cache
      }

      if (profile) {
        if (type === 'search') return profile.searches_limit;
        if (type === 'pnr') return profile.pnr_limit;
        if (type === 'live') return profile.live_limit;
      }
    } catch (err: any) {
      winstonLogger.error(`[QUOTA_RESOLVER_ERROR] Failed to resolve dynamic limit: ${err.message}`);
    }

    // 4. Default Hardcoded Fallbacks
    if (!userId) {
      if (type === 'search') return 2;
      if (type === 'pnr') return 2;
      return 1; // live
    }
    if (type === 'search') return 5;
    if (type === 'pnr') return 3;
    return 3; // live
  }

  public verifyDeviceIpBinding(ip: string, deviceId: string): boolean {
    const today = new Date().toISOString().split('T')[0];
    if (this.ipGuestDevicesDate !== today) {
      this.ipGuestDevices.clear();
      this.ipGuestDevicesDate = today;
    }

    if (!this.ipGuestDevices.has(ip)) {
      this.ipGuestDevices.set(ip, new Set());
    }
    
    const devices = this.ipGuestDevices.get(ip)!;
    
    // Allow if already tracked
    if (devices.has(deviceId)) return true;
    
    // Reject if at/over limit
    if (devices.size >= this.IP_DEVICE_LIMIT) {
      winstonLogger.warn(`[GUEST_SECURITY] IP ${ip} exceeded guest device limit (${this.IP_DEVICE_LIMIT}). Rejected deviceId: ${deviceId}`);
      return false;
    }
    
    // Add new device
    devices.add(deviceId);
    return true;
  }

  private betaHeaderGrantsUnlimited(
    userId: string | null,
    betaCode: string | undefined,
    feature: 'search' | 'pnr' | 'live' | 'split'
  ): boolean {
    if (!betaCode) return false;
    if (betaService.hasUnlimitedAccess(betaCode, feature)) return true;
    if (userId && betaService.hasRedeemedCode(userId, betaCode)) {
      return betaService.hasUnlimitedAccess(betaCode, feature);
    }
    return false;
  }

  public async userHasActiveProSubscription(userId: string): Promise<boolean> {
    const user = await this.getUserById(userId);
    if (!user) return false;
    return this.isProPlanActive(user);
  }

  public async canUseFeature(userId: string | null, type: 'search' | 'pnr' | 'live', betaCode?: string, deviceId?: string) {
    if (userId && betaService.hasActiveRedemption(userId)) return true;
    if (this.betaHeaderGrantsUnlimited(userId, betaCode, type)) return true;
    
    // GUEST LOGIC
    if (!userId) {
        if (!deviceId) return false;
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

    if (user.isBlocked) return false;

    // Admin / beta / premium — never enforce daily caps
    if (this.userBypassesQuota(user) || this.isProPlanActive(user)) return true;

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

  public async canUseSplit(userId: string | null, betaCode?: string) {
    if (userId && betaService.hasActiveRedemption(userId)) return true;
    if (this.betaHeaderGrantsUnlimited(userId, betaCode, 'split')) return true;
    if (!userId) return false; // Guests cannot use split
    
    const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
    if (!UUID_REGEX.test(userId)) return false;

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

    if (user.isBlocked) return false;

    if (this.userBypassesQuota(user) || this.isProPlanActive(user)) return true;

    // Check if user has temporary split access
    if (user.splitAccessUntil && new Date(user.splitAccessUntil).getTime() > Date.now()) {
      return true;
    }

    return false;
  }

  public async incrementUsage(userId: string | null, type: 'search' | 'pnr' | 'live', betaCode?: string) {
    if (userId && betaService.hasActiveRedemption(userId)) return true;
    if (this.betaHeaderGrantsUnlimited(userId, betaCode, type)) return true;
    if (!userId) return false; // Handled by incrementGuestUsage now
    
    const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
    if (!UUID_REGEX.test(userId)) return false;

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
    if (this.isProPlanActive(user)) return true;

    // implicit reset removed

    // Increment usage
    const limit = await this.getEffectiveLimit(userId, user.planType, type);
    switch (type) {
      case 'search':
        if (user.dailySearchCount < limit) {
          user.dailySearchCount++;
          this.updateLocalUser(user);
          if (isSupabaseConfigured()) {
            userRepository.incrementUsage(user.id, 'searches').catch(e => winstonLogger.error(`[AUTH_PHASE1] Dual-write error: ${e.message}`));
            await userCache.invalidate(user.id);
          }
          this.saveUsers();
          return true;
        }
        break;
      case 'pnr':
        if (user.dailyPnrCount < limit) {
          user.dailyPnrCount++;
          this.updateLocalUser(user);
          if (isSupabaseConfigured()) {
            userRepository.incrementUsage(user.id, 'pnr').catch(e => winstonLogger.error(`[AUTH_PHASE1] Dual-write error: ${e.message}`));
            await userCache.invalidate(user.id);
          }
          this.saveUsers();
          return true;
        }
        break;
      case 'live':
        if (user.dailyLiveCount < limit) {
          user.dailyLiveCount++;
          this.updateLocalUser(user);
          if (isSupabaseConfigured()) {
            userRepository.incrementUsage(user.id, 'live').catch(e => winstonLogger.error(`[AUTH_PHASE1] Dual-write error: ${e.message}`));
            await userCache.invalidate(user.id);
          }
          this.saveUsers();
          return true;
        }
        break;
    }

    return false;
  }

  public async incrementGuestUsage(deviceId: string, type: 'search' | 'pnr' | 'live') {
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

  public async watchAd(userId: string | null, deviceId: string): Promise<{ success: boolean, message: string }> {
      const entity = userId ? await this.getUserById(userId) : this.getOrCreateGuest(deviceId);
      
      if (!entity) return { success: false, message: "Account not found" };
      
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

      if (userId) this.saveUsers();
      else this.saveGuests();

      return { success: true, message: "Ad watched successfully! +1 Search granted." };
  }

  public async getUserStatus(userId: string | null, betaCode?: string, deviceId?: string) {
    const isBeta = betaCode ? betaService.isValidCode(betaCode) : false;
    
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
          }
      }
      return null;
    }

    const user = await this.getUserById(userId);
    if (!user) return null;

    // Check expiry
    this.isProPlanActive(user); // Triggers downgrade if expired

    // implicit reset removed

    const isBetaUser =
      isBeta ||
      user.planType === 'beta' ||
      betaService.hasActiveRedemption(userId);
    const isUnlimited = isBetaUser || this.userBypassesQuota(user);
    const hasSplitAccess = isUnlimited || (await this.canUseSplit(userId, betaCode));
    let splitMinutesLeft = 0;

    if (hasSplitAccess && user.splitAccessUntil && !isUnlimited && !this.isProPlanActive(user)) {
      splitMinutesLeft = Math.max(0, Math.floor((new Date(user.splitAccessUntil).getTime() - Date.now()) / 60000));
    } else if (isUnlimited || this.isProPlanActive(user)) {
      splitMinutesLeft = 9999;
    }

    const searchLimit = isUnlimited ? 9999 : await this.getEffectiveLimit(userId, user.planType, 'search');
    const pnrLimit = isUnlimited ? 9999 : await this.getEffectiveLimit(userId, user.planType, 'pnr');
    const liveLimit = isUnlimited ? 9999 : await this.getEffectiveLimit(userId, user.planType, 'live');

    let threshold = 0.80;
    if (isSupabaseConfigured() && !isBetaUser) {
      try {
        const profileCacheKey = `quota_profile:${user.planType}`;
        let profile = cacheService.get<any>(profileCacheKey);
        if (profile === undefined) {
          profile = await quotaRepository.getProfile(user.planType);
          cacheService.set(profileCacheKey, profile || null, 1800);
        }
        if (profile && profile.warning_threshold) {
          threshold = Number(profile.warning_threshold);
        }
      } catch (e) {}
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

  public checkDeviceLock(deviceId: string, userId: string | null = null) {
    // Check if this device is already associated with another account
    const otherUser = this.users.find(u => u.deviceId === deviceId && u.id !== userId);
    return !!otherUser;
  }

  public async updateUserProfile(userId: string, updates: { fullName?: string; dob?: string; mobileNumber?: string; preferences?: { notifyEmail?: boolean; notifyBirthday?: boolean; notifyMarketing?: boolean } }): Promise<User> {
    const user = await this.getUserById(userId);
    if (!user) throw new Error('User not found');

    if (updates.fullName !== undefined) user.fullName = updates.fullName;
    if (updates.dob !== undefined) user.dob = updates.dob;
    
    if (updates.preferences !== undefined) {
      if (updates.preferences.notifyEmail !== undefined) user.notifyEmail = !!updates.preferences.notifyEmail;
      if (updates.preferences.notifyBirthday !== undefined) user.notifyBirthday = !!updates.preferences.notifyBirthday;
      if (updates.preferences.notifyMarketing !== undefined) user.notifyMarketing = !!updates.preferences.notifyMarketing;
    }

    if (updates.mobileNumber !== undefined) {
      if (updates.mobileNumber !== user.mobileNumber) {
        user.mobileNumber = updates.mobileNumber;
        user.mobileVerified = false;
        user.mobileVerificationMethod = null;
        user.mobileVerifiedAt = null;
      }
    }

    if (isSupabaseConfigured()) {
      try {
        await userRepository.update(userId, {
          fullName: user.fullName,
          dob: user.dob,
          mobileNumber: user.mobileNumber,
          mobileVerified: user.mobileVerified,
          mobileVerificationMethod: user.mobileVerificationMethod,
          mobileVerifiedAt: user.mobileVerifiedAt
        });
      } catch (err: any) {
        winstonLogger.error(`[AUTH_SUPABASE] Failed to sync updateUserProfile to Supabase: ${err.message}`);
        throw new Error(`Profile persistence failed: ${err.message}`);
      }
      await userCache.invalidate(userId);
    }

    this.updateLocalUser(user);
    this.saveUsers();
    return user;
  }

  public async sendMobileOtp(userId: string, mobileNumber: string): Promise<boolean> {
    const user = await this.getUserById(userId);
    if (!user) throw new Error('User not found');
    
    // Check if mobile number is already verified on another account
    const existing = this.users.find(u => u.mobileNumber === mobileNumber && u.mobileVerified && u.id !== userId);
    if (existing) throw new Error('Mobile number already verified on another account');

    // Generate 6-digit OTP code
    const otp = Math.floor(100000 + Math.random() * 900000).toString();
    this.mobileOtps[userId] = {
      otp,
      mobileNumber,
      expiresAt: Date.now() + 5 * 60 * 1000, // 5 minutes expiry
      attempts: 0
    };

    const { smsService } = await import('./smsService');
    const sent = await smsService.sendSmsOtp(mobileNumber, otp);
    if (!sent) throw new Error('Failed to send SMS OTP. Please try again.');
    return true;
  }

  public async verifyMobileOtp(userId: string, otpCode: string): Promise<boolean> {
    const user = await this.getUserById(userId);
    if (!user) throw new Error('User not found');

    const record = this.mobileOtps[userId];
    if (!record) throw new Error('No OTP sent for this user');

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
    if (isSupabaseConfigured()) {
      try {
        await userRepository.update(userId, {
          mobileNumber: user.mobileNumber,
          mobileVerified: user.mobileVerified,
          mobileVerificationMethod: user.mobileVerificationMethod,
          mobileVerifiedAt: user.mobileVerifiedAt
        });
      } catch (err: any) {
        winstonLogger.error(`[AUTH_SUPABASE] Failed to sync mobile verification to Supabase: ${err.message}`);
      }
      await userCache.invalidate(userId);
    }
    
    this.updateLocalUser(user);
    this.saveUsers();
    return true;
  }

  private sanitizeUser(user: User) {
    const { password, ...rest } = user;
    return rest;
  }
}

export const authService = new AuthService();
