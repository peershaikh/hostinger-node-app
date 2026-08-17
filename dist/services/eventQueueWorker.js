"use strict";
/**
 * PHASE_4C823 / PHASE_AI_EVENT_FOUNDATION_024 — Universal Event Queue Worker
 *
 * In-memory queue with:
 *   - Batch Supabase insert (up to BATCH_SIZE rows per flush)
 *   - Timer-based flush every FLUSH_INTERVAL_MS
 *   - Bounded queue protection (max MAX_QUEUE_SIZE items)
 *   - Exponential backoff retry (up to MAX_RETRIES attempts)
 *   - Durable local JSONL fallback on failure/outage
 *   - Automatic deduplicated replay synchronization
 *   - Graceful shutdown queue flush
 *
 * The request path never waits for DB writes.
 * Maximum additional latency to the caller: ~0ms (enqueue is synchronous array push).
 */
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.quarantineRecord = quarantineRecord;
exports.enqueueEvent = enqueueEvent;
exports.queueDepth = queueDepth;
exports.replayUniversalEventsFallback = replayUniversalEventsFallback;
exports.startEventQueueWorker = startEventQueueWorker;
exports.stopEventQueueWorker = stopEventQueueWorker;
const fs_1 = __importDefault(require("fs"));
const path_1 = __importDefault(require("path"));
const supabase_1 = require("../config/supabase");
const eventTaxonomy_1 = require("../constants/eventTaxonomy");
const logger_1 = require("../middleware/logger");
const universalIds_1 = require("../utils/universalIds");
const eventMetrics_1 = require("./eventMetrics");
const eventValidator_1 = require("./eventValidator");
// ─── Configuration ───────────────────────────────────────────────────────────
const BATCH_SIZE = 50; // max events per Supabase insert
const FLUSH_INTERVAL_MS = 2000; // flush every 2 s
const MAX_RETRIES = 3; // attempts before fallback write
const BACKOFF_BASE_MS = 1000; // 1 s → 2 s → 4 s
const MAX_QUEUE_SIZE = 5000; // bounded queue ceiling
const DATA_DIR = path_1.default.join(__dirname, '../../data');
const FALLBACK_FILE = path_1.default.join(DATA_DIR, 'universal_events_fallback.jsonl');
const queue = [];
// ─── Helpers ─────────────────────────────────────────────────────────────────
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
function ensureDataDir() {
    if (!(0, supabase_1.isNoWriteMode)() && !fs_1.default.existsSync(DATA_DIR)) {
        try {
            (0, supabase_1.safeMkdirSync)(DATA_DIR, { recursive: true });
        }
        catch {
            // ignore
        }
    }
}
function payloadToRow(payload) {
    return {
        event_id: payload.eventId || (0, universalIds_1.createEventId)(),
        event_name: payload.eventName,
        schema_version: payload.eventVersion || eventTaxonomy_1.EVENT_SCHEMA_VERSION,
        request_id: payload.requestId || null,
        search_id: payload.searchId || null,
        option_id: payload.optionId || null,
        segment_id: payload.segmentId || null,
        provider_call_id: payload.providerCallId || null,
        guest_id: payload.guestId || null,
        user_id: payload.userId || null,
        route: payload.route || null,
        source: payload.source || null,
        mode: payload.mode || 'rail',
        provider: payload.provider || null,
        status: payload.status || null,
        latency_ms: payload.latencyMs ?? null,
        metadata: (0, eventValidator_1.sanitizeMetadata)(payload.metadata || {})
    };
}
const QUARANTINE_DIR = path_1.default.join(DATA_DIR, 'quarantine');
function ensureQuarantineDir() {
    if (!(0, supabase_1.isNoWriteMode)() && !fs_1.default.existsSync(QUARANTINE_DIR)) {
        try {
            (0, supabase_1.safeMkdirSync)(QUARANTINE_DIR, { recursive: true });
        }
        catch {
            // ignore
        }
    }
}
/**
 * Quarantines malformed/corrupt records without losing them or halting replay
 */
function quarantineRecord(filename, rawLine, reason) {
    if ((0, supabase_1.isNoWriteMode)())
        return;
    try {
        ensureQuarantineDir();
        const qFile = path_1.default.join(QUARANTINE_DIR, `${filename}.quarantine.jsonl`);
        const qPayload = {
            quarantined_at: new Date().toISOString(),
            reason,
            raw_line: rawLine
        };
        (0, supabase_1.safeAppendFileSync)(qFile, JSON.stringify(qPayload) + '\n', 'utf8');
        logger_1.winstonLogger.warn(`[FALLBACK_REPLAY_QUARANTINE] file=${filename} reason="${reason}"`);
    }
    catch (err) {
        logger_1.winstonLogger.error(`[QUARANTINE_WRITE_FAIL] ${err.message}`);
    }
}
/**
 * Persist dropped/failed events to local fallback JSONL file
 */
function saveFallbackEvents(entries) {
    if (entries.length === 0 || (0, supabase_1.isNoWriteMode)())
        return;
    try {
        ensureDataDir();
        let lines = '';
        const nowIso = new Date().toISOString();
        for (const entry of entries) {
            const linePayload = {
                event_id: entry.row.event_id,
                event_name: entry.row.event_name,
                schema_version: entry.row.schema_version,
                created_at: nowIso,
                row: entry.row
            };
            lines += JSON.stringify(linePayload) + '\n';
        }
        (0, supabase_1.safeAppendFileSync)(FALLBACK_FILE, lines, 'utf8');
        logger_1.winstonLogger.info(`[FALLBACK_ENQUEUE] file=${path_1.default.basename(FALLBACK_FILE)} count=${entries.length}`);
    }
    catch (err) {
        logger_1.winstonLogger.error(`[EVENT_FALLBACK_ERROR] Failed writing fallback events: ${err.message}`);
    }
}
// ─── Public API: enqueue ──────────────────────────────────────────────────────
function enqueueEvent(payload) {
    // Bounded queue protection: if queue full, shed oldest to fallback file
    if (queue.length >= MAX_QUEUE_SIZE) {
        const shed = queue.splice(0, BATCH_SIZE);
        saveFallbackEvents(shed);
        eventMetrics_1.eventMetrics.incFailed(shed.length);
        logger_1.winstonLogger.warn(`[EVENT_DROPPED] Queue full (${MAX_QUEUE_SIZE}); shed ${shed.length} events to fallback`);
    }
    const row = payloadToRow(payload);
    queue.push({ row, retries: 0, createdAt: Date.now() });
    logger_1.winstonLogger.debug(`[EVENT_QUEUE] event_id=${row.event_id} event_name=${row.event_name} queue_depth=${queue.length}`);
}
function queueDepth() {
    return queue.length;
}
// ─── Flush a batch to Supabase ────────────────────────────────────────────────
async function flushBatch(batch) {
    if (batch.length === 0)
        return;
    if (!(0, supabase_1.isSupabaseConfigured)()) {
        // Database unconfigured: route directly to durable local fallback
        saveFallbackEvents(batch);
        eventMetrics_1.eventMetrics.incFailed(batch.length);
        logger_1.winstonLogger.debug(`[EVENT_QUEUE_SKIP] Supabase not configured; saved ${batch.length} events to fallback`);
        return;
    }
    const rows = batch.map(e => e.row);
    const startTime = Date.now();
    const { error } = await supabase_1.supabase.from('universal_events').insert(rows);
    const durationMs = Date.now() - startTime;
    if (!error) {
        eventMetrics_1.eventMetrics.incWritten(rows.length);
        logger_1.winstonLogger.info(`[EVENT_PERSISTED] count=${rows.length} duration_ms=${durationMs}`);
        return;
    }
    // Partial / total failure handling
    const toRetry = [];
    const toFallback = [];
    for (const entry of batch) {
        if (entry.retries < MAX_RETRIES) {
            toRetry.push({ row: entry.row, retries: entry.retries + 1, createdAt: entry.createdAt });
        }
        else {
            toFallback.push(entry);
        }
    }
    // Backoff before re-queuing retries
    if (toRetry.length > 0) {
        const backoffMs = BACKOFF_BASE_MS * Math.pow(2, toRetry[0].retries - 1);
        eventMetrics_1.eventMetrics.incRetry();
        logger_1.winstonLogger.warn(`[EVENT_RETRY] count=${toRetry.length} attempt=${toRetry[0].retries} backoffMs=${backoffMs} error="${error.message}"`);
        await sleep(backoffMs);
        // Re-enqueue at front so retries maintain causal order
        queue.unshift(...toRetry);
    }
    // Persist exhausted retries to durable fallback file
    if (toFallback.length > 0) {
        saveFallbackEvents(toFallback);
        eventMetrics_1.eventMetrics.incFailed(toFallback.length);
        logger_1.winstonLogger.error(`[EVENT_DROPPED] count=${toFallback.length} reason="${error.message}" — written to fallback`);
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
        // Safety net: unexpected throws saved to fallback to prevent data loss
        logger_1.winstonLogger.error(`[EVENT_QUEUE_EXCEPTION] ${err.message}`);
        saveFallbackEvents(batch);
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
// ─── Fallback Replay Synchronization (Hardened) ──────────────────────────────
let isReplaying = false;
async function replayUniversalEventsFallback() {
    if (isReplaying) {
        logger_1.winstonLogger.warn('[FALLBACK_REPLAY_LOCKED] Replay already in progress. Skipping concurrent run.');
        return { processed: 0, success: 0, failed: 0, quarantined: 0 };
    }
    if (!(0, supabase_1.isSupabaseConfigured)() || !fs_1.default.existsSync(FALLBACK_FILE)) {
        return { processed: 0, success: 0, failed: 0, quarantined: 0 };
    }
    isReplaying = true;
    const startTime = Date.now();
    try {
        const content = fs_1.default.readFileSync(FALLBACK_FILE, 'utf8').trim();
        if (!content)
            return { processed: 0, success: 0, failed: 0, quarantined: 0 };
        const lines = content.split('\n').filter(Boolean);
        if (lines.length === 0)
            return { processed: 0, success: 0, failed: 0, quarantined: 0 };
        logger_1.winstonLogger.info(`[FALLBACK_REPLAY_START] file=${path_1.default.basename(FALLBACK_FILE)} total_lines=${lines.length}`);
        const validRows = [];
        const remainingLines = [];
        const seenEventIds = new Set();
        let quarantinedCount = 0;
        for (const line of lines) {
            try {
                const item = JSON.parse(line);
                const row = item.row || item;
                if (!row || typeof row !== 'object' || !row.event_id || !row.event_name) {
                    quarantineRecord('universal_events', line, 'Malformed row missing event_id or event_name');
                    quarantinedCount++;
                    continue;
                }
                if (!seenEventIds.has(row.event_id)) {
                    seenEventIds.add(row.event_id);
                    validRows.push(row);
                }
            }
            catch (parseErr) {
                quarantineRecord('universal_events', line, `JSON parse error: ${parseErr.message}`);
                quarantinedCount++;
            }
        }
        let successCount = 0;
        // Batch upload valid rows (FIFO order, bounded batch size)
        for (let i = 0; i < validRows.length; i += BATCH_SIZE) {
            const batch = validRows.slice(i, i + BATCH_SIZE);
            let batchSuccess = false;
            let attempt = 0;
            while (attempt < MAX_RETRIES && !batchSuccess) {
                attempt++;
                try {
                    const { error } = await supabase_1.supabase.from('universal_events').insert(batch);
                    if (!error) {
                        batchSuccess = true;
                        successCount += batch.length;
                    }
                    else if (error.code === '23505') {
                        // Unique constraint conflict — already in DB, idempotent pass
                        batchSuccess = true;
                        successCount += batch.length;
                    }
                    else {
                        if (attempt < MAX_RETRIES) {
                            const backoffMs = BACKOFF_BASE_MS * Math.pow(2, attempt - 1);
                            logger_1.winstonLogger.warn(`[FALLBACK_REPLAY_RETRY] file=${path_1.default.basename(FALLBACK_FILE)} attempt=${attempt} backoff_ms=${backoffMs} error="${error.message}"`);
                            await sleep(backoffMs);
                        }
                        else {
                            logger_1.winstonLogger.error(`[FALLBACK_REPLAY_FAIL] file=${path_1.default.basename(FALLBACK_FILE)} failed=${batch.length} error="${error.message}"`);
                        }
                    }
                }
                catch (exc) {
                    if (attempt < MAX_RETRIES) {
                        const backoffMs = BACKOFF_BASE_MS * Math.pow(2, attempt - 1);
                        logger_1.winstonLogger.warn(`[FALLBACK_REPLAY_RETRY] file=${path_1.default.basename(FALLBACK_FILE)} attempt=${attempt} backoff_ms=${backoffMs} error="${exc.message}"`);
                        await sleep(backoffMs);
                    }
                    else {
                        logger_1.winstonLogger.error(`[FALLBACK_REPLAY_FAIL] file=${path_1.default.basename(FALLBACK_FILE)} failed=${batch.length} error="${exc.message}"`);
                    }
                }
            }
            if (!batchSuccess) {
                // Re-queue failed batch items into remaining lines so they are preserved
                batch.forEach(r => remainingLines.push(JSON.stringify({ row: r })));
            }
        }
        // Atomic file update: rewrite with remaining lines or safely unlink
        if (!(0, supabase_1.isNoWriteMode)()) {
            if (remainingLines.length > 0) {
                (0, supabase_1.safeWriteFileSync)(FALLBACK_FILE, remainingLines.join('\n') + '\n', 'utf8');
                logger_1.winstonLogger.info(`[FALLBACK_REPLAY_SUCCESS] file=${path_1.default.basename(FALLBACK_FILE)} recovered=${successCount} remaining=${remainingLines.length} duration_ms=${Date.now() - startTime}`);
            }
            else {
                try {
                    fs_1.default.unlinkSync(FALLBACK_FILE);
                }
                catch {
                    (0, supabase_1.safeWriteFileSync)(FALLBACK_FILE, '', 'utf8');
                }
                logger_1.winstonLogger.info(`[FALLBACK_REPLAY_SUCCESS] file=${path_1.default.basename(FALLBACK_FILE)} recovered=${successCount} duration_ms=${Date.now() - startTime} — fallback cleared`);
            }
        }
        return {
            processed: lines.length,
            success: successCount,
            failed: remainingLines.length,
            quarantined: quarantinedCount
        };
    }
    catch (err) {
        logger_1.winstonLogger.error(`[FALLBACK_REPLAY_FAIL] Replay crashed: ${err.message}`);
        return { processed: 0, success: 0, failed: 0, quarantined: 0 };
    }
    finally {
        isReplaying = false;
    }
}
// ─── Lifecycle ────────────────────────────────────────────────────────────────
function startEventQueueWorker() {
    if (running)
        return;
    running = true;
    eventMetrics_1.eventMetrics.registerQueueDepthProvider(queueDepth);
    scheduleFlush();
    logger_1.winstonLogger.info(`[EVENT_QUEUE_WORKER] Started — batchSize=${BATCH_SIZE} flushMs=${FLUSH_INTERVAL_MS} maxRetries=${MAX_RETRIES} maxQueue=${MAX_QUEUE_SIZE}`);
}
async function stopEventQueueWorker() {
    running = false;
    if (flushTimer !== null) {
        clearTimeout(flushTimer);
        flushTimer = null;
    }
    // Graceful shutdown: flush any pending entries in queue or save to fallback
    if (queue.length > 0) {
        logger_1.winstonLogger.info(`[EVENT_QUEUE_WORKER] Flushing ${queue.length} remaining events on shutdown`);
        const remaining = queue.splice(0, queue.length);
        try {
            if ((0, supabase_1.isSupabaseConfigured)()) {
                const rows = remaining.map(e => e.row);
                const { error } = await supabase_1.supabase.from('universal_events').insert(rows);
                if (error) {
                    saveFallbackEvents(remaining);
                }
            }
            else {
                saveFallbackEvents(remaining);
            }
        }
        catch {
            saveFallbackEvents(remaining);
        }
    }
    logger_1.winstonLogger.info(`[EVENT_QUEUE_WORKER] Stopped`);
}
