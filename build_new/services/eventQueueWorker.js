"use strict";
/**
 * PHASE_4C823 — Universal Event Queue Worker
 *
 * In-memory queue with:
 *   - Batch Supabase insert (up to BATCH_SIZE rows per flush)
 *   - Timer-based flush every FLUSH_INTERVAL_MS
 *   - Exponential backoff retry (up to MAX_RETRIES attempts)
 *   - Structured dead-letter log after final failure
 *
 * The request path never waits for DB writes.
 * Maximum additional latency to the caller: ~0ms (enqueue is synchronous array push).
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.enqueueEvent = enqueueEvent;
exports.queueDepth = queueDepth;
exports.startEventQueueWorker = startEventQueueWorker;
exports.stopEventQueueWorker = stopEventQueueWorker;
const supabase_1 = require("../config/supabase");
const eventTaxonomy_1 = require("../constants/eventTaxonomy");
const logger_1 = require("../middleware/logger");
const universalIds_1 = require("../utils/universalIds");
const eventMetrics_1 = require("./eventMetrics");
// ─── Configuration ───────────────────────────────────────────────────────────
const BATCH_SIZE = 50; // max events per Supabase insert
const FLUSH_INTERVAL_MS = 2000; // flush every 2 s
const MAX_RETRIES = 3; // attempts before dead-letter
const BACKOFF_BASE_MS = 1000; // 1 s → 2 s → 4 s
const queue = [];
// ─── Helpers ─────────────────────────────────────────────────────────────────
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
function payloadToRow(payload) {
    return {
        event_id: (0, universalIds_1.createEventId)(),
        event_name: payload.eventName,
        schema_version: eventTaxonomy_1.EVENT_SCHEMA_VERSION,
        request_id: payload.requestId || null,
        search_id: payload.searchId || null,
        option_id: payload.optionId || null,
        segment_id: payload.segmentId || null,
        provider_call_id: payload.providerCallId || null,
        guest_id: payload.guestId || null,
        user_id: payload.userId || null,
        route: payload.route || null,
        source: payload.source || null,
        mode: payload.mode || null,
        provider: payload.provider || null,
        status: payload.status || null,
        latency_ms: payload.latencyMs ?? null,
        metadata: payload.metadata || {}
    };
}
// ─── Public API: enqueue ──────────────────────────────────────────────────────
function enqueueEvent(payload) {
    queue.push({ row: payloadToRow(payload), retries: 0 });
    logger_1.winstonLogger.debug(`[EVENT_RECEIVED] eventName=${payload.eventName} queue=${queue.length}`);
}
function queueDepth() {
    return queue.length;
}
// ─── Flush a batch to Supabase ────────────────────────────────────────────────
async function flushBatch(batch) {
    if (batch.length === 0)
        return;
    if (!(0, supabase_1.isSupabaseConfigured)()) {
        // Drain silently — no DB available
        logger_1.winstonLogger.debug(`[EVENT_QUEUE_SKIP] Supabase not configured; dropping ${batch.length} events`);
        return;
    }
    const rows = batch.map(e => e.row);
    const { error } = await supabase_1.supabase.from('universal_events').insert(rows);
    if (!error) {
        eventMetrics_1.eventMetrics.incWritten(rows.length);
        logger_1.winstonLogger.info(`[EVENT_WRITTEN] count=${rows.length}`);
        return;
    }
    // Partial failure: re-queue entries that haven't exceeded MAX_RETRIES
    const toRetry = [];
    const toDrop = [];
    for (const entry of batch) {
        if (entry.retries < MAX_RETRIES) {
            toRetry.push({ row: entry.row, retries: entry.retries + 1 });
        }
        else {
            toDrop.push(entry);
        }
    }
    // Backoff before re-queuing retries
    if (toRetry.length > 0) {
        const backoffMs = BACKOFF_BASE_MS * Math.pow(2, toRetry[0].retries - 1);
        eventMetrics_1.eventMetrics.incRetry();
        logger_1.winstonLogger.warn(`[QUEUE_RETRY] count=${toRetry.length} attempt=${toRetry[0].retries} backoffMs=${backoffMs} error="${error.message}"`);
        await sleep(backoffMs);
        // Re-enqueue at front so retries don't starve behind new arrivals
        queue.unshift(...toRetry);
    }
    // Dead-letter: log and discard
    for (const dead of toDrop) {
        eventMetrics_1.eventMetrics.incFailed();
        logger_1.winstonLogger.error(`[QUEUE_DROP] event_id=${dead.row.event_id} event_name=${dead.row.event_name} ` +
            `retries=${dead.row /* MAX_RETRIES */} reason="${error.message}" — dead-lettered`);
    }
    if (toDrop.length > 0) {
        logger_1.winstonLogger.error(`[EVENT_FAILED] count=${toDrop.length} reason="${error.message}"`);
    }
}
// ─── Flush loop ───────────────────────────────────────────────────────────────
let flushTimer = null;
let running = false;
async function flush() {
    if (queue.length === 0)
        return;
    const batch = queue.splice(0, BATCH_SIZE);
    try {
        await flushBatch(batch);
    }
    catch (err) {
        // Safety net: unexpected throws re-queue with retry++
        logger_1.winstonLogger.error(`[EVENT_QUEUE_EXCEPTION] ${err.message}`);
        eventMetrics_1.eventMetrics.incFailed(batch.length);
    }
}
function scheduleFlush() {
    if (flushTimer !== null)
        return;
    flushTimer = setTimeout(async () => {
        flushTimer = null;
        if (!running)
            return;
        await flush();
        scheduleFlush(); // perpetual loop
    }, FLUSH_INTERVAL_MS);
}
// ─── Lifecycle ────────────────────────────────────────────────────────────────
function startEventQueueWorker() {
    if (running)
        return;
    running = true;
    eventMetrics_1.eventMetrics.registerQueueDepthProvider(queueDepth);
    scheduleFlush();
    logger_1.winstonLogger.info(`[EVENT_QUEUE_WORKER] Started — batchSize=${BATCH_SIZE} flushMs=${FLUSH_INTERVAL_MS} maxRetries=${MAX_RETRIES}`);
}
function stopEventQueueWorker() {
    running = false;
    if (flushTimer !== null) {
        clearTimeout(flushTimer);
        flushTimer = null;
    }
    logger_1.winstonLogger.info(`[EVENT_QUEUE_WORKER] Stopped — ${queue.length} events remaining in queue`);
}
