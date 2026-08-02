"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const express_1 = require("express");
const notificationController_1 = require("../controllers/notificationController");
const rateLimiter_1 = require("../middleware/rateLimiter");
const authMiddleware_1 = require("../middleware/authMiddleware");
const router = (0, express_1.Router)();
// Endpoint to register PWA/native device token (pre-auth, device-level — no requireAuth)
router.post('/register', rateLimiter_1.notificationRegisterLimiter, notificationController_1.registerDeviceToken);
router.delete('/token', notificationController_1.deleteDeviceToken);
// Endpoint to update privacy settings (pre-auth, device-level — no requireAuth)
router.put('/preferences', rateLimiter_1.notificationPrefsLimiter, notificationController_1.updateNotificationPreferences);
// Notification history routes — require authenticated session (P0-002)
router.get('/', authMiddleware_1.requireAuth, notificationController_1.getNotifications);
router.post('/read', authMiddleware_1.requireAuth, notificationController_1.markNotificationsRead);
router.post('/read-all', authMiddleware_1.requireAuth, notificationController_1.markAllNotificationsRead);
router.delete('/history', authMiddleware_1.requireAuth, notificationController_1.clearNotificationHistory);
exports.default = router;
