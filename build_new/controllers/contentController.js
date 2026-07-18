"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.contentController = exports.ContentController = void 0;
const contentService_1 = require("../services/contentService");
class ContentController {
    // ==========================================
    // PUBLIC ENDPOINTS (Read-only)
    // ==========================================
    async getActiveBanners(req, res) {
        try {
            const banners = await contentService_1.contentService.getActiveBanners();
            res.json({ success: true, data: banners });
        }
        catch (err) {
            res.status(500).json({ success: false, error: err.message });
        }
    }
    async getActiveCampaigns(req, res) {
        try {
            const campaigns = await contentService_1.contentService.getActiveCampaigns();
            res.json({ success: true, data: campaigns });
        }
        catch (err) {
            res.status(500).json({ success: false, error: err.message });
        }
    }
    async getActiveReferralOffers(req, res) {
        try {
            const offers = await contentService_1.contentService.getActiveReferralOffers();
            res.json({ success: true, data: offers });
        }
        catch (err) {
            res.status(500).json({ success: false, error: err.message });
        }
    }
    // ==========================================
    // ADMIN ENDPOINTS (CRUD)
    // ==========================================
    // Banners
    async getBanners(req, res) {
        try {
            const data = await contentService_1.contentService.getBanners();
            res.json({ success: true, data });
        }
        catch (err) {
            res.status(500).json({ success: false, error: err.message });
        }
    }
    async createBanner(req, res) {
        try {
            const data = await contentService_1.contentService.createBanner(req.body);
            res.json({ success: true, data });
        }
        catch (err) {
            res.status(500).json({ success: false, error: err.message });
        }
    }
    async updateBanner(req, res) {
        try {
            const { id } = req.params;
            const data = await contentService_1.contentService.updateBanner(id, req.body);
            res.json({ success: true, data });
        }
        catch (err) {
            res.status(500).json({ success: false, error: err.message });
        }
    }
    async deleteBanner(req, res) {
        try {
            const { id } = req.params;
            await contentService_1.contentService.deleteBanner(id);
            res.json({ success: true, message: 'Deleted successfully' });
        }
        catch (err) {
            res.status(500).json({ success: false, error: err.message });
        }
    }
    // Campaigns
    async getCampaigns(req, res) {
        try {
            const data = await contentService_1.contentService.getCampaigns();
            res.json({ success: true, data });
        }
        catch (err) {
            res.status(500).json({ success: false, error: err.message });
        }
    }
    async createCampaign(req, res) {
        try {
            const data = await contentService_1.contentService.createCampaign(req.body);
            res.json({ success: true, data });
        }
        catch (err) {
            res.status(500).json({ success: false, error: err.message });
        }
    }
    async updateCampaign(req, res) {
        try {
            const { id } = req.params;
            const data = await contentService_1.contentService.updateCampaign(id, req.body);
            res.json({ success: true, data });
        }
        catch (err) {
            res.status(500).json({ success: false, error: err.message });
        }
    }
    async deleteCampaign(req, res) {
        try {
            const { id } = req.params;
            await contentService_1.contentService.deleteCampaign(id);
            res.json({ success: true, message: 'Deleted successfully' });
        }
        catch (err) {
            res.status(500).json({ success: false, error: err.message });
        }
    }
    // Referral Offers
    async getReferralOffers(req, res) {
        try {
            const data = await contentService_1.contentService.getReferralOffers();
            res.json({ success: true, data });
        }
        catch (err) {
            res.status(500).json({ success: false, error: err.message });
        }
    }
    async createReferralOffer(req, res) {
        try {
            const data = await contentService_1.contentService.createReferralOffer(req.body);
            res.json({ success: true, data });
        }
        catch (err) {
            res.status(500).json({ success: false, error: err.message });
        }
    }
    async updateReferralOffer(req, res) {
        try {
            const { id } = req.params;
            const data = await contentService_1.contentService.updateReferralOffer(id, req.body);
            res.json({ success: true, data });
        }
        catch (err) {
            res.status(500).json({ success: false, error: err.message });
        }
    }
    async deleteReferralOffer(req, res) {
        try {
            const { id } = req.params;
            await contentService_1.contentService.deleteReferralOffer(id);
            res.json({ success: true, message: 'Deleted successfully' });
        }
        catch (err) {
            res.status(500).json({ success: false, error: err.message });
        }
    }
}
exports.ContentController = ContentController;
exports.contentController = new ContentController();
