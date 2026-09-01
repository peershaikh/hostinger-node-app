/**
 * News Admin CMS Routes — Phase 066
 *
 * Mounted at /api/admin/news (inside admin router which already applies requireAuth).
 * All routes additionally require requireAdmin.
 * Rate-limited by adminLimiter.
 * CSRF is handled globally by conditionalCsrf middleware (DO NOT modify here).
 */

import { Router } from 'express';
import { requireAdmin } from '../middleware/adminAuth';
import { adminLimiter } from '../middleware/rateLimiter';
import { newsAdminController } from '../controllers/newsAdminController';
import { asyncHandler } from '../middleware/errorHandler';

const router = Router();

// ─── All routes require admin authorization + rate limiting ───────────────────
// (requireAuth is already applied by the parent admin router)

router.get(
  '/',
  adminLimiter as any,
  requireAdmin as any,
  asyncHandler(newsAdminController.listArticles.bind(newsAdminController))
);

router.get(
  '/analytics',
  adminLimiter as any,
  requireAdmin as any,
  asyncHandler(newsAdminController.getAnalytics.bind(newsAdminController))
);

router.get(
  '/search-console',
  adminLimiter as any,
  requireAdmin as any,
  asyncHandler(newsAdminController.getSearchConsoleAnalytics.bind(newsAdminController))
);

router.get(
  '/conversion-funnel',
  adminLimiter as any,
  requireAdmin as any,
  asyncHandler(newsAdminController.getConversionFunnel.bind(newsAdminController))
);

router.get(
  '/revenue-intelligence',
  adminLimiter as any,
  requireAdmin as any,
  asyncHandler(newsAdminController.getRevenueIntelligence.bind(newsAdminController))
);

router.get(
  '/:id',
  adminLimiter as any,
  requireAdmin as any,
  asyncHandler(newsAdminController.getArticle.bind(newsAdminController))
);

router.get(
  '/:id/audit',
  adminLimiter as any,
  requireAdmin as any,
  asyncHandler(newsAdminController.getAuditHistory.bind(newsAdminController))
);

router.patch(
  '/:id/draft',
  adminLimiter as any,
  requireAdmin as any,
  asyncHandler(newsAdminController.editDraft.bind(newsAdminController))
);

router.post(
  '/:id/approve',
  adminLimiter as any,
  requireAdmin as any,
  asyncHandler(newsAdminController.approve.bind(newsAdminController))
);

router.post(
  '/:id/reject',
  adminLimiter as any,
  requireAdmin as any,
  asyncHandler(newsAdminController.reject.bind(newsAdminController))
);

router.post(
  '/:id/schedule',
  adminLimiter as any,
  requireAdmin as any,
  asyncHandler(newsAdminController.schedule.bind(newsAdminController))
);

router.post(
  '/:id/publish',
  adminLimiter as any,
  requireAdmin as any,
  asyncHandler(newsAdminController.publish.bind(newsAdminController))
);

router.post(
  '/:id/unpublish',
  adminLimiter as any,
  requireAdmin as any,
  asyncHandler(newsAdminController.unpublish.bind(newsAdminController))
);

router.post(
  '/:id/archive',
  adminLimiter as any,
  requireAdmin as any,
  asyncHandler(newsAdminController.archive.bind(newsAdminController))
);

router.post(
  '/:id/restore',
  adminLimiter as any,
  requireAdmin as any,
  asyncHandler(newsAdminController.restore.bind(newsAdminController))
);

export default router;
