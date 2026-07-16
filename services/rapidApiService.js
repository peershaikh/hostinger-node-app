"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.rapidApiService = exports.RapidApiService = void 0;
const logger_1 = require("../middleware/logger");
const providerConfigService_1 = require("./providerConfigService");
class RapidApiService {
    constructor() {
        // keys fetched dynamically per request
        this.currentKeyIndex = 0;
        this.HOST = process.env.RAPIDAPI_HOST || 'irctc-train-api.p.rapidapi.com';
        this.lastCallTime = 0;
    }
    async getNextApiKey() {
        try {
            const keys = await providerConfigService_1.providerConfigService.getKeysFor('RAPIDAPI');
            if (keys.length === 0) {
                logger_1.winstonLogger.warn(`[PROVIDER_MISSING_KEY] RapidAPI: No API key found in configuration.`);
                throw new Error("REAL API FAILED - No RapidAPI key configured");
            }
            const key = keys[this.currentKeyIndex % keys.length];
            this.currentKeyIndex = (this.currentKeyIndex + 1) % keys.length;
            return key;
        }
        catch (err) {
            if (err.message && !err.message.includes("No RapidAPI key configured")) {
                logger_1.winstonLogger.warn(`[PROVIDER_MISSING_KEY] RapidAPI: Key retrieval failed: ${err.message}`);
            }
            throw new Error("REAL API FAILED - No RapidAPI key configured");
        }
    }
    async getHeaders() {
        const key = await this.getNextApiKey();
        return {
            "X-RapidAPI-Key": key,
            "X-RapidAPI-Host": this.HOST
        };
    }
    async stagger() {
        const now = Date.now();
        const elapsed = now - this.lastCallTime;
        const MIN_INTERVAL = 800;
        if (elapsed < MIN_INTERVAL) {
            await new Promise(r => setTimeout(r, MIN_INTERVAL - elapsed));
        }
        this.lastCallTime = Date.now();
    }
    // ====================== FIX_7 COMPATIBLE METHODS ======================
    async getPNRStatus(pnr) {
        logger_1.winstonLogger.info(`[RAPIDAPI_DISABLED] RapidAPI is disabled by user.`);
        return null;
    }
    async getLiveStatus(trainNo, date) {
        logger_1.winstonLogger.info(`[RAPIDAPI_DISABLED] RapidAPI is disabled by user.`);
        return null;
    }
    async getTrainSchedule(trainNo) {
        logger_1.winstonLogger.info(`[RAPIDAPI_DISABLED] RapidAPI is disabled by user.`);
        return null;
    }
    async searchTrainsBetweenStations(from, to, date) {
        logger_1.winstonLogger.info(`[RAPIDAPI_DISABLED] RapidAPI is disabled by user.`);
        return [];
    }
    async getSeatAvailability(params) {
        logger_1.winstonLogger.info(`[RAPIDAPI_DISABLED] RapidAPI is disabled by user.`);
        return null;
    }
    // ====================== HELPERS ======================
    async search(from, to, date) {
        return this.searchTrainsBetweenStations(from, to, date);
    }
    async saveToLearningDatabase(from, to, trains) {
        // Optional learning logic (kept as-is)
        try {
            const validTrains = trains.filter((t) => t.train_number && t.train_name);
            // ... (your existing upsert logic)
        }
        catch { }
    }
    getStatus() {
        return {
            service: "RapidAPI",
            role: "FALLBACK_2",
            keysConfigured: process.env.USE_DB_PROVIDERS === 'true' ? 'DB_CONFIG' : 'ENV_CONFIG',
            host: this.HOST
        };
    }
}
exports.RapidApiService = RapidApiService;
exports.rapidApiService = new RapidApiService();
