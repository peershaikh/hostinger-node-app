"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.feedbackSyncService = exports.FeedbackSyncService = void 0;
const fs_1 = __importDefault(require("fs"));
const path_1 = __importDefault(require("path"));
const supabase_1 = require("../config/supabase");
const logger_1 = require("../middleware/logger");
const eventQueueWorker_1 = require("./eventQueueWorker");
const DATA_DIR = path_1.default.join(__dirname, '../../data');
const BATCH_SIZE = 50;
const MAX_RETRIES = 3;
const BACKOFF_BASE_MS = 1000;
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
class FeedbackSyncService {
    constructor() {
        this.isSyncing = false;
    }
    async syncAllFallbacks() {
        if (this.isSyncing) {
            logger_1.winstonLogger.warn('[FALLBACK_REPLAY_LOCKED] Sync is already in progress. Skipping concurrent run.');
            return;
        }
        if (!(0, supabase_1.isSupabaseConfigured)()) {
            logger_1.winstonLogger.debug('[FEEDBACK_SYNC] Supabase is not configured. Skipping sync.');
            return;
        }
        this.isSyncing = true;
        logger_1.winstonLogger.info('[FALLBACK_REPLAY_START] Starting comprehensive offline fallback synchronization...');
        try {
            await this.syncFeedbackFile();
            await this.syncPnrPredictionFeedbackFile();
            await this.syncSocialComplaintsFile();
            await this.syncSearchHistoryFallback();
            await this.syncLiveLearningFallback();
            await this.syncSplitLearningFallback();
            await this.syncPnrLearningFallback();
            await (0, eventQueueWorker_1.replayUniversalEventsFallback)();
            logger_1.winstonLogger.info('[FALLBACK_REPLAY_SUCCESS] Comprehensive offline fallback synchronization completed.');
        }
        catch (err) {
            logger_1.winstonLogger.error(`[FALLBACK_REPLAY_FAIL] Sync process encountered errors: ${err.message}`);
        }
        finally {
            this.isSyncing = false;
        }
    }
    // ─── 1. feedback.json (Legacy JSON array) ──────────────────────────────────
    async syncFeedbackFile() {
        const filePath = path_1.default.join(__dirname, '../../../data/feedback.json');
        if (!fs_1.default.existsSync(filePath))
            return;
        try {
            const content = fs_1.default.readFileSync(filePath, 'utf8').trim();
            if (!content || content === '[]')
                return;
            let items;
            try {
                items = JSON.parse(content);
            }
            catch (parseErr) {
                (0, eventQueueWorker_1.quarantineRecord)('feedback_json', content, `JSON parse error: ${parseErr.message}`);
                if (!(0, supabase_1.isNoWriteMode)())
                    (0, supabase_1.safeWriteFileSync)(filePath, '[]', 'utf8');
                return;
            }
            if (!Array.isArray(items) || items.length === 0)
                return;
            logger_1.winstonLogger.info(`[FALLBACK_REPLAY_START] file=feedback.json total_lines=${items.length}`);
            const remainingItems = [];
            let successCount = 0;
            for (const item of items) {
                try {
                    const { data, error } = await supabase_1.supabase
                        .from('feedback')
                        .select('id')
                        .eq('pnr', item.pnr || '')
                        .eq('timestamp', item.timestamp || '');
                    if (error)
                        throw error;
                    if (data && data.length > 0) {
                        successCount++;
                        continue;
                    }
                    const { error: insertError } = await supabase_1.supabase.from('feedback').insert([{
                            pnr: item.pnr,
                            is_accurate: item.is_accurate,
                            comments: item.comments,
                            timestamp: item.timestamp,
                            name: item.name || null,
                            email: item.email || null,
                            device: item.device || null,
                            os: item.os || null,
                            feature: item.feature || null,
                            bug: item.bug || null,
                            screenshot: item.screenshot || null,
                            severity: item.severity || null,
                            performance: item.performance || null,
                            ui: item.ui || null,
                            suggestions: item.suggestions || null,
                            user_id: item.user_id || item.userId || null,
                            search_id: item.search_id || item.searchId || null,
                            route_context: item.route_context || item.routeContext || null
                        }]);
                    if (insertError) {
                        remainingItems.push(item);
                    }
                    else {
                        successCount++;
                    }
                }
                catch {
                    remainingItems.push(item);
                }
            }
            if (!(0, supabase_1.isNoWriteMode)()) {
                if (remainingItems.length > 0) {
                    (0, supabase_1.safeWriteFileSync)(filePath, JSON.stringify(remainingItems, null, 2), 'utf8');
                    logger_1.winstonLogger.info(`[FALLBACK_REPLAY_SUCCESS] file=feedback.json recovered=${successCount} remaining=${remainingItems.length}`);
                }
                else {
                    (0, supabase_1.safeWriteFileSync)(filePath, '[]', 'utf8');
                    logger_1.winstonLogger.info(`[FALLBACK_REPLAY_SUCCESS] file=feedback.json recovered=${successCount} — cleared`);
                }
            }
        }
        catch (err) {
            logger_1.winstonLogger.error(`[FALLBACK_REPLAY_FAIL] file=feedback.json error="${err.message}"`);
        }
    }
    // ─── 2. pnr_prediction_feedback_fallback.jsonl ──────────────────────────────
    async syncPnrPredictionFeedbackFile() {
        await this.replayJsonlFile('pnr_prediction_feedback_fallback.jsonl', 'pnr_prediction_feedback', (item) => ({
            pnr: item.pnr,
            prediction_percent: item.prediction_percent,
            confidence_label: item.confidence_label,
            current_status: item.current_status,
            user_feedback: item.user_feedback,
            comment: item.comment || null,
            created_at: item.created_at || item.timestamp
        }));
    }
    // ─── 3. social_complaints_fallback.jsonl ────────────────────────────────────
    async syncSocialComplaintsFile() {
        await this.replayJsonlFile('social_complaints_fallback.jsonl', 'social_complaints', (item) => ({
            pnr: item.pnr,
            train_no: item.train_no,
            issue_type: item.issue_type,
            tweet_content: item.tweet_content,
            timestamp: item.timestamp || item.created_at
        }));
    }
    // ─── 4. search_history_fallback.jsonl ───────────────────────────────────────
    async syncSearchHistoryFallback() {
        await this.replayJsonlFile('search_history_fallback.jsonl', 'search_history', (item) => ({
            source: String(item.source || '').slice(0, 30),
            destination: String(item.destination || '').slice(0, 30),
            date: String(item.date || '').slice(0, 20),
            device_id: item.device_id || 'anonymous',
            user_id: item.user_id || null,
            search_count: Math.max(1, Math.min(10000, parseInt(String(item.search_count || 1), 10) || 1)),
            results_shown: Math.max(0, Math.min(10000, parseInt(String(item.results_shown || 0), 10) || 0)),
            time_taken_ms: Math.max(0, Math.min(3600000, parseInt(String(item.time_taken_ms || 0), 10) || 0))
        }));
    }
    // ─── 5. live_learning_fallback.jsonl ────────────────────────────────────────
    async syncLiveLearningFallback() {
        await this.replayJsonlFile('live_learning_fallback.jsonl', 'live_learning', (item) => ({
            train_no: String(item.train_no || '').slice(0, 20),
            station: String(item.station || '').slice(0, 20),
            delay_mins: Math.max(-1440, Math.min(1440, parseInt(String(item.delay_mins || 0), 10) || 0)),
            speed_kmh: Math.max(0, Math.min(500, parseInt(String(item.speed_kmh || 0), 10) || 0)),
            actual_arrival: item.actual_arrival ? String(item.actual_arrival).slice(0, 50) : null,
            actual_departure: item.actual_departure ? String(item.actual_departure).slice(0, 50) : null
        }));
    }
    // ─── 6. split_learning_fallback.jsonl ───────────────────────────────────────
    async syncSplitLearningFallback() {
        await this.replayJsonlFile('split_learning_fallback.jsonl', 'split_learning', (item) => {
            const payload = {
                source: String(item.source || '').slice(0, 30),
                destination: String(item.destination || '').slice(0, 30),
                hub: String(item.hub || '').slice(0, 30),
                wait_time_mins: Math.max(0, Math.min(1440, parseInt(String(item.wait_time_mins || 0), 10) || 0)),
                total_duration_mins: Math.max(0, Math.min(10000, parseInt(String(item.total_duration_mins || 0), 10) || 0)),
                success_probability: Math.max(0, Math.min(1, parseFloat(String(item.success_probability || 0)) || 0)),
                user_clicked: !!item.user_clicked,
                user_refreshed: !!item.user_refreshed
            };
            if (item.transferType)
                payload.transferType = item.transferType;
            if (item.stationChange !== undefined)
                payload.stationChange = item.stationChange;
            if (item.arrivalStationCode)
                payload.arrivalStationCode = item.arrivalStationCode;
            if (item.boardingStationCode)
                payload.boardingStationCode = item.boardingStationCode;
            if (item.distanceKm)
                payload.distanceKm = item.distanceKm;
            if (item.transitMode)
                payload.transitMode = item.transitMode;
            return payload;
        });
    }
    // ─── 7. pnr_learning_fallback.jsonl ─────────────────────────────────────────
    async syncPnrLearningFallback() {
        await this.replayJsonlFile('pnr_learning_fallback.jsonl', 'pnr_learning', (item) => ({
            pnr: String(item.pnr || '').slice(0, 20),
            initial_status: String(item.initial_status || 'UNKNOWN').slice(0, 50),
            final_status: String(item.final_status || 'UNKNOWN').slice(0, 50),
            chart_prepared: !!item.chart_prepared,
            time_checked: item.time_checked || item._created_at || new Date().toISOString()
        }));
    }
    // ─── Universal Generic JSONL Replayer (Atomic, Bounded, Backoff) ────────────
    async replayJsonlFile(filename, targetTable, transformRow) {
        const filePath = path_1.default.join(DATA_DIR, filename);
        if (!fs_1.default.existsSync(filePath))
            return;
        const startTime = Date.now();
        try {
            const content = fs_1.default.readFileSync(filePath, 'utf8').trim();
            if (!content)
                return;
            const lines = content.split('\n').filter(Boolean);
            if (lines.length === 0)
                return;
            logger_1.winstonLogger.info(`[FALLBACK_REPLAY_START] file=${filename} total_lines=${lines.length} target_table=${targetTable}`);
            const validRows = [];
            const remainingLines = [];
            for (const line of lines) {
                try {
                    const raw = JSON.parse(line);
                    const transformed = transformRow(raw);
                    if (transformed && typeof transformed === 'object') {
                        validRows.push(transformed);
                    }
                    else {
                        (0, eventQueueWorker_1.quarantineRecord)(filename, line, 'Transform returned non-object');
                    }
                }
                catch (parseErr) {
                    (0, eventQueueWorker_1.quarantineRecord)(filename, line, `JSON parse error: ${parseErr.message}`);
                }
            }
            let successCount = 0;
            // Process in batches with exponential backoff retry
            for (let i = 0; i < validRows.length; i += BATCH_SIZE) {
                const batch = validRows.slice(i, i + BATCH_SIZE);
                let batchSuccess = false;
                let attempt = 0;
                while (attempt < MAX_RETRIES && !batchSuccess) {
                    attempt++;
                    try {
                        const { error } = await supabase_1.supabase.from(targetTable).insert(batch);
                        if (!error) {
                            batchSuccess = true;
                            successCount += batch.length;
                        }
                        else if (error.code === '23505') {
                            // Unique key duplicate — already inserted, idempotent pass
                            batchSuccess = true;
                            successCount += batch.length;
                        }
                        else {
                            if (attempt < MAX_RETRIES) {
                                const backoffMs = BACKOFF_BASE_MS * Math.pow(2, attempt - 1);
                                logger_1.winstonLogger.warn(`[FALLBACK_REPLAY_RETRY] file=${filename} attempt=${attempt} backoff_ms=${backoffMs} error="${error.message}"`);
                                await sleep(backoffMs);
                            }
                            else {
                                logger_1.winstonLogger.error(`[FALLBACK_REPLAY_FAIL] file=${filename} failed=${batch.length} error="${error.message}"`);
                            }
                        }
                    }
                    catch (exc) {
                        if (attempt < MAX_RETRIES) {
                            const backoffMs = BACKOFF_BASE_MS * Math.pow(2, attempt - 1);
                            logger_1.winstonLogger.warn(`[FALLBACK_REPLAY_RETRY] file=${filename} attempt=${attempt} backoff_ms=${backoffMs} error="${exc.message}"`);
                            await sleep(backoffMs);
                        }
                        else {
                            logger_1.winstonLogger.error(`[FALLBACK_REPLAY_FAIL] file=${filename} failed=${batch.length} error="${exc.message}"`);
                        }
                    }
                }
                if (!batchSuccess) {
                    batch.forEach(r => remainingLines.push(JSON.stringify(r)));
                }
            }
            // Atomic file update
            if (!(0, supabase_1.isNoWriteMode)()) {
                if (remainingLines.length > 0) {
                    (0, supabase_1.safeWriteFileSync)(filePath, remainingLines.join('\n') + '\n', 'utf8');
                    logger_1.winstonLogger.info(`[FALLBACK_REPLAY_SUCCESS] file=${filename} recovered=${successCount} remaining=${remainingLines.length} duration_ms=${Date.now() - startTime}`);
                }
                else {
                    try {
                        fs_1.default.unlinkSync(filePath);
                    }
                    catch {
                        (0, supabase_1.safeWriteFileSync)(filePath, '', 'utf8');
                    }
                    logger_1.winstonLogger.info(`[FALLBACK_REPLAY_SUCCESS] file=${filename} recovered=${successCount} duration_ms=${Date.now() - startTime} — fallback cleared`);
                }
            }
        }
        catch (err) {
            logger_1.winstonLogger.error(`[FALLBACK_REPLAY_FAIL] file=${filename} error="${err.message}"`);
        }
    }
}
exports.FeedbackSyncService = FeedbackSyncService;
exports.feedbackSyncService = new FeedbackSyncService();
