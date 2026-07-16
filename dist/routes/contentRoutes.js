"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.router = void 0;
const express_1 = require("express");
const contentController_1 = require("../controllers/contentController");
const authMiddleware_1 = require("../middleware/authMiddleware");
const adminAuth_1 = require("../middleware/adminAuth");
exports.router = (0, express_1.Router)();
// ==========================================
// PUBLIC ENDPOINTS
// No auth required - Used by the homepage UI
// ==========================================
exports.router.get('/banner', contentController_1.contentController.getActiveBanners);
exports.router.get('/campaigns', contentController_1.contentController.getActiveCampaigns);
exports.router.get('/referral-offers', contentController_1.contentController.getActiveReferralOffers);
// ==========================================
// ADMIN ENDPOINTS
// Require JWT + verified admin role (PHASE_4C837 P0-003)
// ==========================================
exports.router.use('/admin', authMiddleware_1.requireAuth, adminAuth_1.requireAdmin);
// Banners
exports.router.get('/admin/banners', contentController_1.contentController.getBanners);
exports.router.post('/admin/banners', contentController_1.contentController.createBanner);
exports.router.put('/admin/banners/:id', contentController_1.contentController.updateBanner);
exports.router.delete('/admin/banners/:id', contentController_1.contentController.deleteBanner);
// Campaigns
exports.router.get('/admin/campaigns', contentController_1.contentController.getCampaigns);
exports.router.post('/admin/campaigns', contentController_1.contentController.createCampaign);
exports.router.put('/admin/campaigns/:id', contentController_1.contentController.updateCampaign);
exports.router.delete('/admin/campaigns/:id', contentController_1.contentController.deleteCampaign);
// Referral Offers
exports.router.get('/admin/referral-offers', contentController_1.contentController.getReferralOffers);
exports.router.post('/admin/referral-offers', contentController_1.contentController.createReferralOffer);
exports.router.put('/admin/referral-offers/:id', contentController_1.contentController.updateReferralOffer);
exports.router.delete('/admin/referral-offers/:id', contentController_1.contentController.deleteReferralOffer);
exports.default = exports.router;
