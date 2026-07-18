"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.availabilityRedisCache = void 0;
/**
 * PHASE_4C870 — Redis L2 for availability snapshots.
 * Never throws — all errors are swallowed and counted as redis_failures.
 */
const ioredis_1 = __importDefault(require("ioredis"));
const smartAvailabilityMetrics_1 = require("../services/smartAvailabilityMetrics");
function log(level, msg) {
    try {
        const { winstonLogger } = require('../middleware/logger');
        winstonLogger[level](msg);
    }
    catch {
        // test / minimal environments
    }
}
class AvailabilityRedisCache {
    constructor() {
        this.client = null;
        this.isConnected = false;
        this.initRedis();
    }
    initRedis() {
        const redisUrl = process.env.UPSTASH_REDIS_URL || process.env.REDIS_URL;
        if (!redisUrl) {
            log('warn', '[SMART_AVAIL] REDIS_URL not set — L2 disabled (L1-only fallback).');
            return;
        }
        try {
            this.client = new ioredis_1.default(redisUrl, {
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
                smartAvailabilityMetrics_1.smartAvailabilityMetrics.recordRedisFailure();
                log('warn', `[SMART_AVAIL] L2 Redis error (non-fatal): ${err.message}`);
            });
            this.client.connect().catch((err) => {
                this.isConnected = false;
                smartAvailabilityMetrics_1.smartAvailabilityMetrics.recordRedisFailure();
                log('warn', `[SMART_AVAIL] L2 Redis connect failed (non-fatal): ${err.message}`);
            });
        }
        catch (e) {
            const msg = e instanceof Error ? e.message : String(e);
            smartAvailabilityMetrics_1.smartAvailabilityMetrics.recordRedisFailure();
            log('warn', `[SMART_AVAIL] L2 Redis init failed (non-fatal): ${msg}`);
        }
    }
    isAvailable() {
        return this.isConnected && this.client !== null;
    }
    async get(redisKey) {
        if (!this.client)
            return null;
        try {
            const raw = await this.client.get(redisKey);
            if (!raw)
                return null;
            return JSON.parse(raw);
        }
        catch (e) {
            const msg = e instanceof Error ? e.message : String(e);
            smartAvailabilityMetrics_1.smartAvailabilityMetrics.recordRedisFailure();
            log('warn', `[SMART_AVAIL] L2 read failed (non-fatal): ${msg}`);
            return null;
        }
    }
    async set(redisKey, entry, ttlSeconds) {
        if (!this.client)
            return;
        try {
            await this.client.setex(redisKey, Math.max(15, ttlSeconds), JSON.stringify(entry));
        }
        catch (e) {
            const msg = e instanceof Error ? e.message : String(e);
            smartAvailabilityMetrics_1.smartAvailabilityMetrics.recordRedisFailure();
            log('warn', `[SMART_AVAIL] L2 write failed (non-fatal): ${msg}`);
        }
    }
    /** Test hook — force disconnected state */
    _setConnectedForTests(connected) {
        this.isConnected = connected;
    }
}
exports.availabilityRedisCache = new AvailabilityRedisCache();
