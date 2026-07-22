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

const router = Router();

// Endpoint to register PWA/native device token
router.post('/register', notificationRegisterLimiter, registerDeviceToken);
router.delete('/token', deleteDeviceToken);

// Endpoint to update privacy settings
router.put('/preferences', notificationPrefsLimiter, updateNotificationPreferences);

// Notification history routes
router.get('/', getNotifications);
router.post('/read', markNotificationsRead);
router.post('/read-all', markAllNotificationsRead);
router.delete('/history', clearNotificationHistory);

export default router;

