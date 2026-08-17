/**
 * PHASE_ADMIN_SAFE_BULK_OPERATIONS_053 — Bulk Admin Routes
 *
 * Routes for previewing, executing, monitoring, cancelling, and rolling back
 * administrative bulk operations.
 */

import { Router } from 'express';
import { bulkAdminController } from '../controllers/bulkAdminController';
import { requireAuth } from '../middleware/authMiddleware';
import { requireAdmin } from '../middleware/adminAuth';
import { adminLimiter } from '../middleware/rateLimiter';

const router = Router();

// Strict RBAC and authentication guards
router.use(requireAuth);
router.use(requireAdmin as any);
router.use(adminLimiter as any);

router.post('/preview', bulkAdminController.preview.bind(bulkAdminController));
router.post('/execute', bulkAdminController.execute.bind(bulkAdminController));
router.get('/jobs', bulkAdminController.listJobs.bind(bulkAdminController));
router.get('/jobs/:id', bulkAdminController.getJob.bind(bulkAdminController));
router.post('/jobs/:id/cancel', bulkAdminController.cancelJob.bind(bulkAdminController));
router.post('/jobs/:id/rollback', bulkAdminController.rollbackJob.bind(bulkAdminController));
router.get('/jobs/:id/export', bulkAdminController.exportResult.bind(bulkAdminController));

export default router;
