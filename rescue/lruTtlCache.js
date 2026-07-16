"use strict";
/**
 * PHASE_4C830 — Memory Hardening
 * LRU Cache with TTL and Background Cleanup
 *
 * Replaces unbounded Maps in the Rescue Intelligence Layer to prevent OOMs.
 * Implements LRU (Least Recently Used) eviction and time-based expiration.
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.LruTtlCache = void 0;
class LruTtlCache {
    constructor(maxSize, ttlMs, cleanupIntervalMs = 60000) {
        this.cache = new Map();
        this.cleanupInterval = null;
        // Metrics
        this.hits = 0;
        this.misses = 0;
        this.evictions = 0;
        this.expirations = 0;
        this.maxSize = maxSize;
        this.ttlMs = ttlMs;
        // Background task to sweep expired entries without blocking the event loop on read
        this.cleanupInterval = setInterval(() => {
            this.sweep();
        }, cleanupIntervalMs);
        // Don't keep the Node process alive just for this timer
        if (this.cleanupInterval.unref) {
            this.cleanupInterval.unref();
        }
    }
    get(key) {
        const entry = this.cache.get(key);
        if (!entry) {
            this.misses++;
            return undefined;
        }
        if (Date.now() > entry.expiresAt) {
            this.cache.delete(key);
            this.expirations++;
            this.misses++;
            return undefined;
        }
        // Refresh LRU order by deleting and re-inserting
        this.cache.delete(key);
        this.cache.set(key, entry);
        this.hits++;
        return entry.value;
    }
    set(key, value) {
        if (this.cache.has(key)) {
            this.cache.delete(key);
        }
        else if (this.cache.size >= this.maxSize) {
            // Evict the first key (Least Recently Used since we re-insert on get)
            const firstKey = this.cache.keys().next().value;
            if (firstKey !== undefined) {
                this.cache.delete(firstKey);
                this.evictions++;
            }
        }
        this.cache.set(key, {
            value,
            expiresAt: Date.now() + this.ttlMs
        });
    }
    delete(key) {
        this.cache.delete(key);
    }
    clear() {
        this.cache.clear();
        this.hits = 0;
        this.misses = 0;
        this.evictions = 0;
        this.expirations = 0;
    }
    getStats() {
        return {
            size: this.cache.size,
            maxSize: this.maxSize,
            hits: this.hits,
            misses: this.misses,
            evictions: this.evictions,
            expirations: this.expirations
        };
    }
    dispose() {
        if (this.cleanupInterval) {
            clearInterval(this.cleanupInterval);
            this.cleanupInterval = null;
        }
        this.cache.clear();
    }
    sweep() {
        const now = Date.now();
        for (const [key, entry] of this.cache.entries()) {
            if (now > entry.expiresAt) {
                this.cache.delete(key);
                this.expirations++;
            }
        }
    }
}
exports.LruTtlCache = LruTtlCache;
