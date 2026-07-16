"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const express_1 = require("express");
const analyticsController_1 = require("../controllers/analyticsController");
const router = (0, express_1.Router)();
// Stats for Admin & Frontend
router.get('/', analyticsController_1.analyticsController.getDashboard.bind(analyticsController_1.analyticsController));
router.get('/trending', analyticsController_1.analyticsController.getTrending.bind(analyticsController_1.analyticsController));
// Tracking & Feedback
router.post('/event', analyticsController_1.analyticsController.trackEvent.bind(analyticsController_1.analyticsController));
router.post('/split-click', analyticsController_1.analyticsController.logSplitClick.bind(analyticsController_1.analyticsController));
router.post('/feedback', analyticsController_1.analyticsController.submitFeedback.bind(analyticsController_1.analyticsController));
router.post('/complaint', analyticsController_1.analyticsController.logComplaint.bind(analyticsController_1.analyticsController));
// Referrals
router.get('/referrals/:sessionId?', analyticsController_1.analyticsController.getReferralStats.bind(analyticsController_1.analyticsController));
router.post('/referrals/claim', analyticsController_1.analyticsController.claimReferral.bind(analyticsController_1.analyticsController));
exports.default = router;
