import * as fs from 'fs';
import * as path from 'path';
import { supabase, isSupabaseConfigured, safeAppendFileSync, safeMkdirSync, safeWriteFileSync, isNoWriteMode } from '../../config/supabase';
import { winstonLogger } from '../../middleware/logger';

// ─── Types & Contract ─────────────────────────────────────────────────────────

export type CanonicalEventType =
  | 'search'
  | 'split'
  | 'pnr'
  | 'live'
  | 'availability'
  | 'schedule'
  | 'ai'
  | 'pnr_poll';

export const CANONICAL_EVENT_TYPES: Set<string> = new Set([
  'search',
  'split',
  'pnr',
  'live',
  'availability',
  'schedule',
  'ai',
  'pnr_poll'
]);

/**
 * Incoming wire-level and legacy telemetry payload accepted by LedgerTransport.
 * Conforms strictly to the columns approved in Step 2A migration.
 */
export interface LedgerEventPayload {
  provider_name: string;
  event_type: CanonicalEventType;
  user_id?: string | null;
  applied_rate?: number;
  currency?: string;
  timestamp?: string;
  success?: boolean | null;
  http_status?: number | null;
  latency_ms?: number | null;
  is_retry?: boolean;
  is_fallback?: boolean;
  caller_feature?: string | null;
  tokens_in?: number | null;
  tokens_out?: number | null;
  model_name?: string | null;
}

/**
 * Database row contract for public.api_provider_transaction_ledger
 */
export interface LedgerTransactionRow {
  provider_name: string;
  event_type: CanonicalEventType;
  user_id: string | null;
  applied_rate: number;
  currency: string;
  timestamp: string;
  success: boolean | null;
  http_status: number | null;
  latency_ms: number | null;
  is_retry: boolean;
  is_fallback: boolean;
  caller_feature: string | null;
  tokens_in: number | null;
  tokens_out: number | null;
  model_name: string | null;
}

interface QueueEntry {
  row: LedgerTransactionRow;
  attempts: number;
  enqueuedAt: number;
}

export interface LedgerTransportOptions {
  maxQueueSize?: number;
  batchSize?: number;
  flushIntervalMs?: number;
  maxAttempts?: number;
  backoffMs?: number[];
  dataDir?: string;
  spillFileName?: string;
  autoStart?: boolean;
  supabaseClient?: any;
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function sanitizeUserId(userId?: string | null): string | null {
  if (!userId || typeof userId !== 'string') return null;
  const trimmed = userId.trim();
  return UUID_REGEX.test(trimmed) ? trimmed : null;
}

function payloadToRow(payload: LedgerEventPayload): LedgerTransactionRow {
  const eventType: CanonicalEventType = CANONICAL_EVENT_TYPES.has(payload.event_type)
    ? payload.event_type
    : 'search';

  const appliedRate = typeof payload.applied_rate === 'number' && !isNaN(payload.applied_rate)
    ? payload.applied_rate
    : 0.000000;

  return {
    provider_name: (payload.provider_name || 'UNKNOWN').trim().toUpperCase(),
    event_type: eventType,
    user_id: sanitizeUserId(payload.user_id),
    applied_rate: appliedRate,
    currency: (payload.currency || 'INR').trim().toUpperCase(),
    timestamp: payload.timestamp || new Date().toISOString(),
    success: typeof payload.success === 'boolean' ? payload.success : true,
    http_status: typeof payload.http_status === 'number' && !isNaN(payload.http_status) ? payload.http_status : null,
    latency_ms: typeof payload.latency_ms === 'number' && !isNaN(payload.latency_ms) ? Math.round(payload.latency_ms) : null,
    is_retry: Boolean(payload.is_retry),
    is_fallback: Boolean(payload.is_fallback),
    caller_feature: payload.caller_feature ? String(payload.caller_feature).trim() : null,
    tokens_in: typeof payload.tokens_in === 'number' && !isNaN(payload.tokens_in) ? Math.round(payload.tokens_in) : null,
    tokens_out: typeof payload.tokens_out === 'number' && !isNaN(payload.tokens_out) ? Math.round(payload.tokens_out) : null,
    model_name: payload.model_name ? String(payload.model_name).trim() : null
  };
}

const sleep = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));

// ─── Transport Class ──────────────────────────────────────────────────────────

export class LedgerTransport {
  private readonly maxQueueSize: number;
  private readonly batchSize: number;
  private readonly flushIntervalMs: number;
  private readonly maxAttempts: number;
  private readonly backoffMs: number[];
  private readonly dataDir: string;
  private readonly spillFilePath: string;

  private queue: QueueEntry[] = [];
  private flushTimer: NodeJS.Timeout | null = null;
  private isFlushing = false;
  private running = false;
  private isShuttingDown = false;
  private mockSupabase: any = null;

  constructor(options: LedgerTransportOptions = {}) {
    this.maxQueueSize = options.maxQueueSize ?? 5000;
    this.batchSize = options.batchSize ?? 50;
    this.flushIntervalMs = options.flushIntervalMs ?? 1000;
    this.maxAttempts = options.maxAttempts ?? 3;
    this.backoffMs = options.backoffMs ?? [1000, 2000, 4000];

    const defaultDataDir = path.join(__dirname, '../../../data');
    this.dataDir = options.dataDir ?? (process.env.LEDGER_DATA_DIR || defaultDataDir);
    this.spillFilePath = path.join(this.dataDir, options.spillFileName ?? 'ledger_spill.jsonl');
    this.mockSupabase = options.supabaseClient ?? null;

    if (options.autoStart ?? (process.env.NODE_ENV !== 'test')) {
      this.start();
      this.registerSignalHandlers();
    }
  }

  /**
   * Synchronous, non-blocking enqueue for telemetry events.
   * Completely isolated from network latency and provider execution.
   */
  public enqueue(payload: LedgerEventPayload): void {
    try {
      const row = payloadToRow(payload);

      // Backpressure / Queue Saturation Check
      if (this.queue.length >= this.maxQueueSize) {
        this.handleQueueSaturation(row);
      } else {
        this.queue.push({ row, attempts: 0, enqueuedAt: Date.now() });
      }

      // If batch size threshold reached, trigger async flush if not already flushing
      if (this.queue.length >= this.batchSize && !this.isFlushing) {
        setImmediate(() => {
          this.flush().catch(err => {
            winstonLogger.error(`[LEDGER_TRANSPORT_FLUSH_ERROR] ${err.message}`);
          });
        });
      }

      // Ensure flush timer is running
      this.scheduleFlush();
    } catch (err: any) {
      // NEVER crash or throw into caller execution
      winstonLogger.error(`[LEDGER_ENQUEUE_FAIL] Failed to enqueue telemetry: ${err.message}`);
    }
  }

  /**
   * Handles memory ceiling saturation without dropping financial/AI records.
   */
  private handleQueueSaturation(incomingRow: LedgerTransactionRow): void {
    const isIncomingHighPriority = incomingRow.event_type === 'ai' || incomingRow.applied_rate > 0;

    // Preferentially find low-priority diagnostic entries to shed
    const lowPriorityIndices: number[] = [];
    for (let i = 0; i < this.queue.length && lowPriorityIndices.length < this.batchSize; i++) {
      const entryType = this.queue[i].row.event_type;
      if (entryType === 'pnr_poll' || entryType === 'availability' || entryType === 'schedule') {
        lowPriorityIndices.push(i);
      }
    }

    let shed: QueueEntry[] = [];
    if (lowPriorityIndices.length >= this.batchSize) {
      // Remove selected low-priority items in reverse order to preserve indexing
      for (let i = lowPriorityIndices.length - 1; i >= 0; i--) {
        const removed = this.queue.splice(lowPriorityIndices[i], 1);
        shed.push(removed[0]);
      }
    } else {
      // FIFO shed: splice oldest from queue
      shed = this.queue.splice(0, this.batchSize);
    }

    // Spill shed events to disk
    const rowsToSpill = shed.map(e => e.row);
    try {
      this.saveSpilloverEvents(rowsToSpill, 'queue_saturation');
      winstonLogger.warn(
        `[LEDGER_QUEUE_SATURATION] Queue ceiling reached (${this.maxQueueSize}); spilled ${rowsToSpill.length} events to disk`
      );
    } catch (spillErr: any) {
      // If disk write failed, low-priority diagnostic events may be dropped to protect process memory
      winstonLogger.error(
        `[LEDGER_SPILL_FAIL] Disk write failed on saturation: ${spillErr.message}. Shedding ${rowsToSpill.length} events.`
      );
    }

    // Push the incoming entry
    this.queue.push({ row: incomingRow, attempts: 0, enqueuedAt: Date.now() });
  }

  /**
   * Schedule the next perpetual flush timer.
   */
  private scheduleFlush(): void {
    if (this.flushTimer !== null || !this.running || this.isShuttingDown) return;
    this.flushTimer = setTimeout(async () => {
      this.flushTimer = null;
      if (!this.running || this.isShuttingDown) return;
      await this.flush();
      this.scheduleFlush();
    }, this.flushIntervalMs);
  }

  /**
   * Flush one batch of pending events to Supabase or spillover.
   */
  public async flush(): Promise<void> {
    if (this.isFlushing || this.queue.length === 0) return;

    this.isFlushing = true;
    const batch = this.queue.splice(0, this.batchSize);

    try {
      await this.flushBatch(batch);
    } catch (err: any) {
      winstonLogger.error(`[LEDGER_FLUSH_EXCEPTION] Unexpected error in flush: ${err.message}`);
      this.saveSpilloverEvents(batch.map(e => e.row), `flush_exception: ${err.message}`);
    } finally {
      this.isFlushing = false;
      // If queue still has items, schedule another flush tick
      if (this.queue.length > 0 && this.running && !this.isShuttingDown) {
        this.scheduleFlush();
      }
    }
  }

  /**
   * Core batch insertion with retry and backoff logic.
   */
  private async flushBatch(batch: QueueEntry[]): Promise<void> {
    if (batch.length === 0) return;

    const rows = batch.map(e => e.row);
    const client = this.mockSupabase || supabase;

    // Supabase unconfigured check
    if (!isSupabaseConfigured() && !this.mockSupabase) {
      winstonLogger.debug(`[LEDGER_MOCK] Supabase not configured; enqueuing ${rows.length} rows to spillover`);
      this.saveSpilloverEvents(rows, 'supabase_not_configured');
      return;
    }

    let attempt = 0;
    let success = false;
    let lastError: any = null;

    while (attempt < this.maxAttempts && !success && !this.isShuttingDown) {
      attempt++;
      const startTime = Date.now();
      try {
        const { error } = await client.from('api_provider_transaction_ledger').insert(rows);
        if (!error) {
          success = true;
          const durationMs = Date.now() - startTime;
          winstonLogger.info(`[LEDGER_PERSISTED] count=${rows.length} duration_ms=${durationMs} attempt=${attempt}`);
          return;
        }
        lastError = error;
      } catch (err: any) {
        lastError = err;
      }

      if (!success) {
        if (attempt < this.maxAttempts && !this.isShuttingDown) {
          const backoff = this.backoffMs[attempt - 1] ?? 1000;
          winstonLogger.warn(
            `[LEDGER_INSERT_RETRY] Batch of ${rows.length} failed (attempt ${attempt}/${this.maxAttempts}): ${lastError?.message || lastError}. Retrying in ${backoff}ms`
          );
          await sleep(backoff);
        }
      }
    }

    if (!success) {
      winstonLogger.error(
        `[LEDGER_RETRY_EXHAUSTED] Batch of ${rows.length} failed after ${this.maxAttempts} attempts: ${lastError?.message || lastError}. Writing to spillover file.`
      );
      this.saveSpilloverEvents(rows, `retry_exhausted: ${lastError?.message || lastError}`);
    }
  }

  /**
   * Safe, append-only disk spillover.
   */
  private saveSpilloverEvents(rows: LedgerTransactionRow[], reason: string): void {
    if (rows.length === 0 || isNoWriteMode()) return;
    try {
      if (!fs.existsSync(this.dataDir)) {
        safeMkdirSync(this.dataDir, { recursive: true });
      }

      let lines = '';
      const nowIso = new Date().toISOString();
      for (const row of rows) {
        const entry = {
          spilled_at: nowIso,
          spill_reason: reason,
          row
        };
        lines += JSON.stringify(entry) + '\n';
      }

      safeAppendFileSync(this.spillFilePath, lines, 'utf8');
      winstonLogger.warn(`[LEDGER_SPILLOVER] Spilled ${rows.length} rows to ${this.spillFilePath} (reason: ${reason})`);
    } catch (err: any) {
      winstonLogger.error(`[LEDGER_SPILLOVER_ERROR] Failed writing spillover rows: ${err.message}`);
    }
  }

  /**
   * Replays records from ledger_spill.jsonl back into Supabase.
   */
  public async replaySpillover(): Promise<{ processed: number; succeeded: number; failed: number }> {
    if (!fs.existsSync(this.spillFilePath)) {
      return { processed: 0, succeeded: 0, failed: 0 };
    }

    const client = this.mockSupabase || supabase;
    if (!isSupabaseConfigured() && !this.mockSupabase) {
      return { processed: 0, succeeded: 0, failed: 0 };
    }

    try {
      const content = fs.readFileSync(this.spillFilePath, 'utf8').trim();
      if (!content) return { processed: 0, succeeded: 0, failed: 0 };

      const lines = content.split('\n').filter(Boolean);
      const validRows: LedgerTransactionRow[] = [];
      const remainingLines: string[] = [];

      for (const line of lines) {
        try {
          const item = JSON.parse(line);
          const row: LedgerTransactionRow = item.row || item;
          if (row && row.provider_name && row.event_type) {
            validRows.push(row);
          } else {
            remainingLines.push(line);
          }
        } catch {
          remainingLines.push(line);
        }
      }

      let succeededCount = 0;
      for (let i = 0; i < validRows.length; i += this.batchSize) {
        const batch = validRows.slice(i, i + this.batchSize);
        try {
          const { error } = await client.from('api_provider_transaction_ledger').insert(batch);
          if (!error) {
            succeededCount += batch.length;
          } else {
            batch.forEach(r => remainingLines.push(JSON.stringify({ row: r })));
          }
        } catch {
          batch.forEach(r => remainingLines.push(JSON.stringify({ row: r })));
        }
      }

      // Update spill file with remaining lines
      if (!isNoWriteMode()) {
        if (remainingLines.length > 0) {
          safeWriteFileSync(this.spillFilePath, remainingLines.join('\n') + '\n', 'utf8');
        } else {
          try {
            fs.unlinkSync(this.spillFilePath);
          } catch {
            safeWriteFileSync(this.spillFilePath, '', 'utf8');
          }
        }
      }

      return {
        processed: lines.length,
        succeeded: succeededCount,
        failed: remainingLines.length
      };
    } catch (err: any) {
      winstonLogger.error(`[LEDGER_REPLAY_ERROR] Replay failed: ${err.message}`);
      return { processed: 0, succeeded: 0, failed: 0 };
    }
  }

  /**
   * Graceful shutdown: clears timers, stops scheduling, and flushes or spills remaining rows.
   */
  public async shutdown(): Promise<void> {
    if (this.isShuttingDown) return;
    this.isShuttingDown = true;
    this.running = false;

    if (this.flushTimer !== null) {
      clearTimeout(this.flushTimer);
      this.flushTimer = null;
    }

    // Wait briefly for in-flight flush to finish
    const start = Date.now();
    while (this.isFlushing && Date.now() - start < 3000) {
      await sleep(50);
    }

    if (this.queue.length > 0) {
      winstonLogger.info(`[LEDGER_TRANSPORT] Flushing ${this.queue.length} remaining events during shutdown`);
      const remaining = this.queue.splice(0, this.queue.length);
      const rows = remaining.map(e => e.row);
      const client = this.mockSupabase || supabase;

      try {
        if (isSupabaseConfigured() || this.mockSupabase) {
          const { error } = await client.from('api_provider_transaction_ledger').insert(rows);
          if (error) {
            this.saveSpilloverEvents(rows, `shutdown_insert_error: ${error.message}`);
          } else {
            winstonLogger.info(`[LEDGER_TRANSPORT] Flushed ${rows.length} rows on shutdown`);
          }
        } else {
          this.saveSpilloverEvents(rows, 'shutdown_supabase_unconfigured');
        }
      } catch (err: any) {
        this.saveSpilloverEvents(rows, `shutdown_exception: ${err.message}`);
      }
    }

    winstonLogger.info('[LEDGER_TRANSPORT] Shutdown complete');
  }

  public start(): void {
    if (this.running) return;
    this.running = true;
    this.isShuttingDown = false;
    this.scheduleFlush();
    winstonLogger.info(
      `[LEDGER_TRANSPORT] Started — batchSize=${this.batchSize} flushMs=${this.flushIntervalMs} maxAttempts=${this.maxAttempts} maxQueue=${this.maxQueueSize}`
    );
  }

  public getQueueDepth(): number {
    return this.queue.length;
  }

  public isHealthy(): { queueDepth: number; isFlushing: boolean; running: boolean } {
    return {
      queueDepth: this.queue.length,
      isFlushing: this.isFlushing,
      running: this.running
    };
  }

  public resetForTesting(): void {
    this.running = false;
    this.isShuttingDown = false;
    this.isFlushing = false;
    if (this.flushTimer !== null) {
      clearTimeout(this.flushTimer);
      this.flushTimer = null;
    }
    this.queue = [];
  }

  private registerSignalHandlers(): void {
    const handler = async (signal: string) => {
      try {
        winstonLogger.info(`[LEDGER_TRANSPORT] Received ${signal}, initiating graceful shutdown`);
        await this.shutdown();
      } catch (err: any) {
        winstonLogger.error(`[LEDGER_TRANSPORT] Error during ${signal} shutdown: ${err.message}`);
      }
    };

    if (process.env.NODE_ENV !== 'test') {
      process.once('SIGTERM', () => handler('SIGTERM'));
      process.once('SIGINT', () => handler('SIGINT'));
    }
  }
}

// ─── Singleton Export ────────────────────────────────────────────────────────

export const ledgerTransport = new LedgerTransport();
