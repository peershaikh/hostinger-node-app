"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.knowledgeMetricsService = void 0;
/**
 * PHASE_4C868 — Phase 0 observability counters (in-process, no Redis).
 * Emits structured logs when KNOWLEDGE_METRICS=true.
 */
const featureFlags_1 = require("../config/featureFlags");
let activeSearchContext = null;
const lifetime = {
    cacheHits: 0,
    cacheMisses: 0,
    availabilityProviderCalls: 0,
    findSegmentSplitsCalls: 0,
    duplicateSplitPrevented: 0,
    searchLatencySamples: 0,
    searchLatencyTotalMs: 0,
    rescueLatencySamples: 0,
    rescueLatencyTotalMs: 0,
    shadowCompareSamples: 0,
    shadowCompareMatches: 0,
    catalogHit: 0,
    catalogMiss: 0,
    hydrationSuccess: 0,
    hydrationFailure: 0,
    catalogRuntimeMatch: 0,
    catalogRuntimeMismatch: 0,
    catalogRuntimeDiffCount: 0,
    hydrationLatencySamples: 0,
    hydrationLatencyTotalMs: 0,
};
function emit(metric, payload) {
    if (!featureFlags_1.featureFlags.knowledgeMetrics)
        return;
    try {
        const { winstonLogger } = require('../middleware/logger');
        winstonLogger.info(`[KNOWLEDGE_METRICS] ${metric} ${JSON.stringify(payload)}`);
    }
    catch {
        // test / minimal environments
    }
}
exports.knowledgeMetricsService = {
    beginSearchContext(source, destination) {
        activeSearchContext = {
            route: `${source.toUpperCase().trim()}→${destination.toUpperCase().trim()}`,
            availCalls: 0,
            findSegmentSplitsCalls: 0,
            duplicateSplitPrevented: 0,
            startedAt: Date.now(),
        };
    },
    endSearchContext() {
        if (!activeSearchContext)
            return;
        const latencyMs = Date.now() - activeSearchContext.startedAt;
        lifetime.searchLatencySamples++;
        lifetime.searchLatencyTotalMs += latencyMs;
        emit('search_complete', {
            route: activeSearchContext.route,
            availability_calls_per_search: activeSearchContext.availCalls,
            find_segment_splits_calls: activeSearchContext.findSegmentSplitsCalls,
            duplicate_split_calls_prevented: activeSearchContext.duplicateSplitPrevented,
            search_latency_ms: latencyMs,
        });
        activeSearchContext = null;
    },
    recordAvailabilityProviderCall() {
        lifetime.availabilityProviderCalls++;
        if (activeSearchContext)
            activeSearchContext.availCalls++;
        emit('availability_provider_call', { total: lifetime.availabilityProviderCalls });
    },
    recordFindSegmentSplitsInvocation() {
        lifetime.findSegmentSplitsCalls++;
        if (activeSearchContext)
            activeSearchContext.findSegmentSplitsCalls++;
        emit('find_segment_splits', { total: lifetime.findSegmentSplitsCalls });
    },
    recordDuplicateSplitPrevented() {
        lifetime.duplicateSplitPrevented++;
        if (activeSearchContext)
            activeSearchContext.duplicateSplitPrevented++;
        emit('duplicate_split_prevented', { total: lifetime.duplicateSplitPrevented });
    },
    recordCacheHit(layer) {
        lifetime.cacheHits++;
        emit('cache_hit', { layer, total: lifetime.cacheHits });
    },
    recordCacheMiss() {
        lifetime.cacheMisses++;
        emit('cache_miss', { total: lifetime.cacheMisses });
    },
    recordSearchLatency(latencyMs, route) {
        lifetime.searchLatencySamples++;
        lifetime.searchLatencyTotalMs += latencyMs;
        emit('search_latency', { route, search_latency_ms: latencyMs });
    },
    recordRescueLatency(latencyMs, trainNo) {
        lifetime.rescueLatencySamples++;
        lifetime.rescueLatencyTotalMs += latencyMs;
        emit('rescue_latency', { trainNo, rescue_latency_ms: latencyMs });
    },
    recordShadowCompare(match, matchRate) {
        lifetime.shadowCompareSamples++;
        if (match)
            lifetime.shadowCompareMatches++;
        emit('knowledge_hub_shadow', {
            match,
            match_rate: matchRate,
            samples: lifetime.shadowCompareSamples,
            matches: lifetime.shadowCompareMatches,
        });
    },
    /** PHASE_4C877 — B1 dual-read telemetry counters (in-process; logs when KNOWLEDGE_METRICS=true). */
    recordB1DualRead(payload) {
        if (payload.catalog_hit)
            lifetime.catalogHit++;
        if (payload.catalog_miss)
            lifetime.catalogMiss++;
        if (payload.hydration_success)
            lifetime.hydrationSuccess++;
        if (payload.hydration_failure)
            lifetime.hydrationFailure++;
        if (payload.catalog_runtime_match) {
            lifetime.catalogRuntimeMatch++;
        }
        else {
            lifetime.catalogRuntimeMismatch++;
        }
        lifetime.catalogRuntimeDiffCount +=
            payload.catalog_runtime_diff.runtime_only.length +
                payload.catalog_runtime_diff.catalog_only.length;
        if (payload.hydration_latency_ms >= 0) {
            lifetime.hydrationLatencySamples++;
            lifetime.hydrationLatencyTotalMs += payload.hydration_latency_ms;
        }
        emit('catalog_hit', { total: lifetime.catalogHit, hit: payload.catalog_hit });
        emit('catalog_miss', { total: lifetime.catalogMiss, miss: payload.catalog_miss });
        emit('hydration_success', { total: lifetime.hydrationSuccess, success: payload.hydration_success });
        emit('hydration_failure', { total: lifetime.hydrationFailure, failure: payload.hydration_failure });
        emit('catalog_runtime_match', {
            total_matches: lifetime.catalogRuntimeMatch,
            total_mismatches: lifetime.catalogRuntimeMismatch,
            match: payload.catalog_runtime_match,
        });
        emit('catalog_runtime_diff', {
            total_diff_hubs: lifetime.catalogRuntimeDiffCount,
            runtime_only: payload.catalog_runtime_diff.runtime_only,
            catalog_only: payload.catalog_runtime_diff.catalog_only,
            train_no: payload.train_no,
            source: payload.source,
            destination: payload.destination,
            runtime_hubs: payload.runtime_hubs,
            catalog_hubs: payload.catalog_hubs,
        });
        emit('hydration_latency_ms', {
            hydration_latency_ms: payload.hydration_latency_ms,
            samples: lifetime.hydrationLatencySamples,
            avg_ms: lifetime.hydrationLatencySamples > 0
                ? Math.round(lifetime.hydrationLatencyTotalMs / lifetime.hydrationLatencySamples)
                : 0,
            train_no: payload.train_no,
        });
    },
    getSnapshot() {
        return {
            cache_hits: lifetime.cacheHits,
            cache_misses: lifetime.cacheMisses,
            availability_provider_calls: lifetime.availabilityProviderCalls,
            find_segment_splits_calls: lifetime.findSegmentSplitsCalls,
            duplicate_split_prevented: lifetime.duplicateSplitPrevented,
            search_latency_avg_ms: lifetime.searchLatencySamples > 0
                ? Math.round(lifetime.searchLatencyTotalMs / lifetime.searchLatencySamples)
                : 0,
            rescue_latency_avg_ms: lifetime.rescueLatencySamples > 0
                ? Math.round(lifetime.rescueLatencyTotalMs / lifetime.rescueLatencySamples)
                : 0,
            shadow_compare_samples: lifetime.shadowCompareSamples,
            shadow_compare_matches: lifetime.shadowCompareMatches,
            catalog_hit: lifetime.catalogHit,
            catalog_miss: lifetime.catalogMiss,
            hydration_success: lifetime.hydrationSuccess,
            hydration_failure: lifetime.hydrationFailure,
            catalog_runtime_match: lifetime.catalogRuntimeMatch,
            catalog_runtime_mismatch: lifetime.catalogRuntimeMismatch,
            catalog_runtime_diff_count: lifetime.catalogRuntimeDiffCount,
            hydration_latency_samples: lifetime.hydrationLatencySamples,
            hydration_latency_avg_ms: lifetime.hydrationLatencySamples > 0
                ? Math.round(lifetime.hydrationLatencyTotalMs / lifetime.hydrationLatencySamples)
                : 0,
        };
    },
    /** Test-only reset */
    _resetForTests() {
        activeSearchContext = null;
        lifetime.cacheHits = 0;
        lifetime.cacheMisses = 0;
        lifetime.availabilityProviderCalls = 0;
        lifetime.findSegmentSplitsCalls = 0;
        lifetime.duplicateSplitPrevented = 0;
        lifetime.searchLatencySamples = 0;
        lifetime.searchLatencyTotalMs = 0;
        lifetime.rescueLatencySamples = 0;
        lifetime.rescueLatencyTotalMs = 0;
        lifetime.shadowCompareSamples = 0;
        lifetime.shadowCompareMatches = 0;
        lifetime.catalogHit = 0;
        lifetime.catalogMiss = 0;
        lifetime.hydrationSuccess = 0;
        lifetime.hydrationFailure = 0;
        lifetime.catalogRuntimeMatch = 0;
        lifetime.catalogRuntimeMismatch = 0;
        lifetime.catalogRuntimeDiffCount = 0;
        lifetime.hydrationLatencySamples = 0;
        lifetime.hydrationLatencyTotalMs = 0;
    },
};
