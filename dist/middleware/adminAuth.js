"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.requireAdmin = void 0;
const authService_1 = require("../services/authService");
const requireAdmin = async (req, res, next) => {
    const userId = req.headers['x-user-id']?.trim();
    if (!userId) {
        return res.status(401).json({ success: false, error: 'Missing admin user context' });
    }
    const user = await authService_1.authService.getUserStatus(userId);
    if (!user || !user.isAdmin) {
        return res.status(403).json({ success: false, error: 'Admin access required' });
    }
    const tokenVersion = req.headers['x-token-version'];
    const fullUser = await authService_1.authService.getUserById(userId);
    if (tokenVersion && fullUser && (fullUser.tokenVersion || 1) !== parseInt(tokenVersion, 10)) {
        return res.status(401).json({ success: false, error: 'invalid_token_version' });
    }
    next();
};
exports.requireAdmin = requireAdmin;
