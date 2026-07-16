import { Router } from 'express';
import { contentController } from '../controllers/contentController';
import { requireAuth } from '../middleware/authMiddleware';
import { requireAdmin } from '../middleware/adminAuth';

export const router = Router();

// ==========================================
// PUBLIC ENDPOINTS
// No auth required - Used by the homepage UI
// ==========================================
router.get('/banner', contentController.getActiveBanners);
router.get('/campaigns', contentController.getActiveCampaigns);
router.get('/referral-offers', contentController.getActiveReferralOffers);

// ==========================================
// ADMIN ENDPOINTS
// Require JWT + verified admin role (PHASE_4C837 P0-003)
// ==========================================

router.use('/admin', requireAuth, requireAdmin as any);

// Banners
router.get('/admin/banners', contentController.getBanners);
router.post('/admin/banners', contentController.createBanner);
router.put('/admin/banners/:id', contentController.updateBanner);
router.delete('/admin/banners/:id', contentController.deleteBanner);

// Campaigns
router.get('/admin/campaigns', contentController.getCampaigns);
router.post('/admin/campaigns', contentController.createCampaign);
router.put('/admin/campaigns/:id', contentController.updateCampaign);
router.delete('/admin/campaigns/:id', contentController.deleteCampaign);

// Referral Offers
router.get('/admin/referral-offers', contentController.getReferralOffers);
router.post('/admin/referral-offers', contentController.createReferralOffer);
router.put('/admin/referral-offers/:id', contentController.updateReferralOffer);
router.delete('/admin/referral-offers/:id', contentController.deleteReferralOffer);

export default router;
