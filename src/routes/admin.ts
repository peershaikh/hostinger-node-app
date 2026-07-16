import { Router } from 'express';
import { adminController } from '../controllers/adminController';
import { requireAuth } from '../middleware/authMiddleware';
import { requireAdmin } from '../middleware/adminAuth';
import { adminLimiter, diagnosticsLimiter, cacheClearLimiter } from '../middleware/rateLimiter';
import providersRouter from './providers';
import ratesRouter from './rates';

const router = Router();

// ─── P1-2 (PHASE_4C885): /api/admin/health must be BEFORE requireAuth ──────────
// All other admin routes require a verified JWT, but the health probe is called
// by monitoring infrastructure without credentials. Placing this route above the
// router.use(requireAuth) guard makes it publicly accessible.
router.get('/health', (_req, res) => {
  res.status(200).json({
    success: true,
    status: 'ok',
    uptime: process.uptime(),
    timestamp: new Date().toISOString(),
  });
});

// PHASE_4C837 P0-003: All /api/admin/* routes require verified JWT before role check
router.use(requireAuth);

// Dashboard Admin API
router.get('/analytics', adminLimiter as any, requireAdmin as any, adminController.getAdminAnalytics.bind(adminController));
router.get('/analytics/history', adminLimiter as any, requireAdmin as any, adminController.getAnalyticsHistory.bind(adminController));
router.get('/analytics/export', adminLimiter as any, requireAdmin as any, adminController.exportAnalyticsLogs.bind(adminController));

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

// ─── API Provider Management ────────────────────────────────────────────────
router.use('/providers/rates', adminLimiter as any, requireAdmin as any, ratesRouter);
router.use('/providers', adminLimiter as any, requireAdmin as any, providersRouter);

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

export default router;
