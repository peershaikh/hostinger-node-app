import { Router } from 'express';
import { aiAdminController } from '../controllers/aiAdminController';
import { requireAuth } from '../middleware/authMiddleware';
import { requireAdmin } from '../middleware/adminAuth';

const router = Router();

// Apply requireAdmin to all AI admin routes
router.use(requireAdmin);

router.get('/providers', aiAdminController.getAiProviders);
router.post('/providers/update', aiAdminController.updateAiProviders);
router.post('/providers/test', aiAdminController.testAiProvider);
router.get('/history', aiAdminController.getAiAuditHistory);
router.post('/rollback', aiAdminController.rollbackAi);
router.get('/observability', aiAdminController.getAiObservability);

export default router;
