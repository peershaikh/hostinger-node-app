"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.alarmWorker = exports.AlarmWorker = void 0;
const supabase_1 = require("../config/supabase");
const logger_1 = require("../middleware/logger");
const liveTrackingService_1 = require("../services/liveTrackingService");
const stationService_1 = require("../services/stationService");
const alertService_1 = require("../services/alertService");
const alarmController_1 = require("../controllers/alarmController");
// ─── Adaptive Polling Intervals ───────────────────────────────────────────────
// Interval is selected based on the nearest active alarm's distance from its
// destination. High-speed trains (130 km/h) cover ~1.1 km in 30 seconds, so
// polling at 30s when within 25km ensures the 20km geofence is never missed.
function getAdaptiveIntervalMs(minDistanceKm) {
    if (minDistanceKm === null)
        return 10 * 60 * 1000; // 10 min — no distance known yet
    if (minDistanceKm <= 25)
        return 30 * 1000; // 30 sec — critical proximity
    if (minDistanceKm <= 50)
        return 2 * 60 * 1000; // 2 min  — approaching
    if (minDistanceKm <= 100)
        return 5 * 60 * 1000; // 5 min  — moderate distance
    return 10 * 60 * 1000; // 10 min — far away
}
class AlarmWorker {
    constructor() {
        this.timer = null;
        this.isProcessing = false;
        // Tracks last known distance (km) per unique train number across cycles.
        // Used to compute the adaptive poll interval without additional DB queries.
        this.trainDistanceCache = new Map();
    }
    start() {
        if (this.timer)
            return;
        logger_1.winstonLogger.info('⏰ Alarm Background Worker: Starting background engine');
        this.run();
    }
    stop() {
        if (this.timer) {
            clearTimeout(this.timer);
            this.timer = null;
            logger_1.winstonLogger.info('🛑 Alarm Worker stopped');
        }
    }
    async run() {
        if (this.isProcessing)
            return;
        this.isProcessing = true;
        try {
            await this.processAlarms();
        }
        catch (err) {
            logger_1.winstonLogger.error(`[ALARM_WORKER] Error in alarm cycle: ${err.message}`);
        }
        finally {
            this.isProcessing = false;
            // ── Adaptive interval: pick next poll time based on nearest alarm ──────
            const minDistance = this.computeMinDistance();
            const nextIntervalMs = getAdaptiveIntervalMs(minDistance);
            const nextLabel = nextIntervalMs < 60000
                ? `${nextIntervalMs / 1000}s`
                : `${nextIntervalMs / 60000}min`;
            logger_1.winstonLogger.debug(`[ALARM_WORKER] Next cycle in ${nextLabel}` +
                (minDistance !== null ? ` (nearest alarm: ${minDistance.toFixed(1)} km)` : ' (no distance data)'));
            this.timer = setTimeout(() => this.run(), nextIntervalMs);
        }
    }
    /** Returns the minimum distance across all currently tracked trains, or null. */
    computeMinDistance() {
        if (this.trainDistanceCache.size === 0)
            return null;
        let min = Infinity;
        for (const dist of this.trainDistanceCache.values()) {
            if (dist < min)
                min = dist;
        }
        return isFinite(min) ? min : null;
    }
    async processAlarms() {
        // ── STEP 1: Fetch distinct active train numbers from DB ──────────────────
        // This is the core scalability change: instead of SELECT * (O(n) rows),
        // we fetch only the unique train numbers that need live status checks.
        let activeTrainNumbers = [];
        let dbAvailable = false;
        try {
            const { data, error } = await supabase_1.supabase
                .from('user_station_alarms')
                .select('train_no')
                .eq('enabled', true);
            if (!error && data) {
                // De-duplicate in application layer (DISTINCT not directly available via JS client)
                const trainSet = new Set(data.map((row) => row.train_no));
                activeTrainNumbers = Array.from(trainSet);
                dbAvailable = true;
            }
            else if (error && error.code !== '42P01') {
                // 42P01 = table does not exist yet — fall through to memory
                throw error;
            }
        }
        catch (dbErr) {
            logger_1.winstonLogger.debug(`[ALARM_WORKER] DB fetch failed (table may be missing). Falling back to memory: ${dbErr.message}`);
        }
        // ── STEP 2: Merge memory-only trains (active during migration window) ────
        const memoryActive = Array.from(alarmController_1.MEMORY_ALARMS.values()).filter(a => a.enabled);
        for (const memAlarm of memoryActive) {
            if (!activeTrainNumbers.includes(memAlarm.train_no)) {
                activeTrainNumbers.push(memAlarm.train_no);
            }
        }
        if (activeTrainNumbers.length === 0) {
            // No active alarms — clear distance cache so interval resets to 10min
            this.trainDistanceCache.clear();
            return;
        }
        logger_1.winstonLogger.info(`[ALARM_WORKER] Processing ${activeTrainNumbers.length} unique active train(s).`);
        const todayStr = new Date().toISOString().split('T')[0];
        // ── STEP 3: Process each unique active train ─────────────────────────────
        for (const trainNo of activeTrainNumbers) {
            try {
                // Fetch all active alarms for this train number
                let trainAlarms = [];
                if (dbAvailable) {
                    const { data: dbAlarms, error: alarmErr } = await supabase_1.supabase
                        .from('user_station_alarms')
                        .select('*')
                        .eq('train_no', trainNo)
                        .eq('enabled', true);
                    if (!alarmErr && dbAlarms) {
                        trainAlarms = dbAlarms;
                    }
                }
                // Merge memory alarms for this train (de-duplicate by id)
                const dbIds = new Set(trainAlarms.map(a => a.id));
                for (const memAlarm of memoryActive) {
                    if (memAlarm.train_no === trainNo && !dbIds.has(memAlarm.id)) {
                        trainAlarms.push(memAlarm);
                    }
                }
                if (trainAlarms.length === 0)
                    continue;
                logger_1.winstonLogger.info(`[ALARM_WORKER] Fetching live status for train ${trainNo} (${trainAlarms.length} alarm(s))`);
                const status = await liveTrackingService_1.liveTrackingService.getTrainRunningStatus(trainNo, todayStr);
                if (!status) {
                    logger_1.winstonLogger.warn(`[ALARM_WORKER] Live status not available for train ${trainNo}`);
                    continue;
                }
                // ── STEP 4: Evaluate each alarm for this train ───────────────────────
                // Track the nearest alarm distance for this train to update the cache
                let nearestDistanceForTrain = null;
                for (const alarm of trainAlarms) {
                    const distance = await this.evaluateAlarmProximity(alarm, status);
                    if (distance !== null) {
                        if (nearestDistanceForTrain === null || distance < nearestDistanceForTrain) {
                            nearestDistanceForTrain = distance;
                        }
                    }
                }
                // Update the distance cache for adaptive interval calculation
                if (nearestDistanceForTrain !== null) {
                    this.trainDistanceCache.set(trainNo, nearestDistanceForTrain);
                }
                else {
                    this.trainDistanceCache.delete(trainNo);
                }
            }
            catch (trainErr) {
                logger_1.winstonLogger.error(`[ALARM_WORKER] Failed to process train ${trainNo}: ${trainErr.message}`);
            }
        }
        // Evict stale train entries from the cache (trains no longer active)
        const activeSet = new Set(activeTrainNumbers);
        for (const cachedTrain of this.trainDistanceCache.keys()) {
            if (!activeSet.has(cachedTrain)) {
                this.trainDistanceCache.delete(cachedTrain);
            }
        }
    }
    /**
     * Evaluates a single alarm against the train's live status.
     * Returns the distance in km (for cache updates), or null if it could not be determined.
     * A return of null does NOT indicate an error — it means GPS and station coords were unavailable.
     */
    async evaluateAlarmProximity(alarm, status) {
        try {
            const destCoords = await stationService_1.stationService.getCoordinates(alarm.destination_station);
            if (!destCoords) {
                logger_1.winstonLogger.warn(`[ALARM_WORKER] Cannot find coordinates for target station: ${alarm.destination_station}`);
                return null;
            }
            let distanceKm = null;
            // Method A: GPS Proximity (Primary — preferred if live coordinates are available)
            if (status.latitude && status.longitude) {
                distanceKm = this.calculateHaversine(Number(status.latitude), Number(status.longitude), destCoords.lat, destCoords.lon);
                logger_1.winstonLogger.debug(`[ALARM_WORKER] GPS check: Train ${alarm.train_no} is ${distanceKm.toFixed(2)} km from ${alarm.destination_station}`);
            }
            // Method B: Current Station Proximity (Fallback when GPS coords absent)
            else if (status.current_station) {
                const currentStationCode = status.journey_timeline?.[status.current_station_index || 0]?.station_code ||
                    status.current_station;
                const currentCoords = await stationService_1.stationService.getCoordinates(currentStationCode);
                if (currentCoords) {
                    distanceKm = this.calculateHaversine(currentCoords.lat, currentCoords.lon, destCoords.lat, destCoords.lon);
                    logger_1.winstonLogger.debug(`[ALARM_WORKER] Station fallback: Train ${alarm.train_no} at ${currentStationCode} is ${distanceKm.toFixed(2)} km from ${alarm.destination_station}`);
                }
            }
            // ── Trigger alert if within radius ────────────────────────────────────
            if (distanceKm !== null && distanceKm <= alarm.radius_km) {
                logger_1.winstonLogger.info(`[ALARM_WORKER] 🚨 Alarm TRIGGERED: Train ${alarm.train_no} is within ${distanceKm.toFixed(1)}km of ${alarm.destination_station}`);
                // Atomic disable first — prevents duplicate triggers under concurrent cycles
                const disabled = await this.atomicDisableAlarm(alarm.id);
                if (!disabled) {
                    // Another cycle already triggered this alarm
                    logger_1.winstonLogger.warn(`[ALARM_WORKER] Alarm ${alarm.id} already disabled — skipping duplicate dispatch`);
                    return distanceKm;
                }
                // Queue alert via the existing notification pipeline
                await alertService_1.alertService.queueAlert({
                    userId: alarm.user_id || alarm.device_id,
                    type: 'WAKEUP_ALARM',
                    priority: 'HIGH',
                    metadata: {
                        trainNo: alarm.train_no,
                        station: alarm.destination_station,
                        distance: distanceKm.toFixed(1),
                        device_id: alarm.device_id,
                        title: `🚄 Proximity Alert: Train ${alarm.train_no}`,
                        message: `Wake up! Your train is ${distanceKm.toFixed(1)} km away from ${alarm.destination_station}.`
                    }
                });
            }
            return distanceKm;
        }
        catch (err) {
            logger_1.winstonLogger.error(`[ALARM_WORKER] Failed to evaluate alarm ${alarm.id}: ${err.message}`);
            return null;
        }
    }
    /**
     * Atomically disables an alarm using a conditional UPDATE.
     * The WHERE clause checks enabled = true — if the alarm was already disabled
     * by another process/cycle, rowCount will be 0 and this returns false.
     */
    async atomicDisableAlarm(alarmId) {
        try {
            // Supabase does not expose rowCount directly; use a select-then-update strategy
            const { data, error } = await supabase_1.supabase
                .from('user_station_alarms')
                .update({ enabled: false, updated_at: new Date().toISOString() })
                .eq('id', alarmId)
                .eq('enabled', true) // Atomic condition — only updates if still enabled
                .select('id');
            if (error)
                throw error;
            if (data && data.length > 0) {
                logger_1.winstonLogger.info(`[ALARM_WORKER] Atomically disabled alarm ${alarmId} in Supabase`);
                return true;
            }
            // 0 rows updated = already disabled by another cycle
            return false;
        }
        catch (e) {
            logger_1.winstonLogger.debug(`[ALARM_WORKER] Supabase atomic disable failed, disabling in memory: ${e.message}`);
            const mem = alarmController_1.MEMORY_ALARMS.get(alarmId);
            if (mem && mem.enabled) {
                alarmController_1.MEMORY_ALARMS.set(alarmId, {
                    ...mem,
                    enabled: false,
                    updated_at: new Date().toISOString()
                });
                logger_1.winstonLogger.info(`[ALARM_WORKER] Disabled alarm ${alarmId} in memory`);
                return true;
            }
            // Already disabled in memory too
            return false;
        }
    }
    calculateHaversine(lat1, lon1, lat2, lon2) {
        const R = 6371; // Radius of earth in km
        const dLat = ((lat2 - lat1) * Math.PI) / 180;
        const dLon = ((lon2 - lon1) * Math.PI) / 180;
        const a = Math.sin(dLat / 2) * Math.sin(dLat / 2) +
            Math.cos((lat1 * Math.PI) / 180) * Math.cos((lat2 * Math.PI) / 180) *
                Math.sin(dLon / 2) * Math.sin(dLon / 2);
        const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
        return R * c;
    }
}
exports.AlarmWorker = AlarmWorker;
exports.alarmWorker = new AlarmWorker();
