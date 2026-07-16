import { Router } from 'express';
import { pnrController } from '../controllers/pnrController';
import { requireAuth } from '../middleware/authMiddleware';
import { pnrLimiter } from '../middleware/rateLimiter';
import { usageMiddleware } from '../middleware/usageMiddleware';

const router = Router();

// @route   GET /api/pnr/status/:pnr or /api/pnr/predict/:pnr
// @desc    Get PNR status + AI prediction
router.get('/:pnr', pnrLimiter, usageMiddleware('pnr'), pnrController.getStatus);
router.get('/predict/:pnr', pnrLimiter, usageMiddleware('pnr'), pnrController.getStatus);

router.post('/track', pnrLimiter, pnrController.track);
router.post('/upgrade/:pnr', requireAuth, pnrController.upgrade);
router.get('/list/:sessionId', pnrController.listTracked);
router.delete('/untrack/:pnr/:sessionId', pnrController.untrack);

export default router;
