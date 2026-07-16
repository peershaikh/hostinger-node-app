"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.referralController = void 0;
const referralService_1 = require("../services/referralService");
class ReferralController {
    extractUserId(req) {
        const userId = req.headers['x-user-id'];
        return userId?.trim() || null;
    }
    async getMyReferralCode(req, res) {
        try {
            const userId = this.extractUserId(req);
            if (!userId) {
                return res.status(401).json({ success: false, error: 'Missing authenticated user id.' });
            }
            const code = await (0, referralService_1.getUserReferralCode)(userId);
            return res.status(200).json({ success: true, data: { referralCode: code } });
        }
        catch (err) {
            return res.status(500).json({ success: false, error: err.message || 'Failed to get referral code.' });
        }
    }
    async getStats(req, res) {
        try {
            const userId = this.extractUserId(req);
            if (!userId) {
                return res.status(401).json({ success: false, error: 'Missing authenticated user id.' });
            }
            const stats = referralService_1.referralService.getUserStats(userId);
            return res.status(200).json({ success: true, data: stats });
        }
        catch (err) {
            return res.status(500).json({ success: false, error: err.message || 'Failed to get stats.' });
        }
    }
    async apply(req, res) {
        try {
            const userId = this.extractUserId(req);
            if (!userId) {
                return res.status(401).json({ success: false, error: 'Missing authenticated user id.' });
            }
            const { referralCode, deviceFingerprint } = req.body || {};
            const ipAddress = req.ip || req.connection.remoteAddress;
            if (!referralCode || typeof referralCode !== 'string') {
                return res.status(400).json({ success: false, error: 'Referral code is required.' });
            }
            const result = await (0, referralService_1.applyReferralCode)(userId, referralCode, deviceFingerprint, ipAddress);
            if (!result.success) {
                return res.status(400).json({ success: false, error: result.message });
            }
            return res.status(200).json(result);
        }
        catch (err) {
            return res.status(500).json({ success: false, error: err.message || 'Failed to apply referral code.' });
        }
    }
    async getLeaderboard(req, res) {
        try {
            const data = referralService_1.referralService.getLeaderboard();
            return res.status(200).json({ success: true, data });
        }
        catch (err) {
            return res.status(500).json({ success: false, error: err.message || 'Failed to get leaderboard.' });
        }
    }
    async getHistory(req, res) {
        try {
            const userId = this.extractUserId(req);
            if (!userId) {
                return res.status(401).json({ success: false, error: 'Missing authenticated user id.' });
            }
            const data = referralService_1.referralService.getHistory(userId);
            return res.status(200).json({ success: true, data });
        }
        catch (err) {
            return res.status(500).json({ success: false, error: err.message || 'Failed to get history.' });
        }
    }
}
exports.referralController = new ReferralController();
