import { Request, Response } from 'express';
import { userUsageService } from '../services/userUsageService';
import { winstonLogger } from '../middleware/logger';

export class InviteController {
  /**
   * GET /api/invites/stats/:sessionId
   */
  async getStats(req: Request, res: Response) {
    const { sessionId } = req.params;
    try {
      const stats = await userUsageService.getUsage(sessionId);
      res.status(200).json({ success: true, data: stats });
    } catch (err: any) {
      res.status(500).json({ success: false, error: err.message });
    }
  }

  /**
   * POST /api/invites/claim
   */
  async claim(req: Request, res: Response) {
    const { sessionId, referralCode } = req.body;
    if (!sessionId || !referralCode) {
      return res.status(400).json({ success: false, error: 'Session ID and Referral Code required' });
    }

    try {
      const result = await userUsageService.claimReferral(sessionId, referralCode);
      res.status(result.success ? 200 : 400).json(result);
    } catch (err: any) {
      winstonLogger.error(`[INVITE_CLAIM] Error: ${err.message}`);
      res.status(500).json({ success: false, error: 'Internal Server Error' });
    }
  }
}

export const inviteController = new InviteController();
