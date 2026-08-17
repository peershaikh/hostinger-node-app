/**
 * PHASE_4C822 / PHASE_4C823 / PHASE_AI_EVENT_FOUNDATION_024 — Universal Event Emitter
 *
 * Public API for emitting instrumentation events.
 * Zero synchronous cost to callers — validation runs inline (<1 μs),
 * then the event is pushed into the in-memory queue.
 *
 * The queue worker (eventQueueWorker) handles batching, retry, and
 * dead-letter logging asynchronously, completely off the request path.
 *
 * Schema version: v1 (EVENT_SCHEMA_VERSION)
 */

import { UniversalEventName } from '../constants/eventTaxonomy';
import { winstonLogger } from '../middleware/logger';
import { eventMetrics } from './eventMetrics';
import { enqueueEvent } from './eventQueueWorker';
import { rejectEvent, validateEventPayload } from './eventValidator';

export interface UniversalEventPayload {
  eventId?: string;
  eventName: UniversalEventName;
  eventVersion?: number;
  requestId?: string;
  searchId?: string;
  optionId?: string;
  segmentId?: string;
  providerCallId?: string;
  guestId?: string;
  userId?: string | null;
  route?: string;
  source?: string;
  mode?: string;
  provider?: string;
  status?: string;
  latencyMs?: number;
  metadata?: Record<string, any>;
}

class UniversalEventEmitter {
  /**
   * Emit an event.
   *
   * Runs validation synchronously (O(1)), then pushes onto the in-memory queue.
   * The caller returns before any DB I/O occurs.
   * If the event is invalid it is dropped with a structured WARN log.
   * If the DB is unavailable later, the queue worker dead-letters / stores to fallback.
   */
  emit(payload: UniversalEventPayload): void {
    eventMetrics.incReceived();

    const validation = validateEventPayload(payload);
    if (!validation.valid) {
      rejectEvent(payload, validation.reason!);
      return;
    }

    // Enqueue is a synchronous array push — adds <1 μs to the request path
    enqueueEvent(payload);

    // Non-blocking forward to userFeedbackIntelligenceService for implicit signal derivation
    try {
      const { userFeedbackIntelligenceService } = require('./userFeedbackIntelligenceService');
      userFeedbackIntelligenceService.ingestImplicitSignal({
        eventName: payload.eventName,
        eventId: payload.eventId,
        userId: payload.userId,
        guestId: payload.guestId,
        route: payload.route,
        metadata: payload.metadata
      });
    } catch {
      // Non-blocking
    }

    winstonLogger.debug(
      `[EVENT_EMIT] event_name=${payload.eventName} mode=${payload.mode ?? 'rail'} guest=${payload.guestId ?? 'none'} user=${payload.userId ?? 'anon'}`
    );
  }
}

export const universalEventEmitter = new UniversalEventEmitter();

