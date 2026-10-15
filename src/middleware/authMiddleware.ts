import { Request, Response, NextFunction } from 'express';
import jwt from 'jsonwebtoken';
import { featureFlags } from '../config/featureFlags';
import { authService } from '../services/authService';
import { winstonLogger } from './logger';

export const authMiddleware = (req: Request, res: Response, next: NextFunction) => {
    // PHASE_4C837 P0-001: Never trust client-supplied identity headers.
    // Clear before auth so spoofed x-user-id cannot survive a missing/invalid JWT.
    delete req.headers['x-user-id'];
    delete req.headers['x-token-version'];

    const authHeader = req.headers.authorization;
    if (authHeader && authHeader.startsWith('Bearer ')) {
        const token = authHeader.split(' ')[1];
        try {
            const decoded = jwt.verify(token, process.env.JWT_SECRET as string) as any;
            // Inject x-user-id explicitly for Phase 2 compatibility
            req.headers['x-user-id'] = decoded.userId;
            req.headers['x-token-version'] = decoded.tokenVersion?.toString();
        } catch (e: any) {
            // AUTH_STRICT_EXPIRY: when enabled, return 401 on expired tokens so
            // clients can trigger the silent refresh → retry flow.
            // Only fires on TokenExpiredError — tampered/invalid tokens fall through
            // as guest to avoid leaking JWT structure information.
            if (process.env.AUTH_STRICT_EXPIRY === 'true' && e.name === 'TokenExpiredError') {
                return res.status(401).json({
                    success: false,
                    error: 'Token expired',
                    code: 'TOKEN_EXPIRED',
                });
            }
            // All other errors: treat as guest (do not attach x-user-id)
        }
    }
    next();
};

/**
 * PHASE_4C837 P0-002 / PHASE_4C965 Stage 2: Route guard for destructive/authenticated actions.
 * Requires a present, verifiable Bearer JWT — x-user-id alone is insufficient.
 * When authEnforceSessionEpoch is enabled, verifies token sessionEpoch against authoritative user state.
 */
export const requireAuth = async (req: Request, res: Response, next: NextFunction) => {
    const authHeader = req.headers.authorization;
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
        return res.status(401).json({ success: false, error: 'Unauthorized' });
    }

    const token = authHeader.split(' ')[1];
    if (!token) {
        return res.status(401).json({ success: false, error: 'Unauthorized' });
    }

    let decoded: any;
    try {
        decoded = jwt.verify(token, process.env.JWT_SECRET as string) as any;
        if (!decoded?.userId) {
            return res.status(401).json({ success: false, error: 'Unauthorized' });
        }
    } catch (e: any) {
        if (process.env.AUTH_STRICT_EXPIRY === 'true' && e.name === 'TokenExpiredError') {
            return res.status(401).json({
                success: false,
                error: 'Token expired',
                code: 'TOKEN_EXPIRED',
            });
        }
        return res.status(401).json({ success: false, error: 'Unauthorized' });
    }

    // PHASE_4C965 Stage 2: Authoritative sessionEpoch validation
    if (featureFlags.authEnforceSessionEpoch) {
        try {
            const user = await authService.getUserById(decoded.userId);
            if (!user) {
                return res.status(401).json({
                    success: false,
                    error: 'Unauthorized',
                    code: 'USER_NOT_FOUND',
                });
            }

            if (user.isBlocked) {
                return res.status(403).json({
                    success: false,
                    error: 'Account has been blocked',
                    code: 'ACCOUNT_BLOCKED',
                });
            }

            // Safe backward-compatible epoch evaluation:
            // A genuinely missing claim (undefined) defaults to 1 for legacy compatibility.
            // Any present claim MUST be a positive integer. Malformed claims are rejected.
            let tokenEpoch: number;
            if (decoded.sessionEpoch === undefined) {
                tokenEpoch = 1;
            } else if (
                typeof decoded.sessionEpoch === 'number' &&
                Number.isInteger(decoded.sessionEpoch) &&
                decoded.sessionEpoch > 0
            ) {
                tokenEpoch = decoded.sessionEpoch;
            } else {
                return res.status(401).json({
                    success: false,
                    error: 'Session has expired or was revoked',
                    code: 'SESSION_REVOKED',
                });
            }

            const currentEpoch = typeof user.sessionEpoch === 'number' && Number.isInteger(user.sessionEpoch) && user.sessionEpoch > 0
                ? user.sessionEpoch
                : 1;

            if (tokenEpoch !== currentEpoch) {
                return res.status(401).json({
                    success: false,
                    error: 'Session has expired or was revoked',
                    code: 'SESSION_REVOKED',
                });
            }
        } catch (err: any) {
            winstonLogger.error(`[AUTH] Session epoch validation failure: ${err.message}`);
            return res.status(503).json({
                success: false,
                error: 'Authentication service temporarily unavailable',
                code: 'AUTH_SERVICE_UNAVAILABLE',
            });
        }
    }

    req.headers['x-user-id'] = decoded.userId;
    req.headers['x-token-version'] = decoded.tokenVersion?.toString();
    next();
};
