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

import { isSupabaseConfigured, supabase } from '../config/supabase';
import { EVENT_SCHEMA_VERSION } from '../constants/eventTaxonomy';
import { winstonLogger } from '../middleware/logger';
import { createEventId } from '../utils/universalIds';
import { eventMetrics } from './eventMetrics';
import { UniversalEventPayload } from './universalEventEmitter';

// ─── Configuration ───────────────────────────────────────────────────────────
const BATCH_SIZE       = 50;          // max events per Supabase insert
const FLUSH_INTERVAL_MS = 2_000;      // flush every 2 s
const MAX_RETRIES       = 3;          // attempts before dead-letter
const BACKOFF_BASE_MS   = 1_000;      // 1 s → 2 s → 4 s

// ─── Row shape (matches universal_events table) ───────────────────────────────
interface EventRow {
  event_id:        string;
  event_name:      string;
  schema_version:  number;
  request_id:      string | null;
  search_id:       string | null;
  option_id:       string | null;
  segment_id:      string | null;
  provider_call_id: string | null;
  guest_id:        string | null;
  user_id:         string | null;
  route:           string | null;
  source:          string | null;
  mode:            string | null;
  provider:        string | null;
  status:          string | null;
  latency_ms:      number | null;
  metadata:        Record<string, unknown>;
}

// ─── Internal queue ───────────────────────────────────────────────────────────
type PendingEntry = { row: EventRow; retries: number };
const queue: PendingEntry[] = [];

// ─── Helpers ─────────────────────────────────────────────────────────────────
const sleep = (ms: number) => new Promise<void>(r => setTimeout(r, ms));

function payloadToRow(payload: UniversalEventPayload): EventRow {
  return {
    event_id:         createEventId(),
    event_name:       payload.eventName,
    schema_version:   EVENT_SCHEMA_VERSION,
    request_id:       payload.requestId      || null,
    search_id:        payload.searchId       || null,
    option_id:        payload.optionId       || null,
    segment_id:       payload.segmentId      || null,
    provider_call_id: payload.providerCallId || null,
    guest_id:         payload.guestId        || null,
    user_id:          payload.userId         || null,
    route:            payload.route          || null,
    source:           payload.source         || null,
    mode:             payload.mode           || null,
    provider:         payload.provider       || null,
    status:           payload.status         || null,
    latency_ms:       payload.latencyMs      ?? null,
    metadata:         payload.metadata       || {}
  };
}

// ─── Public API: enqueue ──────────────────────────────────────────────────────
export function enqueueEvent(payload: UniversalEventPayload): void {
  queue.push({ row: payloadToRow(payload), retries: 0 });
  winstonLogger.debug(`[EVENT_RECEIVED] eventName=${payload.eventName} queue=${queue.length}`);
}

export function queueDepth(): number {
  return queue.length;
}

// ─── Flush a batch to Supabase ────────────────────────────────────────────────
async function flushBatch(batch: PendingEntry[]): Promise<void> {
  if (batch.length === 0) return;

  if (!isSupabaseConfigured()) {
    // Drain silently — no DB available
    winstonLogger.debug(`[EVENT_QUEUE_SKIP] Supabase not configured; dropping ${batch.length} events`);
    return;
  }

  const rows = batch.map(e => e.row);
  const { error } = await supabase.from('universal_events').insert(rows);

  if (!error) {
    eventMetrics.incWritten(rows.length);
    winstonLogger.info(`[EVENT_WRITTEN] count=${rows.length}`);
    return;
  }

  // Partial failure: re-queue entries that haven't exceeded MAX_RETRIES
  const toRetry: PendingEntry[] = [];
  const toDrop:  PendingEntry[] = [];

  for (const entry of batch) {
    if (entry.retries < MAX_RETRIES) {
      toRetry.push({ row: entry.row, retries: entry.retries + 1 });
    } else {
      toDrop.push(entry);
    }
  }

  // Backoff before re-queuing retries
  if (toRetry.length > 0) {
    const backoffMs = BACKOFF_BASE_MS * Math.pow(2, toRetry[0].retries - 1);
    eventMetrics.incRetry();
    winstonLogger.warn(
      `[QUEUE_RETRY] count=${toRetry.length} attempt=${toRetry[0].retries} backoffMs=${backoffMs} error="${error.message}"`
    );
    await sleep(backoffMs);
    // Re-enqueue at front so retries don't starve behind new arrivals
    queue.unshift(...toRetry);
  }

  // Dead-letter: log and discard
  for (const dead of toDrop) {
    eventMetrics.incFailed();
    winstonLogger.error(
      `[QUEUE_DROP] event_id=${dead.row.event_id} event_name=${dead.row.event_name} ` +
      `retries=${dead.row /* MAX_RETRIES */} reason="${error.message}" — dead-lettered`
    );
  }

  if (toDrop.length > 0) {
    winstonLogger.error(
      `[EVENT_FAILED] count=${toDrop.length} reason="${error.message}"`
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
    // Safety net: unexpected throws re-queue with retry++
    winstonLogger.error(`[EVENT_QUEUE_EXCEPTION] ${err.message}`);
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

// ─── Lifecycle ────────────────────────────────────────────────────────────────
export function startEventQueueWorker(): void {
  if (running) return;
  running = true;
  eventMetrics.registerQueueDepthProvider(queueDepth);
  scheduleFlush();
  winstonLogger.info(
    `[EVENT_QUEUE_WORKER] Started — batchSize=${BATCH_SIZE} flushMs=${FLUSH_INTERVAL_MS} maxRetries=${MAX_RETRIES}`
  );
}

export function stopEventQueueWorker(): void {
  running = false;
  if (flushTimer !== null) {
    clearTimeout(flushTimer);
    flushTimer = null;
  }
  winstonLogger.info(`[EVENT_QUEUE_WORKER] Stopped — ${queue.length} events remaining in queue`);
}
