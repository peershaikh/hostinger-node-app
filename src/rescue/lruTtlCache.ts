/**
 * PHASE_4C830 — Memory Hardening
 * LRU Cache with TTL and Background Cleanup
 *
 * Replaces unbounded Maps in the Rescue Intelligence Layer to prevent OOMs.
 * Implements LRU (Least Recently Used) eviction and time-based expiration.
 */

export interface CacheStats {
  size: number;
  maxSize: number;
  hits: number;
  misses: number;
  evictions: number;
  expirations: number;
}

interface CacheEntry<V> {
  value: V;
  expiresAt: number;
}

export class LruTtlCache<K, V> {
  private cache = new Map<K, CacheEntry<V>>();
  private readonly maxSize: number;
  private readonly ttlMs: number;
  private cleanupInterval: NodeJS.Timeout | null = null;

  // Metrics
  private hits = 0;
  private misses = 0;
  private evictions = 0;
  private expirations = 0;

  constructor(maxSize: number, ttlMs: number, cleanupIntervalMs: number = 60000) {
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

  public get(key: K): V | undefined {
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

  public set(key: K, value: V): void {
    if (this.cache.has(key)) {
      this.cache.delete(key);
    } else if (this.cache.size >= this.maxSize) {
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

  public delete(key: K): void {
    this.cache.delete(key);
  }

  public clear(): void {
    this.cache.clear();
    this.hits = 0;
    this.misses = 0;
    this.evictions = 0;
    this.expirations = 0;
  }

  public getStats(): CacheStats {
    return {
      size: this.cache.size,
      maxSize: this.maxSize,
      hits: this.hits,
      misses: this.misses,
      evictions: this.evictions,
      expirations: this.expirations
    };
  }

  public dispose(): void {
    if (this.cleanupInterval) {
      clearInterval(this.cleanupInterval);
      this.cleanupInterval = null;
    }
    this.cache.clear();
  }

  private sweep(): void {
    const now = Date.now();
    for (const [key, entry] of this.cache.entries()) {
      if (now > entry.expiresAt) {
        this.cache.delete(key);
        this.expirations++;
      }
    }
  }
}
