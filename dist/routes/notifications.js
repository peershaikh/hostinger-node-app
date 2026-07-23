"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const express_1 = require("express");
const notificationController_1 = require("../controllers/notificationController");
const rateLimiter_1 = require("../middleware/rateLimiter");
const router = (0, express_1.Router)();
// Endpoint to register PWA/native device token
router.post('/register', rateLimiter_1.notificationRegisterLimiter, notificationController_1.registerDeviceToken);
router.delete('/token', notificationController_1.deleteDeviceToken);
// Endpoint to update privacy settings
router.put('/preferences', rateLimiter_1.notificationPrefsLimiter, notificationController_1.updateNotificationPreferences);
// Notification history routes
router.get('/', notificationController_1.getNotifications);
router.post('/read', notificationController_1.markNotificationsRead);
router.post('/read-all', notificationController_1.markAllNotificationsRead);
router.delete('/history', notificationController_1.clearNotificationHistory);
exports.default = router;
