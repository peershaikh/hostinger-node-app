import { Router } from 'express';
import { betaService } from '../services/betaService';
import { authMiddleware } from '../middleware/authMiddleware';
import { authService } from '../services/authService';

const router = Router();

router.post('/redeem', authMiddleware, async (req: any, res: any) => {
  try {
    const { code } = req.body;
    const userId = (req.headers['x-user-id'] as string) || req.user?.id;

    if (!userId) {
      return res.status(401).json({ success: false, error: 'Unauthorized' });
    }

    if (!code || typeof code !== 'string') {
      return res.status(400).json({ success: false, error: 'Beta code is required' });
    }

    const trimmedCode = code.trim();
    
    // Attempt to redeem the code
    const success = await betaService.redeemCode(userId, trimmedCode);

    if (success) {
      // Find duration days
      const codeDetails = betaService.getCode(trimmedCode);
      let durationDays: number | undefined = undefined;
      if (codeDetails && codeDetails.expiresAt) {
        const msDiff = new Date(codeDetails.expiresAt).getTime() - Date.now();
        durationDays = Math.max(0.1, msDiff / (24 * 60 * 60 * 1000)); // at least 0.1 days
      } else {
        durationDays = 30; // fallback to default 30 days
      }
      
      await authService.changeUserPlan(userId, 'beta', durationDays);

      return res.json({ success: true, message: 'Beta Access Active' });
    } else {
      return res.status(400).json({ success: false, error: 'Invalid, expired, or fully claimed beta code' });
    }
  } catch (error: any) {
    return res.status(500).json({ success: false, error: error.message || 'Internal server error' });
  }
});

export default router;
