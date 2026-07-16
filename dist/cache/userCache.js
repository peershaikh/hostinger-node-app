"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.userCache = void 0;
const node_cache_1 = __importDefault(require("node-cache"));
const ioredis_1 = __importDefault(require("ioredis"));
const logger_1 = require("../middleware/logger");
class UserCache {
    constructor() {
        // L1 Cache: 5 minutes TTL
        this.cache = new node_cache_1.default({ stdTTL: 300, checkperiod: 60 });
        // L2 Cache & PubSub
        this.redisClient = null;
        this.redisSubscriber = null;
        this.isRedisConnected = false;
        this.stats = {
            l1Hits: 0,
            l2Hits: 0,
            misses: 0,
            invalidations: 0,
            pubSubEvents: 0
        };
        this.PUBSUB_CHANNEL = 'auth_cache_invalidation';
        this.initRedis();
    }
    initRedis() {
        const redisUrl = process.env.UPSTASH_REDIS_URL || process.env.REDIS_URL;
        if (!redisUrl) {
            logger_1.winstonLogger.warn('[AUTH_PHASE2B] REDIS_URL not set. Running in L1-only mode.');
            return;
        }
        try {
            this.redisClient = new ioredis_1.default(redisUrl, {
                maxRetriesPerRequest: 1,
                retryStrategy: (times) => Math.min(times * 50, 2000)
            });
            this.redisSubscriber = new ioredis_1.default(redisUrl, {
                maxRetriesPerRequest: 1,
                retryStrategy: (times) => Math.min(times * 50, 2000)
            });
            this.redisClient.on('connect', () => {
                this.isRedisConnected = true;
                logger_1.winstonLogger.info('[AUTH_PHASE2B] L2 Upstash Redis Connected');
            });
            this.redisClient.on('error', (err) => {
                this.isRedisConnected = false;
                logger_1.winstonLogger.error(`[AUTH_PHASE2B] L2 Redis Error: ${err.message}`);
            });
            // Setup Pub/Sub for cross-instance L1 invalidation
            this.redisSubscriber.subscribe(this.PUBSUB_CHANNEL, (err) => {
                if (err)
                    logger_1.winstonLogger.error(`[AUTH_PHASE2B] PubSub Subscribe Error: ${err.message}`);
            });
            this.redisSubscriber.on('message', (channel, message) => {
                if (channel === this.PUBSUB_CHANNEL) {
                    const userId = message;
                    if (userId === 'CLEAR_ALL') {
                        this.cache.flushAll();
                        this.stats.pubSubEvents++;
                        logger_1.winstonLogger.info('[AUTH_PHASE2B] PubSub L1 Invalidation CLEAR_ALL');
                    }
                    else if (this.cache.has(userId)) {
                        this.cache.del(userId);
                        this.stats.pubSubEvents++;
                        logger_1.winstonLogger.info(`[AUTH_PHASE2B] PubSub L1 Invalidation for ${userId}`);
                    }
                }
            });
        }
        catch (e) {
            logger_1.winstonLogger.error(`[AUTH_PHASE2B] Redis init failed: ${e.message}`);
        }
    }
    // Changed to Async to support L2
    async getUser(id) {
        // 1. Check L1
        const l1User = this.cache.get(id);
        if (l1User) {
            this.stats.l1Hits++;
            logger_1.winstonLogger.info(`[AUTH_PHASE2B] L1 Cache hit for ${id}`);
            return l1User;
        }
        // 2. Check L2
        if (this.isRedisConnected && this.redisClient) {
            try {
                const l2UserStr = await this.redisClient.get(`user:${id}`);
                if (l2UserStr) {
                    const user = JSON.parse(l2UserStr);
                    // Hydrate L1
                    this.cache.set(id, user);
                    this.stats.l2Hits++;
                    logger_1.winstonLogger.info(`[AUTH_PHASE2B] L2 Cache hit for ${id}`);
                    return user;
                }
            }
            catch (e) {
                logger_1.winstonLogger.warn(`[AUTH_PHASE2B] L2 Redis read failed for ${id}: ${e.message}`);
            }
        }
        // 3. Miss
        this.stats.misses++;
        return null;
    }
    async setUser(user) {
        // 1. Set L1
        this.cache.set(user.id, user);
        // 2. Set L2 (7 days TTL)
        if (this.isRedisConnected && this.redisClient) {
            try {
                await this.redisClient.setex(`user:${user.id}`, 604800, JSON.stringify(user));
            }
            catch (e) {
                logger_1.winstonLogger.warn(`[AUTH_PHASE2B] L2 Redis write failed for ${user.id}: ${e.message}`);
            }
        }
    }
    async invalidate(id) {
        // 1. Invalidate L1 locally
        this.cache.del(id);
        this.stats.invalidations++;
        if (this.isRedisConnected && this.redisClient) {
            try {
                // 2. Invalidate L2
                await this.redisClient.del(`user:${id}`);
                // 3. Broadcast to other instances
                await this.redisClient.publish(this.PUBSUB_CHANNEL, id);
                logger_1.winstonLogger.info(`[AUTH_PHASE2B] L2 Invalidated & PubSub Broadcasted for ${id}`);
            }
            catch (e) {
                logger_1.winstonLogger.warn(`[AUTH_PHASE2B] L2 Redis invalidation failed for ${id}: ${e.message}`);
            }
        }
    }
    async clear() {
        // 1. Clear L1 locally
        this.cache.flushAll();
        this.stats.invalidations++;
        if (this.isRedisConnected && this.redisClient) {
            try {
                // 2. Broadcast to other instances
                await this.redisClient.publish(this.PUBSUB_CHANNEL, 'CLEAR_ALL');
                logger_1.winstonLogger.info('[AUTH_PHASE2B] L2 PubSub Broadcasted CLEAR_ALL');
            }
            catch (e) {
                logger_1.winstonLogger.warn(`[AUTH_PHASE2B] L2 Redis pubsub broadcast failed: ${e.message}`);
            }
        }
    }
    getStats() {
        return { ...this.stats };
    }
}
exports.userCache = new UserCache();
