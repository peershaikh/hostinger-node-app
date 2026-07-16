/**
 * PHASE_4C870 — Single gateway for all availability requests.
 * L1 bounded LRU (60s) → L2 Redis (when SMART_AVAIL_CACHE) → Provider.
 * PHASE_4C871 — Resolver-canonical cache keys (schedule stops + padded train).
 */
import { LruTtlCache } from '../rescue/lruTtlCache';
import { availabilityRedisCache, AvailCacheEntry } from '../cache/availabilityRedisCache';
import {
  generateCanonicalAvailabilityKey,
  generateRedisAvailabilityKey,
  normalizeAvailKeyPart,
  resolveAvailabilityCacheKeyParts,
  ResolvedCacheKeyParts,
  normalizeTrainNumber,
} from '../utils/availabilityCacheKeys';
import {
  classifyAvailabilityStatus,
  computeAvailTtlSeconds,
  L1_AVAIL_TTL_SECONDS,
  shouldCacheResult,
} from '../utils/availabilityTtlPolicy';
import { featureFlags } from '../config/featureFlags';
import { smartAvailabilityMetrics } from './smartAvailabilityMetrics';

function logDebug(msg: string): void {
  try {
    const { winstonLogger } = require('../middleware/logger');
    winstonLogger.debug(msg);
  } catch {
    // test / minimal environments
  }
}

export interface SmartAvailRequest {
  trainNo: string;
  from: string;
  to: string;
  date: string;
  classType: string;
  quota: string;
  forceRefresh?: boolean;
}

export interface SmartAvailResult {
  success: boolean;
  data?: unknown;
  reason?: string;
  message?: string;
  cacheLayer?: 'l1' | 'l2' | 'provider';
  stale?: boolean;
}

interface L1Envelope {
  result: SmartAvailResult;
  storedAt: number;
}

const L1_MAX_KEYS = 5000;
const L1_TTL_MS = L1_AVAIL_TTL_SECONDS * 1000;

class SmartAvailabilityService {
  private readonly l1 = new LruTtlCache<string, L1Envelope>(L1_MAX_KEYS, L1_TTL_MS);
  private readonly inFlight = new Map<string, Promise<SmartAvailResult>>();
  private fetchOverride: ((params: SmartAvailRequest) => Promise<SmartAvailResult>) | null = null;
  private resolveOverride: ((params: SmartAvailRequest) => Promise<ResolvedCacheKeyParts>) | null = null;

  async getAvailability(params: SmartAvailRequest): Promise<SmartAvailResult> {
    const normalized = this.normalizeParams(params);
    const keyParts = await this.resolveCacheKeyParts(normalized);
    const l1Key = this.buildCacheKey(normalized, keyParts);

    const pending = this.inFlight.get(l1Key);
    if (pending) {
      smartAvailabilityMetrics.recordSingleflightHit();
      logDebug(`[SMART_AVAIL] Single-flight coalesce ${l1Key}`);
      return pending;
    }

    const operation = this.executeFetch(normalized, l1Key, keyParts);
    this.inFlight.set(l1Key, operation);
    try {
      return await operation;
    } finally {
      if (this.inFlight.get(l1Key) === operation) {
        this.inFlight.delete(l1Key);
      }
    }
  }

  private normalizeParams(params: SmartAvailRequest): SmartAvailRequest {
    return {
      trainNo: String(params.trainNo || '').trim(),
      from: normalizeAvailKeyPart(params.from),
      to: normalizeAvailKeyPart(params.to),
      date: (params.date || '').trim(),
      classType: normalizeAvailKeyPart(params.classType || '3A'),
      quota: normalizeAvailKeyPart(params.quota || 'GN'),
      forceRefresh: params.forceRefresh === true,
    };
  }

  private async resolveCacheKeyParts(params: SmartAvailRequest): Promise<ResolvedCacheKeyParts> {
    if (this.resolveOverride) {
      return this.resolveOverride(params);
    }
    return resolveAvailabilityCacheKeyParts(
      params.trainNo,
      params.from,
      params.to,
      params.date
    );
  }

  private buildCacheKey(params: SmartAvailRequest, keyParts: ResolvedCacheKeyParts): string {
    return generateCanonicalAvailabilityKey(
      keyParts.trainNo,
      keyParts.from,
      keyParts.to,
      params.date,
      params.quota,
      params.classType
    );
  }

  private cacheKeyParams(
    params: SmartAvailRequest,
    keyParts: ResolvedCacheKeyParts
  ): SmartAvailRequest {
    return {
      ...params,
      trainNo: keyParts.trainNo,
      from: keyParts.from,
      to: keyParts.to,
    };
  }

  private async executeFetch(
    params: SmartAvailRequest,
    l1Key: string,
    keyParts: ResolvedCacheKeyParts
  ): Promise<SmartAvailResult> {
    const started = Date.now();
    const cacheParams = this.cacheKeyParams(params, keyParts);

    if (!params.forceRefresh) {
      const l1Hit = this.l1.get(l1Key);
      if (l1Hit?.result) {
        smartAvailabilityMetrics.recordL1Hit();
        smartAvailabilityMetrics.recordCacheLatency(Date.now() - started);
        return { ...l1Hit.result, cacheLayer: 'l1' };
      }

      if (featureFlags.smartAvailCache) {
        const redisKey = generateRedisAvailabilityKey(
          cacheParams.trainNo,
          cacheParams.from,
          cacheParams.to,
          cacheParams.date,
          cacheParams.quota,
          cacheParams.classType
        );
        const l2Entry = await availabilityRedisCache.get(redisKey);
        if (l2Entry) {
          smartAvailabilityMetrics.recordL2Hit();
          const result: SmartAvailResult = l2Entry.success
            ? { success: true, data: l2Entry.payload, cacheLayer: 'l2' }
            : {
                success: false,
                reason: l2Entry.reason,
                message: l2Entry.message,
                cacheLayer: 'l2',
              };
          this.warmL1(l1Key, result);
          smartAvailabilityMetrics.recordCacheLatency(Date.now() - started);
          return result;
        }
      }
    }

    smartAvailabilityMetrics.recordCacheMiss();

    const providerResult = await this.fetchFromProvider(params);
    smartAvailabilityMetrics.recordProviderCall();

    const result: SmartAvailResult = {
      success: providerResult.success,
      data: providerResult.data,
      reason: providerResult.reason,
      message: providerResult.message,
      cacheLayer: 'provider',
    };

    const mayCache = shouldCacheResult(result) && keyParts.resolverCanonical;
    if (mayCache) {
      this.warmL1(l1Key, result);
      if (featureFlags.smartAvailCache) {
        await this.writeL2(cacheParams, result);
      }
    }

    smartAvailabilityMetrics.recordCacheLatency(Date.now() - started);
    return result;
  }

  private warmL1(l1Key: string, result: SmartAvailResult): void {
    this.l1.set(l1Key, { result, storedAt: Date.now() });
  }

  private async writeL2(params: SmartAvailRequest, result: SmartAvailResult): Promise<void> {
    const status = classifyAvailabilityStatus(result);
    const ttlSeconds = computeAvailTtlSeconds(status, params.date);
    const redisKey = generateRedisAvailabilityKey(
      params.trainNo,
      params.from,
      params.to,
      params.date,
      params.quota,
      params.classType
    );

    const entry: AvailCacheEntry = {
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

    await availabilityRedisCache.set(redisKey, entry, ttlSeconds);
  }

  private async fetchFromProvider(params: SmartAvailRequest): Promise<SmartAvailResult> {
    if (this.fetchOverride) {
      return this.fetchOverride(params);
    }
    const { availabilityProvider } = require('./availabilityProvider');
    return availabilityProvider.fetchFromProvider({
      trainNo: normalizeTrainNumber(params.trainNo),
      from: params.from,
      to: params.to,
      date: params.date,
      classType: params.classType,
      quota: params.quota,
    });
  }

  /** Test hooks */
  _setFetchOverrideForTests(
    fn: ((params: SmartAvailRequest) => Promise<SmartAvailResult>) | null
  ): void {
    this.fetchOverride = fn;
  }

  _setResolveOverrideForTests(
    fn: ((params: SmartAvailRequest) => Promise<ResolvedCacheKeyParts>) | null
  ): void {
    this.resolveOverride = fn;
  }

  _resetForTests(): void {
    this.l1.clear();
    this.inFlight.clear();
    this.fetchOverride = null;
    this.resolveOverride = null;
  }

  getL1Stats() {
    return this.l1.getStats();
  }
}

export const smartAvailabilityService = new SmartAvailabilityService();