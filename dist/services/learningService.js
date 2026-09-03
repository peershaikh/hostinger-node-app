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
exports.learningService = exports.LearningService = void 0;
const supabase_1 = require("../config/supabase");
const logger_1 = require("../middleware/logger");
const fs = __importStar(require("fs"));
const path = __importStar(require("path"));
const rateService_1 = require("./rateService");
// Local fallback if Supabase tables don't exist yet
const DATA_DIR = path.join(__dirname, '../../data');
if (!(0, supabase_1.isNoWriteMode)() && !fs.existsSync(DATA_DIR)) {
    (0, supabase_1.safeMkdirSync)(DATA_DIR, { recursive: true });
}
/**
 * Minimum number of confirmed outcome samples required before a learning aggregate
 * is trusted as a prediction signal. Records below this threshold are statistically
 * unreliable (a single confirmed PNR produces 100% success_rate) and are ignored,
 * falling back to the calibrated heuristic table in pnrController instead.
 */
const MIN_SAMPLE_SIZE = 5;
function saveLocalFallback(table, data) {
    try {
        const filePath = path.join(DATA_DIR, `${table}_fallback.jsonl`);
        const line = JSON.stringify({ ...data, _created_at: new Date().toISOString() }) + '\n';
        (0, supabase_1.safeAppendFileSync)(filePath, line, 'utf8');
        logger_1.winstonLogger.info(`[FALLBACK_ENQUEUE] file=${table}_fallback.jsonl count=1`);
    }
    catch (err) {
        logger_1.winstonLogger.error(`[LEARNING_SERVICE] Local fallback save failed for ${table}`);
    }
}
class LearningService {
    // ─── STEP 1: Search Learning ─────────────────────────────────────────────
    async logSearch(source, destination, date, deviceId, userId, resultsShown, timeTakenMs) {
        if (global.SYSTEM_MODE === 'MODE_A')
            return;
        try {
            const payload = {
                source,
                destination,
                date,
                device_id: deviceId || 'anonymous',
                user_id: userId || null,
                search_count: 1,
                results_shown: resultsShown,
                time_taken_ms: timeTakenMs,
            };
            const { error } = await supabase_1.supabase.from('search_history').insert([payload]);
            if (error) {
                if (error.code === 'PGRST205' || error.code === '42P01') {
                    saveLocalFallback('search_history', payload);
                }
                else {
                    logger_1.winstonLogger.error(`[SEARCH_LEARNING] DB error: ${error.message}`);
                }
            }
            else {
                logger_1.winstonLogger.debug(`[SEARCH_LEARNING] Saved search ${source} -> ${destination}`);
            }
            // Log transaction cost dynamically (fail-safe)
            rateService_1.rateService.logTransaction('IRCTC', 'search', userId).catch(() => { });
        }
        catch (err) {
            logger_1.winstonLogger.error(`[SEARCH_LEARNING] Error: ${err.message}`);
        }
    }
    // ─── STEP 2: Split Learning ─────────────────────────────────────────────
    async logSplitRecommendation(source, destination, hub, waitTimeMins, totalDurationMins, successProb, transferMeta) {
        if (global.SYSTEM_MODE === 'MODE_A')
            return null;
        try {
            const payload = {
                source,
                destination,
                hub,
                wait_time_mins: waitTimeMins,
                total_duration_mins: totalDurationMins,
                success_probability: successProb,
                user_clicked: false,
                user_refreshed: false
            };
            if (transferMeta && transferMeta.transferType === 'INTER_STATION') {
                payload.transferType = transferMeta.transferType;
                payload.stationChange = transferMeta.stationChange;
                payload.arrivalStationCode = transferMeta.arrivalStation?.code;
                payload.boardingStationCode = transferMeta.boardingStation?.code;
                payload.distanceKm = transferMeta.distanceKm;
                payload.transitMode = transferMeta.transitMode;
                payload.minimumRequiredBufferMinutes = transferMeta.minimumRequiredBufferMinutes;
                payload.actualBufferMinutes = transferMeta.actualBufferMinutes;
                payload.bufferSurplusMinutes = transferMeta.bufferSurplusMinutes;
            }
            // Log transaction cost dynamically (fail-safe)
            rateService_1.rateService.logTransaction('IRCTC', 'split', null).catch(() => { });
            const { data, error } = await supabase_1.supabase.from('split_learning').insert([payload]).select('id').single();
            if (error) {
                if (error.code === 'PGRST205' || error.code === '42P01') {
                    saveLocalFallback('split_learning', payload);
                    return 'fallback-id';
                }
                logger_1.winstonLogger.error(`[SPLIT_LEARNING] DB error: ${error.message}`);
                return null;
            }
            return data?.id || null;
        }
        catch (err) {
            logger_1.winstonLogger.error(`[SPLIT_LEARNING] Error: ${err.message}`);
            return null;
        }
    }
    async updateSplitInteraction(id, clicked, refreshed) {
        if (global.SYSTEM_MODE === 'MODE_A')
            return;
        if (id === 'fallback-id' || !id)
            return;
        try {
            const { error } = await supabase_1.supabase.from('split_learning').update({
                user_clicked: clicked,
                user_refreshed: refreshed,
                updated_at: new Date().toISOString()
            }).eq('id', id);
            if (error && error.code !== 'PGRST205' && error.code !== '42P01') {
                logger_1.winstonLogger.error(`[SPLIT_LEARNING] Update error: ${error.message}`);
            }
        }
        catch (err) {
            logger_1.winstonLogger.error(`[SPLIT_LEARNING] Update error: ${err.message}`);
        }
    }
    // ─── STEP 3: PNR Learning ─────────────────────────────────────────────
    async logPnrCheck(pnr, initialStatus, finalStatus, chartPrepared) {
        if (global.SYSTEM_MODE === 'MODE_A')
            return;
        try {
            const payload = {
                pnr,
                initial_status: initialStatus,
                final_status: finalStatus,
                chart_prepared: chartPrepared,
                time_checked: new Date().toISOString()
            };
            // Log transaction cost dynamically (fail-safe)
            rateService_1.rateService.logTransaction('IRCTC', 'pnr', null).catch(() => { });
            const { error } = await supabase_1.supabase.from('pnr_learning').insert([payload]);
            if (error) {
                if (error.code === 'PGRST205' || error.code === '42P01') {
                    saveLocalFallback('pnr_learning', payload);
                }
                else {
                    logger_1.winstonLogger.error(`[PNR_LEARNING] DB error: ${error.message}`);
                }
            }
        }
        catch (err) {
            logger_1.winstonLogger.error(`[PNR_LEARNING] Error: ${err.message}`);
        }
    }
    // ─── STEP 4: Live Train Learning ──────────────────────────────────────
    async logLiveTrain(trainNo, station, delayMins, speedKmh, actualArrival, actualDeparture, providerName) {
        if (global.SYSTEM_MODE === 'MODE_A')
            return;
        try {
            const payload = {
                train_no: trainNo,
                station,
                delay_mins: delayMins,
                speed_kmh: speedKmh,
                actual_arrival: actualArrival,
                actual_departure: actualDeparture
            };
            // Log transaction cost dynamically (fail-safe)
            const provider = (providerName || 'RAILRADAR').trim().toUpperCase();
            if (provider !== 'DATABASE_SCHEDULE') {
                rateService_1.rateService.logTransaction(provider, 'live', null).catch(() => { });
            }
            const { error } = await supabase_1.supabase.from('live_learning').insert([payload]);
            if (error) {
                if (error.code === 'PGRST205' || error.code === '42P01') {
                    saveLocalFallback('live_learning', payload);
                }
                else {
                    logger_1.winstonLogger.error(`[LIVE_LEARNING] DB error: ${error.message}`);
                }
            }
        }
        catch (err) {
            logger_1.winstonLogger.error(`[LIVE_LEARNING] Error: ${err.message}`);
        }
    }
    // ─── STEP 8: Cost Optimization ────────────────────────────────────────
    async trackApiUsage(endpoint) {
        if (global.SYSTEM_MODE === 'MODE_A')
            return;
        try {
            // Use RPC if available, otherwise just use fallback
            const { error } = await supabase_1.supabase.rpc('increment_api_usage', { endpoint_name: endpoint });
            if (error) {
                // Fallback or ignore if table/rpc missing
                saveLocalFallback('api_metrics', { endpoint, timestamp: new Date().toISOString() });
            }
        }
        catch (err) {
            // Silent fail
        }
    }
    // ─── GET TRENDS (Admin) ──────────────────────────────────────────────
    async getDashboardAnalytics(tz = 'Asia/Kolkata') {
        const todayIso = this.getStartOfTodayIso(tz);
        try {
            const [{ count: searchesToday }, { count: splitsToday }, { count: pnrsToday }, { count: livesToday }, { count: searchesAllTime }, { count: splitsAllTime }, { count: pnrsAllTime }, { count: livesAllTime }, { data: apis }] = await Promise.all([
                // Today's counts using authoritative table timestamp columns
                supabase_1.supabase.from('search_history').select('*', { count: 'exact', head: true }).gte('searched_at', todayIso),
                supabase_1.supabase.from('split_learning').select('*', { count: 'exact', head: true }).gte('created_at', todayIso),
                supabase_1.supabase.from('pnr_learning').select('*', { count: 'exact', head: true }).gte('time_checked', todayIso),
                supabase_1.supabase.from('live_learning').select('*', { count: 'exact', head: true }).gte('created_at', todayIso),
                // All-time totals preserved
                supabase_1.supabase.from('search_history').select('*', { count: 'exact', head: true }),
                supabase_1.supabase.from('split_learning').select('*', { count: 'exact', head: true }),
                supabase_1.supabase.from('pnr_learning').select('*', { count: 'exact', head: true }),
                supabase_1.supabase.from('live_learning').select('*', { count: 'exact', head: true }),
                supabase_1.supabase.from('api_metrics').select('*')
            ]);
            return {
                status: 'learning_engine_active',
                tracking: {
                    search_events: searchesToday ?? this.getLocalCount('search_history', todayIso),
                    split_events: splitsToday ?? this.getLocalCount('split_learning', todayIso),
                    pnr_events: pnrsToday ?? this.getLocalCount('pnr_learning', todayIso),
                    live_events: livesToday ?? this.getLocalCount('live_learning', todayIso)
                },
                all_time: {
                    search_events: searchesAllTime ?? this.getLocalCount('search_history'),
                    split_events: splitsAllTime ?? this.getLocalCount('split_learning'),
                    pnr_events: pnrsAllTime ?? this.getLocalCount('pnr_learning'),
                    live_events: livesAllTime ?? this.getLocalCount('live_learning')
                },
                api_usage: apis || []
            };
        }
        catch (err) {
            return { status: 'learning_engine_fallback_only' };
        }
    }
    getStartOfTodayIso(tz = 'Asia/Kolkata') {
        const now = new Date();
        if (tz === 'UTC') {
            return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), 0, 0, 0, 0)).toISOString();
        }
        const dateStr = now.toLocaleDateString('en-CA', { timeZone: 'Asia/Kolkata' });
        return new Date(`${dateStr}T00:00:00+05:30`).toISOString();
    }
    getLocalCount(table, todayIso) {
        try {
            const file = path.join(DATA_DIR, `${table}_fallback.jsonl`);
            if (!fs.existsSync(file))
                return 0;
            const content = fs.readFileSync(file, 'utf8').trim();
            if (!content)
                return 0;
            const lines = content.split('\n');
            if (!todayIso)
                return lines.length;
            let count = 0;
            for (const line of lines) {
                try {
                    const parsed = JSON.parse(line);
                    const ts = parsed.searched_at || parsed.created_at || parsed.time_checked || parsed.timestamp;
                    if (ts && ts >= todayIso) {
                        count++;
                    }
                }
                catch {
                    // Ignore parse errors on individual fallback lines
                }
            }
            return count;
        }
        catch (e) {
            return 0;
        }
    }
    // ─── STEP 6: Historical Prediction ──────────────────────────────────
    async getHistoricalConfirmationRate(initialStatus) {
        try {
            // E.g., 'TQWL-3'
            if (!initialStatus)
                return null;
            const { data, error } = await supabase_1.supabase
                .from('pnr_learning')
                .select('final_status')
                .eq('initial_status', initialStatus)
                .eq('chart_prepared', true);
            if (error || !data || data.length < 5)
                return null; // Need enough data points
            const confirmed = data.filter(r => r.final_status === 'CNF').length;
            return Math.round((confirmed / data.length) * 100);
        }
        catch (err) {
            return null;
        }
    }
    // ─── STEP 5: Smart Split Ranking ────────────────────────────────────
    async getHubSuccessModifier(hub) {
        try {
            const { data, error } = await supabase_1.supabase
                .from('split_learning')
                .select('user_clicked')
                .eq('hub', hub);
            if (error || !data || data.length === 0)
                return 0;
            const clicked = data.filter(r => r.user_clicked).length;
            const rate = clicked / data.length;
            // If hub has > 50% click rate, it's popular
            if (rate > 0.5)
                return 10;
            if (rate < 0.1)
                return -5;
            return 0;
        }
        catch (err) {
            return 0;
        }
    }
    // ─── DELAY INTELLIGENCE: Historical delay stats per train ────────────────
    /**
     * Returns the average delay and on-time percentage for a given train,
     * computed from historical live-tracking data collected in live_learning.
     * Returns null if insufficient data (< MIN_SAMPLE_SIZE records).
     */
    async getTrainDelayStats(trainNo) {
        try {
            // Query last 30 days of live observations for this train
            const since = new Date();
            since.setDate(since.getDate() - 30);
            const { data, error } = await supabase_1.supabase
                .from('live_learning')
                .select('delay_mins')
                .eq('train_no', trainNo)
                .gte('created_at', since.toISOString())
                .not('delay_mins', 'is', null);
            if (error || !data || data.length < MIN_SAMPLE_SIZE)
                return null;
            const totalMins = data.reduce((sum, r) => sum + (Number(r.delay_mins) || 0), 0);
            const avgDelayMins = Math.round(totalMins / data.length);
            const onTimePct = Math.round((data.filter((r) => (Number(r.delay_mins) || 0) <= 5).length / data.length) * 100);
            logger_1.winstonLogger.debug(`[DELAY_INTEL] Train ${trainNo}: avg=${avgDelayMins}m onTime=${onTimePct}% n=${data.length}`);
            return { avgDelayMins, onTimePct, sampleSize: data.length };
        }
        catch (err) {
            logger_1.winstonLogger.debug(`[DELAY_INTEL] getTrainDelayStats failed for ${trainNo}: ${err.message}`);
            return null;
        }
    }
    // ─── STEP 9: PNR Self-Improving Learning Loop ────────────────────────
    async logPrediction(pnr, trainNumber, route, quota, travelClass, wlType, wlPosition, probability, modelVersion) {
        if (global.SYSTEM_MODE === 'MODE_A')
            return;
        try {
            const payload = {
                pnr,
                train_number: trainNumber,
                route,
                quota,
                class: travelClass,
                wl_type: wlType,
                wl_position: wlPosition,
                probability,
                model_version: modelVersion
            };
            const { error } = await supabase_1.supabase.from('pnr_predictions_log').insert([payload]);
            if (error) {
                if (error.code === 'PGRST205' || error.code === '42P01') {
                    saveLocalFallback('pnr_predictions_log', payload);
                }
                else {
                    logger_1.winstonLogger.error(`[PNR_PREDICTION_LOG] DB error: ${error.message}`);
                }
            }
        }
        catch (err) {
            logger_1.winstonLogger.error(`[PNR_PREDICTION_LOG] Error: ${err.message}`);
        }
    }
    /**
     * Returns a learning aggregate for the given entity type and value.
     * IMPORTANT: records with sample_size < MIN_SAMPLE_SIZE (currently 5) are treated as
     * statistically unreliable and discarded — this function returns null for them so the
     * caller falls back to the calibrated heuristic table in pnrController.
     * A single confirmed PNR produces success_rate=100 with sample_size=1, which would
     * otherwise contaminate the GPT prompt and cause wildly inflated predictions.
     */
    async getLearningAggregate(type, value) {
        try {
            // 1. Try Supabase
            const { data, error } = await supabase_1.supabase
                .from('pnr_learning_aggregates')
                .select('success_rate, sample_size')
                .eq('entity_type', type)
                .eq('entity_value', value)
                .maybeSingle();
            if (!error && data) {
                const sampleSize = Number(data.sample_size) || 0;
                // ── Sample-size floor (4C301) ──────────────────────────────────────────
                // Reject sparse aggregates — they are not statistically meaningful.
                if (sampleSize < MIN_SAMPLE_SIZE) {
                    logger_1.winstonLogger.debug(`[LEARNING_AGGREGATE] Rejected ${type}=${value}: sample_size=${sampleSize} < MIN_SAMPLE_SIZE=${MIN_SAMPLE_SIZE}`);
                    return null;
                }
                return {
                    successRate: Number(data.success_rate),
                    sampleSize
                };
            }
        }
        catch (err) { }
        // 2. Try local fallback file
        try {
            const localPath = path.join(DATA_DIR, 'pnr_learning_aggregates_fallback.json');
            if (fs.existsSync(localPath)) {
                const content = fs.readFileSync(localPath, 'utf8');
                const list = JSON.parse(content);
                const match = list.find((item) => item.entity_type === type && item.entity_value === value);
                if (match) {
                    const sampleSize = Number(match.sample_size) || 0;
                    // ── Sample-size floor (local fallback) ────────────────────────────
                    if (sampleSize < MIN_SAMPLE_SIZE) {
                        logger_1.winstonLogger.debug(`[LEARNING_AGGREGATE] Rejected (local) ${type}=${value}: sample_size=${sampleSize} < MIN_SAMPLE_SIZE=${MIN_SAMPLE_SIZE}`);
                        return null;
                    }
                    return {
                        successRate: Number(match.success_rate),
                        sampleSize
                    };
                }
            }
        }
        catch (err) { }
        return null;
    }
    async getFeedbackDrift() {
        try {
            let feedbacks = [];
            // Try Supabase
            try {
                const { data } = await supabase_1.supabase.from('pnr_prediction_feedback').select('*').limit(50);
                feedbacks = data || [];
            }
            catch (err) { }
            // Try local fallback
            const localPath = path.join(DATA_DIR, 'pnr_prediction_feedback_fallback.jsonl');
            if (fs.existsSync(localPath)) {
                const lines = fs.readFileSync(localPath, 'utf8').trim().split('\n');
                for (const line of lines) {
                    if (line) {
                        try {
                            feedbacks.push(JSON.parse(line));
                        }
                        catch (e) { }
                    }
                }
            }
            if (feedbacks.length === 0) {
                return "No recent feedback discrepancies reported.";
            }
            const thumbsUp = feedbacks.filter(f => f.user_feedback === true).length;
            const thumbsDown = feedbacks.filter(f => f.user_feedback === false).length;
            const total = thumbsUp + thumbsDown;
            const accuracy = total > 0 ? Math.round((thumbsUp / total) * 100) : 100;
            const tatkalFeedback = feedbacks.filter(f => f.current_status?.toUpperCase().includes('TQWL'));
            const tatkalThumbsDown = tatkalFeedback.filter(f => f.user_feedback === false).length;
            let trendStr = `Overall feedback accuracy: ${accuracy}% (${thumbsUp} thumbs up, ${thumbsDown} thumbs down).`;
            if (tatkalThumbsDown > 2) {
                trendStr += " WARNING: Users report Tatkal (TQWL) predictions are too optimistic.";
            }
            return trendStr;
        }
        catch (err) {
            return "No recent feedback discrepancies reported.";
        }
    }
    async aggregateLearning() {
        try {
            logger_1.winstonLogger.info('[LEARNING_AGGREGATION] Starting learning aggregation...');
            let logs = [];
            let outcomes = [];
            try {
                const { data: dbLogs } = await supabase_1.supabase.from('pnr_predictions_log').select('*');
                const { data: dbOutcomes } = await supabase_1.supabase.from('pnr_learning').select('*');
                logs = dbLogs || [];
                outcomes = dbOutcomes || [];
            }
            catch (err) {
                logger_1.winstonLogger.warn('[LEARNING_AGGREGATION] Supabase fetch failed, trying local fallback files');
            }
            const logFallbackPath = path.join(DATA_DIR, 'pnr_predictions_log_fallback.jsonl');
            const learningFallbackPath = path.join(DATA_DIR, 'pnr_learning_fallback.jsonl');
            if (fs.existsSync(logFallbackPath)) {
                const lines = fs.readFileSync(logFallbackPath, 'utf8').trim().split('\n');
                for (const line of lines) {
                    if (line) {
                        try {
                            logs.push(JSON.parse(line));
                        }
                        catch (e) { }
                    }
                }
            }
            if (fs.existsSync(learningFallbackPath)) {
                const lines = fs.readFileSync(learningFallbackPath, 'utf8').trim().split('\n');
                for (const line of lines) {
                    if (line) {
                        try {
                            outcomes.push(JSON.parse(line));
                        }
                        catch (e) { }
                    }
                }
            }
            if (logs.length === 0) {
                logger_1.winstonLogger.info('[LEARNING_AGGREGATION] No prediction logs found. Skipping aggregation.');
                return;
            }
            const pnrOutcomes = new Map();
            for (const outcome of outcomes) {
                const isResolved = outcome.chart_prepared || outcome.final_status?.toUpperCase().includes('CNF') || outcome.final_status?.toUpperCase().includes('RAC');
                if (isResolved && outcome.pnr) {
                    pnrOutcomes.set(outcome.pnr, outcome.final_status.toUpperCase());
                }
            }
            const aggregations = {
                route: new Map(),
                train: new Map(),
                quota: new Map(),
                wl_type: new Map()
            };
            for (const log of logs) {
                const outcome = pnrOutcomes.get(log.pnr);
                if (!outcome)
                    continue;
                const isSuccess = outcome.includes('CNF') || outcome.includes('CONFIRMED') || outcome.includes('RAC');
                const addSample = (type, value) => {
                    if (!value)
                        return;
                    const map = aggregations[type];
                    const curr = map.get(value) || { success: 0, total: 0 };
                    curr.total++;
                    if (isSuccess)
                        curr.success++;
                    map.set(value, curr);
                };
                addSample('route', log.route);
                addSample('train', log.train_number);
                addSample('quota', log.quota);
                addSample('wl_type', log.wl_type);
            }
            const entitiesToUpsert = [];
            const processMap = (type) => {
                for (const [value, stats] of Array.from(aggregations[type].entries())) {
                    const successRate = Math.round((stats.success / stats.total) * 100);
                    entitiesToUpsert.push({
                        entity_type: type,
                        entity_value: value,
                        success_rate: successRate,
                        sample_size: stats.total,
                        updated_at: new Date().toISOString()
                    });
                }
            };
            processMap('route');
            processMap('train');
            processMap('quota');
            processMap('wl_type');
            logger_1.winstonLogger.info(`[LEARNING_AGGREGATION] Aggregated ${entitiesToUpsert.length} entities.`);
            let upsertCount = 0;
            if (entitiesToUpsert.length > 0) {
                try {
                    const { error } = await supabase_1.supabase
                        .from('pnr_learning_aggregates')
                        .upsert(entitiesToUpsert, { onConflict: 'entity_type,entity_value' });
                    if (!error) {
                        upsertCount = entitiesToUpsert.length;
                    }
                }
                catch (e) { }
            }
            try {
                const localPath = path.join(DATA_DIR, 'pnr_learning_aggregates_fallback.json');
                (0, supabase_1.safeWriteFileSync)(localPath, JSON.stringify(entitiesToUpsert, null, 2), 'utf8');
                logger_1.winstonLogger.info(`[LEARNING_AGGREGATION] Saved aggregates to local fallback: ${localPath}`);
            }
            catch (err) {
                logger_1.winstonLogger.error(`[LEARNING_AGGREGATION] Local fallback save failed: ${err.message}`);
            }
            logger_1.winstonLogger.info(`[LEARNING_AGGREGATION] Successfully completed. Upserted ${upsertCount} records to Supabase.`);
        }
        catch (err) {
            logger_1.winstonLogger.error(`[LEARNING_AGGREGATION] Critical Error: ${err.message}`);
        }
    }
    // ─── PHASE_4C871: Rescue Outcome Dual-Write ───────────────────────────────
    /**
     * Dual-write rescue telemetry to rescue_outcome_events when KNOWLEDGE_STATS or shadow ON.
     * Does not modify existing split_learning behaviour.
     */
    async logRescueOutcome(params) {
        if (global.SYSTEM_MODE === 'MODE_A')
            return;
        try {
            const { knowledgeService } = require('./knowledgeService');
            await knowledgeService.recordRescueEvent(params.eventType, {
                trainNo: params.trainNo,
                source: params.source,
                destination: params.destination,
                hubStation: params.hubStation,
                journeyDate: params.journeyDate,
                classCode: params.classCode,
                userId: params.userId || undefined,
                deviceId: params.deviceId,
            });
        }
        catch (err) {
            logger_1.winstonLogger.debug(`[RESCUE_OUTCOME_KNOWLEDGE] skipped: ${err.message}`);
        }
    }
}
exports.LearningService = LearningService;
exports.learningService = new LearningService();
