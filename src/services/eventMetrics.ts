/**
 * PHASE_4C823 — Universal Event Pipeline Metrics
 *
 * Simple in-process counters. No external dependencies.
 * Exposed via /api/health when featureFlags.eventStream is enabled.
 */

export interface EventPipelineMetrics {
  events_received: number;
  events_written: number;
  events_failed: number;
  queue_depth: number;
  retry_count: number;
}

class EventMetricsCollector {
  private _received = 0;
  private _written  = 0;
  private _failed   = 0;
  private _retries  = 0;

  // queue_depth is provided by the queue worker at read-time
  private _queueDepthProvider: (() => number) | null = null;

  registerQueueDepthProvider(fn: () => number): void {
    this._queueDepthProvider = fn;
  }

  incReceived(): void { this._received++; }
  incWritten(n = 1): void { this._written += n; }
  incFailed(n = 1): void  { this._failed  += n; }
  incRetry(): void         { this._retries++; }

  snapshot(): EventPipelineMetrics {
    return {
      events_received: this._received,
      events_written:  this._written,
      events_failed:   this._failed,
      queue_depth:     this._queueDepthProvider ? this._queueDepthProvider() : 0,
      retry_count:     this._retries
    };
  }
}

export const eventMetrics = new EventMetricsCollector();
