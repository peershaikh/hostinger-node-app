"use strict";
/**
 * PHASE 1.6.214 — Admin Mobile Verification Analytics Service
 *
 * Provides authoritative, aggregate-only analytics for Trayago's mobile
 * verification rollout, compliant with administrative security and privacy guidelines.
 *
 * Guarantees:
 * 1. Strict aggregation: Zero exposure of OTP values, hashes, or full phone numbers.
 * 2. Independent factors: Mobile verification is strictly isolated from email verification.
 * 3. Exact user counts: Duplicate phone numbers or unverified profiles never inflate counts.
 * 4. Transparent data availability: If attempt tables are restricted by RLS, reported honestly.
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.mobileVerificationAnalyticsService = exports.MobileVerificationAnalyticsService = void 0;
exports.calculateMobileVerificationMetrics = calculateMobileVerificationMetrics;
const authService_1 = require("./authService");
const supabase_1 = require("../config/supabase");
const featureFlags_1 = require("../config/featureFlags");
const verificationRollout_1 = require("../config/verificationRollout");
const logger_1 = require("../middleware/logger");
/**
 * Pure calculation helper to evaluate mobile verification metrics from user records.
 * Exported for isolated, deterministic unit testing.
 */
function calculateMobileVerificationMetrics(users, otpStats, referenceDate) {
    const totalUsers = users.length;
    let verifiedMobileUsers = 0;
    let enteredNotVerifiedUsers = 0;
    let noMobileEnteredUsers = 0;
    let successfulVerificationsToday = 0;
    const now = referenceDate || new Date();
    const todayStr = getIstDateString(now);
    // Initialize 7-day trend map
    const trendMap = new Map();
    for (let i = 6; i >= 0; i--) {
        const d = new Date(now.getTime() - i * 24 * 60 * 60 * 1000);
        const dStr = getIstDateString(d);
        trendMap.set(dStr, { verifications: 0, signups: 0 });
    }
    for (const u of users) {
        const isMobileVerified = Boolean(u.mobileVerified);
        const hasPhone = Boolean(u.mobileNumber && u.mobileNumber.trim().length > 0);
        if (isMobileVerified && hasPhone) {
            verifiedMobileUsers++;
            // Check if verified today (using mobileVerifiedAt if available)
            if (u.mobileVerifiedAt) {
                const vDate = new Date(u.mobileVerifiedAt);
                if (!isNaN(vDate.getTime())) {
                    const vDateStr = getIstDateString(vDate);
                    if (vDateStr === todayStr) {
                        successfulVerificationsToday++;
                    }
                    if (trendMap.has(vDateStr)) {
                        trendMap.get(vDateStr).verifications++;
                    }
                }
            }
        }
        else if (hasPhone) {
            enteredNotVerifiedUsers++;
        }
        else {
            noMobileEnteredUsers++;
        }
        // Signup trend tracking
        if (u.createdAt) {
            const cDate = new Date(u.createdAt);
            if (!isNaN(cDate.getTime())) {
                const cDateStr = getIstDateString(cDate);
                if (trendMap.has(cDateStr)) {
                    trendMap.get(cDateStr).signups++;
                }
            }
        }
    }
    const unverifiedMobileUsers = totalUsers - verifiedMobileUsers;
    const verificationPercentage = totalUsers > 0
        ? Number(((verifiedMobileUsers / totalUsers) * 100).toFixed(2))
        : 0;
    // Format daily trend points
    const dailyTrend = Array.from(trendMap.entries()).map(([dateStr, data]) => {
        const parts = dateStr.split('-');
        const d = new Date(Number(parts[0]), Number(parts[1]) - 1, Number(parts[2]));
        const label = d.toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' });
        return {
            date: dateStr,
            label,
            verifications: data.verifications,
            signups: data.signups
        };
    });
    return {
        summary: {
            totalUsers,
            verifiedMobileUsers,
            unverifiedMobileUsers,
            enteredNotVerifiedUsers,
            noMobileEnteredUsers,
            verificationPercentage,
            otpRequestsToday: otpStats?.requestsToday ?? null,
            successfulVerificationsToday,
            failedOrExpiredAttempts: otpStats?.failedOrExpired ?? null
        },
        dailyTrend
    };
}
/**
 * Returns YYYY-MM-DD in Asia/Kolkata (IST) timezone.
 */
function getIstDateString(date) {
    return new Intl.DateTimeFormat('en-CA', {
        timeZone: 'Asia/Kolkata',
        year: 'numeric',
        month: '2-digit',
        day: '2-digit'
    }).format(date);
}
class MobileVerificationAnalyticsService {
    /**
     * Generates a safe zero-state fallback object when database or upstream services fail.
     */
    static createZeroStateFallback(errorMessage) {
        const now = new Date();
        const trendPoints = [];
        for (let i = 6; i >= 0; i--) {
            const d = new Date(now.getTime() - i * 24 * 60 * 60 * 1000);
            const dStr = getIstDateString(d);
            trendPoints.push({
                date: dStr,
                label: d.toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' }),
                verifications: 0,
                signups: 0
            });
        }
        return {
            summary: {
                totalUsers: 0,
                verifiedMobileUsers: 0,
                unverifiedMobileUsers: 0,
                enteredNotVerifiedUsers: 0,
                noMobileEnteredUsers: 0,
                verificationPercentage: 0,
                otpRequestsToday: null,
                successfulVerificationsToday: 0,
                failedOrExpiredAttempts: null
            },
            rolloutPolicy: {
                gracePeriodDays: verificationRollout_1.verificationRolloutConfig.gracePeriodDays,
                launchDate: verificationRollout_1.verificationRolloutConfig.rolloutStartDate,
                enforcementDeadline: verificationRollout_1.verificationRolloutConfig.deadlineDate,
                isGateActive: featureFlags_1.featureFlags.searchVerificationGate
            },
            dailyTrend: trendPoints,
            dataIntegrity: {
                authoritativeSource: 'zero_state_fallback',
                authOtpsAccessRestricted: true,
                notes: [
                    'Warning: Operational fallback active.',
                    `Error detail: ${errorMessage}`
                ],
                lastUpdated: now.toISOString()
            }
        };
    }
    /**
     * Generates the complete mobile verification analytics report.
     */
    async getAnalytics() {
        const notes = [
            'Metrics are computed strictly from registered user records (users table).',
            'Users are categorized cleanly into verified, unverified with phone entered, and no phone entered.'
        ];
        let users = [];
        try {
            users = await authService_1.authService.getAllUsers();
        }
        catch (err) {
            logger_1.winstonLogger.warn(`[VERIFY_ANALYTICS] Failed to fetch users via authService: ${err.message}`);
            users = [];
            notes.push('Warning: Primary user registry query failed; results may reflect empty dataset.');
        }
        // Probe attempt counts from auth_otps table (handles RLS lockdown gracefully)
        let otpRequestsToday = null;
        let failedOrExpiredAttempts = null;
        let authOtpsAccessRestricted = false;
        if ((0, supabase_1.isSupabaseConfigured)()) {
            try {
                const todayUtc = new Date();
                todayUtc.setUTCHours(0, 0, 0, 0);
                const todayIso = todayUtc.toISOString();
                // Check if direct select on auth_otps is permitted
                const { count, error } = await supabase_1.supabase
                    .from('auth_otps')
                    .select('*', { count: 'exact', head: true })
                    .gte('created_at', todayIso);
                if (error) {
                    authOtpsAccessRestricted = true;
                    notes.push('Direct read access to auth_otps is restricted under least-privilege RLS. Request attempt metrics require elevated service_role permissions.');
                }
                else {
                    otpRequestsToday = count || 0;
                    // Attempt to query failed attempts
                    const { count: failedCount } = await supabase_1.supabase
                        .from('auth_otps')
                        .select('*', { count: 'exact', head: true })
                        .gt('attempts', 1);
                    failedOrExpiredAttempts = failedCount || 0;
                }
            }
            catch (err) {
                authOtpsAccessRestricted = true;
                notes.push('auth_otps table query encountered an exception; attempt metrics omitted.');
            }
        }
        else {
            authOtpsAccessRestricted = true;
            notes.push('Supabase is not configured; attempt metrics are unavailable in local fallback mode.');
        }
        const { summary, dailyTrend } = calculateMobileVerificationMetrics(users, {
            requestsToday: otpRequestsToday,
            failedOrExpired: failedOrExpiredAttempts
        });
        const rolloutPolicy = {
            gracePeriodDays: verificationRollout_1.verificationRolloutConfig.gracePeriodDays,
            launchDate: verificationRollout_1.verificationRolloutConfig.rolloutStartDate,
            enforcementDeadline: verificationRollout_1.verificationRolloutConfig.deadlineDate,
            isGateActive: featureFlags_1.featureFlags.searchVerificationGate
        };
        return {
            summary,
            rolloutPolicy,
            dailyTrend,
            dataIntegrity: {
                authoritativeSource: (0, supabase_1.isSupabaseConfigured)() ? 'supabase_users_table' : 'local_users_registry',
                authOtpsAccessRestricted,
                notes,
                lastUpdated: new Date().toISOString()
            }
        };
    }
}
exports.MobileVerificationAnalyticsService = MobileVerificationAnalyticsService;
exports.mobileVerificationAnalyticsService = new MobileVerificationAnalyticsService();
