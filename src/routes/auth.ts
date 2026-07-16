import { Router } from 'express';
import { authController } from '../controllers/authController';
import { requireAuth } from '../middleware/authMiddleware';
import { authLimiter } from '../middleware/rateLimiter';

const router = Router();

router.post('/send-otp', authLimiter as any, authController.sendOtp);
router.post('/signup', authLimiter as any, authController.signup);
router.post('/login', authLimiter as any, authController.login);
router.post('/refresh', authController.refresh);
router.post('/logout', authController.logout);
router.post('/check-device-lock', authLimiter, authController.checkDeviceLock);
router.post('/mock-ad', authLimiter, authController.mockAdView);
router.post('/verify-otp', authLimiter as any, authController.verifyOtp);
router.get('/status', authController.status);
router.get('/quota-status', authController.getQuotaStatus);
router.post('/can-use-feature', authController.canUseFeature);
router.post('/can-use-split', authController.canUseSplit);
router.post('/app-open', authController.appOpen);
router.get('/profile', authController.getProfile);
router.put('/profile', authController.updateProfile);
router.delete('/profile', requireAuth, authController.deleteAccount);

router.post('/mobile/send-otp', authLimiter as any, authController.sendMobileOtp);
router.post('/mobile/verify-otp', authLimiter as any, authController.verifyMobileOtp);
router.post('/profile/avatar', authLimiter as any, authController.uploadAvatar);
router.delete('/profile/avatar', authLimiter as any, authController.removeAvatar);

// ─── Forgot Password Flow ──────────────────────────────────────────────────
router.post('/forgot-password', authLimiter as any, authController.forgotPassword);
router.post('/reset-password', authLimiter as any, authController.resetPassword);

export default router;
