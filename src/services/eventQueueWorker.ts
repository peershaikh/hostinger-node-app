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

import fs from 'fs';
import path from 'path';
import { isNoWriteMode, isSupabaseConfigured, safeAppendFileSync, safeMkdirSync, safeWriteFileSync, supabase } from '../config/supabase';
import { EVENT_SCHEMA_VERSION } from '../constants/eventTaxonomy';
import { winstonLogger } from '../middleware/logger';
import { createEventId } from '../utils/universalIds';
import { eventMetrics } from './eventMetrics';
import { sanitizeMetadata } from './eventValidator';
import { UniversalEventPayload } from './universalEventEmitter';

// ─── Configuration ───────────────────────────────────────────────────────────
const BATCH_SIZE        = 50;          // max events per Supabase insert
const FLUSH_INTERVAL_MS  = 2_000;      // flush every 2 s
const MAX_RETRIES        = 3;          // attempts before fallback write
const BACKOFF_BASE_MS    = 1_000;      // 1 s → 2 s → 4 s
const MAX_QUEUE_SIZE     = 5_000;      // bounded queue ceiling

const DATA_DIR = path.join(__dirname, '../../data');
const FALLBACK_FILE = path.join(DATA_DIR, 'universal_events_fallback.jsonl');

// ─── Row shape (matches universal_events table) ───────────────────────────────
export interface UniversalEventRow {
  event_id:         string;
  event_name:       string;
  schema_version:   number;
  request_id:       string | null;
  search_id:        string | null;
  option_id:        string | null;
  segment_id:       string | null;
  provider_call_id: string | null;
  guest_id:         string | null;
  user_id:          string | null;
  route:            string | null;
  source:           string | null;
  mode:             string | null;
  provider:         string | null;
  status:           string | null;
  latency_ms:       number | null;
  metadata:         Record<string, unknown>;
  created_at?:      string;
}

// ─── Internal queue ───────────────────────────────────────────────────────────
type PendingEntry = { row: UniversalEventRow; retries: number; createdAt: number };
const queue: PendingEntry[] = [];

// ─── Helpers ─────────────────────────────────────────────────────────────────
const sleep = (ms: number) => new Promise<void>(r => setTimeout(r, ms));

function ensureDataDir(): void {
  if (!isNoWriteMode() && !fs.existsSync(DATA_DIR)) {
    try {
      safeMkdirSync(DATA_DIR, { recursive: true });
    } catch {
      // ignore
    }
  }
}

function payloadToRow(payload: UniversalEventPayload): UniversalEventRow {
  return {
    event_id:         payload.eventId || createEventId(),
    event_name:       payload.eventName,
    schema_version:   payload.eventVersion || EVENT_SCHEMA_VERSION,
    request_id:       payload.requestId      || null,
    search_id:        payload.searchId       || null,
    option_id:        payload.optionId       || null,
    segment_id:       payload.segmentId      || null,
    provider_call_id: payload.providerCallId || null,
    guest_id:         payload.guestId        || null,
    user_id:          payload.userId         || null,
    route:            payload.route          || null,
    source:           payload.source         || null,
    mode:             payload.mode           || 'rail',
    provider:         payload.provider       || null,
    status:           payload.status         || null,
    latency_ms:       payload.latencyMs      ?? null,
    metadata:         sanitizeMetadata(payload.metadata || {})
  };
}

const QUARANTINE_DIR = path.join(DATA_DIR, 'quarantine');

function ensureQuarantineDir(): void {
  if (!isNoWriteMode() && !fs.existsSync(QUARANTINE_DIR)) {
    try {
      safeMkdirSync(QUARANTINE_DIR, { recursive: true });
    } catch {
      // ignore
    }
  }
}

/**
 * Quarantines malformed/corrupt records without losing them or halting replay
 */
export function quarantineRecord(filename: string, rawLine: string, reason: string): void {
  if (isNoWriteMode()) return;
  try {
    ensureQuarantineDir();
    const qFile = path.join(QUARANTINE_DIR, `${filename}.quarantine.jsonl`);
    const qPayload = {
      quarantined_at: new Date().toISOString(),
      reason,
      raw_line: rawLine
    };
    safeAppendFileSync(qFile, JSON.stringify(qPayload) + '\n', 'utf8');
    winstonLogger.warn(`[FALLBACK_REPLAY_QUARANTINE] file=${filename} reason="${reason}"`);
  } catch (err: any) {
    winstonLogger.error(`[QUARANTINE_WRITE_FAIL] ${err.message}`);
  }
}

/**
 * Persist dropped/failed events to local fallback JSONL file
 */
function saveFallbackEvents(entries: PendingEntry[]): void {
  if (entries.length === 0 || isNoWriteMode()) return;
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
    safeAppendFileSync(FALLBACK_FILE, lines, 'utf8');
    winstonLogger.info(`[FALLBACK_ENQUEUE] file=${path.basename(FALLBACK_FILE)} count=${entries.length}`);
  } catch (err: any) {
    winstonLogger.error(`[EVENT_FALLBACK_ERROR] Failed writing fallback events: ${err.message}`);
  }
}

// ─── Public API: enqueue ──────────────────────────────────────────────────────
export function enqueueEvent(payload: UniversalEventPayload): void {
  // Bounded queue protection: if queue full, shed oldest to fallback file
  if (queue.length >= MAX_QUEUE_SIZE) {
    const shed = queue.splice(0, BATCH_SIZE);
    saveFallbackEvents(shed);
    eventMetrics.incFailed(shed.length);
    winstonLogger.warn(`[EVENT_DROPPED] Queue full (${MAX_QUEUE_SIZE}); shed ${shed.length} events to fallback`);
  }

  const row = payloadToRow(payload);
  queue.push({ row, retries: 0, createdAt: Date.now() });
  winstonLogger.debug(`[EVENT_QUEUE] event_id=${row.event_id} event_name=${row.event_name} queue_depth=${queue.length}`);
}

export function queueDepth(): number {
  return queue.length;
}

// ─── Flush a batch to Supabase ────────────────────────────────────────────────
async function flushBatch(batch: PendingEntry[]): Promise<void> {
  if (batch.length === 0) return;

  if (!isSupabaseConfigured()) {
    // Database unconfigured: route directly to durable local fallback
    saveFallbackEvents(batch);
    eventMetrics.incFailed(batch.length);
    winstonLogger.debug(`[EVENT_QUEUE_SKIP] Supabase not configured; saved ${batch.length} events to fallback`);
    return;
  }

  const rows = batch.map(e => e.row);
  const startTime = Date.now();
  const { error } = await supabase.from('universal_events').insert(rows);
  const durationMs = Date.now() - startTime;

  if (!error) {
    eventMetrics.incWritten(rows.length);
    winstonLogger.info(`[EVENT_PERSISTED] count=${rows.length} duration_ms=${durationMs}`);
    return;
  }

  // Partial / total failure handling
  const toRetry: PendingEntry[] = [];
  const toFallback: PendingEntry[] = [];

  for (const entry of batch) {
    if (entry.retries < MAX_RETRIES) {
      toRetry.push({ row: entry.row, retries: entry.retries + 1, createdAt: entry.createdAt });
    } else {
      toFallback.push(entry);
    }
  }

  // Backoff before re-queuing retries
  if (toRetry.length > 0) {
    const backoffMs = BACKOFF_BASE_MS * Math.pow(2, toRetry[0].retries - 1);
    eventMetrics.incRetry();
    winstonLogger.warn(
      `[EVENT_RETRY] count=${toRetry.length} attempt=${toRetry[0].retries} backoffMs=${backoffMs} error="${error.message}"`
    );
    await sleep(backoffMs);
    // Re-enqueue at front so retries maintain causal order
    queue.unshift(...toRetry);
  }

  // Persist exhausted retries to durable fallback file
  if (toFallback.length > 0) {
    saveFallbackEvents(toFallback);
    eventMetrics.incFailed(toFallback.length);
    winstonLogger.error(
      `[EVENT_DROPPED] count=${toFallback.length} reason="${error.message}" — written to fallback`
    );
  }
}

// ─── Flush loop ───────────────────────────────────────────────────────────────
let flushTimer: ReturnType<typeof setTimeout> | null = null;
let running = false;

async function flush(): Promise<void> {
  if (queue.length === 0) return;

  const batch = queue.splice(0, BATCH_SIZE);
  try {
    await flushBatch(batch);
  } catch (err: any) {
    // Safety net: unexpected throws saved to fallback to prevent data loss
    winstonLogger.error(`[EVENT_QUEUE_EXCEPTION] ${err.message}`);
    saveFallbackEvents(batch);
    eventMetrics.incFailed(batch.length);
  }
}

function scheduleFlush(): void {
  if (flushTimer !== null) return;
  flushTimer = setTimeout(async () => {
    flushTimer = null;
    if (!running) return;
    await flush();
    scheduleFlush(); // perpetual loop
  }, FLUSH_INTERVAL_MS);
}

// ─── Fallback Replay Synchronization (Hardened) ──────────────────────────────
let isReplaying = false;

export async function replayUniversalEventsFallback(): Promise<{ processed: number; success: number; failed: number; quarantined: number }> {
  if (isReplaying) {
    winstonLogger.warn('[FALLBACK_REPLAY_LOCKED] Replay already in progress. Skipping concurrent run.');
    return { processed: 0, success: 0, failed: 0, quarantined: 0 };
  }

  if (!isSupabaseConfigured() || !fs.existsSync(FALLBACK_FILE)) {
    return { processed: 0, success: 0, failed: 0, quarantined: 0 };
  }

  isReplaying = true;
  const startTime = Date.now();

  try {
    const content = fs.readFileSync(FALLBACK_FILE, 'utf8').trim();
    if (!content) return { processed: 0, success: 0, failed: 0, quarantined: 0 };

    const lines = content.split('\n').filter(Boolean);
    if (lines.length === 0) return { processed: 0, success: 0, failed: 0, quarantined: 0 };

    winstonLogger.info(`[FALLBACK_REPLAY_START] file=${path.basename(FALLBACK_FILE)} total_lines=${lines.length}`);

    const validRows: UniversalEventRow[] = [];
    const remainingLines: string[] = [];
    const seenEventIds = new Set<string>();
    let quarantinedCount = 0;

    for (const line of lines) {
      try {
        const item = JSON.parse(line);
        const row: UniversalEventRow = item.row || item;
        if (!row || typeof row !== 'object' || !row.event_id || !row.event_name) {
          quarantineRecord('universal_events', line, 'Malformed row missing event_id or event_name');
          quarantinedCount++;
          continue;
        }

        if (!seenEventIds.has(row.event_id)) {
          seenEventIds.add(row.event_id);
          validRows.push(row);
        }
      } catch (parseErr: any) {
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
          const { error } = await supabase.from('universal_events').insert(batch);
          if (!error) {
            batchSuccess = true;
            successCount += batch.length;
          } else if (error.code === '23505') {
            // Unique constraint conflict — already in DB, idempotent pass
            batchSuccess = true;
            successCount += batch.length;
          } else {
            if (attempt < MAX_RETRIES) {
              const backoffMs = BACKOFF_BASE_MS * Math.pow(2, attempt - 1);
              winstonLogger.warn(`[FALLBACK_REPLAY_RETRY] file=${path.basename(FALLBACK_FILE)} attempt=${attempt} backoff_ms=${backoffMs} error="${error.message}"`);
              await sleep(backoffMs);
            } else {
              winstonLogger.error(`[FALLBACK_REPLAY_FAIL] file=${path.basename(FALLBACK_FILE)} failed=${batch.length} error="${error.message}"`);
            }
          }
        } catch (exc: any) {
          if (attempt < MAX_RETRIES) {
            const backoffMs = BACKOFF_BASE_MS * Math.pow(2, attempt - 1);
            winstonLogger.warn(`[FALLBACK_REPLAY_RETRY] file=${path.basename(FALLBACK_FILE)} attempt=${attempt} backoff_ms=${backoffMs} error="${exc.message}"`);
            await sleep(backoffMs);
          } else {
            winstonLogger.error(`[FALLBACK_REPLAY_FAIL] file=${path.basename(FALLBACK_FILE)} failed=${batch.length} error="${exc.message}"`);
          }
        }
      }

      if (!batchSuccess) {
        // Re-queue failed batch items into remaining lines so they are preserved
        batch.forEach(r => remainingLines.push(JSON.stringify({ row: r })));
      }
    }

    // Atomic file update: rewrite with remaining lines or safely unlink
    if (!isNoWriteMode()) {
      if (remainingLines.length > 0) {
        safeWriteFileSync(FALLBACK_FILE, remainingLines.join('\n') + '\n', 'utf8');
        winstonLogger.info(`[FALLBACK_REPLAY_SUCCESS] file=${path.basename(FALLBACK_FILE)} recovered=${successCount} remaining=${remainingLines.length} duration_ms=${Date.now() - startTime}`);
      } else {
        try {
          fs.unlinkSync(FALLBACK_FILE);
        } catch {
          safeWriteFileSync(FALLBACK_FILE, '', 'utf8');
        }
        winstonLogger.info(`[FALLBACK_REPLAY_SUCCESS] file=${path.basename(FALLBACK_FILE)} recovered=${successCount} duration_ms=${Date.now() - startTime} — fallback cleared`);
      }
    }

    return {
      processed: lines.length,
      success: successCount,
      failed: remainingLines.length,
      quarantined: quarantinedCount
    };
  } catch (err: any) {
    winstonLogger.error(`[FALLBACK_REPLAY_FAIL] Replay crashed: ${err.message}`);
    return { processed: 0, success: 0, failed: 0, quarantined: 0 };
  } finally {
    isReplaying = false;
  }
}

// ─── Lifecycle ────────────────────────────────────────────────────────────────
export function startEventQueueWorker(): void {
  if (running) return;
  running = true;
  eventMetrics.registerQueueDepthProvider(queueDepth);
  scheduleFlush();
  winstonLogger.info(
    `[EVENT_QUEUE_WORKER] Started — batchSize=${BATCH_SIZE} flushMs=${FLUSH_INTERVAL_MS} maxRetries=${MAX_RETRIES} maxQueue=${MAX_QUEUE_SIZE}`
  );
}

export async function stopEventQueueWorker(): Promise<void> {
  running = false;
  if (flushTimer !== null) {
    clearTimeout(flushTimer);
    flushTimer = null;
  }
  // Graceful shutdown: flush any pending entries in queue or save to fallback
  if (queue.length > 0) {
    winstonLogger.info(`[EVENT_QUEUE_WORKER] Flushing ${queue.length} remaining events on shutdown`);
    const remaining = queue.splice(0, queue.length);
    try {
      if (isSupabaseConfigured()) {
        const rows = remaining.map(e => e.row);
        const { error } = await supabase.from('universal_events').insert(rows);
        if (error) {
          saveFallbackEvents(remaining);
        }
      } else {
        saveFallbackEvents(remaining);
      }
    } catch {
      saveFallbackEvents(remaining);
    }
  }
  winstonLogger.info(`[EVENT_QUEUE_WORKER] Stopped`);
}


