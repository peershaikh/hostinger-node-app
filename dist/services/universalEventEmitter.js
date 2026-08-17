"use strict";
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
Object.defineProperty(exports, "__esModule", { value: true });
exports.universalEventEmitter = void 0;
const logger_1 = require("../middleware/logger");
const eventMetrics_1 = require("./eventMetrics");
const eventQueueWorker_1 = require("./eventQueueWorker");
const eventValidator_1 = require("./eventValidator");
class UniversalEventEmitter {
    /**
     * Emit an event.
     *
     * Runs validation synchronously (O(1)), then pushes onto the in-memory queue.
     * The caller returns before any DB I/O occurs.
     * If the event is invalid it is dropped with a structured WARN log.
     * If the DB is unavailable later, the queue worker dead-letters / stores to fallback.
     */
    emit(payload) {
        eventMetrics_1.eventMetrics.incReceived();
        const validation = (0, eventValidator_1.validateEventPayload)(payload);
        if (!validation.valid) {
            (0, eventValidator_1.rejectEvent)(payload, validation.reason);
            return;
        }
        // Enqueue is a synchronous array push — adds <1 μs to the request path
        (0, eventQueueWorker_1.enqueueEvent)(payload);
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
        }
        catch {
            // Non-blocking
        }
        logger_1.winstonLogger.debug(`[EVENT_EMIT] event_name=${payload.eventName} mode=${payload.mode ?? 'rail'} guest=${payload.guestId ?? 'none'} user=${payload.userId ?? 'anon'}`);
    }
}
exports.universalEventEmitter = new UniversalEventEmitter();
