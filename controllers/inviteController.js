"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.inviteController = exports.InviteController = void 0;
const userUsageService_1 = require("../services/userUsageService");
const logger_1 = require("../middleware/logger");
class InviteController {
    /**
     * GET /api/invites/stats/:sessionId
     */
    async getStats(req, res) {
        const { sessionId } = req.params;
        try {
            const stats = await userUsageService_1.userUsageService.getUsage(sessionId);
            res.status(200).json({ success: true, data: stats });
        }
        catch (err) {
            res.status(500).json({ success: false, error: err.message });
        }
    }
    /**
     * POST /api/invites/claim
     */
    async claim(req, res) {
        const { sessionId, referralCode } = req.body;
        if (!sessionId || !referralCode) {
            return res.status(400).json({ success: false, error: 'Session ID and Referral Code required' });
        }
        try {
            const result = await userUsageService_1.userUsageService.claimReferral(sessionId, referralCode);
            res.status(result.success ? 200 : 400).json(result);
        }
        catch (err) {
            logger_1.winstonLogger.error(`[INVITE_CLAIM] Error: ${err.message}`);
            res.status(500).json({ success: false, error: 'Internal Server Error' });
        }
    }
}
exports.InviteController = InviteController;
exports.inviteController = new InviteController();
