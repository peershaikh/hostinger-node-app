"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const express_1 = require("express");
const adminController_1 = require("../controllers/adminController");
const authMiddleware_1 = require("../middleware/authMiddleware");
const adminAuth_1 = require("../middleware/adminAuth");
const rateLimiter_1 = require("../middleware/rateLimiter");
const providers_1 = __importDefault(require("./providers"));
const rates_1 = __importDefault(require("./rates"));
// ── Phase 10.8.42 additions (T2/T3/T4) ──────────────────────────────────────
const eventMetrics_1 = require("../services/eventMetrics");
const userCache_1 = require("../cache/userCache");
const smartAvailabilityMetrics_1 = require("../services/smartAvailabilityMetrics");
const router = (0, express_1.Router)();
// ─── P1-2 (PHASE_4C885): /api/admin/health must be BEFORE requireAuth ──────────
// All other admin routes require a verified JWT, but the health probe is called
// by monitoring infrastructure without credentials. Placing this route above the
// router.use(requireAuth) guard makes it publicly accessible.
router.get('/health', (_req, res) => {
    // T4 (PHASE 10.8.42 F1): use global.SYSTEM_MODE — set at boot, zero I/O cost.
    // validateConnection() runs 5 sequential DB queries (500-2000ms); not suitable for polling.
    const dbConnected = global.SYSTEM_MODE !== 'MODE_A';
    const eventStats = eventMetrics_1.eventMetrics.snapshot(); // T2: event pipeline counters
    const cacheStats = userCache_1.userCache.getStats(); // T3: user L1/L2 cache counters
    const availStats = smartAvailabilityMetrics_1.smartAvailabilityMetrics.getSnapshot(); // T3: availability cache counters
    res.status(dbConnected ? 200 : 503).json({
        // Existing fields preserved (backward-compatible, additive only)
        success: true,
        status: dbConnected ? 'ok' : 'degraded',
        uptime: process.uptime(),
        timestamp: new Date().toISOString(),
        // T4: database connectivity via SYSTEM_MODE
        database: {
            connected: dbConnected,
        },
        // T2: universal event pipeline metrics
        event_pipeline: {
            events_received: eventStats.events_received,
            events_written: eventStats.events_written,
            events_failed: eventStats.events_failed,
            queue_depth: eventStats.queue_depth,
            retry_count: eventStats.retry_count,
        },
        // T3: in-process cache counters (all 11 fields — zero I/O)
        cache: {
            user_l1_hits: cacheStats.l1Hits,
            user_l2_hits: cacheStats.l2Hits,
            user_misses: cacheStats.misses,
            user_invalidations: cacheStats.invalidations,
            user_pubsub_events: cacheStats.pubSubEvents,
            avail_l1_hits: availStats.l1_hits,
            avail_l2_hits: availStats.l2_hits,
            avail_provider_calls: availStats.provider_calls,
            avail_singleflight_hits: availStats.singleflight_hits,
            avail_redis_failures: availStats.redis_failures,
            avail_latency_avg_ms: availStats.cache_latency_avg_ms,
        },
    });
});
// PHASE_4C837 P0-003: All /api/admin/* routes require verified JWT before role check
router.use(authMiddleware_1.requireAuth);
// Dashboard Admin API
router.get('/analytics', rateLimiter_1.adminLimiter, adminAuth_1.requireAdmin, adminController_1.adminController.getAdminAnalytics.bind(adminController_1.adminController));
router.get('/analytics/history', rateLimiter_1.adminLimiter, adminAuth_1.requireAdmin, adminController_1.adminController.getAnalyticsHistory.bind(adminController_1.adminController));
router.get('/analytics/export', rateLimiter_1.adminLimiter, adminAuth_1.requireAdmin, adminController_1.adminController.exportAnalyticsLogs.bind(adminController_1.adminController));
router.get('/daily-operations', rateLimiter_1.adminLimiter, adminAuth_1.requireAdmin, adminController_1.adminController.getDailyOperations.bind(adminController_1.adminController));
router.get('/incidents', rateLimiter_1.adminLimiter, adminAuth_1.requireAdmin, adminController_1.adminController.getIncidents.bind(adminController_1.adminController));
router.get('/engineering-tasks', rateLimiter_1.adminLimiter, adminAuth_1.requireAdmin, adminController_1.adminController.getEngineeringTasks.bind(adminController_1.adminController));
router.get('/intelligence-v2', rateLimiter_1.adminLimiter, adminAuth_1.requireAdmin, adminController_1.adminController.getIntelligenceV2.bind(adminController_1.adminController));
router.get('/production-incidents', rateLimiter_1.adminLimiter, adminAuth_1.requireAdmin, adminController_1.adminController.getProductionIncidents.bind(adminController_1.adminController));
// Phase 10.8.42 (T8): morning ops digest summary
router.get('/last-digest', rateLimiter_1.adminLimiter, adminAuth_1.requireAdmin, adminController_1.adminController.getLastDigest.bind(adminController_1.adminController));
// Payment & Revenue API
router.get('/revenue', rateLimiter_1.adminLimiter, adminAuth_1.requireAdmin, adminController_1.adminController.getPaymentRevenue.bind(adminController_1.adminController));
router.get('/subscriptions', rateLimiter_1.adminLimiter, adminAuth_1.requireAdmin, adminController_1.adminController.getPaymentSubscriptions.bind(adminController_1.adminController));
router.get('/payment-metrics', rateLimiter_1.adminLimiter, adminAuth_1.requireAdmin, adminController_1.adminController.getPaymentMetrics.bind(adminController_1.adminController));
router.get('/audit-logs', rateLimiter_1.adminLimiter, adminAuth_1.requireAdmin, adminController_1.adminController.listAuditLogs.bind(adminController_1.adminController));
router.post('/audit-logs', rateLimiter_1.adminLimiter, adminAuth_1.requireAdmin, adminController_1.adminController.logAuditEvent.bind(adminController_1.adminController));
router.get('/diagnostics', rateLimiter_1.diagnosticsLimiter, adminAuth_1.requireAdmin, adminController_1.adminController.getDiagnostics.bind(adminController_1.adminController));
router.post('/cache/clear', rateLimiter_1.cacheClearLimiter, adminAuth_1.requireAdmin, adminController_1.adminController.clearCache.bind(adminController_1.adminController));
router.get('/feedback', rateLimiter_1.adminLimiter, adminAuth_1.requireAdmin, adminController_1.adminController.listFeedback.bind(adminController_1.adminController));
router.get('/feedback/categories', rateLimiter_1.adminLimiter, adminAuth_1.requireAdmin, adminController_1.adminController.listFeedbackCategories.bind(adminController_1.adminController));
router.get('/feedback/analytics', rateLimiter_1.adminLimiter, adminAuth_1.requireAdmin, adminController_1.adminController.getFeedbackCategoryAnalytics.bind(adminController_1.adminController));
router.post('/push/test', rateLimiter_1.adminLimiter, adminAuth_1.requireAdmin, adminController_1.adminController.testPushNotification.bind(adminController_1.adminController));
// ─── User Management ────────────────────────────────────────────────────────
router.get('/users', rateLimiter_1.adminLimiter, adminAuth_1.requireAdmin, adminController_1.adminController.listUsers.bind(adminController_1.adminController));
router.get('/users/:id', rateLimiter_1.adminLimiter, adminAuth_1.requireAdmin, adminController_1.adminController.getUser.bind(adminController_1.adminController));
router.post('/users/:id/block', rateLimiter_1.adminLimiter, adminAuth_1.requireAdmin, adminController_1.adminController.blockUser.bind(adminController_1.adminController));
router.post('/users/:id/unblock', rateLimiter_1.adminLimiter, adminAuth_1.requireAdmin, adminController_1.adminController.unblockUser.bind(adminController_1.adminController));
router.post('/users/:id/reset-limits', rateLimiter_1.adminLimiter, adminAuth_1.requireAdmin, adminController_1.adminController.resetUserLimits.bind(adminController_1.adminController));
router.post('/users/:id/change-plan', rateLimiter_1.adminLimiter, adminAuth_1.requireAdmin, adminController_1.adminController.changeUserPlan.bind(adminController_1.adminController));
router.post('/users/:id/override-quota', rateLimiter_1.adminLimiter, adminAuth_1.requireAdmin, adminController_1.adminController.overrideUserQuota.bind(adminController_1.adminController));
router.post('/users/bulk-block', rateLimiter_1.adminLimiter, adminAuth_1.requireAdmin, adminController_1.adminController.bulkBlockUsers.bind(adminController_1.adminController));
router.post('/users/bulk-unblock', rateLimiter_1.adminLimiter, adminAuth_1.requireAdmin, adminController_1.adminController.bulkUnblockUsers.bind(adminController_1.adminController));
router.post('/users/:id/terminate-sessions', rateLimiter_1.adminLimiter, adminAuth_1.requireAdmin, adminController_1.adminController.terminateUserSessions.bind(adminController_1.adminController));
router.post('/users/:id/adjust-credits', rateLimiter_1.adminLimiter, adminAuth_1.requireAdmin, adminController_1.adminController.adjustUserCredits.bind(adminController_1.adminController));
// ─── API Provider Management ────────────────────────────────────────────────
router.use('/providers/rates', rateLimiter_1.adminLimiter, adminAuth_1.requireAdmin, rates_1.default);
router.use('/providers', rateLimiter_1.adminLimiter, adminAuth_1.requireAdmin, providers_1.default);
// ─── Beta Codes Management ──────────────────────────────────────────────────
router.get('/beta/codes', rateLimiter_1.adminLimiter, adminAuth_1.requireAdmin, adminController_1.adminController.listBetaCodes.bind(adminController_1.adminController));
router.post('/beta/codes', rateLimiter_1.adminLimiter, adminAuth_1.requireAdmin, adminController_1.adminController.createBetaCode.bind(adminController_1.adminController));
router.post('/beta/codes/:code/disable', rateLimiter_1.adminLimiter, adminAuth_1.requireAdmin, adminController_1.adminController.disableBetaCode.bind(adminController_1.adminController));
router.get('/beta/redemptions', rateLimiter_1.adminLimiter, adminAuth_1.requireAdmin, adminController_1.adminController.listBetaRedemptions.bind(adminController_1.adminController));
router.get('/beta/analytics-dashboard', rateLimiter_1.adminLimiter, adminAuth_1.requireAdmin, adminController_1.adminController.getBetaAnalyticsData.bind(adminController_1.adminController));
router.get('/beta/user-health', rateLimiter_1.adminLimiter, adminAuth_1.requireAdmin, adminController_1.adminController.getBetaUserHealth.bind(adminController_1.adminController));
// ─── Self Learning Engine Management ────────────────────────────────────────
router.get('/self-learning/data', rateLimiter_1.adminLimiter, adminAuth_1.requireAdmin, adminController_1.adminController.getSelfLearningData.bind(adminController_1.adminController));
router.get('/self-learning/analytics', rateLimiter_1.adminLimiter, adminAuth_1.requireAdmin, adminController_1.adminController.getSelfLearningAnalytics.bind(adminController_1.adminController));
router.post('/self-learning/approve', rateLimiter_1.adminLimiter, adminAuth_1.requireAdmin, adminController_1.adminController.approveSelfLearning.bind(adminController_1.adminController));
router.post('/self-learning/reject', rateLimiter_1.adminLimiter, adminAuth_1.requireAdmin, adminController_1.adminController.rejectSelfLearning.bind(adminController_1.adminController));
exports.default = router;
