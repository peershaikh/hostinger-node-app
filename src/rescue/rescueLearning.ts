/**
 * PHASE_4C828 / PHASE_4C830 — Pan India Rescue Intelligence Layer
 * Rescue Learning Model (Hardened)
 *
 * Implements an in-memory learning loop to track the success/failure
 * of rescue recommendations. Uses LRU caches with TTL to prevent OOMs.
 */

import { LruTtlCache, CacheStats } from './lruTtlCache';

export interface HubSuccessStats {
  successes: number;
  failures: number;
}

export interface RegionSuccessStats {
  successes: number;
  failures: number;
}

export class RescueLearningService {
  private static instance: RescueLearningService;

  // Hardened caches: Max 10k hubs, 100 regions. 1 Hour TTL.
  private hubStats = new LruTtlCache<string, HubSuccessStats>(10000, 3600000);
  private regionStats = new LruTtlCache<string, RegionSuccessStats>(100, 3600000);
  private overallScore: number = 50; // Base baseline score 0-100

  private constructor() {}

  public static getInstance(): RescueLearningService {
    if (!RescueLearningService.instance) {
      RescueLearningService.instance = new RescueLearningService();
    }
    return RescueLearningService.instance;
  }

  public recordSuccess(hub: string, region: string): void {
    const hStats = this.hubStats.get(hub) || { successes: 0, failures: 0 };
    hStats.successes++;
    this.hubStats.set(hub, hStats);

    const rStats = this.regionStats.get(region) || { successes: 0, failures: 0 };
    rStats.successes++;
    this.regionStats.set(region, rStats);

    this.overallScore = Math.min(100, this.overallScore + 1);
  }

  public recordFailure(hub: string, region: string): void {
    const hStats = this.hubStats.get(hub) || { successes: 0, failures: 0 };
    hStats.failures++;
    this.hubStats.set(hub, hStats);

    const rStats = this.regionStats.get(region) || { successes: 0, failures: 0 };
    rStats.failures++;
    this.regionStats.set(region, rStats);

    this.overallScore = Math.max(0, this.overallScore - 2);
  }

  public getHubSuccessProbability(hub: string): number {
    const stats = this.hubStats.get(hub);
    if (!stats || (stats.successes + stats.failures) < 3) {
      return 0.75;
    }
    return stats.successes / (stats.successes + stats.failures);
  }

  public getRegionSuccessProbability(region: string): number {
    const stats = this.regionStats.get(region);
    if (!stats || (stats.successes + stats.failures) < 5) {
      return 0.8;
    }
    return stats.successes / (stats.successes + stats.failures);
  }

  public getOverallLearningScore(): number {
    return this.overallScore;
  }

  public clearMemory(): void {
    this.hubStats.clear();
    this.regionStats.clear();
    this.overallScore = 50;
  }

  public dispose(): void {
    this.hubStats.dispose();
    this.regionStats.dispose();
  }

  public getMemoryStats() {
    const mem = process.memoryUsage();
    return {
      heapUsedMb: Math.round(mem.heapUsed / 1024 / 1024),
      heapTotalMb: Math.round(mem.heapTotal / 1024 / 1024),
      hubCache: this.hubStats.getStats(),
      regionCache: this.regionStats.getStats()
    };
  }
}

export const rescueLearning = RescueLearningService.getInstance();
