"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.requireAuth = exports.authMiddleware = void 0;
const jsonwebtoken_1 = __importDefault(require("jsonwebtoken"));
const authMiddleware = (req, res, next) => {
    // PHASE_4C837 P0-001: Never trust client-supplied identity headers.
    // Clear before auth so spoofed x-user-id cannot survive a missing/invalid JWT.
    delete req.headers['x-user-id'];
    delete req.headers['x-token-version'];
    const authHeader = req.headers.authorization;
    if (authHeader && authHeader.startsWith('Bearer ')) {
        const token = authHeader.split(' ')[1];
        try {
            const decoded = jsonwebtoken_1.default.verify(token, process.env.JWT_SECRET);
            // Inject x-user-id explicitly for Phase 2 compatibility
            req.headers['x-user-id'] = decoded.userId;
            req.headers['x-token-version'] = decoded.tokenVersion?.toString();
        }
        catch (e) {
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
exports.authMiddleware = authMiddleware;
/**
 * PHASE_4C837 P0-002: Route guard for destructive/authenticated actions.
 * Requires a present, verifiable Bearer JWT — x-user-id alone is insufficient.
 */
const requireAuth = (req, res, next) => {
    const authHeader = req.headers.authorization;
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
        return res.status(401).json({ success: false, error: 'Unauthorized' });
    }
    const token = authHeader.split(' ')[1];
    if (!token) {
        return res.status(401).json({ success: false, error: 'Unauthorized' });
    }
    try {
        const decoded = jsonwebtoken_1.default.verify(token, process.env.JWT_SECRET);
        if (!decoded?.userId) {
            return res.status(401).json({ success: false, error: 'Unauthorized' });
        }
        req.headers['x-user-id'] = decoded.userId;
        req.headers['x-token-version'] = decoded.tokenVersion?.toString();
        next();
    }
    catch (e) {
        if (process.env.AUTH_STRICT_EXPIRY === 'true' && e.name === 'TokenExpiredError') {
            return res.status(401).json({
                success: false,
                error: 'Token expired',
                code: 'TOKEN_EXPIRED',
            });
        }
        return res.status(401).json({ success: false, error: 'Unauthorized' });
    }
};
exports.requireAuth = requireAuth;
