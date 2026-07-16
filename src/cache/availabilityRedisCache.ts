/**
 * PHASE_4C870 — Redis L2 for availability snapshots.
 * Never throws — all errors are swallowed and counted as redis_failures.
 */
import Redis from 'ioredis';
import { smartAvailabilityMetrics } from '../services/smartAvailabilityMetrics';

function log(level: 'info' | 'warn', msg: string): void {
  try {
    const { winstonLogger } = require('../middleware/logger');
    winstonLogger[level](msg);
  } catch {
    // test / minimal environments
  }
}

export interface AvailCacheEntry {
  v: number;
  status: string;
  success: boolean;
  payload?: unknown;
  reason?: string;
  message?: string;
  fetchedAt: string;
  provider: string;
  ttlSeconds: number;
}

class AvailabilityRedisCache {
  private client: Redis | null = null;
  private isConnected = false;

  constructor() {
    this.initRedis();
  }

  private initRedis(): void {
    const redisUrl = process.env.UPSTASH_REDIS_URL || process.env.REDIS_URL;
    if (!redisUrl) {
      log('warn', '[SMART_AVAIL] REDIS_URL not set — L2 disabled (L1-only fallback).');
      return;
    }

    try {
      this.client = new Redis(redisUrl, {
        maxRetriesPerRequest: 1,
        retryStrategy: (times) => Math.min(times * 50, 2000),
        lazyConnect: true,
      });

      this.client.on('connect', () => {
        this.isConnected = true;
        log('info', '[SMART_AVAIL] L2 Redis connected');
      });

      this.client.on('error', (err) => {
        this.isConnected = false;
        smartAvailabilityMetrics.recordRedisFailure();
        log('warn', `[SMART_AVAIL] L2 Redis error (non-fatal): ${err.message}`);
      });

      this.client.connect().catch((err) => {
        this.isConnected = false;
        smartAvailabilityMetrics.recordRedisFailure();
        log('warn', `[SMART_AVAIL] L2 Redis connect failed (non-fatal): ${err.message}`);
      });
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      smartAvailabilityMetrics.recordRedisFailure();
      log('warn', `[SMART_AVAIL] L2 Redis init failed (non-fatal): ${msg}`);
    }
  }

  isAvailable(): boolean {
    return this.isConnected && this.client !== null;
  }

  async get(redisKey: string): Promise<AvailCacheEntry | null> {
    if (!this.client) return null;
    try {
      const raw = await this.client.get(redisKey);
      if (!raw) return null;
      return JSON.parse(raw) as AvailCacheEntry;
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      smartAvailabilityMetrics.recordRedisFailure();
      log('warn', `[SMART_AVAIL] L2 read failed (non-fatal): ${msg}`);
      return null;
    }
  }

  async set(redisKey: string, entry: AvailCacheEntry, ttlSeconds: number): Promise<void> {
    if (!this.client) return;
    try {
      await this.client.setex(redisKey, Math.max(15, ttlSeconds), JSON.stringify(entry));
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      smartAvailabilityMetrics.recordRedisFailure();
      log('warn', `[SMART_AVAIL] L2 write failed (non-fatal): ${msg}`);
    }
  }

  /** Test hook — force disconnected state */
  _setConnectedForTests(connected: boolean): void {
    this.isConnected = connected;
  }
}

export const availabilityRedisCache = new AvailabilityRedisCache();