import NodeCache from 'node-cache';
import { featureFlags } from '../config/featureFlags';
import { winstonLogger } from '../middleware/logger';
import {
  generateCanonicalAvailabilityKey,
  generateLegacyAvailabilityKey,
} from '../utils/availabilityCacheKeys';
import { knowledgeMetricsService } from './knowledgeMetricsService';

// Initialize cache with default TTL and check period
const cache = new NodeCache({ stdTTL: 600, checkperiod: 120 });

// Cache TTL configuration (in seconds)
const CACHE_TTL = {
  SEARCH: 300,        // 5 minutes
  SPLIT: 600,         // 10 minutes for valid splits
  SPLIT_EMPTY: 20,    // 20 seconds for empty results (short TTL to prevent cache poisoning)
  PNR: 60,            // 60 seconds
  LIVE: 30,           // 30 seconds
  STATIONS: 3600,     // 1 hour
  AVAILABILITY: 300   // 5 minutes
};

class CacheService {
  /**
   * Get cached data by key
   * @param key Cache key
   * @returns Cached data or null if not found/expired
   */
  get<T>(key: string): T | null {
    try {
      const value = cache.get<T>(key);
      if (value !== undefined) {
        winstonLogger.debug(`[CACHE_HIT] ${key}`);
        return value;
      }
      winstonLogger.debug(`[CACHE_MISS] ${key}`);
      return null;
    } catch (error) {
      winstonLogger.error(`[CACHE_GET_ERROR] ${key}: ${error}`);
      return null;
    }
  }

  /**
   * Set data in cache
   * @param key Cache key
   * @param value Data to cache
   * @param ttl Time to live in seconds (optional, uses default if not provided)
   */
  set<T>(key: string, value: T, ttl?: number): boolean {
    try {
      const result = cache.set(key, value, ttl as number);
      if (result) {
        winstonLogger.debug(`[CACHE_SET] ${key} (TTL: ${ttl || 'default'})`);
      } else {
        winstonLogger.warn(`[CACHE_SET_FAILED] ${key}`);
      }
      return result;
    } catch (error) {
      winstonLogger.error(`[CACHE_SET_ERROR] ${key}: ${error}`);
      return false;
    }
  }

  /**
   * Delete cached data by key
   * @param key Cache key
   */
  del(key: string): boolean {
    try {
      const result = cache.del(key);
      if (result) {
        winstonLogger.debug(`[CACHE_DEL] ${key}`);
      }
      return result > 0;
    } catch (error) {
      winstonLogger.error(`[CACHE_DEL_ERROR] ${key}: ${error}`);
      return false;
    }
  }

  /**
   * Check if key exists in cache
   * @param key Cache key
   */
  has(key: string): boolean {
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
  flushAll(): void {
    cache.flushAll();
    winstonLogger.info('[CACHE_FLUSH] All cache cleared');
  }

  /**
   * Generate cache key for search results
   */
  generateSearchKey(source: string, destination: string, date: string): string {
    return `search:${source}:${destination}:${date}`;
  }

  /**
   * Generate cache key for split journey results.
   * MUST include all parameters that affect the output to prevent stale cache hits.
   */
  generateSplitKey(
    source: string,
    destination: string,
    date: string,
    includeSplit: boolean = true,
    classType: string = '3A',
    quota: string = 'GN'
  ): string {
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
  generatePNRKey(pnr: string): string {
    return `pnr:${pnr}`;
  }

  /**
   * Generate cache key for live train status
   */
  generateLiveKey(trainNo: string, date: string): string {
    return `live:${trainNo}:${date}`;
  }

  /**
   * Generate canonical cache key for availability data (PHASE_4C868).
   */
  generateAvailabilityKey(trainNo: string, from: string, to: string, date: string, quota: string, classType: string): string {
    return generateCanonicalAvailabilityKey(trainNo, from, to, date, quota, classType);
  }

  generateLegacyAvailabilityKey(trainNo: string, from: string, to: string, date: string, classType: string): string {
    return generateLegacyAvailabilityKey(trainNo, from, to, date, classType);
  }

  /**
   * Read availability from canonical key, then legacy avail_* (backward compat).
   */
  lookupAvailabilityCache<T>(
    trainNo: string,
    from: string,
    to: string,
    date: string,
    quota: string,
    classType: string
  ): T | null {
    const canonicalKey = this.generateAvailabilityKey(trainNo, from, to, date, quota, classType);
    const canonical = this.get<T>(canonicalKey);
    if (canonical !== null) {
      if (featureFlags.knowledgeMetrics) knowledgeMetricsService.recordCacheHit('canonical');
      return canonical;
    }

    const legacyKey = this.generateLegacyAvailabilityKey(trainNo, from, to, date, classType);
    const legacy = this.get<T>(legacyKey);
    if (legacy !== null) {
      if (featureFlags.knowledgeMetrics) knowledgeMetricsService.recordCacheHit('legacy');
      return legacy;
    }

    if (featureFlags.knowledgeMetrics) knowledgeMetricsService.recordCacheMiss();
    return null;
  }

  /**
   * Store availability snapshot. When unified flag ON, writes canonical only.
   * When OFF, also mirrors to legacy key (irctcService rollout compat).
   */
  storeAvailabilityCache(
    trainNo: string,
    from: string,
    to: string,
    date: string,
    quota: string,
    classType: string,
    data: unknown,
    ttlSeconds: number
  ): void {
    const canonicalKey = this.generateAvailabilityKey(trainNo, from, to, date, quota, classType);
    this.set(canonicalKey, data, ttlSeconds);

    if (!featureFlags.unifiedAvailCacheKeys) {
      const legacyKey = this.generateLegacyAvailabilityKey(trainNo, from, to, date, classType);
      this.set(legacyKey, data, ttlSeconds);
    }
  }

  /**
   * Get search results from cache
   */
  getCachedSearch(source: string, destination: string, date: string) {
    const key = this.generateSearchKey(source, destination, date);
    return this.get(key);
  }

  /**
   * Cache search results
   */
  cacheSearch(source: string, destination: string, date: string, data: any) {
    const key = this.generateSearchKey(source, destination, date);
    return this.set(key, data, CACHE_TTL.SEARCH);
  }

  /**
   * Get PNR data from cache
   */
  getCachedPNR(pnr: string) {
    const key = this.generatePNRKey(pnr);
    return this.get(key);
  }

  /**
   * Cache PNR data
   */
  cachePNR(pnr: string, data: any) {
    const key = this.generatePNRKey(pnr);
    return this.set(key, data, CACHE_TTL.PNR);
  }

  /**
   * Get live train status from cache
   */
  getCachedLive(trainNo: string, date: string) {
    const key = this.generateLiveKey(trainNo, date);
    return this.get(key);
  }

  /**
   * Cache live train status
   */
  cacheLive(trainNo: string, date: string, data: any) {
    const key = this.generateLiveKey(trainNo, date);
    return this.set(key, data, CACHE_TTL.LIVE);
  }

  /**
   * Get availability data from cache
   */
  getCachedAvailability(trainNo: string, from: string, to: string, date: string, quota: string, classType: string) {
    return this.lookupAvailabilityCache(trainNo, from, to, date, quota, classType);
  }

  /**
   * Cache availability data (segment engine — 180s TTL unchanged)
   */
  cacheAvailability(trainNo: string, from: string, to: string, date: string, quota: string, classType: string, data: any) {
    return this.storeAvailabilityCache(
      trainNo, from, to, date, quota, classType, data, CACHE_TTL.AVAILABILITY
    );
  }

  /**
   * Get split journey results from cache.
   * Returns null on miss (key absent or expired).
   */
  getCachedSplit(
    source: string,
    destination: string,
    date: string,
    includeSplit: boolean = true,
    classType: string = '3A',
    quota: string = 'GN'
  ) {
    const key = this.generateSplitKey(source, destination, date, includeSplit, classType, quota);
    const hit = this.get(key);
    if (hit !== null) {
      winstonLogger.info(`[SPLIT_CACHE_HIT] ${key}`);
    } else {
      winstonLogger.info(`[SPLIT_CACHE_MISS] ${key}`);
    }
    return hit;
  }

  /**
   * Cache split journey results with appropriate TTL based on content.
   * Empty results get shorter TTL to prevent cache poisoning.
   */
  cacheSplit(
    source: string,
    destination: string,
    date: string,
    data: any,
    includeSplit: boolean = true,
    classType: string = '3A',
    quota: string = 'GN'
  ): boolean {
    const key = this.generateSplitKey(source, destination, date, includeSplit, classType, quota);

    // Never cache invalid trains or empty live responses
    const FABRICATED_NAME_RE = /^(Passenger|Unknown Express|Unknown Train)\s*\d*/i;
    const splits: any[] = Array.isArray(data?.split) ? data.split : [];
    const hasInvalidTrain = splits.some((s: any) =>
      (s?.legs || []).some((leg: any) => {
        const name = String(leg?.trainName || leg?.name || '').trim();
        return !name || FABRICATED_NAME_RE.test(name);
      })
    );
    if (hasInvalidTrain) {
      winstonLogger.warn(`[SPLIT_CACHE_BLOCKED] ${key} — contains invalid/fabricated trains. Not caching.`);
      return false;
    }

    // Determine appropriate TTL based on content
    const hasResults = data && (
      (Array.isArray(data.direct) && data.direct.length > 0) ||
      (Array.isArray(data.split) && data.split.length > 0)
    );

    // DO NOT cache failed responses
    if (data?.splitError || data?.fallback || data?.success === false) {
      winstonLogger.warn(`[SPLIT_CACHE_BLOCKED] ${key} — response failed or used fallback.`);
      return false;
    }

    const ttl = hasResults ? 900 : CACHE_TTL.SPLIT_EMPTY; // 900s = 15 mins
    const result = this.set(key, data, ttl);
    winstonLogger.info(`[SPLIT_CACHE_SET] ${key} TTL=${ttl}s (hasResults=${hasResults})`);
    return result;
  }
}

export const cacheService = new CacheService();
