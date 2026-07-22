import { Router } from 'express';
import { referralController } from '../controllers/referralController';
import { requireAuth } from '../middleware/authMiddleware';
import { referralLimiter } from '../middleware/rateLimiter';
import { validateBody } from '../middleware/validateSchema';
import { referralCodeSchema } from '../schemas/appSchemas';

const router = Router();

router.get('/me', requireAuth, referralLimiter as any, referralController.getMyReferralCode.bind(referralController));
router.get('/stats', requireAuth, referralLimiter as any, referralController.getStats.bind(referralController));
router.post('/apply', requireAuth, referralLimiter as any, validateBody(referralCodeSchema), referralController.apply.bind(referralController));

router.get(
  '/leaderboard',
  referralLimiter as any,
  referralController.getLeaderboard.bind(referralController)
);

router.get(
  '/history',
  requireAuth,
  referralLimiter as any,
  referralController.getHistory.bind(referralController)
);

export default router;
