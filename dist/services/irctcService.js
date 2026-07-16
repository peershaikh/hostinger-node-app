"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
Object.defineProperty(exports, "__esModule", { value: true });
exports.irctcService = exports.IrctcService = void 0;
const logger_1 = require("../middleware/logger");
const featureFlags_1 = require("../config/featureFlags");
const cacheService_1 = require("./cacheService");
const providerConfigService_1 = require("./providerConfigService");
// PHASE_4C862 — codes passed here are already resolved by trainStationResolver in availabilityProvider.
function sanitizeStationCode(code) {
    return (code || '').toUpperCase().trim();
}
// Module-level handle — populated by the async init on first use.
let irctc = null;
class IrctcService {
    constructor() {
        this.initialized = false;
        this.initPromise = null;
        this.apiKey = '';
        // PHASE_4C931 TASK 4: retry state
        this._initRetryCount = 0;
        this._initRetryTimer = null;
        // Kick off async init immediately so the first real request
        // doesn't bear the full init latency.
        this.initPromise = this._init();
    }
    // ── Async initializer ─────────────────────────────────────────────────────
    // Uses dynamic import() which works across the ESM / CJS boundary.
    // The server compiles to CommonJS (tsconfig: "module": "commonjs") but
    // irctc-connect v3 ships as a pure ESM package ("type": "module").
    // require() cannot load ESM; await import() can.
    async _init() {
        try {
            const keys = await providerConfigService_1.providerConfigService.getKeysFor('IRCTC');
            if (keys.length > 0) {
                this.apiKey = keys[0];
            }
        }
        catch (err) {
            logger_1.winstonLogger.error(`[IRCTC] Failed to load keys from provider config: ${err.message}`);
        }
        if (!this.apiKey) {
            // PHASE_4C931 TASK 4: schedule retry instead of giving up permanently
            logger_1.winstonLogger.warn('[IRCTC_INIT_FAIL] No API key found — scheduling retry.');
            this._scheduleInitRetry();
            return;
        }
        try {
            // Dynamic import — handles ESM packages from a CJS host.
            const mod = await Promise.resolve().then(() => __importStar(require('irctc-connect')));
            // ESM default export may be wrapped: prefer .default, fall back to mod itself.
            const lib = mod.default ?? mod;
            if (typeof lib.configure !== 'function') {
                logger_1.winstonLogger.error('[IRCTC_INIT_FAIL] irctc-connect loaded but configure() not found — package API may have changed.');
                this._scheduleInitRetry();
                return;
            }
            lib.configure(this.apiKey);
            irctc = lib;
            this.initialized = true;
            this._initRetryCount = 0; // reset on success
            logger_1.winstonLogger.info('[IRCTC_INIT_SUCCESS] irctc-connect initialized successfully. Availability and PNR features active.');
        }
        catch (e) {
            logger_1.winstonLogger.error(`[IRCTC_INIT_FAIL] Dynamic import of irctc-connect failed: ${e.message}`);
            this._scheduleInitRetry();
        }
    }
    // PHASE_4C931 TASK 4: Retry initializer — never stays permanently broken.
    // First 3 failures: retry every 10s.
    // After that: retry every 60s indefinitely.
    _scheduleInitRetry() {
        if (this.initialized)
            return; // already succeeded — no-op
        if (this._initRetryTimer)
            return; // already scheduled — no double-schedule
        this._initRetryCount++;
        const delayMs = this._initRetryCount <= IrctcService.INIT_MAX_RETRIES
            ? IrctcService.INIT_RETRY_INTERVAL_MS
            : IrctcService.INIT_BACKOFF_INTERVAL_MS;
        logger_1.winstonLogger.warn(`[IRCTC_INIT_RETRY] Attempt ${this._initRetryCount} scheduled in ${delayMs / 1000}s.` +
            (this._initRetryCount > IrctcService.INIT_MAX_RETRIES ? ' (backoff mode)' : ''));
        this._initRetryTimer = setTimeout(async () => {
            this._initRetryTimer = null;
            this.apiKey = ''; // reset so getKeysFor() is re-queried fresh
            this.initPromise = this._init();
            await this.initPromise;
            if (!this.initialized) {
                logger_1.winstonLogger.warn(`[IRCTC_INIT_RETRY] Attempt ${this._initRetryCount} failed — will retry.`);
            }
            else {
                logger_1.winstonLogger.info(`[IRCTC_INIT_SUCCESS] Initialized on retry attempt ${this._initRetryCount}.`);
            }
        }, delayMs);
    }
    // ── Startup warmup ────────────────────────────────────────────────────────
    // P0 (PHASE_4C814): Called from startServer() in index.ts BEFORE httpServer.listen().
    // Awaiting this guarantees irctc-connect is fully loaded and configured before
    // Render routes any traffic to the instance. The first user request will NEVER
    // block on initPromise or the ESM cold parse of irctc-connect.
    //
    // After the first call resolves, subsequent awaits return instantly (~0ms).
    async warmup() {
        if (this.initPromise)
            await this.initPromise;
    }
    // ── Lazy init guard ───────────────────────────────────────────────────────
    // Internal guard: every public method awaits this before proceeding.
    // Post-warmup this is a synchronous no-op (initPromise already resolved).
    async ensureInit() {
        if (this.initPromise)
            await this.initPromise;
    }
    isReady() {
        if (!this.initialized || !irctc) {
            logger_1.winstonLogger.warn('[IRCTC] Service not initialized. Availability unavailable.');
            return false;
        }
        return true;
    }
    // ====================== CORE METHODS ======================
    /** Check PNR Status */
    async checkPNRStatus(pnr) {
        await this.ensureInit();
        if (!this.isReady() || !pnr)
            return null;
        const cacheKey = `pnr_${pnr}`;
        const cached = cacheService_1.cacheService.get(cacheKey);
        if (cached)
            return cached;
        try {
            logger_1.winstonLogger.info(`[IRCTC_PNR] Fetching PNR ${pnr}`);
            const data = await irctc.checkPNRStatus(pnr.trim());
            if (data && (data.success === false || data.error)) {
                const errStr = data.error || 'API reported failure';
                if (errStr.toLowerCase().includes('api key') || errStr.toLowerCase().includes('invalid key')) {
                    logger_1.winstonLogger.error(`[PROVIDER_INVALID_KEY] IRCTC: ${errStr}`);
                }
                logger_1.winstonLogger.error(`[IRCTC_PNR_FAILED] ${pnr}: ${errStr}`);
                return null;
            }
            cacheService_1.cacheService.set(cacheKey, data, 300); // 5 min
            logger_1.winstonLogger.info(`[IRCTC_PNR_SUCCESS] ${pnr}`);
            return data;
        }
        catch (e) {
            const errStr = e.message || '';
            if (errStr.toLowerCase().includes('api key') || errStr.toLowerCase().includes('invalid key')) {
                logger_1.winstonLogger.error(`[PROVIDER_INVALID_KEY] IRCTC: ${errStr}`);
            }
            logger_1.winstonLogger.error(`[IRCTC_PNR_FAILED] ${pnr}: ${errStr}`);
            return null;
        }
    }
    /** Get Train Live Info (static schedule/route — no delay data) */
    async getTrainInfo(trainNo) {
        await this.ensureInit();
        if (!this.isReady() || !trainNo)
            return null;
        const cacheKey = `traininfo_${trainNo}`;
        const cached = cacheService_1.cacheService.get(cacheKey);
        if (cached)
            return cached;
        try {
            logger_1.winstonLogger.info(`[IRCTC_LIVE] Fetching train ${trainNo}`);
            // P0.2 (PHASE_4C811): 8s timeout guard — mirrors the pattern in getAvailability().
            // Without this guard, a slow IRCTC getTrainInfo() blocks the entire rescue budget.
            const infoPromise = irctc.getTrainInfo(trainNo.trim());
            let infoTimer;
            const infoTimeout = new Promise((_, reject) => {
                infoTimer = setTimeout(() => reject(new Error('getTrainInfo timeout (8s)')), 8000);
            });
            const data = await Promise.race([infoPromise, infoTimeout]).finally(() => {
                if (infoTimer)
                    clearTimeout(infoTimer);
            });
            const result = data?.data || data;
            if (result) {
                if (result.success === false || result.error) {
                    const errStr = result.error || 'API reported failure';
                    if (errStr.toLowerCase().includes('api key') || errStr.toLowerCase().includes('invalid key')) {
                        logger_1.winstonLogger.error(`[PROVIDER_INVALID_KEY] IRCTC: ${errStr}`);
                    }
                    logger_1.winstonLogger.error(`[IRCTC_LIVE_FAILED] ${trainNo}: ${errStr}`);
                    return null;
                }
                cacheService_1.cacheService.set(cacheKey, result, 7200); // 2 hours
                logger_1.winstonLogger.info(`[IRCTC_LIVE_SUCCESS] ${trainNo}`);
                return result;
            }
            return null;
        }
        catch (e) {
            const errStr = e.message || '';
            if (errStr.toLowerCase().includes('api key') || errStr.toLowerCase().includes('invalid key')) {
                logger_1.winstonLogger.error(`[PROVIDER_INVALID_KEY] IRCTC: ${errStr}`);
            }
            logger_1.winstonLogger.error(`[IRCTC_LIVE_FAILED] ${trainNo}: ${errStr}`);
            return null;
        }
    }
    /**
     * Get real-time live running status with station-wise delays.
     * Uses trackTrain() — the correct SDK function for live data.
     * Returns: { trainNo, trainName, statusNote, lastUpdate, stations: [...] }
     * where stations[n].departure.delay = "On Time" | "15 Min Late" | ""
     */
    async getLiveStatus(trainNo, date) {
        await this.ensureInit();
        if (!this.isReady() || !trainNo)
            return null;
        let dateStr = '';
        if (date && typeof date === 'string' && date.includes('-')) {
            const parts = date.split('-');
            if (parts[0].length === 4) {
                dateStr = `${parts[2]}-${parts[1]}-${parts[0]}`;
            }
            else {
                dateStr = date;
            }
        }
        else {
            const now = new Date();
            const utcMs = now.getTime() + now.getTimezoneOffset() * 60000;
            const istNow = new Date(utcMs + 5.5 * 3600000);
            const dd = String(istNow.getDate()).padStart(2, '0');
            const mm = String(istNow.getMonth() + 1).padStart(2, '0');
            const yyyy = istNow.getFullYear();
            dateStr = `${dd}-${mm}-${yyyy}`;
        }
        const cacheKey = `live_track_${trainNo}_${dateStr}`;
        const cached = cacheService_1.cacheService.get(cacheKey);
        if (cached)
            return cached;
        try {
            logger_1.winstonLogger.info(`[IRCTC_TRACK] Fetching live status for ${trainNo} on date ${dateStr}`);
            const data = await irctc.trackTrain(trainNo.trim(), dateStr);
            const result = data?.data || data;
            if (result) {
                if (result.success === false || result.error) {
                    const errStr = result.error || 'API reported failure';
                    if (errStr.toLowerCase().includes('api key') || errStr.toLowerCase().includes('invalid key')) {
                        logger_1.winstonLogger.error(`[PROVIDER_INVALID_KEY] IRCTC: ${errStr}`);
                    }
                    logger_1.winstonLogger.error(`[IRCTC_TRACK_FAILED] ${trainNo}: ${errStr}`);
                    return null;
                }
                cacheService_1.cacheService.set(cacheKey, result, 60); // 60s — live data, short TTL
                logger_1.winstonLogger.info(`[IRCTC_TRACK_SUCCESS] ${trainNo}`);
                return result;
            }
            return null;
        }
        catch (e) {
            const errStr = e.message || '';
            if (errStr.toLowerCase().includes('api key') || errStr.toLowerCase().includes('invalid key')) {
                logger_1.winstonLogger.error(`[PROVIDER_INVALID_KEY] IRCTC: ${errStr}`);
            }
            logger_1.winstonLogger.error(`[IRCTC_TRACK_FAILED] ${trainNo}: ${errStr}`);
            return null;
        }
    }
    /** Search Trains Between Stations (Most Important) */
    async search(from, to, date) {
        await this.ensureInit();
        if (!this.isReady() || !from || !to || !date)
            return [];
        const cacheKey = `search_${from}_${to}_${date}`;
        const cached = cacheService_1.cacheService.get(cacheKey);
        // PHASE_4C931 TASK 1: Guard — do NOT serve a cached empty array.
        // If cached is a non-empty array, serve it. If empty array, treat as cache miss.
        if (Array.isArray(cached) && cached.length > 0)
            return cached;
        // (null or empty array from cache → fall through to live call)
        try {
            logger_1.winstonLogger.info(`[API_PRIMARY_ACTIVE] IRCTC Search: ${from} → ${to} | ${date}`);
            // Format date as DD-MM-YYYY (IRCTC requirement)
            let formattedDate = date.trim();
            if (formattedDate.includes('-') && formattedDate.split('-')[0].length === 4) {
                const [y, m, d] = formattedDate.split('-');
                formattedDate = `${d}-${m}-${y}`;
            }
            const data = await irctc.searchTrainBetweenStations(from.toUpperCase().trim(), to.toUpperCase().trim(), formattedDate);
            const results = data?.data || data?.trains || data || [];
            const finalResults = Array.isArray(results) ? results : (results.trains || results.data || []);
            // PHASE_4C931 TASK 1: Never cache empty arrays for 30 minutes.
            // An empty response means IRCTC returned nothing for this query right now —
            // it may succeed on the next request (rate-limit reset, transient error, etc.).
            // We use a 45s negative-cache TTL to prevent hammering while still allowing
            // rapid retry — within the 30–60s spec from PHASE_4C931 requirements.
            if (finalResults.length > 0) {
                cacheService_1.cacheService.set(cacheKey, finalResults, 1800); // 30 min — only for real results
                logger_1.winstonLogger.info(`[IRCTC_SUCCESS] Found ${finalResults.length} trains ${from}→${to}`);
            }
            else {
                cacheService_1.cacheService.set(cacheKey, finalResults, 45); // 45s negative-cache
                logger_1.winstonLogger.warn(`[IRCTC_EMPTY_RESULT] ${from}→${to} on ${date} returned 0 trains from IRCTC. ` +
                    `Negative-cached for 45s. Next live call in ~45s.`);
            }
            return finalResults;
        }
        catch (e) {
            logger_1.winstonLogger.error(`[IRCTC_SEARCH_FAILED] ${from}→${to}: ${e.message}`);
            return [];
        }
    }
    async getAvailability(trainNo, date, from, to, classType = '3A', quota = 'GN', options) {
        await this.ensureInit();
        if (!this.isReady()) {
            logger_1.winstonLogger.error(`[IRCTC_AVAIL_DEAD] Service not initialized — cannot fetch availability for train ${trainNo}`);
            return null;
        }
        const fromNorm = sanitizeStationCode(from);
        const toNorm = sanitizeStationCode(to);
        const quotaNorm = (quota || 'GN').toUpperCase().trim();
        const classNorm = (classType || '3A').toUpperCase().trim();
        const skipCache = options?.bypassCache === true || featureFlags_1.featureFlags.smartAvailCache;
        if (!skipCache) {
            const cached = cacheService_1.cacheService.lookupAvailabilityCache(trainNo, fromNorm, toNorm, date, quotaNorm, classNorm);
            if (cached)
                return cached;
        }
        try {
            logger_1.winstonLogger.info(`[IRCTC_AVAIL_INPUT] train=${trainNo} from=${fromNorm} to=${toNorm} date=${date} cls=${classType} quota=${quota}`);
            // IRCTC requires date in DD-MM-YYYY format
            let formattedDate = date.trim();
            if (formattedDate.includes('-') && formattedDate.split('-')[0].length === 4) {
                const [y, m, d] = formattedDate.split('-');
                formattedDate = `${d}-${m}-${y}`;
            }
            const irctcPromise = irctc.getAvailability(trainNo.trim(), fromNorm, toNorm, formattedDate, classType.toUpperCase(), quota.toUpperCase());
            let availTimer;
            const timeoutPromise = new Promise((_, reject) => {
                availTimer = setTimeout(() => reject(new Error('API Timeout (8s)')), 8000);
            });
            const data = await Promise.race([irctcPromise, timeoutPromise]).finally(() => {
                if (availTimer)
                    clearTimeout(availTimer);
            });
            // FIX-4: log which classes the SDK actually returned vs what was requested
            if (data && typeof data === 'object') {
                const returnedKeys = Array.isArray(data) ? 'ARRAY' : Object.keys(data).join(',');
                logger_1.winstonLogger.info(`[IRCTC_AVAIL_RESPONSE] train=${trainNo} requestedClass=${classType} returnedKeys=${returnedKeys}`);
            }
            // PHASE_4C870 — cache writes only when not routed through SmartAvailabilityService
            if (!skipCache &&
                data &&
                typeof data === 'object' &&
                data.success !== false) {
                cacheService_1.cacheService.storeAvailabilityCache(trainNo, fromNorm, toNorm, date, quotaNorm, classNorm, data, 300);
            }
            return data;
        }
        catch (e) {
            const errMsg = (e.message || '').toLowerCase();
            logger_1.winstonLogger.warn(`[IRCTC_AVAIL_FAIL] ${trainNo}: ${e.message}`);
            // Propagate known semantic errors as structured objects
            // so downstream can classify them
            if (errMsg.includes('class does not exist') ||
                errMsg.includes('not available') ||
                errMsg.includes('invalid') ||
                errMsg.includes('does not run') ||
                errMsg.includes('not found')) {
                return { success: false, error: e.message };
            }
            return null;
        }
    }
    /** Get Fare Breakdown */
    async fareLookup(trainNo, from, to, date, classType, quota = 'GN') {
        await this.ensureInit();
        if (!this.isReady() || !trainNo)
            return null;
        const cacheKey = `fare_${trainNo}_${from}_${to}_${date}_${classType}_${quota}`;
        const cached = cacheService_1.cacheService.get(cacheKey);
        if (cached)
            return cached;
        try {
            logger_1.winstonLogger.info(`[IRCTC_FARE] Fetching fare for train=${trainNo} class=${classType} quota=${quota}`);
            // IRCTC requires date in DD-MM-YYYY format
            let formattedDate = date.trim();
            if (formattedDate.includes('-') && formattedDate.split('-')[0].length === 4) {
                const [y, m, d] = formattedDate.split('-');
                formattedDate = `${d}-${m}-${y}`;
            }
            const data = await irctc.fareLookup(trainNo.trim(), from.toUpperCase().trim(), to.toUpperCase().trim(), formattedDate, classType.toUpperCase(), quota.toUpperCase());
            if (data && typeof data === 'object' && data.success !== false) {
                cacheService_1.cacheService.set(cacheKey, data, 86400); // Cache fare for 24 hours
            }
            return data;
        }
        catch (err) {
            logger_1.winstonLogger.error(`[IRCTC_FARE_FAILED] train=${trainNo}: ${err.message}`);
            return null;
        }
    }
    getStatus() {
        return {
            service: "IRCTC",
            initialized: this.initialized,
            hasApiKey: !!this.apiKey,
            keySource: process.env.USE_DB_PROVIDERS === 'true' ? 'DB_CONFIG_OR_FALLBACK' : 'ENV_FALLBACK',
            role: "PRIMARY_API"
        };
    }
}
exports.IrctcService = IrctcService;
IrctcService.INIT_MAX_RETRIES = 3;
IrctcService.INIT_RETRY_INTERVAL_MS = 10000; // 10s for first 3 retries
IrctcService.INIT_BACKOFF_INTERVAL_MS = 60000; // 60s perpetual after that
exports.irctcService = new IrctcService();
