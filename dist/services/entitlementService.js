"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.entitlementService = exports.EntitlementService = void 0;
const authService_1 = require("./authService");
const fs_1 = __importDefault(require("fs"));
const path_1 = __importDefault(require("path"));
const LEDGER_PATH = path_1.default.join(process.cwd(), 'data', 'free_quota_ledger.json');
const LEGACY_LEDGER_PATH = path_1.default.join(process.cwd(), 'data', 'free_rescue_ledger.json');
function getTodayDateString() {
    // Use Indian Standard Time (UTC+5:30) for daily calendar reset alignment
    const now = new Date();
    const istOffset = 5.5 * 60 * 60 * 1000;
    const istDate = new Date(now.getTime() + istOffset);
    return istDate.toISOString().split('T')[0];
}
function getLedger() {
    try {
        if (fs_1.default.existsSync(LEDGER_PATH)) {
            return JSON.parse(fs_1.default.readFileSync(LEDGER_PATH, 'utf8'));
        }
    }
    catch { }
    // Fallback to legacy single-entry ledger
    try {
        if (fs_1.default.existsSync(LEGACY_LEDGER_PATH)) {
            const legacy = JSON.parse(fs_1.default.readFileSync(LEGACY_LEDGER_PATH, 'utf8'));
            const upgraded = {};
            for (const [uid, val] of Object.entries(legacy)) {
                if (typeof val === 'string') {
                    upgraded[uid] = { rescueUsedOn: val.split('T')[0] };
                }
                else if (typeof val === 'object' && val !== null) {
                    upgraded[uid] = val;
                }
            }
            return upgraded;
        }
    }
    catch { }
    return {};
}
function saveLedger(ledger) {
    try {
        const dir = path_1.default.dirname(LEDGER_PATH);
        if (!fs_1.default.existsSync(dir))
            fs_1.default.mkdirSync(dir, { recursive: true });
        fs_1.default.writeFileSync(LEDGER_PATH, JSON.stringify(ledger, null, 2));
    }
    catch { }
}
class EntitlementService {
    async checkRescueOrSplitEntitlement(userId, actionType) {
        if (!userId) {
            return {
                status: 'REQUIRE_LOGIN',
                hasSplitAccess: false,
                rescueCreditRemaining: true,
                splitCreditRemaining: true,
                freeCreditRemaining: true,
                planType: 'guest',
                splitMinutesLeft: 0
            };
        }
        const user = await authService_1.authService.getUserById(userId);
        if (!user || user.isBlocked) {
            return {
                status: 'REQUIRE_LOGIN',
                hasSplitAccess: false,
                rescueCreditRemaining: false,
                splitCreditRemaining: false,
                freeCreditRemaining: false,
                planType: 'none',
                splitMinutesLeft: 0
            };
        }
        // 1. Paid users (Pro, Blitz, 24h Pass, Yearly, Admin) are NEVER blocked
        const hasSplitAccess = await authService_1.authService.canUseSplit(userId);
        let splitMinutesLeft = 0;
        if (hasSplitAccess && user.splitAccessUntil) {
            splitMinutesLeft = Math.max(0, Math.floor((new Date(user.splitAccessUntil).getTime() - Date.now()) / 60000));
        }
        else if (hasSplitAccess) {
            splitMinutesLeft = 99999;
        }
        if (hasSplitAccess) {
            return {
                status: 'ALLOW_PAID',
                hasSplitAccess: true,
                rescueCreditRemaining: true,
                splitCreditRemaining: true,
                freeCreditRemaining: true,
                planType: user.planType || 'pro',
                splitMinutesLeft
            };
        }
        // 2. Separate Daily Free Quotas: 1 Rescue + 1 Split per calendar day
        const today = getTodayDateString();
        const ledger = getLedger();
        const userQuota = ledger[userId] || {};
        const rescueUsedToday = Boolean(userQuota.rescueUsedOn && userQuota.rescueUsedOn === today);
        const splitUsedToday = Boolean(userQuota.splitUsedOn && userQuota.splitUsedOn === today);
        const rescueCreditRemaining = !rescueUsedToday;
        const splitCreditRemaining = !splitUsedToday;
        let status;
        if (actionType === 'rescue') {
            status = rescueCreditRemaining ? 'ALLOW_FREE_RESCUE' : 'SHOW_PAYWALL_RESCUE';
        }
        else if (actionType === 'split') {
            status = splitCreditRemaining ? 'ALLOW_FREE_SPLIT' : 'SHOW_PAYWALL_SPLIT';
        }
        else {
            // General check: if either is free, allow free; else show paywall
            if (rescueCreditRemaining) {
                status = 'ALLOW_FREE_RESCUE';
            }
            else if (splitCreditRemaining) {
                status = 'ALLOW_FREE_SPLIT';
            }
            else {
                status = 'SHOW_PAYWALL_RESCUE';
            }
        }
        return {
            status,
            hasSplitAccess: false,
            rescueCreditRemaining,
            splitCreditRemaining,
            freeCreditRemaining: rescueCreditRemaining || splitCreditRemaining,
            planType: user.planType || 'free',
            splitMinutesLeft: 0
        };
    }
    async consumeFreeCredit(userId, actionType = 'rescue') {
        const user = await authService_1.authService.getUserById(userId);
        if (!user) {
            return { success: false, message: 'User not found', actionType };
        }
        const today = getTodayDateString();
        const ledger = getLedger();
        if (!ledger[userId]) {
            ledger[userId] = {};
        }
        if (actionType === 'split') {
            ledger[userId].splitUsedOn = today;
        }
        else {
            ledger[userId].rescueUsedOn = today;
        }
        saveLedger(ledger);
        return {
            success: true,
            message: `Free ${actionType} credit consumed successfully`,
            actionType
        };
    }
    // Backward-compatible wrapper
    async consumeFreeRescueCredit(userId) {
        return this.consumeFreeCredit(userId, 'rescue');
    }
}
exports.EntitlementService = EntitlementService;
exports.entitlementService = new EntitlementService();
