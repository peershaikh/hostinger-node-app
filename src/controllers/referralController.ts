import { Request, Response } from 'express';
import { applyReferralCode, getUserReferralCode, referralService } from '../services/referralService';

class ReferralController {
  private extractUserId(req: Request): string | null {
    const userId = req.headers['x-user-id'] as string;
    return userId?.trim() || null;
  }

  async getMyReferralCode(req: Request, res: Response) {
    try {
      const userId = this.extractUserId(req);
      if (!userId) {
        return res.status(401).json({ success: false, error: 'Missing authenticated user id.' });
      }

      const code = await getUserReferralCode(userId);
      return res.status(200).json({ success: true, data: { referralCode: code } });
    } catch (err: any) {
      return res.status(500).json({ success: false, error: err.message || 'Failed to get referral code.' });
    }
  }

  async getStats(req: Request, res: Response) {
    try {
      const userId = this.extractUserId(req);
      if (!userId) {
        return res.status(401).json({ success: false, error: 'Missing authenticated user id.' });
      }

      const stats = referralService.getUserStats(userId);
      return res.status(200).json({ success: true, data: stats });
    } catch (err: any) {
      return res.status(500).json({ success: false, error: err.message || 'Failed to get stats.' });
    }
  }

  async apply(req: Request, res: Response) {
    try {
      const userId = this.extractUserId(req);
      if (!userId) {
        return res.status(401).json({ success: false, error: 'Missing authenticated user id.' });
      }

      const { referralCode, deviceFingerprint } = req.body || {};
      const ipAddress = req.ip || req.connection.remoteAddress;

      if (!referralCode || typeof referralCode !== 'string') {
        return res.status(400).json({ success: false, error: 'Referral code is required.' });
      }

      const result = await applyReferralCode(userId, referralCode, deviceFingerprint, ipAddress);
      if (!result.success) {
        return res.status(400).json({ success: false, error: result.message });
      }

      return res.status(200).json(result);
    } catch (err: any) {
      return res.status(500).json({ success: false, error: err.message || 'Failed to apply referral code.' });
    }
  }

  async getLeaderboard(req: Request, res: Response) {
    try {
      const data = referralService.getLeaderboard();
      return res.status(200).json({ success: true, data });
    } catch (err: any) {
      return res.status(500).json({ success: false, error: err.message || 'Failed to get leaderboard.' });
    }
  }

  async getHistory(req: Request, res: Response) {
    try {
      const userId = this.extractUserId(req);
      if (!userId) {
        return res.status(401).json({ success: false, error: 'Missing authenticated user id.' });
      }

      const data = referralService.getHistory(userId);
      return res.status(200).json({ success: true, data });
    } catch (err: any) {
      return res.status(500).json({ success: false, error: err.message || 'Failed to get history.' });
    }
  }
}

export const referralController = new ReferralController();
