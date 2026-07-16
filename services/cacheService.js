"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.cacheService = void 0;
const node_cache_1 = __importDefault(require("node-cache"));
const featureFlags_1 = require("../config/featureFlags");
const logger_1 = require("../middleware/logger");
const availabilityCacheKeys_1 = require("../utils/availabilityCacheKeys");
const knowledgeMetricsService_1 = require("./knowledgeMetricsService");
// Initialize cache with default TTL and check period
const cache = new node_cache_1.default({ stdTTL: 600, checkperiod: 120 });
// Cache TTL configuration (in seconds)
const CACHE_TTL = {
    SEARCH: 300, // 5 minutes
    SPLIT: 600, // 10 minutes for valid splits
    SPLIT_EMPTY: 20, // 20 seconds for empty results (short TTL to prevent cache poisoning)
    PNR: 60, // 60 seconds
    LIVE: 30, // 30 seconds
    STATIONS: 3600, // 1 hour
    AVAILABILITY: 300 // 5 minutes
};
class CacheService {
    /**
     * Get cached data by key
     * @param key Cache key
     * @returns Cached data or null if not found/expired
     */
    get(key) {
        try {
            const value = cache.get(key);
            if (value !== undefined) {
                logger_1.winstonLogger.debug(`[CACHE_HIT] ${key}`);
                return value;
            }
            logger_1.winstonLogger.debug(`[CACHE_MISS] ${key}`);
            return null;
        }
        catch (error) {
            logger_1.winstonLogger.error(`[CACHE_GET_ERROR] ${key}: ${error}`);
            return null;
        }
    }
    /**
     * Set data in cache
     * @param key Cache key
     * @param value Data to cache
     * @param ttl Time to live in seconds (optional, uses default if not provided)
     */
    set(key, value, ttl) {
        try {
            const result = cache.set(key, value, ttl);
            if (result) {
                logger_1.winstonLogger.debug(`[CACHE_SET] ${key} (TTL: ${ttl || 'default'})`);
            }
            else {
                logger_1.winstonLogger.warn(`[CACHE_SET_FAILED] ${key}`);
            }
            return result;
        }
        catch (error) {
            logger_1.winstonLogger.error(`[CACHE_SET_ERROR] ${key}: ${error}`);
            return false;
        }
    }
    /**
     * Delete cached data by key
     * @param key Cache key
     */
    del(key) {
        try {
            const result = cache.del(key);
            if (result) {
                logger_1.winstonLogger.debug(`[CACHE_DEL] ${key}`);
            }
            return result > 0;
        }
        catch (error) {
            logger_1.winstonLogger.error(`[CACHE_DEL_ERROR] ${key}: ${error}`);
            return false;
        }
    }
    /**
     * Check if key exists in cache
     * @param key Cache key
     */
    has(key) {
        return cache.has(key);
    }
    /**
     * Get cache statistics
     */
    getStats() {
        return cache.getStats();
    }
    /**
     * Clear all cache
     */
    flushAll() {
        cache.flushAll();
        logger_1.winstonLogger.info('[CACHE_FLUSH] All cache cleared');
    }
    /**
     * Generate cache key for search results
     */
    generateSearchKey(source, destination, date) {
        return `search:${source}:${destination}:${date}`;
    }
    /**
     * Generate cache key for split journey results.
     * MUST include all parameters that affect the output to prevent stale cache hits.
     */
    generateSplitKey(source, destination, date, includeSplit = true, classType = '3A', quota = 'GN') {
        // Normalize inputs so upper/lower case differences don't create duplicate keys
        const s = (source || '').toUpperCase().trim();
        const d = (destination || '').toUpperCase().trim();
        const dt = (date || '').trim();
        const cl = (classType || '3A').toUpperCase().trim();
        const qt = (quota || 'GN').toUpperCase().trim();
        return `split:${s}:${d}:${dt}:${cl}:${qt}:${includeSplit ? '1' : '0'}`;
    }
    /**
     * Generate cache key for PNR data
     */
    generatePNRKey(pnr) {
        return `pnr:${pnr}`;
    }
    /**
     * Generate cache key for live train status
     */
    generateLiveKey(trainNo, date) {
        return `live:${trainNo}:${date}`;
    }
    /**
     * Generate canonical cache key for availability data (PHASE_4C868).
     */
    generateAvailabilityKey(trainNo, from, to, date, quota, classType) {
        return (0, availabilityCacheKeys_1.generateCanonicalAvailabilityKey)(trainNo, from, to, date, quota, classType);
    }
    generateLegacyAvailabilityKey(trainNo, from, to, date, classType) {
        return (0, availabilityCacheKeys_1.generateLegacyAvailabilityKey)(trainNo, from, to, date, classType);
    }
    /**
     * Read availability from canonical key, then legacy avail_* (backward compat).
     */
    lookupAvailabilityCache(trainNo, from, to, date, quota, classType) {
        const canonicalKey = this.generateAvailabilityKey(trainNo, from, to, date, quota, classType);
        const canonical = this.get(canonicalKey);
        if (canonical !== null) {
            if (featureFlags_1.featureFlags.knowledgeMetrics)
                knowledgeMetricsService_1.knowledgeMetricsService.recordCacheHit('canonical');
            return canonical;
        }
        const legacyKey = this.generateLegacyAvailabilityKey(trainNo, from, to, date, classType);
        const legacy = this.get(legacyKey);
        if (legacy !== null) {
            if (featureFlags_1.featureFlags.knowledgeMetrics)
                knowledgeMetricsService_1.knowledgeMetricsService.recordCacheHit('legacy');
            return legacy;
        }
        if (featureFlags_1.featureFlags.knowledgeMetrics)
            knowledgeMetricsService_1.knowledgeMetricsService.recordCacheMiss();
        return null;
    }
    /**
     * Store availability snapshot. When unified flag ON, writes canonical only.
     * When OFF, also mirrors to legacy key (irctcService rollout compat).
     */
    storeAvailabilityCache(trainNo, from, to, date, quota, classType, data, ttlSeconds) {
        const canonicalKey = this.generateAvailabilityKey(trainNo, from, to, date, quota, classType);
        this.set(canonicalKey, data, ttlSeconds);
        if (!featureFlags_1.featureFlags.unifiedAvailCacheKeys) {
            const legacyKey = this.generateLegacyAvailabilityKey(trainNo, from, to, date, classType);
            this.set(legacyKey, data, ttlSeconds);
        }
    }
    /**
     * Get search results from cache
     */
    getCachedSearch(source, destination, date) {
        const key = this.generateSearchKey(source, destination, date);
        return this.get(key);
    }
    /**
     * Cache search results
     */
    cacheSearch(source, destination, date, data) {
        const key = this.generateSearchKey(source, destination, date);
        return this.set(key, data, CACHE_TTL.SEARCH);
    }
    /**
     * Get PNR data from cache
     */
    getCachedPNR(pnr) {
        const key = this.generatePNRKey(pnr);
        return this.get(key);
    }
    /**
     * Cache PNR data
     */
    cachePNR(pnr, data) {
        const key = this.generatePNRKey(pnr);
        return this.set(key, data, CACHE_TTL.PNR);
    }
    /**
     * Get live train status from cache
     */
    getCachedLive(trainNo, date) {
        const key = this.generateLiveKey(trainNo, date);
        return this.get(key);
    }
    /**
     * Cache live train status
     */
    cacheLive(trainNo, date, data) {
        const key = this.generateLiveKey(trainNo, date);
        return this.set(key, data, CACHE_TTL.LIVE);
    }
    /**
     * Get availability data from cache
     */
    getCachedAvailability(trainNo, from, to, date, quota, classType) {
        return this.lookupAvailabilityCache(trainNo, from, to, date, quota, classType);
    }
    /**
     * Cache availability data (segment engine — 180s TTL unchanged)
     */
    cacheAvailability(trainNo, from, to, date, quota, classType, data) {
        return this.storeAvailabilityCache(trainNo, from, to, date, quota, classType, data, CACHE_TTL.AVAILABILITY);
    }
    /**
     * Get split journey results from cache.
     * Returns null on miss (key absent or expired).
     */
    getCachedSplit(source, destination, date, includeSplit = true, classType = '3A', quota = 'GN') {
        const key = this.generateSplitKey(source, destination, date, includeSplit, classType, quota);
        const hit = this.get(key);
        if (hit !== null) {
            logger_1.winstonLogger.info(`[SPLIT_CACHE_HIT] ${key}`);
        }
        else {
            logger_1.winstonLogger.info(`[SPLIT_CACHE_MISS] ${key}`);
        }
        return hit;
    }
    /**
     * Cache split journey results with appropriate TTL based on content.
     * Empty results get shorter TTL to prevent cache poisoning.
     */
    cacheSplit(source, destination, date, data, includeSplit = true, classType = '3A', quota = 'GN') {
        const key = this.generateSplitKey(source, destination, date, includeSplit, classType, quota);
        // Never cache invalid trains or empty live responses
        const FABRICATED_NAME_RE = /^(Passenger|Unknown Express|Unknown Train)\s*\d*/i;
        const splits = Array.isArray(data?.split) ? data.split : [];
        const hasInvalidTrain = splits.some((s) => (s?.legs || []).some((leg) => {
            const name = String(leg?.trainName || leg?.name || '').trim();
            return !name || FABRICATED_NAME_RE.test(name);
        }));
        if (hasInvalidTrain) {
            logger_1.winstonLogger.warn(`[SPLIT_CACHE_BLOCKED] ${key} — contains invalid/fabricated trains. Not caching.`);
            return false;
        }
        // Determine appropriate TTL based on content
        const hasResults = data && ((Array.isArray(data.direct) && data.direct.length > 0) ||
            (Array.isArray(data.split) && data.split.length > 0));
        // DO NOT cache failed responses
        if (data?.splitError || data?.fallback || data?.success === false) {
            logger_1.winstonLogger.warn(`[SPLIT_CACHE_BLOCKED] ${key} — response failed or used fallback.`);
            return false;
        }
        const ttl = hasResults ? 900 : CACHE_TTL.SPLIT_EMPTY; // 900s = 15 mins
        const result = this.set(key, data, ttl);
        logger_1.winstonLogger.info(`[SPLIT_CACHE_SET] ${key} TTL=${ttl}s (hasResults=${hasResults})`);
        return result;
    }
}
exports.cacheService = new CacheService();
