import { Request, Response } from 'express';
import { contentService } from '../services/contentService';

export class ContentController {
  
  // ==========================================
  // PUBLIC ENDPOINTS (Read-only)
  // ==========================================

  public async getActiveBanners(req: Request, res: Response) {
    try {
      const banners = await contentService.getActiveBanners();
      res.json({ success: true, data: banners });
    } catch (err: any) {
      res.status(500).json({ success: false, error: err.message });
    }
  }

  public async getActiveCampaigns(req: Request, res: Response) {
    try {
      const campaigns = await contentService.getActiveCampaigns();
      res.json({ success: true, data: campaigns });
    } catch (err: any) {
      res.status(500).json({ success: false, error: err.message });
    }
  }

  public async getActiveReferralOffers(req: Request, res: Response) {
    try {
      const offers = await contentService.getActiveReferralOffers();
      res.json({ success: true, data: offers });
    } catch (err: any) {
      res.status(500).json({ success: false, error: err.message });
    }
  }

  // ==========================================
  // ADMIN ENDPOINTS (CRUD)
  // ==========================================

  // Banners
  public async getBanners(req: Request, res: Response) {
    try {
      const data = await contentService.getBanners();
      res.json({ success: true, data });
    } catch (err: any) {
      res.status(500).json({ success: false, error: err.message });
    }
  }

  public async createBanner(req: Request, res: Response) {
    try {
      const data = await contentService.createBanner(req.body);
      res.json({ success: true, data });
    } catch (err: any) {
      res.status(500).json({ success: false, error: err.message });
    }
  }

  public async updateBanner(req: Request, res: Response) {
    try {
      const { id } = req.params;
      const data = await contentService.updateBanner(id, req.body);
      res.json({ success: true, data });
    } catch (err: any) {
      res.status(500).json({ success: false, error: err.message });
    }
  }

  public async deleteBanner(req: Request, res: Response) {
    try {
      const { id } = req.params;
      await contentService.deleteBanner(id);
      res.json({ success: true, message: 'Deleted successfully' });
    } catch (err: any) {
      res.status(500).json({ success: false, error: err.message });
    }
  }

  // Campaigns
  public async getCampaigns(req: Request, res: Response) {
    try {
      const data = await contentService.getCampaigns();
      res.json({ success: true, data });
    } catch (err: any) {
      res.status(500).json({ success: false, error: err.message });
    }
  }

  public async createCampaign(req: Request, res: Response) {
    try {
      const data = await contentService.createCampaign(req.body);
      res.json({ success: true, data });
    } catch (err: any) {
      res.status(500).json({ success: false, error: err.message });
    }
  }

  public async updateCampaign(req: Request, res: Response) {
    try {
      const { id } = req.params;
      const data = await contentService.updateCampaign(id, req.body);
      res.json({ success: true, data });
    } catch (err: any) {
      res.status(500).json({ success: false, error: err.message });
    }
  }

  public async deleteCampaign(req: Request, res: Response) {
    try {
      const { id } = req.params;
      await contentService.deleteCampaign(id);
      res.json({ success: true, message: 'Deleted successfully' });
    } catch (err: any) {
      res.status(500).json({ success: false, error: err.message });
    }
  }

  // Referral Offers
  public async getReferralOffers(req: Request, res: Response) {
    try {
      const data = await contentService.getReferralOffers();
      res.json({ success: true, data });
    } catch (err: any) {
      res.status(500).json({ success: false, error: err.message });
    }
  }

  public async createReferralOffer(req: Request, res: Response) {
    try {
      const data = await contentService.createReferralOffer(req.body);
      res.json({ success: true, data });
    } catch (err: any) {
      res.status(500).json({ success: false, error: err.message });
    }
  }

  public async updateReferralOffer(req: Request, res: Response) {
    try {
      const { id } = req.params;
      const data = await contentService.updateReferralOffer(id, req.body);
      res.json({ success: true, data });
    } catch (err: any) {
      res.status(500).json({ success: false, error: err.message });
    }
  }

  public async deleteReferralOffer(req: Request, res: Response) {
    try {
      const { id } = req.params;
      await contentService.deleteReferralOffer(id);
      res.json({ success: true, message: 'Deleted successfully' });
    } catch (err: any) {
      res.status(500).json({ success: false, error: err.message });
    }
  }
}

export const contentController = new ContentController();
