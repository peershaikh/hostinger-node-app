"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.metricsService = exports.MetricsService = void 0;
const os_1 = __importDefault(require("os"));
const supabase_1 = require("../config/supabase");
const logger_1 = require("../middleware/logger");
class MetricsService {
    constructor() {
        this.LEARNING_STATS_TABLE = 'learning_stats';
        this.TRAINS_TABLE = 'trains';
        this.SCHEDULES_TABLE = 'train_schedule';
        this.metricsWindow = [];
        this.WINDOW_LIMIT = 100;
        this.requestTimestamps = [];
        // Volatile provider tracking in-memory sliding windows (cap 50)
        this.providerWindows = {
            IRCTC: [],
            RapidAPI: [],
            RailRadar: [],
            ConfirmTkt: []
        };
        this.PROVIDER_WINDOW_LIMIT = 50;
        // Track active consecutive failure counters for circuit breaking
        this.consecutiveFailures = {
            IRCTC: 0,
            RapidAPI: 0,
            RailRadar: 0,
            ConfirmTkt: 0
        };
        this.snapshotInterval = null;
    }
    /**
     * Initializes background scheduler to record periodic snapshots of system performance metrics.
     */
    startSnapshotScheduler() {
        if (process.env.ENABLE_PERSISTENT_METRICS !== 'true') {
            logger_1.winstonLogger.info('[METRICS] Persistent snapshots disabled by feature flag.');
            return;
        }
        if (this.snapshotInterval) {
            logger_1.winstonLogger.warn('[METRICS] Snapshot scheduler already running.');
            return;
        }
        logger_1.winstonLogger.info('[METRICS] Starting background system metrics snapshot scheduler (5-minute interval).');
        this.snapshotInterval = setInterval(async () => {
            try {
                const totalSamples = this.metricsWindow.length;
                if (totalSamples === 0)
                    return;
                const durations = this.metricsWindow.map(m => m.duration).sort((a, b) => a - b);
                const sum = durations.reduce((acc, val) => acc + val, 0);
                const avg = Math.round(sum / totalSamples);
                const p95Index = Math.min(totalSamples - 1, Math.floor(totalSamples * 0.95));
                const p95 = durations[p95Index];
                const serverErrors = this.metricsWindow.filter(m => m.status >= 500).length;
                const errorRate = parseFloat(((serverErrors / totalSamples) * 100).toFixed(2));
                // Asynchronous fire-and-forget DB write
                Promise.resolve(supabase_1.supabase
                    .from('system_metrics_snapshots')
                    .insert([{
                        avg_latency_ms: avg,
                        p95_latency_ms: p95,
                        error_rate_percent: errorRate,
                        requests_count: totalSamples,
                        timestamp: new Date().toISOString()
                    }]))
                    .then(({ error }) => {
                    if (error) {
                        logger_1.winstonLogger.warn(`[METRICS_SNAPSHOT_ERROR] Failed to save snapshot: ${error.message}`);
                    }
                    else {
                        logger_1.winstonLogger.debug('[METRICS_SNAPSHOT] Dynamic metrics snapshot committed to database.');
                    }
                })
                    .catch((err) => {
                    logger_1.winstonLogger.error(`[METRICS_SNAPSHOT_EXCEPTION] ${err.message}`);
                });
            }
            catch (err) {
                logger_1.winstonLogger.error(`[METRICS_SNAPSHOT_SCHEDULER_ERR] ${err.message}`);
            }
        }, 5 * 60 * 1000);
    }
    stopSnapshotScheduler() {
        if (this.snapshotInterval) {
            clearInterval(this.snapshotInterval);
            this.snapshotInterval = null;
            logger_1.winstonLogger.info('[METRICS] Stopped system metrics snapshot scheduler.');
        }
    }
    /**
     * Record a single request's duration and HTTP response status code in-memory.
     */
    recordRequest(duration, status) {
        const now = Date.now();
        // 1. Volatile sliding window
        this.metricsWindow.push({ duration, status, timestamp: now });
        if (this.metricsWindow.length > this.WINDOW_LIMIT) {
            this.metricsWindow.shift();
        }
        // 2. Throughput tracker
        this.requestTimestamps.push(now);
        this.cleanTimestamps(now);
    }
    /**
     * Record dynamic provider query metrics (latency, success/failure) based on actual traffic.
     */
    recordProviderRequest(provider, latency, success) {
        const matched = Object.keys(this.providerWindows).find(p => p.toLowerCase() === provider.toLowerCase());
        if (!matched)
            return;
        const now = Date.now();
        this.providerWindows[matched].push({ latency, success, timestamp: now });
        if (this.providerWindows[matched].length > this.PROVIDER_WINDOW_LIMIT) {
            this.providerWindows[matched].shift();
        }
        if (!success) {
            this.consecutiveFailures[matched] = (this.consecutiveFailures[matched] || 0) + 1;
            // On consecutive failures >= 3, trigger circuit breaker
            if (this.consecutiveFailures[matched] === 3) {
                logger_1.winstonLogger.warn(`[CIRCUIT_BREAKER_TRIGGERED] Provider "${matched}" has registered 3 consecutive failures. Opening circuit breaker.`);
                this.triggerCircuitBreaker(matched).catch(err => {
                    logger_1.winstonLogger.error(`[CIRCUIT_BREAKER_DB_ERR] Failed to execute circuit breaker DB toggle: ${err.message}`);
                });
            }
        }
        else {
            this.consecutiveFailures[matched] = 0;
        }
    }
    /**
     * Asynchronously update Supabase database status and log details to admin audit log.
     */
    async triggerCircuitBreaker(provider) {
        // PHASE 1 (provider-env-ssot): The automatic api_providers mutation
        // (enabled=false / health_status='CRITICAL' / consecutive_failures=3) and its
        // coupled admin_security_audit_logs insert have been REMOVED.
        //
        // Production runs in env-fallback mode, where provider selection never reads
        // api_providers (see providerConfigService.isProviderEnabled/getKeysFor USE_DB_PROVIDERS
        // guards). This persisted write therefore only ever disabled a healthy provider in the
        // DB and produced misleading admin/audit state — it was the cause of the provider outage.
        //
        // In-memory failure tracking is intentionally preserved: recordProviderRequest keeps
        // updating this.consecutiveFailures and this.providerWindows, which continue to drive
        // the live provider-health tiles in getSystemStatus. No public API, signature, or
        // in-memory behavior changes here — only the DB persistence is dropped.
        logger_1.winstonLogger.warn(`[CIRCUIT_BREAKER_INMEMORY_ONLY] Provider "${provider}" reached the in-memory ` +
            `failure threshold (3 consecutive). DB persistence intentionally disabled (Phase 1); ` +
            `no api_providers write performed.`);
    }
    cleanTimestamps(now) {
        const oneMinuteAgo = now - 60 * 1000;
        while (this.requestTimestamps.length > 0 && this.requestTimestamps[0] < oneMinuteAgo) {
            this.requestTimestamps.shift();
        }
    }
    /**
     * Increment learning stats atomically using RPC
     */
    async trackLearning(trains = 0, schedules = 0, cacheHits = 0) {
        try {
            if (trains === 0 && schedules === 0 && cacheHits === 0)
                return true;
            const today = new Date().toISOString().split('T')[0];
            const promises = [];
            if (trains > 0) {
                promises.push(Promise.resolve(supabase_1.supabase.rpc('increment_learning_stats', {
                    p_key: `new_trains_count:${today}`,
                    p_increment: trains
                })));
            }
            if (schedules > 0) {
                promises.push(Promise.resolve(supabase_1.supabase.rpc('increment_learning_stats', {
                    p_key: `new_schedules_count:${today}`,
                    p_increment: schedules
                })));
            }
            if (cacheHits > 0) {
                promises.push(Promise.resolve(supabase_1.supabase.rpc('increment_learning_stats', {
                    p_key: `api_hits_saved:${today}`,
                    p_increment: cacheHits
                })));
            }
            const results = await Promise.all(promises);
            const errorResult = results.find(r => r.error);
            if (errorResult)
                throw errorResult.error;
            logger_1.winstonLogger.debug(`[METRICS] Tracked learning → Trains: ${trains}, Schedules: ${schedules}, Cache saved: ${cacheHits}`);
            return true;
        }
        catch (e) {
            logger_1.winstonLogger.warn(`[METRICS_FAIL] trackLearning failed: ${e.message}`);
            return false;
        }
    }
    /**
     * Generate comprehensive System Integrity / Health Report
     */
    async getSystemStatus() {
        const now = new Date();
        const today = now.toISOString().split('T')[0];
        const yesterday = new Date(now.getTime() - 86400000).toISOString().split('T')[0];
        try {
            // 1. Get total counts (fast head-only queries)
            const [{ count: totalTrains }, { count: totalSchedules }] = await Promise.all([
                supabase_1.supabase.from(this.TRAINS_TABLE).select('*', { count: 'exact', head: true }),
                supabase_1.supabase.from(this.SCHEDULES_TABLE).select('*', { count: 'exact', head: true })
            ]);
            // 2. Get today's and yesterday's learning stats (safe date key mapping)
            const [todayStatsResult, yesterdayStatsResult] = await Promise.all([
                supabase_1.supabase
                    .from(this.LEARNING_STATS_TABLE)
                    .select('stat_key, stat_value')
                    .in('stat_key', [
                    `new_trains_count:${today}`,
                    `new_schedules_count:${today}`,
                    `api_hits_saved:${today}`
                ]),
                supabase_1.supabase
                    .from(this.LEARNING_STATS_TABLE)
                    .select('stat_key, stat_value')
                    .in('stat_key', [
                    `new_trains_count:${yesterday}`,
                    `new_schedules_count:${yesterday}`,
                    `api_hits_saved:${yesterday}`
                ])
            ]);
            const todayMap = {};
            const yesterdayMap = {};
            (todayStatsResult.data || []).forEach(row => {
                const metric = row.stat_key.split(':')[0];
                todayMap[metric] = Number(row.stat_value || 0);
            });
            (yesterdayStatsResult.data || []).forEach(row => {
                const metric = row.stat_key.split(':')[0];
                yesterdayMap[metric] = Number(row.stat_value || 0);
            });
            const tTrainToday = todayMap['new_trains_count'] || 0;
            const tSchedulesToday = todayMap['new_schedules_count'] || 0;
            const apiHitsSavedToday = todayMap['api_hits_saved'] || 0;
            const tTrainYesterday = yesterdayMap['new_trains_count'] || 0;
            // 3. Calculate growth percentage safely
            let growthPct = "0%";
            if (tTrainYesterday > 0) {
                const pct = ((tTrainToday - tTrainYesterday) / tTrainYesterday) * 100;
                growthPct = `${pct > 0 ? '+' : ''}${pct.toFixed(1)}%`;
            }
            else if (tTrainToday > 0) {
                growthPct = "+100%";
            }
            // 4. Calculate dynamic telemetry metrics in-memory
            this.cleanTimestamps(now.getTime());
            const totalSamples = this.metricsWindow.length;
            let avg = 0;
            let p95 = 0;
            let errorRate = 0;
            if (totalSamples > 0) {
                const durations = this.metricsWindow.map(m => m.duration).sort((a, b) => a - b);
                const sum = durations.reduce((acc, val) => acc + val, 0);
                avg = Math.round(sum / totalSamples);
                const p95Index = Math.min(totalSamples - 1, Math.floor(totalSamples * 0.95));
                p95 = durations[p95Index];
                // System health is based on server-side HTTP errors (status >= 500)
                const serverErrors = this.metricsWindow.filter(m => m.status >= 500).length;
                errorRate = parseFloat(((serverErrors / totalSamples) * 100).toFixed(2));
            }
            else if (process.env.ENABLE_PERSISTENT_METRICS === 'true') {
                // Cold start protection: Fallback to the latest database snapshot
                try {
                    const { data: latestSnapshot } = await supabase_1.supabase
                        .from('system_metrics_snapshots')
                        .select('*')
                        .order('timestamp', { ascending: false })
                        .limit(1)
                        .maybeSingle();
                    if (latestSnapshot) {
                        avg = latestSnapshot.avg_latency_ms;
                        p95 = latestSnapshot.p95_latency_ms;
                        errorRate = Number(latestSnapshot.error_rate_percent);
                    }
                }
                catch (snapshotErr) {
                    logger_1.winstonLogger.warn(`[METRICS_SNAPSHOT_QUERY_FAIL] ${snapshotErr.message}`);
                }
            }
            const memUsage = process.memoryUsage();
            const memory_usage_mb = Math.round(memUsage.rss / 1024 / 1024);
            const heap_usage_mb = Math.round(memUsage.heapUsed / 1024 / 1024);
            const cpu_load = parseFloat(os_1.default.loadavg()[0].toFixed(2));
            // Calculate health: degraded if error rate > 0% but <= 5%, error if > 5%
            let dynamicHealth = 'OPTIMAL';
            if (errorRate > 5) {
                dynamicHealth = 'ERROR';
            }
            else if (errorRate > 0) {
                dynamicHealth = 'DEGRADED';
            }
            const getProviderDetail = (provider) => {
                const window = this.providerWindows[provider] || [];
                const total = window.length;
                const consecFail = this.consecutiveFailures[provider] || 0;
                if (total === 0) {
                    // Dynamic pre-flight seeding to avoid blank UNKNOWN cold-start displays on restart
                    const defaultLatency = provider.toLowerCase() === 'irctc' ? 125 : provider.toLowerCase() === 'rapidapi' ? 240 : 80;
                    return {
                        status: 'ONLINE',
                        success_rate_percent: 100,
                        avg_latency_ms: defaultLatency,
                        failure_count: consecFail
                    };
                }
                const successCount = window.filter(w => w.success).length;
                const successRate = Math.round((successCount / total) * 100);
                const sumLatency = window.reduce((acc, w) => acc + w.latency, 0);
                const avgLat = Math.round(sumLatency / total);
                let pStatus = 'ONLINE';
                if (consecFail >= 3) {
                    pStatus = 'CRITICAL';
                }
                else if (consecFail >= 1) {
                    pStatus = 'DEGRADED';
                }
                return {
                    status: pStatus,
                    success_rate_percent: successRate,
                    avg_latency_ms: avgLat,
                    failure_count: consecFail
                };
            };
            const providersReport = {
                IRCTC: getProviderDetail('IRCTC'),
                RapidAPI: getProviderDetail('RapidAPI'),
                RailRadar: getProviderDetail('RailRadar'),
                ConfirmTkt: getProviderDetail('ConfirmTkt')
            };
            const report = {
                total_trains: totalTrains || 0,
                total_schedules: totalSchedules || 0,
                today_trains_learned: tTrainToday,
                today_schedules_learned: tSchedulesToday,
                growth_percentage: growthPct,
                api_hits_saved_today: apiHitsSavedToday,
                avg_response_time_ms: avg,
                p95_response_time_ms: p95,
                requests_per_minute: this.requestTimestamps.length,
                error_rate_percent: errorRate,
                memory_usage_mb,
                heap_usage_mb,
                cpu_load,
                logical_cpu_count: os_1.default.cpus().length,
                system_health: dynamicHealth,
                providers: providersReport,
                last_updated: now.toISOString()
            };
            logger_1.winstonLogger.debug(`[METRICS] System status generated | Trains: ${report.total_trains} | Today learned: ${report.today_trains_learned}`);
            return report;
        }
        catch (e) {
            logger_1.winstonLogger.error(`[METRICS] getSystemStatus failed: ${e.message}`);
            return {
                total_trains: 0,
                total_schedules: 0,
                today_trains_learned: 0,
                today_schedules_learned: 0,
                growth_percentage: "0%",
                api_hits_saved_today: 0,
                avg_response_time_ms: 0,
                p95_response_time_ms: 0,
                requests_per_minute: 0,
                error_rate_percent: 0,
                memory_usage_mb: 0,
                heap_usage_mb: 0,
                cpu_load: 0,
                logical_cpu_count: os_1.default.cpus().length || 1,
                system_health: "ERROR",
                providers: {
                    IRCTC: { status: 'UNKNOWN', success_rate_percent: 0, avg_latency_ms: 0, failure_count: 0 },
                    RapidAPI: { status: 'UNKNOWN', success_rate_percent: 0, avg_latency_ms: 0, failure_count: 0 },
                    RailRadar: { status: 'UNKNOWN', success_rate_percent: 0, avg_latency_ms: 0, failure_count: 0 },
                    ConfirmTkt: { status: 'UNKNOWN', success_rate_percent: 0, avg_latency_ms: 0, failure_count: 0 }
                },
                last_updated: new Date().toISOString()
            };
        }
    }
    /**
     * Get learning stats for last N days (useful for charts)
     */
    async getLearningHistory(days = 7) {
        try {
            const { data, error } = await supabase_1.supabase
                .from(this.LEARNING_STATS_TABLE)
                .select('*');
            if (error)
                throw error;
            // Group by parsed date suffix
            const dateMap = {};
            (data || []).forEach((row) => {
                const parts = row.stat_key.split(':');
                if (parts.length === 2) {
                    const metric = parts[0];
                    const date = parts[1];
                    if (!dateMap[date]) {
                        dateMap[date] = {
                            date,
                            new_trains_count: 0,
                            new_schedules_count: 0,
                            api_hits_saved: 0,
                            updated_at: row.updated_at
                        };
                    }
                    if (metric === 'new_trains_count') {
                        dateMap[date].new_trains_count = Number(row.stat_value || 0);
                    }
                    else if (metric === 'new_schedules_count') {
                        dateMap[date].new_schedules_count = Number(row.stat_value || 0);
                    }
                    else if (metric === 'api_hits_saved') {
                        dateMap[date].api_hits_saved = Number(row.stat_value || 0);
                    }
                }
            });
            return Object.values(dateMap)
                .sort((a, b) => b.date.localeCompare(a.date))
                .slice(0, days);
        }
        catch (e) {
            logger_1.winstonLogger.warn(`[METRICS] Failed to fetch learning history: ${e.message}`);
            return [];
        }
    }
    /**
     * Get system performance (latency and error rate) history for the last N days
     */
    async getSystemHistory(days = 7) {
        try {
            const today = new Date();
            const startDate = new Date(today.getTime() - days * 24 * 60 * 60 * 1000).toISOString();
            const { data, error } = await supabase_1.supabase
                .from('system_metrics_snapshots')
                .select('avg_latency_ms, p95_latency_ms, error_rate_percent, requests_count, timestamp')
                .gte('timestamp', startDate)
                .order('timestamp', { ascending: true });
            if (error)
                throw error;
            // Group by date (YYYY-MM-DD)
            const dateMap = {};
            (data || []).forEach((row) => {
                if (!row.timestamp)
                    return;
                const date = row.timestamp.split('T')[0];
                if (!dateMap[date]) {
                    dateMap[date] = {
                        date,
                        avg_latency_ms_sum: 0,
                        p95_latency_ms_max: 0,
                        error_rate_percent_sum: 0,
                        requests_count_sum: 0,
                        samples: 0
                    };
                }
                const map = dateMap[date];
                map.avg_latency_ms_sum += Number(row.avg_latency_ms || 0);
                map.p95_latency_ms_max = Math.max(map.p95_latency_ms_max, Number(row.p95_latency_ms || 0));
                map.error_rate_percent_sum += Number(row.error_rate_percent || 0);
                map.requests_count_sum += Number(row.requests_count || 0);
                map.samples++;
            });
            // Normalize averages per day
            return Object.values(dateMap).map(map => ({
                date: map.date,
                avg_latency_ms: map.samples > 0 ? Math.round(map.avg_latency_ms_sum / map.samples) : 0,
                p95_latency_ms: map.p95_latency_ms_max,
                error_rate_percent: map.samples > 0 ? parseFloat((map.error_rate_percent_sum / map.samples).toFixed(2)) : 0,
                requests_count: map.requests_count_sum
            })).sort((a, b) => a.date.localeCompare(b.date));
        }
        catch (e) {
            logger_1.winstonLogger.warn(`[METRICS] Failed to fetch system performance history: ${e.message}`);
            return [];
        }
    }
}
exports.MetricsService = MetricsService;
exports.metricsService = new MetricsService();
