import { Request, Response, NextFunction } from 'express';
import crypto from 'crypto';
import { authService } from '../services/authService';
import { resolveClientIp } from '../utils/ipResolver';

function sanitizeDeviceId(rawId: any): string | null {
  if (!rawId || typeof rawId !== 'string') return null;
  const trimmed = rawId.trim();
  if (trimmed.length < 8 || trimmed.length > 128) return null;
  // Disallow path traversal, control chars, spaces, tags
  if (!/^[a-zA-Z0-9_\-\.]+$/.test(trimmed)) return null;
  // Disallow common placeholders or malformed strings
  if (/^(null|undefined|none|guest|anonymous|deviceId|\[object Object\])$/i.test(trimmed)) return null;
  return trimmed;
}

export const usageMiddleware = (feature: 'search' | 'pnr' | 'live') => {
  return async (req: Request, res: Response, next: NextFunction) => {
    // Decouple Split Journey from general direct-search quota:
    // Split requests hitting search-advanced are authoritatively governed by EntitlementService
    const isSplitRequest = feature === 'search' && (
      req.query.includeSplit === 'true' ||
      req.body?.includeSplit === true ||
      req.body?.includeSplit === 'true'
    );
    if (isSplitRequest) {
      return next();
    }

    const userId = (req.headers['x-user-id'] as string) || null;
    const betaCode = req.headers['x-beta-code'] as string;
    const clientIp = resolveClientIp(req);

    // Stable server-validated device identity strategy
    let deviceId = sanitizeDeviceId(req.headers['x-device-id']);
    
    if (!deviceId && req.cookies?.trayago_did) {
      deviceId = sanitizeDeviceId(req.cookies.trayago_did);
    }

    // If still missing or invalid, generate a unique server-assigned guest device ID
    // NEVER fall back to shared proxy IP alone, to avoid cross-user blocking collisions
    if (!deviceId) {
      deviceId = `srv_${crypto.randomUUID()}`;
      try {
        res.cookie('trayago_did', deviceId, {
          maxAge: 365 * 24 * 60 * 60 * 1000,
          httpOnly: false,
          sameSite: 'lax',
          path: '/'
        });
      } catch {}
      res.setHeader('x-device-id', deviceId);
    }

    // IP + Device Binding Protection (Guest Security Hardening)
    if (!userId && !betaCode && deviceId) {
      const isSafe = authService.verifyDeviceIpBinding(clientIp, deviceId);
      if (!isSafe) {
        return res.status(429).json({
          success: false,
          error: "too_many_devices",
          message: "Too many guest devices detected on this network. Please create a free account to continue."
        });
      }
    }

    if (userId) {
      const user = await authService.getUserById(userId);
      if (user?.isBlocked) {
        return res.status(403).json({
          success: false,
          error: "account_blocked",
          message: "Your account has been suspended."
        });
      }
    }

    const canUse = await authService.canUseFeature(userId, feature, betaCode, deviceId);
    
    if (!canUse) {
      return res.status(403).json({
        success: false,
        error: "limit_exceeded",
        message: "Limit exceeded. Watch an ad or upgrade to PRO."
      });
    }

    // Increment guest usage per validated device ID
    if (!userId && !betaCode && deviceId) {
      await authService.incrementGuestUsage(deviceId, feature);
    }

    next();
  };
};
