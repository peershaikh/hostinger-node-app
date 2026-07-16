"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const express_1 = require("express");
const betaService_1 = require("../services/betaService");
const authMiddleware_1 = require("../middleware/authMiddleware");
const authService_1 = require("../services/authService");
const router = (0, express_1.Router)();
router.post('/redeem', authMiddleware_1.authMiddleware, async (req, res) => {
    try {
        const { code } = req.body;
        const userId = req.headers['x-user-id'] || req.user?.id;
        if (!userId) {
            return res.status(401).json({ success: false, error: 'Unauthorized' });
        }
        if (!code || typeof code !== 'string') {
            return res.status(400).json({ success: false, error: 'Beta code is required' });
        }
        const trimmedCode = code.trim();
        // Attempt to redeem the code
        const success = await betaService_1.betaService.redeemCode(userId, trimmedCode);
        if (success) {
            // Find duration days
            const codeDetails = betaService_1.betaService.getCode(trimmedCode);
            let durationDays = undefined;
            if (codeDetails && codeDetails.expiresAt) {
                const msDiff = new Date(codeDetails.expiresAt).getTime() - Date.now();
                durationDays = Math.max(0.1, msDiff / (24 * 60 * 60 * 1000)); // at least 0.1 days
            }
            else {
                durationDays = 30; // fallback to default 30 days
            }
            await authService_1.authService.changeUserPlan(userId, 'beta', durationDays);
            return res.json({ success: true, message: 'Beta Access Active' });
        }
        else {
            return res.status(400).json({ success: false, error: 'Invalid, expired, or fully claimed beta code' });
        }
    }
    catch (error) {
        return res.status(500).json({ success: false, error: error.message || 'Internal server error' });
    }
});
exports.default = router;
