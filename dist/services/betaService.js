"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.betaService = exports.BetaService = void 0;
const crypto_1 = __importDefault(require("crypto"));
const fs_1 = __importDefault(require("fs"));
const path_1 = __importDefault(require("path"));
const supabase_1 = require("../config/supabase");
const logger_1 = require("../middleware/logger");
const BETA_CODES_FILE = path_1.default.join(__dirname, '../../data/beta_codes.json');
const BETA_REDEMPTIONS_FILE = path_1.default.join(__dirname, '../../data/beta_redemptions.json');
class BetaService {
    constructor() {
        this.codes = [];
        this.redemptions = [];
        this.init();
    }
    async init() {
        await this.loadData();
        this.ensureDefaultCode();
    }
    async loadData() {
        let loadedFromDb = false;
        if ((0, supabase_1.isSupabaseConfigured)()) {
            try {
                const { data: remoteCodes, error: codeErr } = await supabase_1.supabase.from('beta_codes').select('*');
                if (!codeErr && remoteCodes && remoteCodes.length > 0) {
                    this.codes = remoteCodes.map(c => ({
                        code: c.code,
                        description: c.description,
                        maxRedemptions: c.max_redemptions,
                        currentRedemptions: c.current_redemptions,
                        expiresAt: c.expires_at,
                        unlimitedSearch: c.unlimited_search,
                        unlimitedPnr: c.unlimited_pnr,
                        unlimitedLiveTracking: c.unlimited_live_tracking,
                        unlimitedSplitSearch: c.unlimited_split_search,
                        isActive: c.is_active,
                        createdAt: c.created_at
                    }));
                    loadedFromDb = true;
                }
                const { data: remoteRedemptions, error: redErr } = await supabase_1.supabase.from('beta_redemptions').select('*');
                if (!redErr && remoteRedemptions && remoteRedemptions.length > 0) {
                    this.redemptions = remoteRedemptions.map(r => ({
                        id: r.id,
                        userId: r.user_id,
                        betaCode: r.beta_code,
                        redeemedAt: r.redeemed_at,
                        expiresAt: r.expires_at
                    }));
                    loadedFromDb = true;
                }
            }
            catch (e) {
                logger_1.winstonLogger.warn(`[BETA_SERVICE] Failed to load Supabase data: ${e.message}`);
            }
        }
        if (!loadedFromDb) {
            try {
                if (fs_1.default.existsSync(BETA_CODES_FILE)) {
                    this.codes = JSON.parse(fs_1.default.readFileSync(BETA_CODES_FILE, 'utf-8'));
                }
                if (fs_1.default.existsSync(BETA_REDEMPTIONS_FILE)) {
                    this.redemptions = JSON.parse(fs_1.default.readFileSync(BETA_REDEMPTIONS_FILE, 'utf-8'));
                }
            }
            catch (e) {
                logger_1.winstonLogger.warn('[BETA_SERVICE] Failed to load local JSON fallback data');
            }
        }
    }
    saveData() {
        try {
            if (!fs_1.default.existsSync(path_1.default.dirname(BETA_CODES_FILE))) {
                fs_1.default.mkdirSync(path_1.default.dirname(BETA_CODES_FILE), { recursive: true });
            }
            fs_1.default.writeFileSync(BETA_CODES_FILE, JSON.stringify(this.codes, null, 2));
            fs_1.default.writeFileSync(BETA_REDEMPTIONS_FILE, JSON.stringify(this.redemptions, null, 2));
        }
        catch (e) {
            logger_1.winstonLogger.warn('[BETA_SERVICE] Failed to save local data');
        }
    }
    ensureDefaultCode() {
        // PHASE_4C839 NF-002: never auto-seed unlimited codes in production
        if (process.env.NODE_ENV === 'production')
            return;
        const defaultCode = 'TRAYAGO25';
        if (!this.codes.find(c => c.code === defaultCode)) {
            const expiry = new Date();
            expiry.setDate(expiry.getDate() + 30);
            const code = {
                code: defaultCode,
                description: 'Default 30-day unlimited beta code',
                maxRedemptions: 999999, // practically unlimited
                currentRedemptions: 0,
                expiresAt: expiry.toISOString(),
                unlimitedSearch: true,
                unlimitedPnr: true,
                unlimitedLiveTracking: true,
                unlimitedSplitSearch: true,
                isActive: true,
                createdAt: new Date().toISOString()
            };
            this.codes.push(code);
            this.saveData();
            if ((0, supabase_1.isSupabaseConfigured)()) {
                supabase_1.supabase.from('beta_codes').insert({
                    code: code.code,
                    description: code.description,
                    max_redemptions: code.maxRedemptions,
                    current_redemptions: code.currentRedemptions,
                    expires_at: code.expiresAt,
                    unlimited_search: code.unlimitedSearch,
                    unlimited_pnr: code.unlimitedPnr,
                    unlimited_live_tracking: code.unlimitedLiveTracking,
                    unlimited_split_search: code.unlimitedSplitSearch,
                    is_active: code.isActive
                }).then(({ error }) => {
                    if (error && error.code !== '23505') { // Ignore unique violation
                        logger_1.winstonLogger.warn(`[BETA_SERVICE] Failed to seed default code to DB: ${error.message}`);
                    }
                });
            }
        }
    }
    async syncWithSupabase() {
        // Deprecated in favor of primary Supabase operations and loadData DB fetching
    }
    getCode(code) {
        return this.codes.find(c => c.code.toUpperCase() === code.toUpperCase());
    }
    getAllCodes() {
        return [...this.codes];
    }
    getAllRedemptions() {
        return [...this.redemptions];
    }
    async createCode(codeData) {
        const existing = this.getCode(codeData.code);
        if (existing) {
            throw new Error('Code already exists');
        }
        const newCode = {
            ...codeData,
            code: codeData.code.toUpperCase(),
            currentRedemptions: 0,
            createdAt: new Date().toISOString()
        };
        this.codes.push(newCode);
        this.saveData();
        if ((0, supabase_1.isSupabaseConfigured)()) {
            await supabase_1.supabase.from('beta_codes').insert({
                code: newCode.code,
                description: newCode.description,
                max_redemptions: newCode.maxRedemptions,
                current_redemptions: newCode.currentRedemptions,
                expires_at: newCode.expiresAt,
                unlimited_search: newCode.unlimitedSearch,
                unlimited_pnr: newCode.unlimitedPnr,
                unlimited_live_tracking: newCode.unlimitedLiveTracking,
                unlimited_split_search: newCode.unlimitedSplitSearch,
                is_active: newCode.isActive
            });
        }
        return newCode;
    }
    async disableCode(code) {
        const existing = this.getCode(code);
        if (!existing)
            return false;
        existing.isActive = false;
        this.saveData();
        if ((0, supabase_1.isSupabaseConfigured)()) {
            await supabase_1.supabase.from('beta_codes').update({ is_active: false }).eq('code', existing.code);
        }
        return true;
    }
    isValidCode(codeStr) {
        const code = this.getCode(codeStr);
        if (!code || !code.isActive)
            return false;
        if (code.expiresAt && new Date() > new Date(code.expiresAt))
            return false;
        if (code.currentRedemptions >= code.maxRedemptions)
            return false;
        return true;
    }
    hasRedeemedCode(userId, codeStr) {
        if (!userId || !codeStr)
            return false;
        return this.redemptions.some(r => r.userId === userId && r.betaCode.toUpperCase() === codeStr.toUpperCase());
    }
    /** Any non-expired beta redemption for this user (header-independent). */
    hasActiveRedemption(userId) {
        if (!userId)
            return false;
        const now = Date.now();
        return this.redemptions.some((r) => r.userId === userId &&
            (!r.expiresAt || new Date(r.expiresAt).getTime() > now));
    }
    hasUnlimitedAccess(codeStr, feature) {
        if (!this.isValidCode(codeStr))
            return false;
        const code = this.getCode(codeStr);
        if (!code)
            return false;
        switch (feature) {
            case 'search': return code.unlimitedSearch;
            case 'pnr': return code.unlimitedPnr;
            case 'live': return code.unlimitedLiveTracking;
            case 'split': return code.unlimitedSplitSearch;
            default: return false;
        }
    }
    async redeemCode(userId, codeStr) {
        if (!this.isValidCode(codeStr))
            return false;
        // Check if already redeemed
        const alreadyRedeemed = this.redemptions.find(r => r.userId === userId && r.betaCode.toUpperCase() === codeStr.toUpperCase());
        if (alreadyRedeemed)
            return true;
        const code = this.getCode(codeStr);
        if (!code)
            return false;
        code.currentRedemptions += 1;
        const redemption = {
            id: crypto_1.default.randomUUID(),
            userId,
            betaCode: code.code,
            redeemedAt: new Date().toISOString(),
            expiresAt: code.expiresAt
        };
        this.redemptions.push(redemption);
        this.saveData();
        if ((0, supabase_1.isSupabaseConfigured)()) {
            await supabase_1.supabase.from('beta_codes').update({ current_redemptions: code.currentRedemptions }).eq('code', code.code);
            await supabase_1.supabase.from('beta_redemptions').insert({
                id: redemption.id,
                user_id: redemption.userId,
                beta_code: redemption.betaCode,
                redeemed_at: redemption.redeemedAt,
                expires_at: redemption.expiresAt
            });
        }
        return true;
    }
    async deleteRedemptionsForUser(userId) {
        this.redemptions = this.redemptions.filter(r => r.userId !== userId);
        this.saveData();
        if ((0, supabase_1.isSupabaseConfigured)()) {
            const { error } = await supabase_1.supabase.from('beta_redemptions').delete().eq('user_id', userId);
            if (error) {
                logger_1.winstonLogger.warn(`[BETA_SERVICE] Failed to delete beta redemptions for user ${userId}: ${error.message}`);
            }
        }
    }
}
exports.BetaService = BetaService;
exports.betaService = new BetaService();
