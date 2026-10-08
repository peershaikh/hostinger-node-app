"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
Object.defineProperty(exports, "__esModule", { value: true });
exports.ledgerTransport = exports.LedgerTransport = exports.CANONICAL_EVENT_TYPES = void 0;
const fs = __importStar(require("fs"));
const path = __importStar(require("path"));
const supabase_1 = require("../../config/supabase");
const logger_1 = require("../../middleware/logger");
exports.CANONICAL_EVENT_TYPES = new Set([
    'search',
    'split',
    'pnr',
    'live',
    'availability',
    'schedule',
    'ai',
    'pnr_poll'
]);
// ─── Helpers ─────────────────────────────────────────────────────────────────
const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
function sanitizeUserId(userId) {
    if (!userId || typeof userId !== 'string')
        return null;
    const trimmed = userId.trim();
    return UUID_REGEX.test(trimmed) ? trimmed : null;
}
function payloadToRow(payload) {
    const eventType = exports.CANONICAL_EVENT_TYPES.has(payload.event_type)
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
const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));
// ─── Transport Class ──────────────────────────────────────────────────────────
class LedgerTransport {
    constructor(options = {}) {
        this.queue = [];
        this.flushTimer = null;
        this.isFlushing = false;
        this.running = false;
        this.isShuttingDown = false;
        this.mockSupabase = null;
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
    enqueue(payload) {
        try {
            const row = payloadToRow(payload);
            // Backpressure / Queue Saturation Check
            if (this.queue.length >= this.maxQueueSize) {
                this.handleQueueSaturation(row);
            }
            else {
                this.queue.push({ row, attempts: 0, enqueuedAt: Date.now() });
            }
            // If batch size threshold reached, trigger async flush if not already flushing
            if (this.queue.length >= this.batchSize && !this.isFlushing) {
                setImmediate(() => {
                    this.flush().catch(err => {
                        logger_1.winstonLogger.error(`[LEDGER_TRANSPORT_FLUSH_ERROR] ${err.message}`);
                    });
                });
            }
            // Ensure flush timer is running
            this.scheduleFlush();
        }
        catch (err) {
            // NEVER crash or throw into caller execution
            logger_1.winstonLogger.error(`[LEDGER_ENQUEUE_FAIL] Failed to enqueue telemetry: ${err.message}`);
        }
    }
    /**
     * Handles memory ceiling saturation without dropping financial/AI records.
     */
    handleQueueSaturation(incomingRow) {
        const isIncomingHighPriority = incomingRow.event_type === 'ai' || incomingRow.applied_rate > 0;
        // Preferentially find low-priority diagnostic entries to shed
        const lowPriorityIndices = [];
        for (let i = 0; i < this.queue.length && lowPriorityIndices.length < this.batchSize; i++) {
            const entryType = this.queue[i].row.event_type;
            if (entryType === 'pnr_poll' || entryType === 'availability' || entryType === 'schedule') {
                lowPriorityIndices.push(i);
            }
        }
        let shed = [];
        if (lowPriorityIndices.length >= this.batchSize) {
            // Remove selected low-priority items in reverse order to preserve indexing
            for (let i = lowPriorityIndices.length - 1; i >= 0; i--) {
                const removed = this.queue.splice(lowPriorityIndices[i], 1);
                shed.push(removed[0]);
            }
        }
        else {
            // FIFO shed: splice oldest from queue
            shed = this.queue.splice(0, this.batchSize);
        }
        // Spill shed events to disk
        const rowsToSpill = shed.map(e => e.row);
        try {
            this.saveSpilloverEvents(rowsToSpill, 'queue_saturation');
            logger_1.winstonLogger.warn(`[LEDGER_QUEUE_SATURATION] Queue ceiling reached (${this.maxQueueSize}); spilled ${rowsToSpill.length} events to disk`);
        }
        catch (spillErr) {
            // If disk write failed, low-priority diagnostic events may be dropped to protect process memory
            logger_1.winstonLogger.error(`[LEDGER_SPILL_FAIL] Disk write failed on saturation: ${spillErr.message}. Shedding ${rowsToSpill.length} events.`);
        }
        // Push the incoming entry
        this.queue.push({ row: incomingRow, attempts: 0, enqueuedAt: Date.now() });
    }
    /**
     * Schedule the next perpetual flush timer.
     */
    scheduleFlush() {
        if (this.flushTimer !== null || !this.running || this.isShuttingDown)
            return;
        this.flushTimer = setTimeout(async () => {
            this.flushTimer = null;
            if (!this.running || this.isShuttingDown)
                return;
            await this.flush();
            this.scheduleFlush();
        }, this.flushIntervalMs);
    }
    /**
     * Flush one batch of pending events to Supabase or spillover.
     */
    async flush() {
        if (this.isFlushing || this.queue.length === 0)
            return;
        this.isFlushing = true;
        const batch = this.queue.splice(0, this.batchSize);
        try {
            await this.flushBatch(batch);
        }
        catch (err) {
            logger_1.winstonLogger.error(`[LEDGER_FLUSH_EXCEPTION] Unexpected error in flush: ${err.message}`);
            this.saveSpilloverEvents(batch.map(e => e.row), `flush_exception: ${err.message}`);
        }
        finally {
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
    async flushBatch(batch) {
        if (batch.length === 0)
            return;
        const rows = batch.map(e => e.row);
        const client = this.mockSupabase || supabase_1.supabase;
        // Supabase unconfigured check
        if (!(0, supabase_1.isSupabaseConfigured)() && !this.mockSupabase) {
            logger_1.winstonLogger.debug(`[LEDGER_MOCK] Supabase not configured; enqueuing ${rows.length} rows to spillover`);
            this.saveSpilloverEvents(rows, 'supabase_not_configured');
            return;
        }
        let attempt = 0;
        let success = false;
        let lastError = null;
        while (attempt < this.maxAttempts && !success && !this.isShuttingDown) {
            attempt++;
            const startTime = Date.now();
            try {
                const { error } = await client.from('api_provider_transaction_ledger').insert(rows);
                if (!error) {
                    success = true;
                    const durationMs = Date.now() - startTime;
                    logger_1.winstonLogger.info(`[LEDGER_PERSISTED] count=${rows.length} duration_ms=${durationMs} attempt=${attempt}`);
                    return;
                }
                lastError = error;
            }
            catch (err) {
                lastError = err;
            }
            if (!success) {
                if (attempt < this.maxAttempts && !this.isShuttingDown) {
                    const backoff = this.backoffMs[attempt - 1] ?? 1000;
                    logger_1.winstonLogger.warn(`[LEDGER_INSERT_RETRY] Batch of ${rows.length} failed (attempt ${attempt}/${this.maxAttempts}): ${lastError?.message || lastError}. Retrying in ${backoff}ms`);
                    await sleep(backoff);
                }
            }
        }
        if (!success) {
            logger_1.winstonLogger.error(`[LEDGER_RETRY_EXHAUSTED] Batch of ${rows.length} failed after ${this.maxAttempts} attempts: ${lastError?.message || lastError}. Writing to spillover file.`);
            this.saveSpilloverEvents(rows, `retry_exhausted: ${lastError?.message || lastError}`);
        }
    }
    /**
     * Safe, append-only disk spillover.
     */
    saveSpilloverEvents(rows, reason) {
        if (rows.length === 0 || (0, supabase_1.isNoWriteMode)())
            return;
        try {
            if (!fs.existsSync(this.dataDir)) {
                (0, supabase_1.safeMkdirSync)(this.dataDir, { recursive: true });
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
            (0, supabase_1.safeAppendFileSync)(this.spillFilePath, lines, 'utf8');
            logger_1.winstonLogger.warn(`[LEDGER_SPILLOVER] Spilled ${rows.length} rows to ${this.spillFilePath} (reason: ${reason})`);
        }
        catch (err) {
            logger_1.winstonLogger.error(`[LEDGER_SPILLOVER_ERROR] Failed writing spillover rows: ${err.message}`);
        }
    }
    /**
     * Replays records from ledger_spill.jsonl back into Supabase.
     */
    async replaySpillover() {
        if (!fs.existsSync(this.spillFilePath)) {
            return { processed: 0, succeeded: 0, failed: 0 };
        }
        const client = this.mockSupabase || supabase_1.supabase;
        if (!(0, supabase_1.isSupabaseConfigured)() && !this.mockSupabase) {
            return { processed: 0, succeeded: 0, failed: 0 };
        }
        try {
            const content = fs.readFileSync(this.spillFilePath, 'utf8').trim();
            if (!content)
                return { processed: 0, succeeded: 0, failed: 0 };
            const lines = content.split('\n').filter(Boolean);
            const validRows = [];
            const remainingLines = [];
            for (const line of lines) {
                try {
                    const item = JSON.parse(line);
                    const row = item.row || item;
                    if (row && row.provider_name && row.event_type) {
                        validRows.push(row);
                    }
                    else {
                        remainingLines.push(line);
                    }
                }
                catch {
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
                    }
                    else {
                        batch.forEach(r => remainingLines.push(JSON.stringify({ row: r })));
                    }
                }
                catch {
                    batch.forEach(r => remainingLines.push(JSON.stringify({ row: r })));
                }
            }
            // Update spill file with remaining lines
            if (!(0, supabase_1.isNoWriteMode)()) {
                if (remainingLines.length > 0) {
                    (0, supabase_1.safeWriteFileSync)(this.spillFilePath, remainingLines.join('\n') + '\n', 'utf8');
                }
                else {
                    try {
                        fs.unlinkSync(this.spillFilePath);
                    }
                    catch {
                        (0, supabase_1.safeWriteFileSync)(this.spillFilePath, '', 'utf8');
                    }
                }
            }
            return {
                processed: lines.length,
                succeeded: succeededCount,
                failed: remainingLines.length
            };
        }
        catch (err) {
            logger_1.winstonLogger.error(`[LEDGER_REPLAY_ERROR] Replay failed: ${err.message}`);
            return { processed: 0, succeeded: 0, failed: 0 };
        }
    }
    /**
     * Graceful shutdown: clears timers, stops scheduling, and flushes or spills remaining rows.
     */
    async shutdown() {
        if (this.isShuttingDown)
            return;
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
            logger_1.winstonLogger.info(`[LEDGER_TRANSPORT] Flushing ${this.queue.length} remaining events during shutdown`);
            const remaining = this.queue.splice(0, this.queue.length);
            const rows = remaining.map(e => e.row);
            const client = this.mockSupabase || supabase_1.supabase;
            try {
                if ((0, supabase_1.isSupabaseConfigured)() || this.mockSupabase) {
                    const { error } = await client.from('api_provider_transaction_ledger').insert(rows);
                    if (error) {
                        this.saveSpilloverEvents(rows, `shutdown_insert_error: ${error.message}`);
                    }
                    else {
                        logger_1.winstonLogger.info(`[LEDGER_TRANSPORT] Flushed ${rows.length} rows on shutdown`);
                    }
                }
                else {
                    this.saveSpilloverEvents(rows, 'shutdown_supabase_unconfigured');
                }
            }
            catch (err) {
                this.saveSpilloverEvents(rows, `shutdown_exception: ${err.message}`);
            }
        }
        logger_1.winstonLogger.info('[LEDGER_TRANSPORT] Shutdown complete');
    }
    start() {
        if (this.running)
            return;
        this.running = true;
        this.isShuttingDown = false;
        this.scheduleFlush();
        logger_1.winstonLogger.info(`[LEDGER_TRANSPORT] Started — batchSize=${this.batchSize} flushMs=${this.flushIntervalMs} maxAttempts=${this.maxAttempts} maxQueue=${this.maxQueueSize}`);
    }
    getQueueDepth() {
        return this.queue.length;
    }
    isHealthy() {
        return {
            queueDepth: this.queue.length,
            isFlushing: this.isFlushing,
            running: this.running
        };
    }
    resetForTesting() {
        this.running = false;
        this.isShuttingDown = false;
        this.isFlushing = false;
        if (this.flushTimer !== null) {
            clearTimeout(this.flushTimer);
            this.flushTimer = null;
        }
        this.queue = [];
    }
    registerSignalHandlers() {
        const handler = async (signal) => {
            try {
                logger_1.winstonLogger.info(`[LEDGER_TRANSPORT] Received ${signal}, initiating graceful shutdown`);
                await this.shutdown();
            }
            catch (err) {
                logger_1.winstonLogger.error(`[LEDGER_TRANSPORT] Error during ${signal} shutdown: ${err.message}`);
            }
        };
        if (process.env.NODE_ENV !== 'test') {
            process.once('SIGTERM', () => handler('SIGTERM'));
            process.once('SIGINT', () => handler('SIGINT'));
        }
    }
}
exports.LedgerTransport = LedgerTransport;
// ─── Singleton Export ────────────────────────────────────────────────────────
exports.ledgerTransport = new LedgerTransport();
