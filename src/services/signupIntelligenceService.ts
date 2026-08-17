import { authService, User } from './authService';
import { winstonLogger } from '../middleware/logger';

export interface DailySignupMetricPoint {
  date: string;
  label: string;
  count: number;
  verifiedCount: number;
  proCount: number;
}

export interface UserQualityBreakdown {
  totalUsers: number;
  verifiedCount: number;
  unverifiedCount: number;
  verifiedPercent: number;
  freeCount: number;
  proCount: number;
  adminCount: number;
  betaCount: number;
  blockedCount: number;
}

export interface SignupRiskSignal {
  type: 'SHARED_DEVICE' | 'RAPID_BURST' | 'UNVERIFIED_SPIKE';
  severity: 'LOW' | 'MEDIUM' | 'HIGH';
  title: string;
  description: string;
  count: number;
  metadata?: Record<string, any>;
}

export interface SanitizedNewUser {
  id: string;
  email: string;
  createdAt: string;
  planType: string;
  isVerified: boolean;
  referredBy?: string | null;
  referralCode?: string;
  maskedDeviceId?: string | null;
  isBlocked: boolean;
  isAdmin: boolean;
}

export interface StateSignupMetric {
  state: string;
  todayCount: number;
  sevenDayCount: number;
  thirtyDayCount: number;
  percentage: number;
}

export interface StateSignupData {
  isAvailable: boolean;
  source: string;
  topStates: StateSignupMetric[];
  unknownCount: {
    todayCount: number;
    sevenDayCount: number;
    thirtyDayCount: number;
    percentage: number;
  };
  distribution: StateSignupMetric[];
}

export type AgeGroupKey = 'UNDER_18' | '18_24' | '25_34' | '35_44' | '45_54' | '55_PLUS' | 'UNKNOWN';

export interface AgeGroupMetric {
  groupKey: AgeGroupKey;
  label: string;
  todayCount: number;
  sevenDayCount: number;
  thirtyDayCount: number;
  percentage: number;
}

export interface AgeAnalyticsData {
  isAvailable: boolean;
  totalUsersWithAge: number;
  totalUsersWithoutAge: number;
  groups: AgeGroupMetric[];
}

export interface SignupIntelligenceData {
  metrics: {
    todayCount: number;
    yesterdayCount: number;
    sevenDayTotal: number;
    thirtyDayTotal: number;
    dayOverDayGrowthPercent: number;
    weekOverWeekGrowthPercent: number;
  };
  dailyTrend: DailySignupMetricPoint[];
  qualityBreakdown: UserQualityBreakdown;
  stateDistribution: StateSignupData;
  ageGroupDistribution: AgeAnalyticsData;
  riskSignals: SignupRiskSignal[];
  recentUsers: SanitizedNewUser[];
  timezone: string;
  generatedAt: string;
}

// Configurable constants for observability heuristics
export const SIGNUP_INTELLIGENCE_CONFIG = {
  SHARED_DEVICE_THRESHOLD: 3, // Accounts sharing same deviceId
  BURST_WINDOW_MS: 3 * 60 * 1000, // 3 minutes
  BURST_COUNT_THRESHOLD: 4, // 4 signups in 3 minutes
  UNVERIFIED_RATIO_ALERT_THRESHOLD: 0.70, // 70% unverified
  RECENT_USERS_LIMIT: 50
};

export class SignupIntelligenceService {
  private getIstDateString(date: Date): string {
    try {
      return date.toLocaleDateString('en-CA', { timeZone: 'Asia/Kolkata' });
    } catch {
      return date.toISOString().split('T')[0];
    }
  }

  private parseUserDate(createdAt: string | undefined): Date | null {
    if (!createdAt) return null;
    const d = new Date(createdAt);
    return isNaN(d.getTime()) ? null : d;
  }

  public async getSignupIntelligence(daysRange: number = 7): Promise<SignupIntelligenceData> {
    const startTime = Date.now();
    const users = await authService.getAllUsers();

    const now = new Date();
    const todayStr = this.getIstDateString(now);

    const yesterdayDate = new Date(now.getTime() - 24 * 60 * 60 * 1000);
    const yesterdayStr = this.getIstDateString(yesterdayDate);

    // Build rolling day intervals
    const sevenDaysAgo = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
    const fourteenDaysAgo = new Date(now.getTime() - 14 * 24 * 60 * 60 * 1000);
    const thirtyDaysAgo = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);
    const sixtyDaysAgo = new Date(now.getTime() - 60 * 24 * 60 * 60 * 1000);

    // Counters
    let todayCount = 0;
    let yesterdayCount = 0;
    let sevenDayTotal = 0;
    let priorSevenDayTotal = 0;
    let thirtyDayTotal = 0;
    let priorThirtyDayTotal = 0;

    let verifiedCount = 0;
    let unverifiedCount = 0;
    let freeCount = 0;
    let proCount = 0;
    let adminCount = 0;
    let betaCount = 0;
    let blockedCount = 0;

    // Date bucket map for trend
    const rangeLength = Math.max(7, Math.min(daysRange, 30));
    const trendMap: Map<string, { count: number; verifiedCount: number; proCount: number }> = new Map();

    for (let i = rangeLength - 1; i >= 0; i--) {
      const d = new Date(now.getTime() - i * 24 * 60 * 60 * 1000);
      const dStr = this.getIstDateString(d);
      trendMap.set(dStr, { count: 0, verifiedCount: 0, proCount: 0 });
    }

    // Device ID and burst grouping maps
    const deviceMap = new Map<string, string[]>(); // deviceId -> userEmails
    const validTimestampUsers: { date: Date; user: User }[] = [];

    for (const u of users) {
      const isVerified = Boolean(u.mobileVerified);
      const isPro = Boolean(u.planType && (u.planType.includes('pro') || u.planType === 'paid'));
      const isFree = !u.planType || u.planType === 'free';
      const isBeta = Boolean(u.referralCode || u.referredBy);
      const isBlocked = Boolean(u.isBlocked);
      const isAdmin = Boolean(u.isAdmin);

      if (isVerified) verifiedCount++;
      else unverifiedCount++;

      if (isPro) proCount++;
      else if (isFree) freeCount++;

      if (isAdmin) adminCount++;
      if (isBeta) betaCount++;
      if (isBlocked) blockedCount++;

      if (u.deviceId && u.deviceId.trim()) {
        const devId = u.deviceId.trim();
        const existing = deviceMap.get(devId) || [];
        existing.push(u.email);
        deviceMap.set(devId, existing);
      }

      const uDate = this.parseUserDate(u.createdAt);
      if (!uDate) continue;

      validTimestampUsers.push({ date: uDate, user: u });

      const uDateStr = this.getIstDateString(uDate);

      // Trend bucket
      if (trendMap.has(uDateStr)) {
        const bucket = trendMap.get(uDateStr)!;
        bucket.count++;
        if (isVerified) bucket.verifiedCount++;
        if (isPro) bucket.proCount++;
      }

      // Today vs Yesterday
      if (uDateStr === todayStr) todayCount++;
      if (uDateStr === yesterdayStr) yesterdayCount++;

      // Rolling windows
      if (uDate >= sevenDaysAgo && uDate <= now) sevenDayTotal++;
      else if (uDate >= fourteenDaysAgo && uDate < sevenDaysAgo) priorSevenDayTotal++;

      if (uDate >= thirtyDaysAgo && uDate <= now) thirtyDayTotal++;
      else if (uDate >= sixtyDaysAgo && uDate < thirtyDaysAgo) priorThirtyDayTotal++;
    }

    // Growth computations
    const dayOverDayGrowthPercent = yesterdayCount > 0
      ? Math.round(((todayCount - yesterdayCount) / yesterdayCount) * 100)
      : (todayCount > 0 ? 100 : 0);

    const weekOverWeekGrowthPercent = priorSevenDayTotal > 0
      ? Math.round(((sevenDayTotal - priorSevenDayTotal) / priorSevenDayTotal) * 100)
      : (sevenDayTotal > 0 ? 100 : 0);

    // Format daily trend
    const dailyTrend: DailySignupMetricPoint[] = [];
    for (const [dateStr, val] of trendMap.entries()) {
      const parts = dateStr.split('-');
      const monthNames = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
      const mIdx = parseInt(parts[1], 10) - 1;
      const label = `${parts[2]} ${monthNames[mIdx] || ''}`;

      dailyTrend.push({
        date: dateStr,
        label,
        count: val.count,
        verifiedCount: val.verifiedCount,
        proCount: val.proCount
      });
    }

    // ── Risk Signals & Anomaly Detection ─────────────────────────────────────
    const riskSignals: SignupRiskSignal[] = [];

    // 1. Shared Device Signal
    let multiDeviceAccountCount = 0;
    for (const [deviceId, emails] of deviceMap.entries()) {
      if (emails.length >= SIGNUP_INTELLIGENCE_CONFIG.SHARED_DEVICE_THRESHOLD) {
        multiDeviceAccountCount += emails.length;
      }
    }
    if (multiDeviceAccountCount > 0) {
      riskSignals.push({
        type: 'SHARED_DEVICE',
        severity: multiDeviceAccountCount >= 6 ? 'HIGH' : 'MEDIUM',
        title: 'Shared Device Signal',
        description: `${multiDeviceAccountCount} accounts are registered using shared hardware/device IDs (≥${SIGNUP_INTELLIGENCE_CONFIG.SHARED_DEVICE_THRESHOLD} accounts per device).`,
        count: multiDeviceAccountCount
      });
    }

    // 2. Rapid Signup Burst Check (in last 24 hours)
    validTimestampUsers.sort((a, b) => b.date.getTime() - a.date.getTime());
    let rapidBurstEvents = 0;
    for (let i = 0; i < validTimestampUsers.length; i++) {
      const windowStart = validTimestampUsers[i].date.getTime();
      let clusterCount = 1;
      for (let j = i + 1; j < validTimestampUsers.length; j++) {
        if (windowStart - validTimestampUsers[j].date.getTime() <= SIGNUP_INTELLIGENCE_CONFIG.BURST_WINDOW_MS) {
          clusterCount++;
        } else {
          break;
        }
      }
      if (clusterCount >= SIGNUP_INTELLIGENCE_CONFIG.BURST_COUNT_THRESHOLD) {
        rapidBurstEvents++;
        i += clusterCount - 1; // jump forward
      }
    }
    if (rapidBurstEvents > 0) {
      riskSignals.push({
        type: 'RAPID_BURST',
        severity: 'MEDIUM',
        title: 'Rapid Signup Burst',
        description: `Detected ${rapidBurstEvents} high-velocity registration cluster(s) with ≥${SIGNUP_INTELLIGENCE_CONFIG.BURST_COUNT_THRESHOLD} signups within 3 minutes.`,
        count: rapidBurstEvents
      });
    }

    // 3. High Unverified Spike (if total users > 5 and > 70% unverified)
    const totalUsers = users.length;
    const verifiedPercent = totalUsers > 0 ? Math.round((verifiedCount / totalUsers) * 100) : 0;
    const unverifiedPercent = 100 - verifiedPercent;

    if (totalUsers >= 5 && (unverifiedCount / totalUsers) >= SIGNUP_INTELLIGENCE_CONFIG.UNVERIFIED_RATIO_ALERT_THRESHOLD) {
      riskSignals.push({
        type: 'UNVERIFIED_SPIKE',
        severity: 'LOW',
        title: 'Unverified Signup Spike',
        description: `${unverifiedPercent}% of total accounts have not completed mobile OTP verification.`,
        count: unverifiedCount
      });
    }

    // ── Recent User Feed ─────────────────────────────────────────────────────
    const recentUsers: SanitizedNewUser[] = validTimestampUsers
      .slice(0, SIGNUP_INTELLIGENCE_CONFIG.RECENT_USERS_LIMIT)
      .map(({ user }) => {
        let maskedDev: string | null = null;
        if (user.deviceId) {
          maskedDev = user.deviceId.length > 8
            ? `${user.deviceId.slice(0, 4)}...${user.deviceId.slice(-4)}`
            : user.deviceId;
        }

        return {
          id: user.id,
          email: user.email,
          createdAt: user.createdAt,
          planType: user.planType || 'free',
          isVerified: Boolean(user.mobileVerified),
          referredBy: user.referredBy || null,
          referralCode: user.referralCode,
          maskedDeviceId: maskedDev,
          isBlocked: Boolean(user.isBlocked),
          isAdmin: Boolean(user.isAdmin)
        };
      });

    // ── Age Group Analytics (derived safely from DOB) ───────────────────────
    const ageGroupCounts: Record<AgeGroupKey, { today: number; sevenDay: number; thirtyDay: number; total: number }> = {
      UNDER_18: { today: 0, sevenDay: 0, thirtyDay: 0, total: 0 },
      '18_24': { today: 0, sevenDay: 0, thirtyDay: 0, total: 0 },
      '25_34': { today: 0, sevenDay: 0, thirtyDay: 0, total: 0 },
      '35_44': { today: 0, sevenDay: 0, thirtyDay: 0, total: 0 },
      '45_54': { today: 0, sevenDay: 0, thirtyDay: 0, total: 0 },
      '55_PLUS': { today: 0, sevenDay: 0, thirtyDay: 0, total: 0 },
      UNKNOWN: { today: 0, sevenDay: 0, thirtyDay: 0, total: 0 }
    };

    let totalUsersWithAge = 0;
    let totalUsersWithoutAge = 0;

    for (const u of users) {
      let age: number | null = null;
      if (u.dob && typeof u.dob === 'string') {
        const birthDate = new Date(u.dob);
        if (!isNaN(birthDate.getTime()) && birthDate.getTime() <= now.getTime()) {
          let calculatedAge = now.getFullYear() - birthDate.getFullYear();
          const m = now.getMonth() - birthDate.getMonth();
          if (m < 0 || (m === 0 && now.getDate() < birthDate.getDate())) {
            calculatedAge--;
          }
          if (calculatedAge >= 0 && calculatedAge <= 120) {
            age = calculatedAge;
          }
        }
      }

      let groupKey: AgeGroupKey = 'UNKNOWN';
      if (age !== null) {
        totalUsersWithAge++;
        if (age < 18) groupKey = 'UNDER_18';
        else if (age <= 24) groupKey = '18_24';
        else if (age <= 34) groupKey = '25_34';
        else if (age <= 44) groupKey = '35_44';
        else if (age <= 54) groupKey = '45_54';
        else groupKey = '55_PLUS';
      } else {
        totalUsersWithoutAge++;
      }

      const uDate = this.parseUserDate(u.createdAt);
      const isToday = uDate ? this.getIstDateString(uDate) === todayStr : false;
      const is7d = uDate ? (uDate >= sevenDaysAgo && uDate <= now) : false;
      const is30d = uDate ? (uDate >= thirtyDaysAgo && uDate <= now) : false;

      ageGroupCounts[groupKey].total++;
      if (isToday) ageGroupCounts[groupKey].today++;
      if (is7d) ageGroupCounts[groupKey].sevenDay++;
      if (is30d) ageGroupCounts[groupKey].thirtyDay++;
    }

    const totalUsersCount = users.length || 1;
    const ageGroupLabels: Record<AgeGroupKey, string> = {
      UNDER_18: 'Under 18',
      '18_24': '18 - 24 years',
      '25_34': '25 - 34 years',
      '35_44': '35 - 44 years',
      '45_54': '45 - 54 years',
      '55_PLUS': '55+ years',
      UNKNOWN: 'Unknown / Not Provided'
    };

    const ageGroupDistribution: AgeAnalyticsData = {
      isAvailable: totalUsersWithAge > 0,
      totalUsersWithAge,
      totalUsersWithoutAge,
      groups: (['UNDER_18', '18_24', '25_34', '35_44', '45_54', '55_PLUS', 'UNKNOWN'] as AgeGroupKey[]).map(key => ({
        groupKey: key,
        label: ageGroupLabels[key],
        todayCount: ageGroupCounts[key].today,
        sevenDayCount: ageGroupCounts[key].sevenDay,
        thirtyDayCount: ageGroupCounts[key].thirtyDay,
        percentage: Math.round((ageGroupCounts[key].total / totalUsersCount) * 100)
      }))
    };

    // ── State-Wise Signup Analytics (Audit: Canonical State field not yet in User Model) ──
    const stateDistribution: StateSignupData = {
      isAvailable: false,
      source: 'NOT_AVAILABLE',
      topStates: [],
      unknownCount: {
        todayCount,
        sevenDayCount: sevenDayTotal,
        thirtyDayCount: thirtyDayTotal,
        percentage: 100
      },
      distribution: [
        {
          state: 'Unknown / Not Provided',
          todayCount,
          sevenDayCount: sevenDayTotal,
          thirtyDayCount: thirtyDayTotal,
          percentage: 100
        }
      ]
    };

    const elapsedMs = Date.now() - startTime;
    winstonLogger.debug(`[SIGNUP_INTELLIGENCE] Computed metrics for ${users.length} users in ${elapsedMs}ms`);

    return {
      metrics: {
        todayCount,
        yesterdayCount,
        sevenDayTotal,
        thirtyDayTotal,
        dayOverDayGrowthPercent,
        weekOverWeekGrowthPercent
      },
      dailyTrend,
      qualityBreakdown: {
        totalUsers,
        verifiedCount,
        unverifiedCount,
        verifiedPercent,
        freeCount,
        proCount,
        adminCount,
        betaCount,
        blockedCount
      },
      stateDistribution,
      ageGroupDistribution,
      riskSignals,
      recentUsers,
      timezone: 'Asia/Kolkata (IST)',
      generatedAt: now.toISOString()
    };
  }
}

export const signupIntelligenceService = new SignupIntelligenceService();
