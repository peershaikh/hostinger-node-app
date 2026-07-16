"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const express_1 = require("express");
const alarmController_1 = require("../controllers/alarmController");
const rateLimiter_1 = require("../middleware/rateLimiter");
const router = (0, express_1.Router)();
// Apply rate limiting to creation and modification to prevent abuse
router.post('/', rateLimiter_1.alarmLimiter, alarmController_1.createAlarm);
router.get('/', alarmController_1.getAlarms);
router.patch('/:id', rateLimiter_1.alarmLimiter, alarmController_1.updateAlarm);
router.delete('/:id', rateLimiter_1.alarmLimiter, alarmController_1.deleteAlarm);
exports.default = router;
