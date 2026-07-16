import { Request, Response, NextFunction } from 'express';
import { betaService } from '../services/betaService';

export const checkBetaAccess = (req: Request, res: Response, next: NextFunction) => {
  const betaCode = req.headers['x-beta-code'] as string;

  if (!betaCode) {
    return res.status(403).json({ success: false, error: 'beta_code_required', message: 'A beta code is required to access this endpoint.' });
  }

  if (!betaService.isValidCode(betaCode)) {
    return res.status(403).json({ success: false, error: 'invalid_beta_code', message: 'The provided beta code is invalid or has expired.' });
  }

  next();
};
