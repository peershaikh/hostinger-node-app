"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.usageMiddleware = void 0;
const crypto_1 = __importDefault(require("crypto"));
const authService_1 = require("../services/authService");
const ipResolver_1 = require("../utils/ipResolver");
function sanitizeDeviceId(rawId) {
    if (!rawId || typeof rawId !== 'string')
        return null;
    const trimmed = rawId.trim();
    if (trimmed.length < 8 || trimmed.length > 128)
        return null;
    // Disallow path traversal, control chars, spaces, tags
    if (!/^[a-zA-Z0-9_\-\.]+$/.test(trimmed))
        return null;
    // Disallow common placeholders or malformed strings
    if (/^(null|undefined|none|guest|anonymous|deviceId|\[object Object\])$/i.test(trimmed))
        return null;
    return trimmed;
}
const usageMiddleware = (feature) => {
    return async (req, res, next) => {
        // Decouple Split Journey from general direct-search quota:
        // Split requests hitting search-advanced are authoritatively governed by EntitlementService
        const isSplitRequest = feature === 'search' && (req.query.includeSplit === 'true' ||
            req.body?.includeSplit === true ||
            req.body?.includeSplit === 'true');
        if (isSplitRequest) {
            return next();
        }
        const userId = req.headers['x-user-id'] || null;
        const betaCode = req.headers['x-beta-code'];
        const clientIp = (0, ipResolver_1.resolveClientIp)(req);
        // Stable server-validated device identity strategy
        let deviceId = sanitizeDeviceId(req.headers['x-device-id']);
        if (!deviceId && req.cookies?.trayago_did) {
            deviceId = sanitizeDeviceId(req.cookies.trayago_did);
        }
        // If still missing or invalid, generate a unique server-assigned guest device ID
        // NEVER fall back to shared proxy IP alone, to avoid cross-user blocking collisions
        if (!deviceId) {
            deviceId = `srv_${crypto_1.default.randomUUID()}`;
            try {
                res.cookie('trayago_did', deviceId, {
                    maxAge: 365 * 24 * 60 * 60 * 1000,
                    httpOnly: false,
                    sameSite: 'lax',
                    path: '/'
                });
            }
            catch { }
            res.setHeader('x-device-id', deviceId);
        }
        // IP + Device Binding Protection (Guest Security Hardening)
        if (!userId && !betaCode && deviceId) {
            const isSafe = authService_1.authService.verifyDeviceIpBinding(clientIp, deviceId);
            if (!isSafe) {
                return res.status(429).json({
                    success: false,
                    error: "too_many_devices",
                    message: "Too many guest devices detected on this network. Please create a free account to continue."
                });
            }
        }
        if (userId) {
            const user = await authService_1.authService.getUserById(userId);
            if (user?.isBlocked) {
                return res.status(403).json({
                    success: false,
                    error: "account_blocked",
                    message: "Your account has been suspended."
                });
            }
        }
        const canUse = await authService_1.authService.canUseFeature(userId, feature, betaCode, deviceId);
        if (!canUse) {
            return res.status(403).json({
                success: false,
                error: "limit_exceeded",
                message: "Limit exceeded. Watch an ad or upgrade to PRO."
            });
        }
        // Increment guest usage per validated device ID
        if (!userId && !betaCode && deviceId) {
            await authService_1.authService.incrementGuestUsage(deviceId, feature);
        }
        next();
    };
};
exports.usageMiddleware = usageMiddleware;
