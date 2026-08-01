import { Router } from 'express';
import { 
  registerDeviceToken, 
  updateNotificationPreferences,
  getNotifications,
  markNotificationsRead,
  markAllNotificationsRead,
  deleteDeviceToken,
  clearNotificationHistory
} from '../controllers/notificationController';
import { notificationRegisterLimiter, notificationPrefsLimiter } from '../middleware/rateLimiter';
import { requireAuth } from '../middleware/authMiddleware';

const router = Router();

// Endpoint to register PWA/native device token (pre-auth, device-level — no requireAuth)
router.post('/register', notificationRegisterLimiter, registerDeviceToken);
router.delete('/token', deleteDeviceToken);

// Endpoint to update privacy settings (pre-auth, device-level — no requireAuth)
router.put('/preferences', notificationPrefsLimiter, updateNotificationPreferences);

// Notification history routes — require authenticated session (P0-002)
router.get('/', requireAuth, getNotifications);
router.post('/read', requireAuth, markNotificationsRead);
router.post('/read-all', requireAuth, markAllNotificationsRead);
router.delete('/history', requireAuth, clearNotificationHistory);

export default router;

