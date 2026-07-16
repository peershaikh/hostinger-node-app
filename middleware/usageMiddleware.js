"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.usageMiddleware = void 0;
const authService_1 = require("../services/authService");
const usageMiddleware = (feature) => {
    return async (req, res, next) => {
        const userId = req.headers['x-user-id'] || null;
        let deviceId = req.headers['x-device-id'];
        const betaCode = req.headers['x-beta-code'];
        // Fallback to IP if no deviceId is provided for guests
        if (!userId && !deviceId) {
            deviceId = `ip_${req.ip}`;
        }
        // IP + Device Binding Protection (Guest Security Hardening)
        if (!userId && !betaCode && deviceId) {
            const isSafe = authService_1.authService.verifyDeviceIpBinding(req.ip || '0.0.0.0', deviceId);
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
            const tokenVersion = req.headers['x-token-version'];
            if (tokenVersion && user && (user.tokenVersion || 1) !== parseInt(tokenVersion, 10)) {
                return res.status(401).json({
                    success: false,
                    error: "invalid_token_version",
                    message: "Session expired. Please log in again."
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
        // Crucial Logic:
        // If the user is logged in (userId) or has a betaCode, trainController WILL increment the usage internally.
        // If the user is a GUEST (no userId and no betaCode), trainController completely bypasses incrementing.
        // So, we MUST increment guest usage here to prevent infinite guest searches!
        if (!userId && !betaCode && deviceId) {
            await authService_1.authService.incrementGuestUsage(deviceId, feature);
        }
        next();
    };
};
exports.usageMiddleware = usageMiddleware;
