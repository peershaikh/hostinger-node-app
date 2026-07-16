"use strict";
/**
 * PHASE_4C828 / PHASE_4C830 — Pan India Rescue Intelligence Layer
 * Rescue Learning Model (Hardened)
 *
 * Implements an in-memory learning loop to track the success/failure
 * of rescue recommendations. Uses LRU caches with TTL to prevent OOMs.
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.rescueLearning = exports.RescueLearningService = void 0;
const lruTtlCache_1 = require("./lruTtlCache");
class RescueLearningService {
    constructor() {
        // Hardened caches: Max 10k hubs, 100 regions. 1 Hour TTL.
        this.hubStats = new lruTtlCache_1.LruTtlCache(10000, 3600000);
        this.regionStats = new lruTtlCache_1.LruTtlCache(100, 3600000);
        this.overallScore = 50; // Base baseline score 0-100
    }
    static getInstance() {
        if (!RescueLearningService.instance) {
            RescueLearningService.instance = new RescueLearningService();
        }
        return RescueLearningService.instance;
    }
    recordSuccess(hub, region) {
        const hStats = this.hubStats.get(hub) || { successes: 0, failures: 0 };
        hStats.successes++;
        this.hubStats.set(hub, hStats);
        const rStats = this.regionStats.get(region) || { successes: 0, failures: 0 };
        rStats.successes++;
        this.regionStats.set(region, rStats);
        this.overallScore = Math.min(100, this.overallScore + 1);
    }
    recordFailure(hub, region) {
        const hStats = this.hubStats.get(hub) || { successes: 0, failures: 0 };
        hStats.failures++;
        this.hubStats.set(hub, hStats);
        const rStats = this.regionStats.get(region) || { successes: 0, failures: 0 };
        rStats.failures++;
        this.regionStats.set(region, rStats);
        this.overallScore = Math.max(0, this.overallScore - 2);
    }
    getHubSuccessProbability(hub) {
        const stats = this.hubStats.get(hub);
        if (!stats || (stats.successes + stats.failures) < 3) {
            return 0.75;
        }
        return stats.successes / (stats.successes + stats.failures);
    }
    getRegionSuccessProbability(region) {
        const stats = this.regionStats.get(region);
        if (!stats || (stats.successes + stats.failures) < 5) {
            return 0.8;
        }
        return stats.successes / (stats.successes + stats.failures);
    }
    getOverallLearningScore() {
        return this.overallScore;
    }
    clearMemory() {
        this.hubStats.clear();
        this.regionStats.clear();
        this.overallScore = 50;
    }
    dispose() {
        this.hubStats.dispose();
        this.regionStats.dispose();
    }
    getMemoryStats() {
        const mem = process.memoryUsage();
        return {
            heapUsedMb: Math.round(mem.heapUsed / 1024 / 1024),
            heapTotalMb: Math.round(mem.heapTotal / 1024 / 1024),
            hubCache: this.hubStats.getStats(),
            regionCache: this.regionStats.getStats()
        };
    }
}
exports.RescueLearningService = RescueLearningService;
exports.rescueLearning = RescueLearningService.getInstance();
