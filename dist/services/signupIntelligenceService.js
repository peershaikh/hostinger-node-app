"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.signupIntelligenceService = exports.SignupIntelligenceService = exports.SIGNUP_INTELLIGENCE_CONFIG = void 0;
const authService_1 = require("./authService");
const logger_1 = require("../middleware/logger");
// Configurable constants for observability heuristics
exports.SIGNUP_INTELLIGENCE_CONFIG = {
    SHARED_DEVICE_THRESHOLD: 3, // Accounts sharing same deviceId
    BURST_WINDOW_MS: 3 * 60 * 1000, // 3 minutes
    BURST_COUNT_THRESHOLD: 4, // 4 signups in 3 minutes
    UNVERIFIED_RATIO_ALERT_THRESHOLD: 0.70, // 70% unverified
    RECENT_USERS_LIMIT: 50
};
class SignupIntelligenceService {
    getIstDateString(date) {
        try {
            return date.toLocaleDateString('en-CA', { timeZone: 'Asia/Kolkata' });
        }
        catch {
            return date.toISOString().split('T')[0];
        }
    }
    parseUserDate(createdAt) {
        if (!createdAt)
            return null;
        const d = new Date(createdAt);
        return isNaN(d.getTime()) ? null : d;
    }
    async getSignupIntelligence(daysRange = 7) {
        const startTime = Date.now();
        const users = await authService_1.authService.getAllUsers();
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
        const trendMap = new Map();
        for (let i = rangeLength - 1; i >= 0; i--) {
            const d = new Date(now.getTime() - i * 24 * 60 * 60 * 1000);
            const dStr = this.getIstDateString(d);
            trendMap.set(dStr, { count: 0, verifiedCount: 0, proCount: 0 });
        }
        // Device ID and burst grouping maps
        const deviceMap = new Map(); // deviceId -> userEmails
        const validTimestampUsers = [];
        for (const u of users) {
            const isVerified = Boolean(u.mobileVerified);
            const isPro = Boolean(u.planType && (u.planType.includes('pro') || u.planType === 'paid'));
            const isFree = !u.planType || u.planType === 'free';
            const isBeta = Boolean(u.referralCode || u.referredBy);
            const isBlocked = Boolean(u.isBlocked);
            const isAdmin = Boolean(u.isAdmin);
            if (isVerified)
                verifiedCount++;
            else
                unverifiedCount++;
            if (isPro)
                proCount++;
            else if (isFree)
                freeCount++;
            if (isAdmin)
                adminCount++;
            if (isBeta)
                betaCount++;
            if (isBlocked)
                blockedCount++;
            if (u.deviceId && u.deviceId.trim()) {
                const devId = u.deviceId.trim();
                const existing = deviceMap.get(devId) || [];
                existing.push(u.email);
                deviceMap.set(devId, existing);
            }
            const uDate = this.parseUserDate(u.createdAt);
            if (!uDate)
                continue;
            validTimestampUsers.push({ date: uDate, user: u });
            const uDateStr = this.getIstDateString(uDate);
            // Trend bucket
            if (trendMap.has(uDateStr)) {
                const bucket = trendMap.get(uDateStr);
                bucket.count++;
                if (isVerified)
                    bucket.verifiedCount++;
                if (isPro)
                    bucket.proCount++;
            }
            // Today vs Yesterday
            if (uDateStr === todayStr)
                todayCount++;
            if (uDateStr === yesterdayStr)
                yesterdayCount++;
            // Rolling windows
            if (uDate >= sevenDaysAgo && uDate <= now)
                sevenDayTotal++;
            else if (uDate >= fourteenDaysAgo && uDate < sevenDaysAgo)
                priorSevenDayTotal++;
            if (uDate >= thirtyDaysAgo && uDate <= now)
                thirtyDayTotal++;
            else if (uDate >= sixtyDaysAgo && uDate < thirtyDaysAgo)
                priorThirtyDayTotal++;
        }
        // Growth computations
        const dayOverDayGrowthPercent = yesterdayCount > 0
            ? Math.round(((todayCount - yesterdayCount) / yesterdayCount) * 100)
            : (todayCount > 0 ? 100 : 0);
        const weekOverWeekGrowthPercent = priorSevenDayTotal > 0
            ? Math.round(((sevenDayTotal - priorSevenDayTotal) / priorSevenDayTotal) * 100)
            : (sevenDayTotal > 0 ? 100 : 0);
        // Format daily trend
        const dailyTrend = [];
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
        const riskSignals = [];
        // 1. Shared Device Signal
        let multiDeviceAccountCount = 0;
        for (const [deviceId, emails] of deviceMap.entries()) {
            if (emails.length >= exports.SIGNUP_INTELLIGENCE_CONFIG.SHARED_DEVICE_THRESHOLD) {
                multiDeviceAccountCount += emails.length;
            }
        }
        if (multiDeviceAccountCount > 0) {
            riskSignals.push({
                type: 'SHARED_DEVICE',
                severity: multiDeviceAccountCount >= 6 ? 'HIGH' : 'MEDIUM',
                title: 'Shared Device Signal',
                description: `${multiDeviceAccountCount} accounts are registered using shared hardware/device IDs (≥${exports.SIGNUP_INTELLIGENCE_CONFIG.SHARED_DEVICE_THRESHOLD} accounts per device).`,
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
                if (windowStart - validTimestampUsers[j].date.getTime() <= exports.SIGNUP_INTELLIGENCE_CONFIG.BURST_WINDOW_MS) {
                    clusterCount++;
                }
                else {
                    break;
                }
            }
            if (clusterCount >= exports.SIGNUP_INTELLIGENCE_CONFIG.BURST_COUNT_THRESHOLD) {
                rapidBurstEvents++;
                i += clusterCount - 1; // jump forward
            }
        }
        if (rapidBurstEvents > 0) {
            riskSignals.push({
                type: 'RAPID_BURST',
                severity: 'MEDIUM',
                title: 'Rapid Signup Burst',
                description: `Detected ${rapidBurstEvents} high-velocity registration cluster(s) with ≥${exports.SIGNUP_INTELLIGENCE_CONFIG.BURST_COUNT_THRESHOLD} signups within 3 minutes.`,
                count: rapidBurstEvents
            });
        }
        // 3. High Unverified Spike (if total users > 5 and > 70% unverified)
        const totalUsers = users.length;
        const verifiedPercent = totalUsers > 0 ? Math.round((verifiedCount / totalUsers) * 100) : 0;
        const unverifiedPercent = 100 - verifiedPercent;
        if (totalUsers >= 5 && (unverifiedCount / totalUsers) >= exports.SIGNUP_INTELLIGENCE_CONFIG.UNVERIFIED_RATIO_ALERT_THRESHOLD) {
            riskSignals.push({
                type: 'UNVERIFIED_SPIKE',
                severity: 'LOW',
                title: 'Unverified Signup Spike',
                description: `${unverifiedPercent}% of total accounts have not completed mobile OTP verification.`,
                count: unverifiedCount
            });
        }
        // ── Recent User Feed ─────────────────────────────────────────────────────
        const recentUsers = validTimestampUsers
            .slice(0, exports.SIGNUP_INTELLIGENCE_CONFIG.RECENT_USERS_LIMIT)
            .map(({ user }) => {
            let maskedDev = null;
            if (user.deviceId) {
                maskedDev = user.deviceId.length > 8
                    ? `${user.deviceId.slice(0, 4)}...${user.deviceId.slice(-4)}`
                    : user.deviceId;
            }
            const devType = user.deviceType || (user.deviceId?.startsWith('dev_') ? 'desktop' : 'mobile');
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
                isAdmin: Boolean(user.isAdmin),
                deviceType: devType,
                platform: user.platform || (devType === 'mobile' ? 'Android' : 'Windows'),
                browser: user.browser || 'Chrome',
                clientType: user.clientType || (devType === 'mobile' ? 'mobile_web' : 'desktop_web'),
                state: user.signupState
            };
        });
        // ── Device & Platform Intelligence ───────────────────────────────────────
        let totalMobile = 0;
        let totalDesktop = 0;
        let totalTablet = 0;
        const platformMap = new Map();
        for (const u of users) {
            const cat = u.deviceType || (u.deviceId?.startsWith('dev_') ? 'desktop' : 'mobile');
            if (cat === 'mobile')
                totalMobile++;
            else if (cat === 'tablet')
                totalTablet++;
            else
                totalDesktop++;
            const p = u.platform || (cat === 'mobile' ? 'Android' : 'Windows');
            platformMap.set(p, (platformMap.get(p) || 0) + 1);
        }
        const totalDevCount = users.length || 1;
        const mobilePercent = Math.round((totalMobile / totalDevCount) * 100);
        const desktopPercent = Math.round((totalDesktop / totalDevCount) * 100);
        const tabletPercent = Math.max(0, 100 - mobilePercent - desktopPercent);
        const deviceDistribution = {
            isAvailable: users.length > 0,
            totalMobile,
            totalDesktop,
            totalTablet,
            mobilePercent,
            desktopPercent,
            tabletPercent,
            devices: [
                { category: 'mobile', label: 'Mobile Phone', count: totalMobile, percentage: mobilePercent },
                { category: 'desktop', label: 'PC / Desktop', count: totalDesktop, percentage: desktopPercent },
                { category: 'tablet', label: 'Tablet', count: totalTablet, percentage: tabletPercent },
            ],
            platforms: Array.from(platformMap.entries())
                .sort((a, b) => b[1] - a[1])
                .map(([platform, count]) => ({
                platform,
                count,
                percentage: Math.round((count / totalDevCount) * 100)
            }))
        };
        // ── Age Group Analytics (derived safely from DOB) ───────────────────────
        const ageGroupCounts = {
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
            let age = null;
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
            let groupKey = 'UNKNOWN';
            if (age !== null) {
                totalUsersWithAge++;
                if (age < 18)
                    groupKey = 'UNDER_18';
                else if (age <= 24)
                    groupKey = '18_24';
                else if (age <= 34)
                    groupKey = '25_34';
                else if (age <= 44)
                    groupKey = '35_44';
                else if (age <= 54)
                    groupKey = '45_54';
                else
                    groupKey = '55_PLUS';
            }
            else {
                totalUsersWithoutAge++;
            }
            const uDate = this.parseUserDate(u.createdAt);
            const isToday = uDate ? this.getIstDateString(uDate) === todayStr : false;
            const is7d = uDate ? (uDate >= sevenDaysAgo && uDate <= now) : false;
            const is30d = uDate ? (uDate >= thirtyDaysAgo && uDate <= now) : false;
            ageGroupCounts[groupKey].total++;
            if (isToday)
                ageGroupCounts[groupKey].today++;
            if (is7d)
                ageGroupCounts[groupKey].sevenDay++;
            if (is30d)
                ageGroupCounts[groupKey].thirtyDay++;
        }
        const totalUsersCount = users.length || 1;
        const ageGroupLabels = {
            UNDER_18: 'Under 18',
            '18_24': '18 - 24 years',
            '25_34': '25 - 34 years',
            '35_44': '35 - 44 years',
            '45_54': '45 - 54 years',
            '55_PLUS': '55+ years',
            UNKNOWN: 'Unknown / Not Provided'
        };
        const ageGroupDistribution = {
            isAvailable: totalUsersWithAge > 0,
            totalUsersWithAge,
            totalUsersWithoutAge,
            groups: ['UNDER_18', '18_24', '25_34', '35_44', '45_54', '55_PLUS', 'UNKNOWN'].map(key => ({
                groupKey: key,
                label: ageGroupLabels[key],
                todayCount: ageGroupCounts[key].today,
                sevenDayCount: ageGroupCounts[key].sevenDay,
                thirtyDayCount: ageGroupCounts[key].thirtyDay,
                percentage: Math.round((ageGroupCounts[key].total / totalUsersCount) * 100)
            }))
        };
        // ── State-Wise Signup Analytics ──────────────────────────────────────
        const stateCounts = new Map();
        let totalWithState = 0;
        for (const u of users) {
            if (u.signupState) {
                totalWithState++;
                const st = u.signupState.trim();
                const current = stateCounts.get(st) || { today: 0, sevenDay: 0, thirtyDay: 0, total: 0 };
                current.total++;
                const uDate = this.parseUserDate(u.createdAt);
                if (uDate) {
                    if (this.getIstDateString(uDate) === todayStr)
                        current.today++;
                    if (uDate >= sevenDaysAgo && uDate <= now)
                        current.sevenDay++;
                    if (uDate >= thirtyDaysAgo && uDate <= now)
                        current.thirtyDay++;
                }
                stateCounts.set(st, current);
            }
        }
        const topStatesList = Array.from(stateCounts.entries())
            .sort((a, b) => b[1].total - a[1].total)
            .slice(0, 10)
            .map(([state, counts]) => ({
            state,
            todayCount: counts.today,
            sevenDayCount: counts.sevenDay,
            thirtyDayCount: counts.thirtyDay,
            percentage: Math.round((counts.total / (totalUsersCount || 1)) * 100)
        }));
        const stateDistribution = {
            isAvailable: totalWithState > 0,
            source: totalWithState > 0 ? 'IP_GEO_HEADERS' : 'NOT_AVAILABLE',
            topStates: topStatesList,
            unknownCount: {
                todayCount: Math.max(0, todayCount - Array.from(stateCounts.values()).reduce((sum, c) => sum + c.today, 0)),
                sevenDayCount: Math.max(0, sevenDayTotal - Array.from(stateCounts.values()).reduce((sum, c) => sum + c.sevenDay, 0)),
                thirtyDayCount: Math.max(0, thirtyDayTotal - Array.from(stateCounts.values()).reduce((sum, c) => sum + c.thirtyDay, 0)),
                percentage: Math.max(0, 100 - Math.round((totalWithState / (totalUsersCount || 1)) * 100))
            },
            distribution: topStatesList.length > 0 ? topStatesList : [
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
        logger_1.winstonLogger.debug(`[SIGNUP_INTELLIGENCE] Computed metrics for ${users.length} users in ${elapsedMs}ms`);
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
            deviceDistribution,
            stateDistribution,
            ageGroupDistribution,
            riskSignals,
            recentUsers,
            timezone: 'Asia/Kolkata (IST)',
            generatedAt: now.toISOString()
        };
    }
}
exports.SignupIntelligenceService = SignupIntelligenceService;
exports.signupIntelligenceService = new SignupIntelligenceService();
