import { Router } from 'express';
import { adminController } from '../controllers/adminController';
import { requireAuth } from '../middleware/authMiddleware';
import { requireAdmin } from '../middleware/adminAuth';
import { adminLimiter, diagnosticsLimiter, cacheClearLimiter } from '../middleware/rateLimiter';
import providersRouter from './providers';
import ratesRouter from './rates';
import bulkAdminRouter from './bulkAdmin';
import featureFlagAdminRouter from './featureFlagAdmin';
import bookingAdminRouter from './bookingAdmin';
import aiAdminRouter from './aiAdmin';
import newsAdminRouter from './newsAdmin';
// ── Phase 10.8.42 additions (T2/T3/T4) ──────────────────────────────────────
import { eventMetrics } from '../services/eventMetrics';
import { userCache } from '../cache/userCache';
import { smartAvailabilityMetrics } from '../services/smartAvailabilityMetrics';

const router = Router();

// ─── P1-2 (PHASE_4C885): /api/admin/health must be BEFORE requireAuth ──────────
// All other admin routes require a verified JWT, but the health probe is called
// by monitoring infrastructure without credentials. Placing this route above the
// router.use(requireAuth) guard makes it publicly accessible.
router.get('/health', (_req, res) => {
  // T4 (PHASE 10.8.42 F1): use global.SYSTEM_MODE — set at boot, zero I/O cost.
  // validateConnection() runs 5 sequential DB queries (500-2000ms); not suitable for polling.
  const dbConnected = (global as any).SYSTEM_MODE !== 'MODE_A';

  const eventStats = eventMetrics.snapshot();               // T2: event pipeline counters
  const cacheStats = userCache.getStats();                  // T3: user L1/L2 cache counters
  const availStats = smartAvailabilityMetrics.getSnapshot(); // T3: availability cache counters

  res.status(dbConnected ? 200 : 503).json({
    // Existing fields preserved (backward-compatible, additive only)
    success:   true,
    status:    dbConnected ? 'ok' : 'degraded',
    uptime:    process.uptime(),
    timestamp: new Date().toISOString(),
    // T4: database connectivity via SYSTEM_MODE
    database: {
      connected: dbConnected,
    },
    // T2: universal event pipeline metrics
    event_pipeline: {
      events_received: eventStats.events_received,
      events_written:  eventStats.events_written,
      events_failed:   eventStats.events_failed,
      queue_depth:     eventStats.queue_depth,
      retry_count:     eventStats.retry_count,
    },
    // T3: in-process cache counters (all 11 fields — zero I/O)
    cache: {
      user_l1_hits:            cacheStats.l1Hits,
      user_l2_hits:            cacheStats.l2Hits,
      user_misses:             cacheStats.misses,
      user_invalidations:      cacheStats.invalidations,
      user_pubsub_events:      cacheStats.pubSubEvents,
      avail_l1_hits:           availStats.l1_hits,
      avail_l2_hits:           availStats.l2_hits,
      avail_provider_calls:    availStats.provider_calls,
      avail_singleflight_hits: availStats.singleflight_hits,
      avail_redis_failures:    availStats.redis_failures,
      avail_latency_avg_ms:    availStats.cache_latency_avg_ms,
    },
  });
});

// PHASE_4C837 P0-003: All /api/admin/* routes require verified JWT before role check
router.use(requireAuth);

// Dashboard Admin API
router.get('/analytics', adminLimiter as any, requireAdmin as any, adminController.getAdminAnalytics.bind(adminController));
router.get('/analytics/history', adminLimiter as any, requireAdmin as any, adminController.getAnalyticsHistory.bind(adminController));
router.get('/analytics/export', adminLimiter as any, requireAdmin as any, adminController.exportAnalyticsLogs.bind(adminController));
router.get('/daily-operations', adminLimiter as any, requireAdmin as any, adminController.getDailyOperations.bind(adminController));
router.get('/incidents', adminLimiter as any, requireAdmin as any, adminController.getIncidents.bind(adminController));
router.get('/engineering-tasks', adminLimiter as any, requireAdmin as any, adminController.getEngineeringTasks.bind(adminController));
router.get('/intelligence-v2', adminLimiter as any, requireAdmin as any, adminController.getIntelligenceV2.bind(adminController));
router.get('/production-incidents', adminLimiter as any, requireAdmin as any, adminController.getProductionIncidents.bind(adminController));
// Phase 10.8.42 (T8): morning ops digest summary
router.get('/last-digest', adminLimiter as any, requireAdmin as any, adminController.getLastDigest.bind(adminController));





// Payment & Revenue API
router.get('/revenue', adminLimiter as any, requireAdmin as any, adminController.getPaymentRevenue.bind(adminController));
router.get('/subscriptions', adminLimiter as any, requireAdmin as any, adminController.getPaymentSubscriptions.bind(adminController));
router.get('/payment-metrics', adminLimiter as any, requireAdmin as any, adminController.getPaymentMetrics.bind(adminController));

router.get('/audit-logs', adminLimiter as any, requireAdmin as any, adminController.listAuditLogs.bind(adminController));
router.post('/audit-logs', adminLimiter as any, requireAdmin as any, adminController.logAuditEvent.bind(adminController));
router.get('/diagnostics', diagnosticsLimiter as any, requireAdmin as any, adminController.getDiagnostics.bind(adminController));
router.post('/cache/clear', cacheClearLimiter as any, requireAdmin as any, adminController.clearCache.bind(adminController));
router.get('/feedback', adminLimiter as any, requireAdmin as any, adminController.listFeedback.bind(adminController));
router.get('/feedback/categories', adminLimiter as any, requireAdmin as any, adminController.listFeedbackCategories.bind(adminController));
router.get('/feedback/analytics', adminLimiter as any, requireAdmin as any, adminController.getFeedbackCategoryAnalytics.bind(adminController));
router.post('/push/test', adminLimiter as any, requireAdmin as any, adminController.testPushNotification.bind(adminController));

// ─── User Management ────────────────────────────────────────────────────────
router.get('/users', adminLimiter as any, requireAdmin as any, adminController.listUsers.bind(adminController));
router.get('/users/:id', adminLimiter as any, requireAdmin as any, adminController.getUser.bind(adminController));
router.post('/users/:id/block', adminLimiter as any, requireAdmin as any, adminController.blockUser.bind(adminController));
router.post('/users/:id/unblock', adminLimiter as any, requireAdmin as any, adminController.unblockUser.bind(adminController));
router.post('/users/:id/reset-limits', adminLimiter as any, requireAdmin as any, adminController.resetUserLimits.bind(adminController));
router.post('/users/:id/change-plan', adminLimiter as any, requireAdmin as any, adminController.changeUserPlan.bind(adminController));
router.post('/users/:id/override-quota', adminLimiter as any, requireAdmin as any, adminController.overrideUserQuota.bind(adminController));
router.post('/users/bulk-block', adminLimiter as any, requireAdmin as any, adminController.bulkBlockUsers.bind(adminController));
router.post('/users/bulk-unblock', adminLimiter as any, requireAdmin as any, adminController.bulkUnblockUsers.bind(adminController));
router.post('/users/:id/terminate-sessions', adminLimiter as any, requireAdmin as any, adminController.terminateUserSessions.bind(adminController));
router.post('/users/:id/adjust-credits', adminLimiter as any, requireAdmin as any, adminController.adjustUserCredits.bind(adminController));
router.get('/signup-intelligence', adminLimiter as any, requireAdmin as any, adminController.getSignupIntelligence.bind(adminController));
router.get('/learning-intelligence', adminLimiter as any, requireAdmin as any, adminController.getLearningIntelligence.bind(adminController));

// ─── Safe Bulk Operations Engine (Phase 053) ────────────────────────────────
router.use('/bulk', bulkAdminRouter);

// ─── Safe Feature Flag & Kill Switch Control Center (Phase 054) ─────────────
router.use('/feature-flags', featureFlagAdminRouter);

// ─── API Provider Management ────────────────────────────────────────────────
router.use('/providers/rates', adminLimiter as any, requireAdmin as any, ratesRouter);
router.use('/providers', adminLimiter as any, requireAdmin as any, providersRouter);
router.use('/booking', adminLimiter as any, requireAdmin as any, bookingAdminRouter);
router.use('/ai', adminLimiter as any, requireAdmin as any, aiAdminRouter);

// ─── Beta Codes Management ──────────────────────────────────────────────────
router.get('/beta/codes', adminLimiter as any, requireAdmin as any, adminController.listBetaCodes.bind(adminController));
router.post('/beta/codes', adminLimiter as any, requireAdmin as any, adminController.createBetaCode.bind(adminController));
router.post('/beta/codes/:code/disable', adminLimiter as any, requireAdmin as any, adminController.disableBetaCode.bind(adminController));
router.get('/beta/redemptions', adminLimiter as any, requireAdmin as any, adminController.listBetaRedemptions.bind(adminController));
router.get('/beta/analytics-dashboard', adminLimiter as any, requireAdmin as any, adminController.getBetaAnalyticsData.bind(adminController));
router.get('/beta/user-health', adminLimiter as any, requireAdmin as any, adminController.getBetaUserHealth.bind(adminController));

// ─── Self Learning Engine Management ────────────────────────────────────────
router.get('/self-learning/data', adminLimiter as any, requireAdmin as any, adminController.getSelfLearningData.bind(adminController));
router.get('/self-learning/analytics', adminLimiter as any, requireAdmin as any, adminController.getSelfLearningAnalytics.bind(adminController));
router.post('/self-learning/approve', adminLimiter as any, requireAdmin as any, adminController.approveSelfLearning.bind(adminController));
router.post('/self-learning/reject', adminLimiter as any, requireAdmin as any, adminController.rejectSelfLearning.bind(adminController));
router.post('/self-learning/revalidate-split', adminLimiter as any, requireAdmin as any, adminController.revalidateSplitRoute.bind(adminController));

// ─── News CMS Admin (Phase 066) ─────────────────────────────────────────────
router.use('/news', newsAdminRouter);

export default router;
