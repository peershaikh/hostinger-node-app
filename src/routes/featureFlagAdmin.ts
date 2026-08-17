import { Router } from 'express';
import { featureFlagController } from '../controllers/featureFlagController';
import { requireAuth } from '../middleware/authMiddleware';
import { requireAdmin } from '../middleware/adminAuth';
import { adminLimiter } from '../middleware/rateLimiter';

const router = Router();

// Public route for client app feature adaptation
router.get('/public', featureFlagController.getPublicFlags);

// Protected Admin API
router.use(adminLimiter);
router.use(requireAuth);
router.use(requireAdmin);

router.get('/', featureFlagController.getFeatureFlags);
router.get('/history/logs', featureFlagController.getAuditLogs);
router.post('/preview', featureFlagController.previewFeatureFlag);
router.get('/:key', featureFlagController.getFeatureFlag);
router.post('/:key/update', featureFlagController.updateFeatureFlag);
router.post('/:key/kill-switch', featureFlagController.killSwitchFeatureFlag);
router.post('/:key/rollback', featureFlagController.rollbackFeatureFlag);

export default router;
