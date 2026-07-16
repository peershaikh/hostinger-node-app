"use strict";
/**
 * PHASE_4C823 — Universal Event Pipeline Metrics
 *
 * Simple in-process counters. No external dependencies.
 * Exposed via /api/health when featureFlags.eventStream is enabled.
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.eventMetrics = void 0;
class EventMetricsCollector {
    constructor() {
        this._received = 0;
        this._written = 0;
        this._failed = 0;
        this._retries = 0;
        // queue_depth is provided by the queue worker at read-time
        this._queueDepthProvider = null;
    }
    registerQueueDepthProvider(fn) {
        this._queueDepthProvider = fn;
    }
    incReceived() { this._received++; }
    incWritten(n = 1) { this._written += n; }
    incFailed(n = 1) { this._failed += n; }
    incRetry() { this._retries++; }
    snapshot() {
        return {
            events_received: this._received,
            events_written: this._written,
            events_failed: this._failed,
            queue_depth: this._queueDepthProvider ? this._queueDepthProvider() : 0,
            retry_count: this._retries
        };
    }
}
exports.eventMetrics = new EventMetricsCollector();
