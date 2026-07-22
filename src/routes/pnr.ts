import { Router } from 'express';
import { pnrController } from '../controllers/pnrController';
import { requireAuth } from '../middleware/authMiddleware';
import { pnrLimiter } from '../middleware/rateLimiter';
import { usageMiddleware } from '../middleware/usageMiddleware';
import { validateParams } from '../middleware/validateSchema';
import { pnrParamSchema } from '../schemas/appSchemas';

const router = Router();

// @route   GET /api/pnr/:pnr or /api/pnr/predict/:pnr
// @desc    Get PNR status + AI prediction (Enforces exact 10 numeric digits validation)
router.get('/:pnr', pnrLimiter, usageMiddleware('pnr'), validateParams(pnrParamSchema), pnrController.getStatus);
router.get('/predict/:pnr', pnrLimiter, usageMiddleware('pnr'), validateParams(pnrParamSchema), pnrController.getStatus);

router.post('/track', pnrLimiter, pnrController.track);
router.post('/upgrade/:pnr', requireAuth, validateParams(pnrParamSchema), pnrController.upgrade);
router.get('/list/:sessionId', pnrController.listTracked);
router.delete('/untrack/:pnr/:sessionId', pnrController.untrack);

export default router;
