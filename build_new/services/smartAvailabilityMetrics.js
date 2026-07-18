"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.smartAvailabilityMetrics = void 0;
/**
 * PHASE_4C870 — Smart availability cache metrics (in-process).
 */
const featureFlags_1 = require("../config/featureFlags");
const lifetime = {
    l1_hits: 0,
    l2_hits: 0,
    provider_calls: 0,
    singleflight_hits: 0,
    redis_failures: 0,
    cache_latency_total_ms: 0,
    cache_latency_samples: 0,
};
function emit(metric, payload) {
    try {
        const { winstonLogger } = require('../middleware/logger');
        winstonLogger.info(`[SMART_AVAIL_METRICS] ${metric} ${JSON.stringify(payload)}`);
    }
    catch {
        // test / minimal environments
    }
    if (featureFlags_1.featureFlags.knowledgeMetrics) {
        try {
            const { knowledgeMetricsService } = require('./knowledgeMetricsService');
            if (metric === 'l1_hit')
                knowledgeMetricsService.recordCacheHit('canonical');
            if (metric === 'l2_hit')
                knowledgeMetricsService.recordCacheHit('canonical');
            if (metric === 'cache_miss')
                knowledgeMetricsService.recordCacheMiss();
            if (metric === 'provider_call')
                knowledgeMetricsService.recordAvailabilityProviderCall();
        }
        catch {
            // ignore
        }
    }
}
exports.smartAvailabilityMetrics = {
    recordL1Hit() {
        lifetime.l1_hits++;
        emit('l1_hit', { l1_hits: lifetime.l1_hits });
    },
    recordL2Hit() {
        lifetime.l2_hits++;
        emit('l2_hit', { l2_hits: lifetime.l2_hits });
    },
    recordProviderCall() {
        lifetime.provider_calls++;
        emit('provider_call', { provider_calls: lifetime.provider_calls });
    },
    recordSingleflightHit() {
        lifetime.singleflight_hits++;
        emit('singleflight_hit', { singleflight_hits: lifetime.singleflight_hits });
    },
    recordRedisFailure() {
        lifetime.redis_failures++;
        emit('redis_failure', { redis_failures: lifetime.redis_failures });
    },
    recordCacheLatency(latencyMs) {
        lifetime.cache_latency_total_ms += latencyMs;
        lifetime.cache_latency_samples++;
        emit('cache_latency', {
            cache_latency_ms: latencyMs,
            cache_latency_avg_ms: Math.round(lifetime.cache_latency_total_ms / lifetime.cache_latency_samples),
        });
    },
    recordCacheMiss() {
        emit('cache_miss', {});
    },
    getSnapshot() {
        return {
            l1_hits: lifetime.l1_hits,
            l2_hits: lifetime.l2_hits,
            provider_calls: lifetime.provider_calls,
            singleflight_hits: lifetime.singleflight_hits,
            redis_failures: lifetime.redis_failures,
            cache_latency_avg_ms: lifetime.cache_latency_samples > 0
                ? Math.round(lifetime.cache_latency_total_ms / lifetime.cache_latency_samples)
                : 0,
        };
    },
    /** Test-only reset */
    _resetForTests() {
        lifetime.l1_hits = 0;
        lifetime.l2_hits = 0;
        lifetime.provider_calls = 0;
        lifetime.singleflight_hits = 0;
        lifetime.redis_failures = 0;
        lifetime.cache_latency_total_ms = 0;
        lifetime.cache_latency_samples = 0;
    },
};
