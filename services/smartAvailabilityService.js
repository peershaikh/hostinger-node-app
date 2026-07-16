"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.smartAvailabilityService = void 0;
/**
 * PHASE_4C870 — Single gateway for all availability requests.
 * L1 bounded LRU (60s) → L2 Redis (when SMART_AVAIL_CACHE) → Provider.
 * PHASE_4C871 — Resolver-canonical cache keys (schedule stops + padded train).
 */
const lruTtlCache_1 = require("../rescue/lruTtlCache");
const availabilityRedisCache_1 = require("../cache/availabilityRedisCache");
const availabilityCacheKeys_1 = require("../utils/availabilityCacheKeys");
const availabilityTtlPolicy_1 = require("../utils/availabilityTtlPolicy");
const featureFlags_1 = require("../config/featureFlags");
const smartAvailabilityMetrics_1 = require("./smartAvailabilityMetrics");
function logDebug(msg) {
    try {
        const { winstonLogger } = require('../middleware/logger');
        winstonLogger.debug(msg);
    }
    catch {
        // test / minimal environments
    }
}
const L1_MAX_KEYS = 5000;
const L1_TTL_MS = availabilityTtlPolicy_1.L1_AVAIL_TTL_SECONDS * 1000;
class SmartAvailabilityService {
    constructor() {
        this.l1 = new lruTtlCache_1.LruTtlCache(L1_MAX_KEYS, L1_TTL_MS);
        this.inFlight = new Map();
        this.fetchOverride = null;
        this.resolveOverride = null;
    }
    async getAvailability(params) {
        const normalized = this.normalizeParams(params);
        const keyParts = await this.resolveCacheKeyParts(normalized);
        const l1Key = this.buildCacheKey(normalized, keyParts);
        const pending = this.inFlight.get(l1Key);
        if (pending) {
            smartAvailabilityMetrics_1.smartAvailabilityMetrics.recordSingleflightHit();
            logDebug(`[SMART_AVAIL] Single-flight coalesce ${l1Key}`);
            return pending;
        }
        const operation = this.executeFetch(normalized, l1Key, keyParts);
        this.inFlight.set(l1Key, operation);
        try {
            return await operation;
        }
        finally {
            if (this.inFlight.get(l1Key) === operation) {
                this.inFlight.delete(l1Key);
            }
        }
    }
    normalizeParams(params) {
        return {
            trainNo: String(params.trainNo || '').trim(),
            from: (0, availabilityCacheKeys_1.normalizeAvailKeyPart)(params.from),
            to: (0, availabilityCacheKeys_1.normalizeAvailKeyPart)(params.to),
            date: (params.date || '').trim(),
            classType: (0, availabilityCacheKeys_1.normalizeAvailKeyPart)(params.classType || '3A'),
            quota: (0, availabilityCacheKeys_1.normalizeAvailKeyPart)(params.quota || 'GN'),
            forceRefresh: params.forceRefresh === true,
        };
    }
    async resolveCacheKeyParts(params) {
        if (this.resolveOverride) {
            return this.resolveOverride(params);
        }
        return (0, availabilityCacheKeys_1.resolveAvailabilityCacheKeyParts)(params.trainNo, params.from, params.to, params.date);
    }
    buildCacheKey(params, keyParts) {
        return (0, availabilityCacheKeys_1.generateCanonicalAvailabilityKey)(keyParts.trainNo, keyParts.from, keyParts.to, params.date, params.quota, params.classType);
    }
    cacheKeyParams(params, keyParts) {
        return {
            ...params,
            trainNo: keyParts.trainNo,
            from: keyParts.from,
            to: keyParts.to,
        };
    }
    async executeFetch(params, l1Key, keyParts) {
        const started = Date.now();
        const cacheParams = this.cacheKeyParams(params, keyParts);
        if (!params.forceRefresh) {
            const l1Hit = this.l1.get(l1Key);
            if (l1Hit?.result) {
                smartAvailabilityMetrics_1.smartAvailabilityMetrics.recordL1Hit();
                smartAvailabilityMetrics_1.smartAvailabilityMetrics.recordCacheLatency(Date.now() - started);
                return { ...l1Hit.result, cacheLayer: 'l1' };
            }
            if (featureFlags_1.featureFlags.smartAvailCache) {
                const redisKey = (0, availabilityCacheKeys_1.generateRedisAvailabilityKey)(cacheParams.trainNo, cacheParams.from, cacheParams.to, cacheParams.date, cacheParams.quota, cacheParams.classType);
                const l2Entry = await availabilityRedisCache_1.availabilityRedisCache.get(redisKey);
                if (l2Entry) {
                    smartAvailabilityMetrics_1.smartAvailabilityMetrics.recordL2Hit();
                    const result = l2Entry.success
                        ? { success: true, data: l2Entry.payload, cacheLayer: 'l2' }
                        : {
                            success: false,
                            reason: l2Entry.reason,
                            message: l2Entry.message,
                            cacheLayer: 'l2',
                        };
                    this.warmL1(l1Key, result);
                    smartAvailabilityMetrics_1.smartAvailabilityMetrics.recordCacheLatency(Date.now() - started);
                    return result;
                }
            }
        }
        smartAvailabilityMetrics_1.smartAvailabilityMetrics.recordCacheMiss();
        const providerResult = await this.fetchFromProvider(params);
        smartAvailabilityMetrics_1.smartAvailabilityMetrics.recordProviderCall();
        const result = {
            success: providerResult.success,
            data: providerResult.data,
            reason: providerResult.reason,
            message: providerResult.message,
            cacheLayer: 'provider',
        };
        const mayCache = (0, availabilityTtlPolicy_1.shouldCacheResult)(result) && keyParts.resolverCanonical;
        if (mayCache) {
            this.warmL1(l1Key, result);
            if (featureFlags_1.featureFlags.smartAvailCache) {
                await this.writeL2(cacheParams, result);
            }
        }
        smartAvailabilityMetrics_1.smartAvailabilityMetrics.recordCacheLatency(Date.now() - started);
        return result;
    }
    warmL1(l1Key, result) {
        this.l1.set(l1Key, { result, storedAt: Date.now() });
    }
    async writeL2(params, result) {
        const status = (0, availabilityTtlPolicy_1.classifyAvailabilityStatus)(result);
        const ttlSeconds = (0, availabilityTtlPolicy_1.computeAvailTtlSeconds)(status, params.date);
        const redisKey = (0, availabilityCacheKeys_1.generateRedisAvailabilityKey)(params.trainNo, params.from, params.to, params.date, params.quota, params.classType);
        const entry = {
            v: 2,
            status,
            success: result.success,
            payload: result.success ? result.data : undefined,
            reason: result.reason,
            message: result.message,
            fetchedAt: new Date().toISOString(),
            provider: 'SMART_AVAIL',
            ttlSeconds,
        };
        await availabilityRedisCache_1.availabilityRedisCache.set(redisKey, entry, ttlSeconds);
    }
    async fetchFromProvider(params) {
        if (this.fetchOverride) {
            return this.fetchOverride(params);
        }
        const { availabilityProvider } = require('./availabilityProvider');
        return availabilityProvider.fetchFromProvider({
            trainNo: (0, availabilityCacheKeys_1.normalizeTrainNumber)(params.trainNo),
            from: params.from,
            to: params.to,
            date: params.date,
            classType: params.classType,
            quota: params.quota,
        });
    }
    /** Test hooks */
    _setFetchOverrideForTests(fn) {
        this.fetchOverride = fn;
    }
    _setResolveOverrideForTests(fn) {
        this.resolveOverride = fn;
    }
    _resetForTests() {
        this.l1.clear();
        this.inFlight.clear();
        this.fetchOverride = null;
        this.resolveOverride = null;
    }
    getL1Stats() {
        return this.l1.getStats();
    }
}
exports.smartAvailabilityService = new SmartAvailabilityService();
