"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const express_1 = require("express");
const inviteController_1 = require("../controllers/inviteController");
const router = (0, express_1.Router)();
// Stats & Codes
router.get('/stats/:sessionId', inviteController_1.inviteController.getStats.bind(inviteController_1.inviteController));
// Claiming
router.post('/claim', inviteController_1.inviteController.claim.bind(inviteController_1.inviteController));
exports.default = router;
