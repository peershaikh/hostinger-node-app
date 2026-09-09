"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.entitlementService = exports.EntitlementService = void 0;
const authService_1 = require("./authService");
const fs_1 = __importDefault(require("fs"));
const path_1 = __importDefault(require("path"));
const LEDGER_PATH = path_1.default.join(process.cwd(), 'data', 'free_rescue_ledger.json');
function getLedger() {
    try {
        if (fs_1.default.existsSync(LEDGER_PATH)) {
            return JSON.parse(fs_1.default.readFileSync(LEDGER_PATH, 'utf8'));
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
    async checkRescueOrSplitEntitlement(userId) {
        if (!userId) {
            return {
                status: 'REQUIRE_LOGIN',
                hasSplitAccess: false,
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
                freeCreditRemaining: false,
                planType: 'none',
                splitMinutesLeft: 0
            };
        }
        // 1. Check if user already has paid split / pro access
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
                freeCreditRemaining: false,
                planType: user.planType || 'pro',
                splitMinutesLeft
            };
        }
        // 2. Check 1 free rescue-or-split check per 24 hours
        const ledger = getLedger();
        const freeUsedAt = ledger[userId];
        const isFreeUsedToday = freeUsedAt && (Date.now() - new Date(freeUsedAt).getTime() < 24 * 60 * 60 * 1000);
        if (!isFreeUsedToday) {
            return {
                status: 'ALLOW_FREE',
                hasSplitAccess: false,
                freeCreditRemaining: true,
                planType: user.planType || 'free',
                splitMinutesLeft: 0
            };
        }
        // 3. Free credit already consumed today -> SHOW_PAYWALL
        return {
            status: 'SHOW_PAYWALL',
            hasSplitAccess: false,
            freeCreditRemaining: false,
            planType: user.planType || 'free',
            splitMinutesLeft: 0
        };
    }
    async consumeFreeRescueCredit(userId) {
        const user = await authService_1.authService.getUserById(userId);
        if (!user) {
            return { success: false, message: 'User not found' };
        }
        const ledger = getLedger();
        ledger[userId] = new Date().toISOString();
        saveLedger(ledger);
        return { success: true, message: 'Free rescue credit consumed successfully' };
    }
}
exports.EntitlementService = EntitlementService;
exports.entitlementService = new EntitlementService();
