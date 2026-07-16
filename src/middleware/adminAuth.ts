import { Request, Response, NextFunction } from 'express';
import { authService } from '../services/authService';

export const requireAdmin = async (req: Request, res: Response, next: NextFunction) => {
  const userId = (req.headers['x-user-id'] as string | undefined)?.trim();

  if (!userId) {
    return res.status(401).json({ success: false, error: 'Missing admin user context' });
  }

  const user = await authService.getUserStatus(userId);
  if (!user || !user.isAdmin) {
    return res.status(403).json({ success: false, error: 'Admin access required' });
  }

  const tokenVersion = req.headers['x-token-version'];
  const fullUser = await authService.getUserById(userId);
  if (tokenVersion && fullUser && (fullUser.tokenVersion || 1) !== parseInt(tokenVersion as string, 10)) {
    return res.status(401).json({ success: false, error: 'invalid_token_version' });
  }

  next();
};
