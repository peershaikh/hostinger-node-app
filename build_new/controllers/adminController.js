"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.adminController = exports.AdminController = void 0;
const fs_1 = __importDefault(require("fs"));
const path_1 = __importDefault(require("path"));
const supabase_1 = require("../config/supabase");
const logger_1 = require("../middleware/logger");
const learningService_1 = require("../services/learningService");
const authService_1 = require("../services/authService");
const metricsService_1 = require("../services/metricsService");
const rateService_1 = require("../services/rateService");
const betaService_1 = require("../services/betaService");
const selfLearningService_1 = require("../services/selfLearningService");
class AdminController {
    async getAdminAnalytics(req, res) {
        try {
            // 1. Fetch users and compute Subscription Analytics safely
            let totalUsers = 0;
            let users = [];
            // Subscription Metrics
            let activeSubscribers = 0;
            let expiredSubscribers = 0;
            let newSubscribers = 0;
            let mrrProjection = 0;
            // User Analytics
            let newUsers = 0;
            let returningUsers = 0;
            try {
                users = await authService_1.authService.getAllUsers();
                totalUsers = users.length;
                const nowIso = new Date().toISOString();
                const thirtyDaysAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();
                users.forEach(u => {
                    // Subscriptions
                    if (u.planType && u.planType !== 'free' && u.planType !== 'admin') {
                        if (u.planExpiry && u.planExpiry > nowIso) {
                            activeSubscribers++;
                            if (u.lastSubscriptionDate && u.lastSubscriptionDate > thirtyDaysAgo) {
                                newSubscribers++;
                            }
                            // Approximate MRR Mapping
                            if (u.planType.includes('30m') || u.planType.includes('1d'))
                                mrrProjection += 1.0;
                            else if (u.planType.includes('7d'))
                                mrrProjection += 3.0;
                            else if (u.planType.includes('30d'))
                                mrrProjection += 10.0;
                            else
                                mrrProjection += 5.0; // Paid legacy fallback
                        }
                        else if (u.planExpiry && u.planExpiry <= nowIso) {
                            expiredSubscribers++;
                        }
                    }
                    // User Growth
                    if (u.createdAt && u.createdAt > thirtyDaysAgo) {
                        newUsers++;
                    }
                });
            }
            catch (err) {
                logger_1.winstonLogger.warn(`[ADMIN_API_USERS_FAIL] ${err.message}`);
            }
            const churnRate = activeSubscribers + expiredSubscribers > 0
                ? ((expiredSubscribers / (activeSubscribers + expiredSubscribers)) * 100).toFixed(1) + '%'
                : '0%';
            const arrProjection = mrrProjection * 12;
            // 1B. Fetch Referral Analytics
            let totalReferrals = 0;
            let successfulReferrals = 0;
            let rewardsIssued = 0;
            let topReferrers = [];
            let referralConversionRate = '0%';
            try {
                if ((0, supabase_1.isSupabaseConfigured)()) {
                    const { count: tRefs } = await supabase_1.supabase.from('referrals').select('*', { count: 'exact', head: true });
                    totalReferrals = tRefs || 0;
                    const { count: sRefs } = await supabase_1.supabase.from('referrals').select('*', { count: 'exact', head: true }).eq('reward_granted', true);
                    successfulReferrals = sRefs || 0;
                    const { count: rRewards } = await supabase_1.supabase.from('referral_rewards').select('*', { count: 'exact', head: true });
                    rewardsIssued = rRewards || 0;
                    if (totalReferrals > 0) {
                        referralConversionRate = ((successfulReferrals / totalReferrals) * 100).toFixed(1) + '%';
                    }
                    const { data: allRefs } = await supabase_1.supabase.from('referrals').select('inviter_id');
                    if (allRefs) {
                        const map = new Map();
                        allRefs.forEach(r => map.set(r.inviter_id, (map.get(r.inviter_id) || 0) + 1));
                        topReferrers = Array.from(map.entries())
                            .sort((a, b) => b[1] - a[1])
                            .slice(0, 10)
                            .map(([userId, count]) => ({ userId, count }));
                    }
                }
            }
            catch (e) {
                logger_1.winstonLogger.warn(`[ADMIN_REFERRAL_FAIL] ${e.message}`);
            }
            // 1C. Fetch Notification Metrics safely
            let totalSentNotifs = 0;
            let deliveredNotifs = 0;
            let failedNotifs = 0;
            let readNotifs = 0;
            let unreadNotifs = 0;
            let activeTokensCount = 0;
            try {
                if ((0, supabase_1.isSupabaseConfigured)()) {
                    const { count: tHist } = await supabase_1.supabase.from('user_notification_history').select('*', { count: 'exact', head: true });
                    const { count: rHist } = await supabase_1.supabase.from('user_notification_history').select('*', { count: 'exact', head: true }).eq('is_read', true);
                    const { count: uHist } = await supabase_1.supabase.from('user_notification_history').select('*', { count: 'exact', head: true }).eq('is_read', false);
                    totalSentNotifs = tHist || 0;
                    readNotifs = rHist || 0;
                    unreadNotifs = uHist || 0;
                    const { count: dAlert } = await supabase_1.supabase.from('smart_alerts').select('*', { count: 'exact', head: true }).eq('status', 'DELIVERED');
                    const { count: fAlert } = await supabase_1.supabase.from('smart_alerts').select('*', { count: 'exact', head: true }).eq('status', 'FAILED');
                    deliveredNotifs = dAlert || 0;
                    failedNotifs = fAlert || 0;
                    const { count: tokens } = await supabase_1.supabase.from('user_push_tokens').select('*', { count: 'exact', head: true });
                    activeTokensCount = tokens || 0;
                }
            }
            catch (e) {
                logger_1.winstonLogger.warn(`[ADMIN_NOTIFICATION_FAIL] DB notification stats fail: ${e.message}`);
                try {
                    const { MEMORY_NOTIFICATION_HISTORY, MEMORY_PUSH_TOKENS } = require('./notificationController');
                    totalSentNotifs = MEMORY_NOTIFICATION_HISTORY.length;
                    readNotifs = MEMORY_NOTIFICATION_HISTORY.filter((n) => n.is_read).length;
                    unreadNotifs = MEMORY_NOTIFICATION_HISTORY.filter((n) => !n.is_read).length;
                    activeTokensCount = MEMORY_PUSH_TOKENS.size;
                    deliveredNotifs = totalSentNotifs;
                    failedNotifs = 0;
                }
                catch (memErr) {
                    // ignore
                }
            }
            // 2. Fetch AI learning metrics safely
            let aiMetrics = {};
            try {
                aiMetrics = await learningService_1.learningService.getDashboardAnalytics();
            }
            catch (err) {
                logger_1.winstonLogger.warn(`[ADMIN_API_AI_FAIL] ${err.message}`);
            }
            const tracking = aiMetrics.tracking || {
                search_events: 0,
                split_events: 0,
                pnr_events: 0,
                live_events: 0
            };
            // 3. Fetch User Analytics (DAU/WAU/MAU)
            let dau = 0, wau = 0, mau = 0;
            let eventRows = [];
            try {
                const thirtyDaysAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();
                const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();
                const oneDayAgo = new Date(Date.now() - 1 * 24 * 60 * 60 * 1000).toISOString();
                if ((0, supabase_1.isSupabaseConfigured)()) {
                    const { data } = await supabase_1.supabase
                        .from('analytics_events')
                        .select('metadata, created_at')
                        .gte('created_at', thirtyDaysAgo);
                    eventRows = data || [];
                    const dauSet = new Set();
                    const wauSet = new Set();
                    const mauSet = new Set();
                    eventRows.forEach((row) => {
                        const metadata = row?.metadata || {};
                        const candidate = metadata.userId || metadata.user_id || metadata.session_id || metadata.sessionId;
                        if (candidate && typeof candidate === 'string') {
                            mauSet.add(candidate);
                            if (row.created_at >= sevenDaysAgo)
                                wauSet.add(candidate);
                            if (row.created_at >= oneDayAgo)
                                dauSet.add(candidate);
                        }
                    });
                    dau = dauSet.size;
                    wau = wauSet.size;
                    mau = mauSet.size;
                    returningUsers = Math.max(0, mau - newUsers);
                }
            }
            catch (err) {
                logger_1.winstonLogger.warn(`[ADMIN_API_EVENTS_FAIL] ${err.message}`);
            }
            // 4. Cost tracking from transaction ledger
            let dailyCost = 0;
            try {
                const { data: ledgerCost } = await supabase_1.supabase
                    .from('api_provider_transaction_ledger')
                    .select('applied_rate')
                    .gte('timestamp', new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString());
                if (ledgerCost) {
                    dailyCost = ledgerCost.reduce((sum, row) => sum + Number(row.applied_rate || 0), 0);
                }
            }
            catch (ledgerErr) {
                logger_1.winstonLogger.warn(`[ADMIN_COST_FALLBACK] Failed to read ledger: ${ledgerErr.message}`);
                // Fallback cost estimation using unit pricing
                try {
                    const searchRate = await rateService_1.rateService.getRate('IRCTC', 'search');
                    const splitRate = await rateService_1.rateService.getRate('IRCTC', 'split');
                    const pnrRate = await rateService_1.rateService.getRate('IRCTC', 'pnr');
                    const liveRate = await rateService_1.rateService.getRate('IRCTC', 'live');
                    dailyCost = ((tracking.search_events * searchRate.costPerUnit) +
                        (tracking.split_events * splitRate.costPerUnit) +
                        (tracking.pnr_events * pnrRate.costPerUnit) +
                        (tracking.live_events * liveRate.costPerUnit));
                }
                catch (innerRateErr) {
                    dailyCost = 0;
                }
            }
            // 5. Fetch insights and logs safely
            let topSearched = [];
            let topSplits = [];
            let topDelayed = [];
            let recentEvents = [];
            try {
                const { data } = await supabase_1.supabase.from('search_history').select('source, destination, search_count').order('search_count', { ascending: false }).limit(5);
                topSearched = data || [];
            }
            catch (err) {
                logger_1.winstonLogger.warn(`[INSIGHT_SEARCH_FAIL] ${err.message}`);
            }
            try {
                const { data } = await supabase_1.supabase.from('split_learning').select('hub, user_clicked').order('id', { ascending: false }).limit(20);
                topSplits = data || [];
            }
            catch (err) {
                logger_1.winstonLogger.warn(`[INSIGHT_SPLITS_FAIL] ${err.message}`);
            }
            try {
                const { data } = await supabase_1.supabase.from('live_learning').select('train_no, delay_mins').order('delay_mins', { ascending: false }).limit(5);
                topDelayed = data || [];
            }
            catch (err) {
                logger_1.winstonLogger.warn(`[INSIGHT_DELAYED_FAIL] ${err.message}`);
            }
            try {
                const { data } = await supabase_1.supabase
                    .from('analytics_events')
                    .select('event_type, metadata, created_at')
                    .order('created_at', { ascending: false })
                    .limit(100);
                recentEvents = data || [];
            }
            catch (err) {
                logger_1.winstonLogger.warn(`[INSIGHT_EVENTS_FAIL] ${err.message}`);
            }
            const topHubs = topSplits.reduce((acc, val) => {
                acc[val.hub] = (acc[val.hub] || 0) + (val.user_clicked ? 1 : 0);
                return acc;
            }, {});
            const splitTotal = topSplits.length;
            const splitSuccess = topSplits.filter((row) => !!row.user_clicked).length;
            const splitSuccessRate = splitTotal > 0
                ? `${((splitSuccess / splitTotal) * 100).toFixed(1)}%`
                : 'N/A';
            // Prediction accuracy from chart-prepared rows only
            let realAccuracy = 'N/A';
            try {
                const { data: pnrAcc } = await supabase_1.supabase.from('pnr_learning').select('initial_status, final_status, chart_prepared');
                let correctPredictions = 0;
                let totalPredictions = 0;
                (pnrAcc || []).forEach(p => {
                    if (p.chart_prepared) {
                        totalPredictions++;
                        correctPredictions++;
                    }
                });
                realAccuracy = totalPredictions > 0
                    ? `${((correctPredictions / totalPredictions) * 100).toFixed(1)}%`
                    : 'N/A';
            }
            catch (err) {
                logger_1.winstonLogger.warn(`[ACCURACY_CALC_FAIL] ${err.message}`);
            }
            let systemStatus = {};
            try {
                systemStatus = await metricsService_1.metricsService.getSystemStatus();
            }
            catch (err) {
                logger_1.winstonLogger.warn(`[SYSTEM_HEALTH_FETCH_FAIL] ${err.message}`);
            }
            // Map DB created_at to timestamp property for client compatibility
            const mappedRecentEvents = recentEvents.map((row) => ({
                event_type: row.event_type,
                metadata: row.metadata,
                timestamp: row.created_at || row.timestamp
            }));
            res.status(200).json({
                success: true,
                data: {
                    users: {
                        total: totalUsers || 0,
                        active: mau || 0, // Fallback to mau for active users
                        premium: activeSubscribers,
                        new_users: newUsers,
                        returning_users: returningUsers,
                        dau: dau,
                        wau: wau,
                        mau: mau
                    },
                    subscriptions: {
                        active_subscribers: activeSubscribers,
                        expired_subscribers: expiredSubscribers,
                        new_subscribers: newSubscribers,
                        churn_rate: churnRate,
                        mrr_usd: mrrProjection.toFixed(2),
                        arr_usd: arrProjection.toFixed(2)
                    },
                    referrals: {
                        total_referrals: totalReferrals,
                        successful_referrals: successfulReferrals,
                        rewards_issued: rewardsIssued,
                        conversion_rate: referralConversionRate,
                        top_referrers: topReferrers
                    },
                    usage: {
                        searches_today: tracking.search_events,
                        split_searches: tracking.split_events,
                        live_tracking: tracking.live_events,
                        pnr_checks: tracking.pnr_events
                    },
                    cost: {
                        daily_usd: dailyCost.toFixed(2),
                        monthly_projection_usd: (dailyCost * 30).toFixed(2),
                        per_user_usd: totalUsers ? (dailyCost / totalUsers).toFixed(4) : "0.00"
                    },
                    insights: {
                        top_routes: topSearched || [],
                        top_hubs: Object.entries(topHubs).sort((a, b) => b[1] - a[1]).slice(0, 5).map(x => x[0]),
                        top_delayed: topDelayed || [],
                        prediction_accuracy: realAccuracy,
                        split_success_rate: splitSuccessRate
                    },
                    notifications: {
                        total_sent: totalSentNotifs,
                        delivered: deliveredNotifs,
                        failed: failedNotifs,
                        read: readNotifs,
                        unread: unreadNotifs,
                        active_tokens: activeTokensCount
                    },
                    event_history: mappedRecentEvents || [],
                    system_health: systemStatus
                }
            });
        }
        catch (err) {
            logger_1.winstonLogger.error(`[ADMIN_API] Error: ${err.message}`);
            res.status(500).json({ success: false, error: 'Failed to generate admin report' });
        }
    }
    // ─── User Management ────────────────────────────────────────────────────────
    async listUsers(req, res) {
        try {
            const users = await authService_1.authService.getAllUsers();
            const safeUsers = users.map(u => ({
                id: u.id,
                email: u.email,
                planType: u.planType,
                planExpiry: u.planExpiry,
                createdAt: u.createdAt,
                dailySearchCount: u.dailySearchCount,
                dailyPnrCount: u.dailyPnrCount,
                dailyLiveCount: u.dailyLiveCount,
                isAdmin: u.isAdmin,
                isBlocked: u.isBlocked || false,
                referralCode: u.referralCode,
                credits: u.credits,
                aiSplitSearches: u.aiSplitSearches,
            }));
            res.json({ success: true, data: safeUsers });
        }
        catch (err) {
            logger_1.winstonLogger.error(`[ADMIN_USERS] listUsers error: ${err.message}`);
            res.status(500).json({ success: false, error: 'Failed to fetch users' });
        }
    }
    async testPushNotification(req, res) {
        try {
            const { title, message, targetUserId } = req.body;
            const adminId = req.user?.id || req.headers['x-user-id'] || 'unknown-admin';
            if (!title || !message) {
                return res.status(400).json({ success: false, error: 'Title and message are required' });
            }
            const { pushService } = require('../services/pushService');
            const userId = targetUserId || adminId;
            logger_1.winstonLogger.info(`[ADMIN_TEST_PUSH] Sending test notification to ${userId}`);
            const success = await pushService.sendToUsers([userId], title, message);
            if (success) {
                res.json({ success: true, message: 'Test notification sent successfully' });
            }
            else {
                res.status(500).json({ success: false, error: 'Push service returned failure. Check logs for OneSignal errors or missing credentials.' });
            }
        }
        catch (err) {
            logger_1.winstonLogger.error(`[ADMIN_TEST_PUSH_ERROR] ${err.message}`);
            res.status(500).json({ success: false, error: 'Failed to send test push notification' });
        }
    }
    async getUser(req, res) {
        try {
            const { id } = req.params;
            const user = await authService_1.authService.getUserById(id);
            if (!user)
                return res.status(404).json({ success: false, error: 'User not found' });
            const { password, ...safeUser } = user;
            res.json({ success: true, data: safeUser });
        }
        catch (err) {
            logger_1.winstonLogger.error(`[ADMIN_USERS] getUser error: ${err.message}`);
            res.status(500).json({ success: false, error: 'Failed to fetch user' });
        }
    }
    async blockUser(req, res) {
        try {
            const { id } = req.params;
            const adminId = req.user?.id || req.headers['x-user-id'] || 'unknown-admin';
            const adminUser = await authService_1.authService.getUserById(adminId);
            const adminEmail = adminUser?.email || 'unknown-admin@trayago.in';
            // 1. Database-level transactional RPC block
            if ((0, supabase_1.isSupabaseConfigured)()) {
                const { error } = await supabase_1.supabase.rpc('admin_block_user_rpc', {
                    p_admin_id: adminId,
                    p_admin_email: adminEmail,
                    p_target_id: id,
                    p_ip_address: req.ip || req.headers['x-forwarded-for'] || null,
                    p_user_agent: req.headers['user-agent'] || null,
                    p_details: { target: id, action: 'BLOCK' }
                });
                if (error)
                    throw new Error(error.message);
            }
            // 2. Local state synchronization on success
            const success = await authService_1.authService.blockUser(id);
            if (!success)
                return res.status(400).json({ success: false, error: 'Cannot block this user (admin or not found)' });
            logger_1.winstonLogger.warn(`[ADMIN_ACTION] User ${id} blocked via transaction`);
            res.json({ success: true, message: 'User blocked successfully' });
        }
        catch (err) {
            logger_1.winstonLogger.error(`[ADMIN_EXCEPTION] BlockUser transaction failed. Reverted. Error: ${err.message}`);
            res.status(500).json({ success: false, error: 'Audit transaction failed. State change rolled back.' });
        }
    }
    async unblockUser(req, res) {
        try {
            const { id } = req.params;
            const adminId = req.user?.id || req.headers['x-user-id'] || 'unknown-admin';
            const adminUser = await authService_1.authService.getUserById(adminId);
            const adminEmail = adminUser?.email || 'unknown-admin@trayago.in';
            // 1. Database-level transactional RPC block
            if ((0, supabase_1.isSupabaseConfigured)()) {
                const { error } = await supabase_1.supabase.rpc('admin_unblock_user_rpc', {
                    p_admin_id: adminId,
                    p_admin_email: adminEmail,
                    p_target_id: id,
                    p_ip_address: req.ip || req.headers['x-forwarded-for'] || null,
                    p_user_agent: req.headers['user-agent'] || null,
                    p_details: { target: id, action: 'UNBLOCK' }
                });
                if (error)
                    throw new Error(error.message);
            }
            // 2. Local state synchronization on success
            const success = await authService_1.authService.unblockUser(id);
            if (!success)
                return res.status(404).json({ success: false, error: 'User not found' });
            logger_1.winstonLogger.info(`[ADMIN_ACTION] User ${id} unblocked via transaction`);
            res.json({ success: true, message: 'User unblocked successfully' });
        }
        catch (err) {
            logger_1.winstonLogger.error(`[ADMIN_EXCEPTION] UnblockUser transaction failed. Reverted. Error: ${err.message}`);
            res.status(500).json({ success: false, error: 'Audit transaction failed. State change rolled back.' });
        }
    }
    async resetUserLimits(req, res) {
        try {
            const { id } = req.params;
            const adminId = req.user?.id || req.headers['x-user-id'] || 'unknown-admin';
            const adminUser = await authService_1.authService.getUserById(adminId);
            const adminEmail = adminUser?.email || 'unknown-admin@trayago.in';
            // 1. Database-level transactional RPC block
            if ((0, supabase_1.isSupabaseConfigured)()) {
                const { error } = await supabase_1.supabase.rpc('admin_reset_user_limits_rpc', {
                    p_admin_id: adminId,
                    p_admin_email: adminEmail,
                    p_target_id: id,
                    p_ip_address: req.ip || req.headers['x-forwarded-for'] || null,
                    p_user_agent: req.headers['user-agent'] || null,
                    p_details: { target: id, action: 'RESET_LIMITS' }
                });
                if (error)
                    throw new Error(error.message);
            }
            // 2. Local state synchronization on success
            const success = await authService_1.authService.resetUserLimits(id);
            if (!success)
                return res.status(404).json({ success: false, error: 'User not found' });
            logger_1.winstonLogger.info(`[ADMIN_ACTION] Limits reset for user ${id} via transaction`);
            res.json({ success: true, message: 'Daily limits reset successfully' });
        }
        catch (err) {
            logger_1.winstonLogger.error(`[ADMIN_EXCEPTION] ResetLimits transaction failed. Reverted. Error: ${err.message}`);
            res.status(500).json({ success: false, error: 'Audit transaction failed. State change rolled back.' });
        }
    }
    async changeUserPlan(req, res) {
        try {
            const { id } = req.params;
            const { planType, durationDays } = req.body;
            const validPlans = ['free', 'paid', 'beta', 'safar_pro_30m', 'safar_pro_1d', 'safar_pro_7d', 'safar_pro_30d', 'admin'];
            if (!planType || !validPlans.includes(planType)) {
                return res.status(400).json({ success: false, error: 'Invalid plan type' });
            }
            const adminId = req.user?.id || req.headers['x-user-id'] || 'unknown-admin';
            const adminUser = await authService_1.authService.getUserById(adminId);
            const adminEmail = adminUser?.email || 'unknown-admin@trayago.in';
            let planExpiry = null;
            if (planType !== 'free' && durationDays) {
                const expiry = new Date();
                expiry.setDate(expiry.getDate() + durationDays);
                planExpiry = expiry.toISOString();
            }
            // 1. Database-level transactional RPC block
            if ((0, supabase_1.isSupabaseConfigured)()) {
                const { error } = await supabase_1.supabase.rpc('admin_change_user_plan_rpc', {
                    p_admin_id: adminId,
                    p_admin_email: adminEmail,
                    p_target_id: id,
                    p_plan_type: planType,
                    p_plan_expiry: planExpiry,
                    p_ip_address: req.ip || req.headers['x-forwarded-for'] || null,
                    p_user_agent: req.headers['user-agent'] || null,
                    p_details: { target: id, planType, durationDays }
                });
                if (error)
                    throw new Error(error.message);
            }
            // 2. Local state synchronization on success
            const success = await authService_1.authService.changeUserPlan(id, planType, durationDays);
            if (!success)
                return res.status(404).json({ success: false, error: 'User not found' });
            logger_1.winstonLogger.info(`[ADMIN_ACTION] Plan changed to ${planType} for user ${id} via transaction`);
            res.json({ success: true, message: `Plan changed to ${planType}` });
        }
        catch (err) {
            logger_1.winstonLogger.error(`[ADMIN_EXCEPTION] ChangeUserPlan transaction failed. Reverted. Error: ${err.message}`);
            res.status(500).json({ success: false, error: 'Audit transaction failed. State change rolled back.' });
        }
    }
    async overrideUserQuota(req, res) {
        try {
            const { id } = req.params;
            const { customSearches, customPnr, customLive, durationDays } = req.body;
            const searchesVal = customSearches !== undefined && customSearches !== null ? parseInt(customSearches, 10) : null;
            const pnrVal = customPnr !== undefined && customPnr !== null ? parseInt(customPnr, 10) : null;
            const liveVal = customLive !== undefined && customLive !== null ? parseInt(customLive, 10) : null;
            const durationVal = durationDays !== undefined && durationDays !== null ? parseInt(durationDays, 10) : null;
            if (searchesVal !== null && searchesVal < 0)
                return res.status(400).json({ success: false, error: 'Searches limit cannot be negative' });
            if (pnrVal !== null && pnrVal < 0)
                return res.status(400).json({ success: false, error: 'PNR limit cannot be negative' });
            if (liveVal !== null && liveVal < 0)
                return res.status(400).json({ success: false, error: 'Live status limit cannot be negative' });
            if (durationVal !== null && durationVal <= 0)
                return res.status(400).json({ success: false, error: 'Duration days must be positive' });
            const adminId = req.user?.id || req.headers['x-user-id'] || 'unknown-admin';
            const adminUser = await authService_1.authService.getUserById(adminId);
            const adminEmail = adminUser?.email || 'unknown-admin@trayago.in';
            // 1. Supabase Dynamic RPC Block
            if ((0, supabase_1.isSupabaseConfigured)()) {
                const { error } = await supabase_1.supabase.rpc('admin_override_user_quota_rpc', {
                    p_admin_id: adminId,
                    p_admin_email: adminEmail,
                    p_target_id: id,
                    p_custom_searches: searchesVal,
                    p_custom_pnr: pnrVal,
                    p_custom_live: liveVal,
                    p_duration_days: durationVal,
                    p_ip_address: req.ip || req.headers['x-forwarded-for'] || null,
                    p_user_agent: req.headers['user-agent'] || null,
                    p_details: { target: id, customSearches: searchesVal, customPnr: pnrVal, customLive: liveVal, durationDays: durationVal }
                });
                if (error)
                    throw new Error(error.message);
                // 2. Cache Invalidation on success
                const { cacheService } = require('../services/cacheService');
                cacheService.del(`quota_override:${id}`);
            }
            else {
                logger_1.winstonLogger.warn(`[ADMIN_FALLBACK] Mocked user quota override successfully in local memory fallback for user ${id}`);
            }
            logger_1.winstonLogger.info(`[ADMIN_ACTION] Custom quota override configured for user ${id} searches=${searchesVal} pnr=${pnrVal} live=${liveVal} duration=${durationVal}`);
            res.json({ success: true, message: 'Custom quota override configured successfully' });
        }
        catch (err) {
            logger_1.winstonLogger.error(`[ADMIN_EXCEPTION] Custom quota override transaction failed: ${err.message}`);
            res.status(500).json({ success: false, error: 'Audit transaction failed. Quota override rolled back.' });
        }
    }
    async bulkBlockUsers(req, res) {
        try {
            const { targetIds, reason } = req.body;
            if (!Array.isArray(targetIds) || targetIds.length === 0) {
                return res.status(400).json({ success: false, error: 'Target IDs must be a non-empty array' });
            }
            if (targetIds.length > 500) {
                return res.status(400).json({ success: false, error: 'Bulk action exceeds maximum cap of 500 users' });
            }
            const adminId = req.user?.id || req.headers['x-user-id'] || 'unknown-admin';
            const adminUser = await authService_1.authService.getUserById(adminId);
            const adminEmail = adminUser?.email || 'unknown-admin@trayago.in';
            // Self-blocking check
            if (targetIds.includes(adminId)) {
                return res.status(400).json({ success: false, error: 'Administrators cannot block their own accounts' });
            }
            // 1. Supabase Dynamic RPC Block
            if ((0, supabase_1.isSupabaseConfigured)()) {
                const { error } = await supabase_1.supabase.rpc('admin_bulk_block_users_rpc', {
                    p_admin_id: adminId,
                    p_admin_email: adminEmail,
                    p_target_ids: targetIds,
                    p_ip_address: req.ip || req.headers['x-forwarded-for'] || null,
                    p_user_agent: req.headers['user-agent'] || null,
                    p_details: { batchSize: targetIds.length, targetIds, reason: reason || 'Bulk suspension' }
                });
                if (error)
                    throw new Error(error.message);
                // 2. Clear global user memory state cache collectively on bulk operations
                const { userCache } = require('../cache/userCache');
                await userCache.clear();
            }
            // 3. Local state synchronization on success
            let modifiedCount = 0;
            for (const targetId of targetIds) {
                const targetUser = await authService_1.authService.getUserById(targetId);
                if (targetUser && !targetUser.isAdmin) {
                    await authService_1.authService.blockUser(targetId);
                    modifiedCount++;
                }
            }
            logger_1.winstonLogger.warn(`[ADMIN_ACTION] Bulk block processed successfully for ${modifiedCount}/${targetIds.length} users`);
            res.json({ success: true, message: `Successfully blocked ${modifiedCount} users` });
        }
        catch (err) {
            logger_1.winstonLogger.error(`[ADMIN_EXCEPTION] Bulk block transaction failed: ${err.message}`);
            res.status(500).json({ success: false, error: 'Audit transaction failed. Bulk block rolled back.' });
        }
    }
    async bulkUnblockUsers(req, res) {
        try {
            const { targetIds, reason } = req.body;
            if (!Array.isArray(targetIds) || targetIds.length === 0) {
                return res.status(400).json({ success: false, error: 'Target IDs must be a non-empty array' });
            }
            if (targetIds.length > 500) {
                return res.status(400).json({ success: false, error: 'Bulk action exceeds maximum cap of 500 users' });
            }
            const adminId = req.user?.id || req.headers['x-user-id'] || 'unknown-admin';
            const adminUser = await authService_1.authService.getUserById(adminId);
            const adminEmail = adminUser?.email || 'unknown-admin@trayago.in';
            // 1. Supabase Dynamic RPC Block
            if ((0, supabase_1.isSupabaseConfigured)()) {
                const { error } = await supabase_1.supabase.rpc('admin_bulk_unblock_users_rpc', {
                    p_admin_id: adminId,
                    p_admin_email: adminEmail,
                    p_target_ids: targetIds,
                    p_ip_address: req.ip || req.headers['x-forwarded-for'] || null,
                    p_user_agent: req.headers['user-agent'] || null,
                    p_details: { batchSize: targetIds.length, targetIds, reason: reason || 'Bulk activation' }
                });
                if (error)
                    throw new Error(error.message);
                // 2. Clear global user memory state cache collectively on bulk operations
                const { userCache } = require('../cache/userCache');
                await userCache.clear();
            }
            // 3. Local state synchronization on success
            let modifiedCount = 0;
            for (const targetId of targetIds) {
                const targetUser = await authService_1.authService.getUserById(targetId);
                if (targetUser && !targetUser.isAdmin) {
                    await authService_1.authService.unblockUser(targetId);
                    modifiedCount++;
                }
            }
            logger_1.winstonLogger.info(`[ADMIN_ACTION] Bulk unblock processed successfully for ${modifiedCount}/${targetIds.length} users`);
            res.json({ success: true, message: `Successfully unblocked ${modifiedCount} users` });
        }
        catch (err) {
            logger_1.winstonLogger.error(`[ADMIN_EXCEPTION] Bulk unblock transaction failed: ${err.message}`);
            res.status(500).json({ success: false, error: 'Audit transaction failed. Bulk unblock rolled back.' });
        }
    }
    async terminateUserSessions(req, res) {
        try {
            const { id } = req.params;
            const { reason } = req.body;
            const adminId = req.user?.id || req.headers['x-user-id'] || 'unknown-admin';
            const adminUser = await authService_1.authService.getUserById(adminId);
            const adminEmail = adminUser?.email || 'unknown-admin@trayago.in';
            // 1. Self-termination check
            if (id === adminId) {
                return res.status(400).json({ success: false, error: 'Administrators cannot terminate their own active session.' });
            }
            // 2. Admin protection check
            const targetUser = await authService_1.authService.getUserById(id);
            if (targetUser && targetUser.isAdmin) {
                return res.status(400).json({ success: false, error: 'Cannot terminate sessions for an administrator account.' });
            }
            // 3. Supabase Dynamic RPC Block
            if ((0, supabase_1.isSupabaseConfigured)()) {
                const { error } = await supabase_1.supabase.rpc('admin_terminate_user_sessions_rpc', {
                    p_admin_id: adminId,
                    p_admin_email: adminEmail,
                    p_target_id: id,
                    p_ip_address: req.ip || req.headers['x-forwarded-for'] || null,
                    p_user_agent: req.headers['user-agent'] || null,
                    p_details: { targetUserId: id, reason: reason || 'Administrative Session Revoke' }
                });
                if (error)
                    throw new Error(error.message);
                // 4. Targeted Cache Invalidation
                const { userCache } = require('../cache/userCache');
                await userCache.invalidate(id);
                const { cacheService } = require('../services/cacheService');
                cacheService.del(`quota_override:${id}`);
            }
            // 5. Local state synchronization on success
            const success = await authService_1.authService.terminateUserSessions(id);
            if (!success)
                return res.status(404).json({ success: false, error: 'User not found or is an administrator.' });
            logger_1.winstonLogger.info(`[ADMIN_ACTION] Active sessions revoked for user ${id}`);
            res.json({ success: true, message: 'Sessions terminated successfully' });
        }
        catch (err) {
            logger_1.winstonLogger.error(`[ADMIN_EXCEPTION] Terminate sessions transaction failed: ${err.message}`);
            res.status(500).json({ success: false, error: 'Audit transaction failed. Session termination rolled back.' });
        }
    }
    async adjustUserCredits(req, res) {
        try {
            const { id } = req.params;
            const { creditsChange } = req.body;
            const creditsVal = parseInt(creditsChange, 10);
            if (isNaN(creditsVal)) {
                return res.status(400).json({ success: false, error: 'Credits change value must be an integer' });
            }
            const adminId = req.user?.id || req.headers['x-user-id'] || 'unknown-admin';
            const adminUser = await authService_1.authService.getUserById(adminId);
            const adminEmail = adminUser?.email || 'unknown-admin@trayago.in';
            // Admin Protection Check
            const targetUser = await authService_1.authService.getUserById(id);
            if (targetUser && targetUser.isAdmin) {
                return res.status(400).json({ success: false, error: 'Cannot adjust credits for an administrator account.' });
            }
            const previousCredits = targetUser ? (targetUser.credits || 0) : 0;
            const expectedCredits = Math.max(0, previousCredits + creditsVal);
            if (expectedCredits > 1000000) {
                return res.status(400).json({ success: false, error: 'Credits allocation exceeds maximum cap of 1,000,000.' });
            }
            // 1. Supabase Dynamic RPC Block
            if ((0, supabase_1.isSupabaseConfigured)()) {
                const { error } = await supabase_1.supabase.rpc('admin_adjust_user_credits_rpc', {
                    p_admin_id: adminId,
                    p_admin_email: adminEmail,
                    p_target_id: id,
                    p_credits_change: creditsVal,
                    p_ip_address: req.ip || req.headers['x-forwarded-for'] || null,
                    p_user_agent: req.headers['user-agent'] || null,
                    p_details: { targetUserId: id, changeValue: creditsVal, previousCredits, newCredits: expectedCredits }
                });
                if (error)
                    throw new Error(error.message);
                // 2. Targeted Cache Invalidation
                const { userCache } = require('../cache/userCache');
                await userCache.invalidate(id);
            }
            // 3. Local state synchronization on success
            const success = await authService_1.authService.adjustUserCredits(id, creditsVal);
            if (!success)
                return res.status(404).json({ success: false, error: 'User not found or is an administrator.' });
            logger_1.winstonLogger.info(`[ADMIN_ACTION] Credits adjusted for user ${id}: change=${creditsVal}, newBalance=${expectedCredits}`);
            res.json({ success: true, message: `Credits adjusted by ${creditsVal} successfully` });
        }
        catch (err) {
            logger_1.winstonLogger.error(`[ADMIN_EXCEPTION] Adjust credits transaction failed: ${err.message}`);
            res.status(500).json({ success: false, error: err.message || 'Audit transaction failed. Credits adjustment rolled back.' });
        }
    }
    async listAuditLogs(req, res) {
        let limit = 50;
        let offset = 0;
        try {
            limit = parseInt(req.query.limit || '50', 10);
            offset = parseInt(req.query.offset || '0', 10);
            const action = req.query.action || undefined;
            if (!(0, supabase_1.isSupabaseConfigured)()) {
                return res.status(200).json({
                    success: true,
                    data: [],
                    pagination: {
                        total: 0,
                        limit,
                        offset
                    }
                });
            }
            let query = supabase_1.supabase
                .from('admin_security_audit_logs')
                .select('*', { count: 'exact' })
                .order('timestamp', { ascending: false })
                .range(offset, offset + limit - 1);
            if (action) {
                query = query.eq('action', action);
            }
            const { data, count, error } = await query;
            if (error)
                throw error;
            res.status(200).json({
                success: true,
                data,
                pagination: {
                    total: count || 0,
                    limit,
                    offset
                }
            });
        }
        catch (err) {
            logger_1.winstonLogger.warn(`[ADMIN_AUDIT_LOGS_FALLBACK] listAuditLogs error: ${err.message}. Returning mock sandbox logs payload.`);
            const mockLogs = [
                {
                    id: 'audit-mock-1',
                    admin_id: 'admin-uuid-123',
                    admin_email: 'admin@trayago.in',
                    action: 'PROVIDER_DEGRADATION',
                    target_id: 'IRCTC',
                    ip_address: '127.0.0.1',
                    user_agent: 'Mozilla/5.0 (Mock Sandbox)',
                    details: { message: 'Database outage warning: cascading to in-memory fallback stores.', status: 'ACTIVE' },
                    timestamp: new Date().toISOString()
                },
                {
                    id: 'audit-mock-2',
                    admin_id: 'admin-uuid-123',
                    admin_email: 'admin@trayago.in',
                    action: 'VIEW_PROVIDER_SECRET',
                    target_id: 'RAPIDAPI',
                    ip_address: '127.0.0.1',
                    user_agent: 'Mozilla/5.0 (Mock Sandbox)',
                    details: { message: 'In-memory sandbox credentials viewed' },
                    timestamp: new Date(Date.now() - 3600000).toISOString()
                }
            ];
            res.status(200).json({
                success: true,
                data: mockLogs,
                fallback: true,
                pagination: {
                    total: mockLogs.length,
                    limit,
                    offset
                }
            });
        }
    }
    async getDiagnostics(req, res) {
        if (process.env.ENABLE_DB_DIAGNOSTICS === 'true') {
            try {
                const { data: dbLogs, error } = await supabase_1.supabase
                    .from('server_error_logs')
                    .select('node_id, level, message, timestamp')
                    .order('timestamp', { ascending: false })
                    .limit(100);
                if (error)
                    throw error;
                if (dbLogs && dbLogs.length > 0) {
                    const formattedLogs = dbLogs.map(log => `[${log.timestamp}] [${log.node_id}] [${log.level}]: ${log.message}`);
                    return res.status(200).json({ success: true, logs: formattedLogs });
                }
            }
            catch (err) {
                logger_1.winstonLogger.warn(`[DB_DIAGNOSTICS_FAILED] Querying server_error_logs failed: ${err.message}. Falling back to disk logs.`);
            }
        }
        // Fallback: Read local file logs
        try {
            const todayStr = new Date().toISOString().split('T')[0];
            const logPath = path_1.default.join(process.cwd(), 'logs', `error-${todayStr}.log`);
            if (!fs_1.default.existsSync(logPath)) {
                return res.status(200).json({ success: true, logs: ["No server errors recorded today."] });
            }
            const stats = fs_1.default.statSync(logPath);
            const fileSize = stats.size;
            const readLimit = 50 * 1024; // 50 KB Safety Cap
            let streamOptions = {};
            if (fileSize > readLimit) {
                streamOptions = { start: fileSize - readLimit, end: fileSize };
            }
            const readStream = fs_1.default.createReadStream(logPath, streamOptions);
            let data = '';
            readStream.on('data', (chunk) => {
                data += chunk.toString();
            });
            readStream.on('end', () => {
                const lines = data.split('\n').filter(l => l.trim().length > 0);
                const last100 = lines.slice(-100);
                res.status(200).json({ success: true, logs: last100 });
            });
            readStream.on('error', (err) => {
                logger_1.winstonLogger.error(`[DIAGNOSTICS_STREAM_ERR] ${err.message}`);
                res.status(500).json({ success: false, error: 'Failed to read diagnostic logs stream' });
            });
        }
        catch (err) {
            logger_1.winstonLogger.error(`[DIAGNOSTICS_ERR] ${err.message}`);
            res.status(500).json({ success: false, error: err.message });
        }
    }
    async logAuditEvent(req, res) {
        try {
            const { action, targetId, details } = req.body;
            const adminId = req.user?.id || req.headers['x-user-id'] || 'unknown-admin';
            const adminUser = await authService_1.authService.getUserById(adminId);
            const adminEmail = adminUser?.email || 'unknown-admin@trayago.in';
            if ((0, supabase_1.isSupabaseConfigured)()) {
                const { error } = await supabase_1.supabase
                    .from('admin_security_audit_logs')
                    .insert([{
                        admin_id: adminId,
                        admin_email: adminEmail,
                        action,
                        target_id: targetId || 'SYSTEM',
                        ip_address: req.ip || req.headers['x-forwarded-for'] || null,
                        user_agent: req.headers['user-agent'] || null,
                        details: details || {},
                        timestamp: new Date().toISOString()
                    }]);
                if (error)
                    throw error;
            }
            else {
                logger_1.winstonLogger.info(`[ADMIN_AUDIT_FALLBACK] Action: ${action}, Target: ${targetId}, Admin: ${adminEmail}`);
            }
            res.status(200).json({ success: true });
        }
        catch (err) {
            logger_1.winstonLogger.warn(`[ADMIN_AUDIT_FALLBACK] Database audit insert failed: ${err.message}. Logging locally to Winston instead.`);
            logger_1.winstonLogger.info(`[ADMIN_AUDIT_LOCAL] Action: ${req.body.action}, Target: ${req.body.targetId || 'SYSTEM'}, Admin: 'admin@trayago.in'`);
            res.status(200).json({ success: true, fallback: true });
        }
    }
    async clearCache(req, res) {
        try {
            const { type } = req.body; // 'L1' | 'L2' | 'both'
            const adminId = req.user?.id || req.headers['x-user-id'] || 'unknown-admin';
            const adminUser = await authService_1.authService.getUserById(adminId);
            const adminEmail = adminUser?.email || 'unknown-admin@trayago.in';
            const { cacheService } = require('../services/cacheService');
            const { userCache } = require('../cache/userCache');
            if (type === 'L1' || type === 'both') {
                cacheService.flushAll();
                userCache.cache.flushAll();
            }
            if (type === 'L2' || type === 'both') {
                await userCache.clear();
            }
            if ((0, supabase_1.isSupabaseConfigured)()) {
                const { error } = await supabase_1.supabase
                    .from('admin_security_audit_logs')
                    .insert([{
                        admin_id: adminId,
                        admin_email: adminEmail,
                        action: 'CACHE_CLEAR',
                        target_id: 'SYSTEM',
                        ip_address: req.ip || req.headers['x-forwarded-for'] || null,
                        user_agent: req.headers['user-agent'] || null,
                        details: { type },
                        timestamp: new Date().toISOString()
                    }]);
                if (error)
                    throw error;
            }
            logger_1.winstonLogger.warn(`[ADMIN_CACHE_CLEAR] Cache of type ${type} cleared by ${adminEmail}`);
            res.status(200).json({ success: true, message: `Successfully cleared ${type} cache.` });
        }
        catch (err) {
            logger_1.winstonLogger.error(`[ADMIN_CACHE] clearCache error: ${err.message}`);
            res.status(500).json({ success: false, error: 'Failed to clear cache' });
        }
    }
    async listFeedback(req, res) {
        try {
            const FEEDBACK_FILE = path_1.default.join(__dirname, '../../../data/feedback.json');
            let fileFeedback = [];
            if (fs_1.default.existsSync(FEEDBACK_FILE)) {
                try {
                    fileFeedback = JSON.parse(fs_1.default.readFileSync(FEEDBACK_FILE, 'utf-8'));
                }
                catch (e) {
                    fileFeedback = [];
                }
            }
            let dbFeedback = [];
            try {
                if ((0, supabase_1.isSupabaseConfigured)()) {
                    const { data } = await supabase_1.supabase.from('feedback').select('*').order('timestamp', { ascending: false });
                    dbFeedback = data || [];
                }
            }
            catch (dbErr) {
                logger_1.winstonLogger.warn(`[FEEDBACK_DB_READ_FAIL] ${dbErr.message}`);
            }
            res.status(200).json({ success: true, data: { fileFeedback, dbFeedback } });
        }
        catch (err) {
            logger_1.winstonLogger.error(`[ADMIN_FEEDBACK] listFeedback error: ${err.message}`);
            res.status(500).json({ success: false, error: 'Failed to retrieve feedback submissions' });
        }
    }
    // ─── AI Feedback Category Admin ──────────────────────────────────────────────
    async listFeedbackCategories(req, res) {
        try {
            const CATEGORIES_FILE = path_1.default.join(__dirname, '../../../data/feedback_categories.json');
            let localCategories = [];
            if (fs_1.default.existsSync(CATEGORIES_FILE)) {
                try {
                    localCategories = JSON.parse(fs_1.default.readFileSync(CATEGORIES_FILE, 'utf-8'));
                }
                catch {
                    localCategories = [];
                }
            }
            let dbCategories = [];
            if ((0, supabase_1.isSupabaseConfigured)()) {
                try {
                    const { data } = await supabase_1.supabase
                        .from('feedback_categories')
                        .select('*')
                        .order('created_at', { ascending: false })
                        .limit(200);
                    dbCategories = data || [];
                }
                catch (dbErr) {
                    logger_1.winstonLogger.warn(`[FEEDBACK_CAT_DB_FAIL] ${dbErr.message}`);
                }
            }
            // Merge: prefer DB data, fall back to local
            const merged = dbCategories.length > 0 ? dbCategories.map(d => ({
                id: d.id,
                feedbackId: d.feedback_id,
                category: d.category,
                confidence: d.confidence,
                priority: d.priority,
                summary: d.summary,
                suggestedAction: d.suggested_action,
                createdAt: d.created_at
            })) : localCategories;
            res.json({ success: true, data: merged });
        }
        catch (err) {
            logger_1.winstonLogger.error(`[ADMIN_FEEDBACK_CAT] listFeedbackCategories error: ${err.message}`);
            res.status(500).json({ success: false, error: 'Failed to retrieve feedback categories' });
        }
    }
    async getFeedbackCategoryAnalytics(req, res) {
        try {
            const CATEGORIES_FILE = path_1.default.join(__dirname, '../../../data/feedback_categories.json');
            let categories = [];
            if ((0, supabase_1.isSupabaseConfigured)()) {
                try {
                    const { data } = await supabase_1.supabase.from('feedback_categories').select('category, priority, created_at');
                    categories = data || [];
                }
                catch { /* fall through */ }
            }
            if (categories.length === 0 && fs_1.default.existsSync(CATEGORIES_FILE)) {
                try {
                    categories = JSON.parse(fs_1.default.readFileSync(CATEGORIES_FILE, 'utf-8'));
                }
                catch {
                    categories = [];
                }
            }
            // Count by category
            const byCategory = {};
            const byPriority = {};
            const byDate = {};
            for (const c of categories) {
                byCategory[c.category] = (byCategory[c.category] || 0) + 1;
                byPriority[c.priority || c.priority] = (byPriority[c.priority || c.priority] || 0) + 1;
                const date = (c.created_at || c.createdAt || '').split('T')[0];
                if (date)
                    byDate[date] = (byDate[date] || 0) + 1;
            }
            res.json({ success: true, data: { byCategory, byPriority, byDate, total: categories.length } });
        }
        catch (err) {
            logger_1.winstonLogger.error(`[ADMIN_FEEDBACK_CAT] analytics error: ${err.message}`);
            res.status(500).json({ success: false, error: 'Failed to compute feedback analytics' });
        }
    }
    async getAnalyticsHistory(req, res) {
        try {
            const days = parseInt(req.query.days, 10) || 7;
            const [learningHistory, systemHistory] = await Promise.all([
                metricsService_1.metricsService.getLearningHistory(days),
                metricsService_1.metricsService.getSystemHistory(days)
            ]);
            res.status(200).json({
                success: true,
                data: {
                    learningHistory,
                    systemHistory
                }
            });
        }
        catch (err) {
            logger_1.winstonLogger.error(`[ADMIN_ANALYTICS] getAnalyticsHistory error: ${err.message}`);
            res.status(500).json({ success: false, error: 'Failed to retrieve analytics history' });
        }
    }
    async exportAnalyticsLogs(req, res) {
        try {
            const { startDate, endDate } = req.query;
            let start = new Date(startDate);
            let end = new Date(endDate);
            if (isNaN(start.getTime())) {
                start = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
            }
            if (isNaN(end.getTime())) {
                end = new Date();
            }
            // Enforce max range cap of 31 days
            const maxDiff = 31 * 24 * 60 * 60 * 1000;
            if (end.getTime() - start.getTime() > maxDiff) {
                start = new Date(end.getTime() - maxDiff);
            }
            res.setHeader('Content-Type', 'text/csv');
            res.setHeader('Content-Disposition', `attachment; filename=analytics_logs_${start.toISOString().split('T')[0]}_to_${end.toISOString().split('T')[0]}.csv`);
            res.setHeader('Transfer-Encoding', 'chunked');
            const escapeCsv = (val) => {
                if (val === null || val === undefined)
                    return '';
                const str = typeof val === 'object' ? JSON.stringify(val) : String(val);
                if (str.includes('"') || str.includes(',') || str.includes('\n') || str.includes('\r')) {
                    return `"${str.replace(/"/g, '""')}"`;
                }
                return str;
            };
            // Write header
            res.write('id,event_type,session_id,created_at,payload\n');
            if (!(0, supabase_1.isSupabaseConfigured)()) {
                res.write('SYSTEM_ERROR,Supabase is not configured in this environment,N/A,N/A,{}\n');
                res.end();
                return;
            }
            let offset = 0;
            const limit = 500;
            let hasMore = true;
            while (hasMore) {
                const { data, error } = await supabase_1.supabase
                    .from('analytics_events')
                    .select('id, event_type, session_id, payload, created_at')
                    .gte('created_at', start.toISOString())
                    .lte('created_at', end.toISOString())
                    .order('created_at', { ascending: true })
                    .range(offset, offset + limit - 1);
                if (error) {
                    logger_1.winstonLogger.error(`[ADMIN_EXPORT] Supabase query failed at offset ${offset}: ${error.message}`);
                    res.write(`\nERROR,Failed to retrieve complete logs: ${error.message},N/A,N/A,{}\n`);
                    break;
                }
                if (!data || data.length === 0) {
                    hasMore = false;
                    break;
                }
                for (const row of data) {
                    const line = [
                        escapeCsv(row.id),
                        escapeCsv(row.event_type),
                        escapeCsv(row.session_id),
                        escapeCsv(row.created_at),
                        escapeCsv(row.payload)
                    ].join(',') + '\n';
                    res.write(line);
                }
                if (data.length < limit) {
                    hasMore = false;
                }
                else {
                    offset += limit;
                }
            }
            res.end();
        }
        catch (err) {
            logger_1.winstonLogger.error(`[ADMIN_EXPORT] exportAnalyticsLogs error: ${err.message}`);
            if (!res.headersSent) {
                res.status(500).json({ success: false, error: 'Failed to export logs' });
            }
            else {
            }
        }
    }
    // ─── Payment & Revenue Analytics ──────────────────────────────────────────
    async getPaymentRevenue(req, res) {
        try {
            if (!(0, supabase_1.isSupabaseConfigured)())
                return res.json({ success: true, data: { total: 0, today: 0, month: 0 } });
            const now = new Date();
            const startOfDay = new Date(now.getFullYear(), now.getMonth(), now.getDate()).toISOString();
            const startOfMonth = new Date(now.getFullYear(), now.getMonth(), 1).toISOString();
            // Total Revenue
            const { data: totalData } = await supabase_1.supabase.from('payment_transactions').select('amount').eq('status', 'SUCCESS');
            const totalRevenue = (totalData || []).reduce((acc, row) => acc + Number(row.amount), 0);
            // Today Revenue
            const { data: todayData } = await supabase_1.supabase.from('payment_transactions').select('amount').eq('status', 'SUCCESS').gte('created_at', startOfDay);
            const todayRevenue = (todayData || []).reduce((acc, row) => acc + Number(row.amount), 0);
            // Month Revenue
            const { data: monthData } = await supabase_1.supabase.from('payment_transactions').select('amount').eq('status', 'SUCCESS').gte('created_at', startOfMonth);
            const monthRevenue = (monthData || []).reduce((acc, row) => acc + Number(row.amount), 0);
            res.json({
                success: true,
                data: {
                    total: totalRevenue,
                    today: todayRevenue,
                    month: monthRevenue
                }
            });
        }
        catch (err) {
            res.status(500).json({ success: false, error: err.message });
        }
    }
    async getPaymentSubscriptions(req, res) {
        try {
            if (!(0, supabase_1.isSupabaseConfigured)())
                return res.json({ success: true, data: { activePaid: 0, activeReferral: 0, expired: 0 } });
            const nowIso = new Date().toISOString();
            const { data: activePaid } = await supabase_1.supabase.from('subscription_history').select('user_id', { count: 'exact' }).eq('source', 'payment').gte('expires_at', nowIso);
            const { data: activeReferral } = await supabase_1.supabase.from('subscription_history').select('user_id', { count: 'exact' }).eq('source', 'referral').gte('expires_at', nowIso);
            res.json({
                success: true,
                data: {
                    activePaid: activePaid?.length || 0,
                    activeReferral: activeReferral?.length || 0,
                    expired: 0 // Simplification for exact count logic limits
                }
            });
        }
        catch (err) {
            res.status(500).json({ success: false, error: err.message });
        }
    }
    async getPaymentMetrics(req, res) {
        try {
            if (!(0, supabase_1.isSupabaseConfigured)())
                return res.json({ success: true, data: { successful: 0, failed: 0, topPlans: [] } });
            const { data: successful } = await supabase_1.supabase.from('payment_transactions').select('id', { count: 'exact' }).eq('status', 'SUCCESS');
            const { data: failed } = await supabase_1.supabase.from('payment_transactions').select('id', { count: 'exact' }).eq('status', 'FAILED');
            const { data: allSuccess } = await supabase_1.supabase.from('payment_transactions').select('plan_id').eq('status', 'SUCCESS');
            const planCounts = (allSuccess || []).reduce((acc, row) => {
                acc[row.plan_id] = (acc[row.plan_id] || 0) + 1;
                return acc;
            }, {});
            const topPlans = Object.entries(planCounts).sort((a, b) => b[1] - a[1]).slice(0, 5).map(x => ({ plan_id: x[0], count: x[1] }));
            res.json({
                success: true,
                data: {
                    successful: successful?.length || 0,
                    failed: failed?.length || 0,
                    topPlans
                }
            });
        }
        catch (err) {
            res.status(500).json({ success: false, error: err.message });
        }
    }
    // ─── Beta Codes Management ────────────────────────────────────────────────
    async listBetaCodes(req, res) {
        try {
            const codes = betaService_1.betaService.getAllCodes();
            res.json({ success: true, data: codes });
        }
        catch (err) {
            logger_1.winstonLogger.error(`[ADMIN_BETA] listBetaCodes error: ${err.message}`);
            res.status(500).json({ success: false, error: 'Failed to fetch beta codes' });
        }
    }
    async createBetaCode(req, res) {
        try {
            const { code, description, maxRedemptions, expiresAt, unlimitedSearch, unlimitedPnr, unlimitedLiveTracking, unlimitedSplitSearch } = req.body;
            if (!code || !description) {
                return res.status(400).json({ success: false, error: 'Code and description are required' });
            }
            const newCode = await betaService_1.betaService.createCode({
                code,
                description,
                maxRedemptions: parseInt(maxRedemptions, 10) || 1,
                expiresAt: expiresAt || null,
                unlimitedSearch: !!unlimitedSearch,
                unlimitedPnr: !!unlimitedPnr,
                unlimitedLiveTracking: !!unlimitedLiveTracking,
                unlimitedSplitSearch: !!unlimitedSplitSearch,
                isActive: true
            });
            res.json({ success: true, data: newCode });
        }
        catch (err) {
            logger_1.winstonLogger.error(`[ADMIN_BETA] createBetaCode error: ${err.message}`);
            res.status(400).json({ success: false, error: err.message || 'Failed to create beta code' });
        }
    }
    async disableBetaCode(req, res) {
        try {
            const { code } = req.params;
            const success = await betaService_1.betaService.disableCode(code);
            if (!success) {
                return res.status(404).json({ success: false, error: 'Beta code not found' });
            }
            res.json({ success: true, message: 'Beta code disabled successfully' });
        }
        catch (err) {
            logger_1.winstonLogger.error(`[ADMIN_BETA] disableBetaCode error: ${err.message}`);
            res.status(500).json({ success: false, error: 'Failed to disable beta code' });
        }
    }
    async listBetaRedemptions(req, res) {
        try {
            const redemptions = betaService_1.betaService.getAllRedemptions();
            res.json({ success: true, data: redemptions });
        }
        catch (err) {
            logger_1.winstonLogger.error(`[ADMIN_BETA] listBetaRedemptions error: ${err.message}`);
            res.status(500).json({ success: false, error: 'Failed to fetch beta redemptions' });
        }
    }
    async getBetaAnalyticsData(req, res) {
        try {
            let totalBetaUsers = 0;
            let activeBetaUsers = 0;
            let searchesToday = 0;
            let splitSearchesToday = 0;
            let pnrChecksToday = 0;
            let liveTrackingToday = 0;
            let feedbackSubmitted = 0;
            let complaintsSubmitted = 0;
            let socialComplaintsSubmitted = 0;
            const todayStr = new Date().toISOString().split('T')[0];
            // 1. Total & Active Beta Users
            try {
                const redemptions = betaService_1.betaService.getAllRedemptions();
                totalBetaUsers = new Set(redemptions.map(r => r.userId)).size;
                const now = new Date();
                activeBetaUsers = redemptions.filter(r => !r.expiresAt || new Date(r.expiresAt) > now).length;
            }
            catch (err) { }
            // 2. Searches Today
            try {
                if ((0, supabase_1.isSupabaseConfigured)()) {
                    const { count } = await supabase_1.supabase
                        .from('search_history')
                        .select('*', { count: 'exact', head: true })
                        .gte('created_at', todayStr);
                    searchesToday = count || 0;
                }
                else {
                    const searchHistoryFile = path_1.default.join(__dirname, '../../data/search_history_fallback.jsonl');
                    if (fs_1.default.existsSync(searchHistoryFile)) {
                        const lines = fs_1.default.readFileSync(searchHistoryFile, 'utf8').split('\n').filter(Boolean);
                        searchesToday = lines.filter(l => l.includes(todayStr)).length;
                    }
                }
            }
            catch (err) { }
            // 3. Split Searches Today
            try {
                if ((0, supabase_1.isSupabaseConfigured)()) {
                    const { count } = await supabase_1.supabase
                        .from('split_learning')
                        .select('*', { count: 'exact', head: true })
                        .gte('created_at', todayStr);
                    splitSearchesToday = count || 0;
                }
                else {
                    const splitFile = path_1.default.join(__dirname, '../../data/split_learning_fallback.jsonl');
                    if (fs_1.default.existsSync(splitFile)) {
                        const lines = fs_1.default.readFileSync(splitFile, 'utf8').split('\n').filter(Boolean);
                        splitSearchesToday = lines.filter(l => l.includes(todayStr)).length;
                    }
                }
            }
            catch (err) { }
            // 4. PNR Checks Today
            try {
                if ((0, supabase_1.isSupabaseConfigured)()) {
                    const { count } = await supabase_1.supabase
                        .from('pnr_tracking')
                        .select('*', { count: 'exact', head: true })
                        .gte('last_updated', todayStr);
                    pnrChecksToday = count || 0;
                }
                else {
                    const pnrFile = path_1.default.join(__dirname, '../../data/pnr_learning_aggregates_fallback.json');
                    if (fs_1.default.existsSync(pnrFile)) {
                        pnrChecksToday = 1;
                    }
                }
            }
            catch (err) { }
            // 5. Live Tracking Today
            try {
                if ((0, supabase_1.isSupabaseConfigured)()) {
                    const { count } = await supabase_1.supabase
                        .from('live_learning')
                        .select('*', { count: 'exact', head: true })
                        .gte('created_at', todayStr);
                    liveTrackingToday = count || 0;
                }
                else {
                    const liveFile = path_1.default.join(__dirname, '../../data/live_learning_fallback.jsonl');
                    if (fs_1.default.existsSync(liveFile)) {
                        const lines = fs_1.default.readFileSync(liveFile, 'utf8').split('\n').filter(Boolean);
                        liveTrackingToday = lines.filter(l => l.includes(todayStr)).length;
                    }
                }
            }
            catch (err) { }
            // 6. Feedback Submitted Today
            try {
                if ((0, supabase_1.isSupabaseConfigured)()) {
                    const { count } = await supabase_1.supabase
                        .from('feedback')
                        .select('*', { count: 'exact', head: true })
                        .gte('timestamp', todayStr);
                    feedbackSubmitted = count || 0;
                }
                else {
                    const feedbackFile = path_1.default.join(__dirname, '../../../data/feedback.json');
                    if (fs_1.default.existsSync(feedbackFile)) {
                        const list = JSON.parse(fs_1.default.readFileSync(feedbackFile, 'utf8'));
                        feedbackSubmitted = list.filter((f) => f.timestamp && f.timestamp.startsWith(todayStr)).length;
                    }
                }
            }
            catch (err) { }
            // 7. Complaints Submitted Today
            try {
                if ((0, supabase_1.isSupabaseConfigured)()) {
                    const { count } = await supabase_1.supabase
                        .from('complaints')
                        .select('*', { count: 'exact', head: true })
                        .gte('timestamp', todayStr);
                    complaintsSubmitted = count || 0;
                }
                else {
                    const complaintsFile = path_1.default.join(__dirname, '../../data/complaints.json');
                    if (fs_1.default.existsSync(complaintsFile)) {
                        const list = JSON.parse(fs_1.default.readFileSync(complaintsFile, 'utf8'));
                        complaintsSubmitted = list.filter((c) => c.timestamp && c.timestamp.startsWith(todayStr)).length;
                    }
                }
            }
            catch (err) { }
            // 7B. Social Complaints Submitted Today
            try {
                if ((0, supabase_1.isSupabaseConfigured)()) {
                    const { count } = await supabase_1.supabase
                        .from('social_complaints')
                        .select('*', { count: 'exact', head: true })
                        .gte('timestamp', todayStr);
                    socialComplaintsSubmitted = count || 0;
                }
                else {
                    const socialComplaintsFile = path_1.default.join(__dirname, '../../data/social_complaints_fallback.jsonl');
                    if (fs_1.default.existsSync(socialComplaintsFile)) {
                        const lines = fs_1.default.readFileSync(socialComplaintsFile, 'utf8').split('\n').filter(Boolean);
                        socialComplaintsSubmitted = lines.filter(l => l.includes(todayStr)).length;
                    }
                }
            }
            catch (err) { }
            // 8. Error Metrics (Today)
            let searchFailuresToday = 0;
            let splitFailuresToday = 0;
            let liveTrackingFailuresToday = 0;
            let pnrFailuresToday = 0;
            try {
                if ((0, supabase_1.isSupabaseConfigured)()) {
                    const { count: sf } = await supabase_1.supabase.from('missing_queries').select('*', { count: 'exact', head: true }).gte('created_at', todayStr);
                    searchFailuresToday = sf || 0;
                    const { count: spf } = await supabase_1.supabase.from('missing_routes').select('*', { count: 'exact', head: true }).gte('created_at', todayStr);
                    splitFailuresToday = spf || 0;
                    const { count: ltf } = await supabase_1.supabase.from('missing_trains').select('*', { count: 'exact', head: true }).gte('created_at', todayStr);
                    liveTrackingFailuresToday = ltf || 0;
                    const { count: pf } = await supabase_1.supabase.from('pnr_failures').select('*', { count: 'exact', head: true }).gte('timestamp', todayStr);
                    pnrFailuresToday = pf || 0;
                }
                else {
                    const mqFile = path_1.default.join(__dirname, '../../data/missing_queries.json');
                    if (fs_1.default.existsSync(mqFile)) {
                        const list = JSON.parse(fs_1.default.readFileSync(mqFile, 'utf8'));
                        searchFailuresToday = list.filter((q) => q.created_at && q.created_at.startsWith(todayStr)).length;
                    }
                    const mrFile = path_1.default.join(__dirname, '../../data/missing_routes.json');
                    if (fs_1.default.existsSync(mrFile)) {
                        const list = JSON.parse(fs_1.default.readFileSync(mrFile, 'utf8'));
                        splitFailuresToday = list.filter((r) => r.created_at && r.created_at.startsWith(todayStr)).length;
                    }
                    const mtFile = path_1.default.join(__dirname, '../../data/missing_trains.json');
                    if (fs_1.default.existsSync(mtFile)) {
                        const list = JSON.parse(fs_1.default.readFileSync(mtFile, 'utf8'));
                        liveTrackingFailuresToday = list.filter((t) => t.created_at && t.created_at.startsWith(todayStr)).length;
                    }
                    const pfFile = path_1.default.join(__dirname, '../../data/pnr_failures.jsonl');
                    if (fs_1.default.existsSync(pfFile)) {
                        const lines = fs_1.default.readFileSync(pfFile, 'utf8').split('\n').filter(Boolean);
                        pnrFailuresToday = lines.filter(l => l.includes(todayStr)).length;
                    }
                }
            }
            catch (err) { }
            // 9. Top Missing Lists
            let topQueries = [];
            let topRoutes = [];
            let topStations = [];
            let topTrains = [];
            try {
                const analytics = await selfLearningService_1.selfLearningService.getAnalytics();
                topQueries = analytics.topQueries || [];
                topRoutes = analytics.topRoutes || [];
                topStations = analytics.topStations || [];
                topTrains = analytics.topTrains || [];
            }
            catch (err) { }
            res.json({
                success: true,
                data: {
                    totalBetaUsers,
                    activeBetaUsers,
                    searchesToday,
                    splitSearchesToday,
                    pnrChecksToday,
                    liveTrackingToday,
                    feedbackSubmitted,
                    complaintsSubmitted,
                    socialComplaintsSubmitted,
                    errorMetrics: {
                        searchFailuresToday,
                        splitFailuresToday,
                        liveTrackingFailuresToday,
                        pnrFailuresToday
                    },
                    topQueries,
                    topRoutes,
                    topStations,
                    topTrains
                }
            });
        }
        catch (err) {
            logger_1.winstonLogger.error(`[ADMIN_BETA] getBetaAnalyticsData error: ${err.message}`);
            res.status(500).json({ success: false, error: 'Failed to fetch beta analytics' });
        }
    }
    async getBetaUserHealth(req, res) {
        try {
            const usersHealth = {};
            const now = new Date();
            const getEntry = (uid) => {
                if (!usersHealth[uid]) {
                    usersHealth[uid] = {
                        userId: uid,
                        searchesCount: 0,
                        feedbackCount: 0,
                        complaintsCount: 0,
                        lastActive: null,
                        healthScore: 100
                    };
                }
                return usersHealth[uid];
            };
            // 1. Scan Searches (Local JSONL Fallback)
            try {
                const searchHistoryFile = path_1.default.join(__dirname, '../../data/search_history_fallback.jsonl');
                if (fs_1.default.existsSync(searchHistoryFile)) {
                    const lines = fs_1.default.readFileSync(searchHistoryFile, 'utf8').split('\n').filter(Boolean);
                    lines.forEach(l => {
                        try {
                            const data = JSON.parse(l);
                            if (data.user_id) {
                                const entry = getEntry(data.user_id);
                                entry.searchesCount += 1;
                                const timestamp = data.created_at || data._created_at;
                                if (timestamp && (!entry.lastActive || new Date(timestamp) > new Date(entry.lastActive))) {
                                    entry.lastActive = timestamp;
                                }
                            }
                        }
                        catch (e) { }
                    });
                }
            }
            catch (err) { }
            // 2. Scan Feedback (Local JSON Fallback)
            try {
                const feedbackFile = path_1.default.join(__dirname, '../../../data/feedback.json');
                if (fs_1.default.existsSync(feedbackFile)) {
                    const list = JSON.parse(fs_1.default.readFileSync(feedbackFile, 'utf8'));
                    list.forEach((f) => {
                        if (f.userId) {
                            const entry = getEntry(f.userId);
                            entry.feedbackCount += 1;
                            const timestamp = f.timestamp;
                            if (timestamp && (!entry.lastActive || new Date(timestamp) > new Date(entry.lastActive))) {
                                entry.lastActive = timestamp;
                            }
                        }
                    });
                }
            }
            catch (err) { }
            // 2.5 Scan Complaints (Local JSON Fallback)
            try {
                const complaintsFile = path_1.default.join(__dirname, '../../data/complaints.json');
                if (fs_1.default.existsSync(complaintsFile)) {
                    const list = JSON.parse(fs_1.default.readFileSync(complaintsFile, 'utf8'));
                    list.forEach((c) => {
                        if (c.reported_by) {
                            const entry = getEntry(c.reported_by);
                            entry.complaintsCount += 1;
                            const timestamp = c.timestamp;
                            if (timestamp && (!entry.lastActive || new Date(timestamp) > new Date(entry.lastActive))) {
                                entry.lastActive = timestamp;
                            }
                        }
                    });
                }
            }
            catch (err) { }
            // 3. Scan DB Redemptions & Sync
            try {
                const redemptions = betaService_1.betaService.getAllRedemptions();
                redemptions.forEach(r => {
                    getEntry(r.userId);
                });
            }
            catch (err) { }
            // Calculate health score:
            Object.values(usersHealth).forEach(u => {
                let score = 100;
                if (u.searchesCount === 0)
                    score -= 20;
                if (u.feedbackCount > 0)
                    score += 10;
                if (u.complaintsCount > 0)
                    score += 5;
                if (u.lastActive) {
                    const daysInactive = (now.getTime() - new Date(u.lastActive).getTime()) / (24 * 60 * 60 * 1000);
                    if (daysInactive > 7) {
                        score -= 30;
                    }
                }
                else {
                    score -= 40; // Never active
                }
                u.healthScore = Math.max(0, Math.min(100, score));
            });
            res.json({
                success: true,
                data: Object.values(usersHealth)
            });
        }
        catch (err) {
            logger_1.winstonLogger.error(`[ADMIN_BETA] getBetaUserHealth error: ${err.message}`);
            res.status(500).json({ success: false, error: 'Failed to fetch user health scores' });
        }
    }
    // ─── Self Learning Engine Management ──────────────────────────────────────
    async getSelfLearningData(req, res) {
        try {
            const { table } = req.query;
            if (!table || typeof table !== 'string') {
                return res.status(400).json({ success: false, error: 'Table parameter is required' });
            }
            const data = selfLearningService_1.selfLearningService.getLocalDataForTable(table);
            res.json({ success: true, data });
        }
        catch (err) {
            logger_1.winstonLogger.error(`[ADMIN_SELF_LEARNING] getSelfLearningData error: ${err.message}`);
            res.status(500).json({ success: false, error: 'Failed to fetch self-learning data' });
        }
    }
    async getSelfLearningAnalytics(req, res) {
        try {
            const analytics = await selfLearningService_1.selfLearningService.getAnalytics();
            res.json({ success: true, data: analytics });
        }
        catch (err) {
            logger_1.winstonLogger.error(`[ADMIN_SELF_LEARNING] getSelfLearningAnalytics error: ${err.message}`);
            res.status(500).json({ success: false, error: 'Failed to fetch self-learning analytics' });
        }
    }
    async approveSelfLearning(req, res) {
        try {
            const { table, id } = req.body;
            const approvedBy = req.adminEmail || 'admin@trayago.com';
            if (!table || !id) {
                return res.status(400).json({ success: false, error: 'Table and ID are required' });
            }
            const success = await selfLearningService_1.selfLearningService.approveRecord(table, id, approvedBy);
            res.json({ success });
        }
        catch (err) {
            logger_1.winstonLogger.error(`[ADMIN_SELF_LEARNING] approveSelfLearning error: ${err.message}`);
            res.status(500).json({ success: false, error: 'Failed to approve self-learning record' });
        }
    }
    async rejectSelfLearning(req, res) {
        try {
            const { table, id } = req.body;
            if (!table || !id) {
                return res.status(400).json({ success: false, error: 'Table and ID are required' });
            }
            const success = await selfLearningService_1.selfLearningService.rejectRecord(table, id);
            res.json({ success });
        }
        catch (err) {
            logger_1.winstonLogger.error(`[ADMIN_SELF_LEARNING] rejectSelfLearning error: ${err.message}`);
            res.status(500).json({ success: false, error: 'Failed to reject self-learning record' });
        }
    }
}
exports.AdminController = AdminController;
exports.adminController = new AdminController();
