import { Router } from 'express';
import { analyticsController } from '../controllers/analyticsController';

const router = Router();

// Stats for Admin & Frontend
router.get('/', analyticsController.getDashboard.bind(analyticsController));
router.get('/trending', analyticsController.getTrending.bind(analyticsController));

// Tracking & Feedback
router.post('/event', analyticsController.trackEvent.bind(analyticsController));
router.post('/split-click', analyticsController.logSplitClick.bind(analyticsController));
router.post('/feedback', analyticsController.submitFeedback.bind(analyticsController));
router.post('/complaint', analyticsController.logComplaint.bind(analyticsController));

// Referrals
router.get('/referrals/:sessionId?', analyticsController.getReferralStats.bind(analyticsController));
router.post('/referrals/claim', analyticsController.claimReferral.bind(analyticsController));

export default router;
