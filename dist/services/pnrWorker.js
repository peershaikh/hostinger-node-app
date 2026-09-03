"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.pnrWorker = exports.PnrWorker = void 0;
const supabase_1 = require("../config/supabase");
const logger_1 = require("../middleware/logger");
const analyticsService_1 = require("./analyticsService");
const cacheService_1 = require("./cacheService");
const pnrTrackingService_1 = require("./pnrTrackingService");
const alertService_1 = require("./alertService");
const pnrNormalizer_1 = require("../utils/pnrNormalizer");
const feedbackSyncService_1 = require("./feedbackSyncService");
class PnrWorker {
    constructor() {
        this.timer = null;
        this.isProcessing = false;
        this.lastCleanupTime = 0;
        this.POLL_INTERVAL_MS = 5 * 60 * 1000; // 5 minutes
    }
    /**
     * Starts the background PNR polling worker
     */
    start() {
        if (this.timer)
            return;
        logger_1.winstonLogger.info('🚀 PNR Adaptive Worker: Starting background engine');
        this.run();
    }
    stop() {
        if (this.timer) {
            clearTimeout(this.timer);
            this.timer = null;
            logger_1.winstonLogger.info('🛑 PNR Worker stopped');
        }
    }
    async run() {
        try {
            // Sync offline feedbacks
            try {
                await feedbackSyncService_1.feedbackSyncService.syncAllFallbacks();
            }
            catch (syncErr) {
                logger_1.winstonLogger.error(`[PNR_WORKER] Feedback sync failed: ${syncErr.message}`);
            }
            await this.processAllPnrs();
            // Daily cleanup checks (run every 12 hours)
            const now = Date.now();
            if (now - this.lastCleanupTime > 12 * 60 * 60 * 1000) {
                await this.cleanupExpiredPnrs();
                this.lastCleanupTime = now;
            }
        }
        catch (err) {
            logger_1.winstonLogger.error(`[PNR_WORKER] Critical error in run cycle: ${err.message}`);
        }
        finally {
            // Schedule next run
            this.timer = setTimeout(() => this.run(), this.POLL_INTERVAL_MS);
        }
    }
    parseDate(dateStr) {
        if (!dateStr || dateStr === 'N/A')
            return null;
        // Extract date portion if time is appended (e.g. "08/06/26 8:05 PM" -> "08/06/26")
        const datePart = dateStr.trim().split(/\s+/)[0];
        // Split on slashes or hyphens
        const parts = datePart.split(/[-/]/);
        if (parts.length === 3) {
            let dd, mm, yyyy;
            if (parts[0].length === 4) {
                // Format: YYYY-MM-DD or YYYY/MM/DD
                yyyy = parts[0];
                mm = parts[1].padStart(2, '0');
                dd = parts[2].padStart(2, '0');
            }
            else {
                // Format: DD-MM-YYYY, DD/MM/YYYY, DD-MM-YY
                dd = parts[0].padStart(2, '0');
                mm = parts[1].padStart(2, '0');
                const yy = parts[2];
                yyyy = yy.length === 2 ? `20${yy}` : yy;
            }
            const d = new Date(`${yyyy}-${mm}-${dd}T00:00:00Z`);
            if (!isNaN(d.getTime())) {
                return d;
            }
        }
        const d = new Date(dateStr);
        return isNaN(d.getTime()) ? null : d;
    }
    async processAllPnrs() {
        if (this.isProcessing) {
            logger_1.winstonLogger.debug('[PNR_WORKER] Already processing - skipping this cycle');
            return;
        }
        this.isProcessing = true;
        const startTime = Date.now();
        try {
            const { data: pnrs, error } = await supabase_1.supabase
                .from('pnr_tracking')
                .select('*')
                .order('last_updated', { ascending: true }); // oldest first for fairness
            if (error) {
                if (error.code !== '42P01')
                    throw error;
                logger_1.winstonLogger.warn('[PNR_WORKER] pnr_tracking table not found');
                return;
            }
            if (!pnrs || pnrs.length === 0) {
                logger_1.winstonLogger.debug('[PNR_WORKER] No PNRs to process');
                return;
            }
            logger_1.winstonLogger.info(`[PNR_WORKER] Checking ${pnrs.length} tracked PNRs...`);
            let processed = 0;
            let changed = 0;
            for (const record of pnrs) {
                if (await this.shouldPoll(record)) {
                    const statusChanged = await this.updatePnrStatus(record);
                    if (statusChanged)
                        changed++;
                    processed++;
                    // Small delay to be gentle on API quota
                    if (processed % 5 === 0) {
                        await new Promise(r => setTimeout(r, 800));
                    }
                }
            }
            const duration = Date.now() - startTime;
            logger_1.winstonLogger.info(`[PNR_WORKER] Cycle completed | Processed: ${processed} | Changes: ${changed} | Duration: ${duration}ms`);
            // Track telemetry
            await analyticsService_1.analyticsService.trackEvent('pnr_worker_cycle', null, {
                processed,
                changes: changed,
                duration_ms: duration
            });
        }
        catch (err) {
            logger_1.winstonLogger.error(`[PNR_WORKER] Process cycle failed: ${err.message}`);
        }
        finally {
            this.isProcessing = false;
        }
    }
    /**
     * Indian Railways 2-Stage Charting Polling Schedule:
     *
     * Stage 1: First Chart (Pehla Chart)
     *   - Morning trains (05:00 - 14:00): Prepared previous night between 20:00 and 21:45 IST.
     *   - Afternoon/Night trains (after 14:00): Prepared ~10 hours before departure.
     *   - During First Chart window: Poll every 30 minutes.
     *
     * Stage 2: Second & Final Chart (Doosra Chart)
     *   - Exactly ~30-45 minutes before train departure.
     *   - During Final Chart window: Poll every 20 minutes.
     *
     * Intermediate Current Booking Window (Between 1st & 2nd Chart):
     *   - Poll once every 2 hours (120 mins).
     *
     * Regular Long-Distance Window (> 24 hours to journey):
     *   - Poll once every 6 hours (360 mins).
     */
    getPollingThresholdMinutes(record) {
        const journeyDate = this.parseDate(record.journey_date);
        const now = Date.now();
        if (!journeyDate) {
            return 240; // Default 4 hours if journey date not specified
        }
        const hoursToJourney = (journeyDate.getTime() - now) / (1000 * 60 * 60);
        // Case 0: Journey completed (train departed > 4 hours ago)
        if (hoursToJourney < -4) {
            return -1; // Stop polling
        }
        // Current IST Time calculation
        const utcMs = now + (new Date().getTimezoneOffset() * 60000);
        const istDate = new Date(utcMs + (5.5 * 3600000));
        const istHour = istDate.getUTCHours();
        const istMinute = istDate.getUTCMinutes();
        // Stage 2: Final Chart Window (around 30-45 mins before departure: -0.5h to 1.5h)
        if (hoursToJourney >= -0.5 && hoursToJourney <= 1.5) {
            return 20; // Poll every 20 mins in the final chart preparation window
        }
        // Stage 1: First Chart Window
        // A. ~10 hours before departure window (8h to 11h before departure)
        if (hoursToJourney >= 8 && hoursToJourney <= 11) {
            return 30; // Poll every 30 mins during the 10-hour First Chart window
        }
        // B. Previous night 20:00 - 21:45 IST window for morning trains (journey between 10h and 22h away)
        if (hoursToJourney > 8 && hoursToJourney <= 22) {
            const isEveningWindow = (istHour === 20) || (istHour === 21 && istMinute <= 45);
            if (isEveningWindow) {
                return 30; // Poll every 30 mins during 8 PM - 9:45 PM IST
            }
        }
        // Intermediate Current Booking Window (between First Chart and Final Chart)
        if (hoursToJourney > 1.5 && hoursToJourney < 8) {
            return 120; // Poll every 2 hours during Current Booking
        }
        // Intermediate Window: 12 to 24 hours before journey
        if (hoursToJourney <= 24) {
            return 180; // Poll every 3 hours
        }
        // Normal Long-Distance: > 24 hours (2-5 days before journey)
        return 360; // Poll every 6 hours
    }
    async shouldPoll(record) {
        const cacheKey = `pnr_poll_${record.pnr_number}`;
        if (cacheService_1.cacheService.get(cacheKey))
            return false; // Recently polled within threshold
        const thresholdMinutes = this.getPollingThresholdMinutes(record);
        if (thresholdMinutes < 0) {
            return false; // Past journey or terminal
        }
        const lastUpdated = new Date(record.last_updated || 0).getTime();
        const minutesSinceUpdate = (Date.now() - lastUpdated) / (1000 * 60);
        return minutesSinceUpdate >= thresholdMinutes;
    }
    /**
     * Update single PNR using service layer
     */
    async updatePnrStatus(record) {
        const pollCacheKey = `pnr_poll_${record.pnr_number}`;
        try {
            // Touch last_updated immediately and cache to prevent rapid re-polling loops
            await pnrTrackingService_1.pnrTrackingService.touchLastUpdated(record.id, record.pnr_number);
            const thresholdMinutes = Math.max(15, this.getPollingThresholdMinutes(record));
            cacheService_1.cacheService.set(pollCacheKey, true, thresholdMinutes * 60);
            logger_1.winstonLogger.info(`[PNR_WORKER] Fetching latest status for PNR ${record.pnr_number} with priority`);
            const latestData = await pnrTrackingService_1.pnrTrackingService.fetchPnrWithPriority(record.pnr_number);
            if (!latestData) {
                logger_1.winstonLogger.warn(`[PNR_WORKER] No data returned for ${record.pnr_number}`);
                return false;
            }
            const normalized = (0, pnrNormalizer_1.normalizeRawPnr)(latestData);
            const newStatus = this.summarizeStatus(normalized);
            const hasChanged = newStatus !== record.current_status;
            const latestJourneyDate = normalized.journey_date;
            // ── Chart Prepared Detection ─────────────────────────────────────────────
            // normalizeRawPnr always produces a chart_status string. Compare against
            // the last stored value (record.chart_status) to detect the unprepared →
            // prepared transition exactly once.
            const newChartStatus = normalized.chart_status || 'Chart Not Prepared';
            const oldChartStatus = record.chart_status || 'Chart Not Prepared';
            const isNowPrepared = newChartStatus.toUpperCase().includes('PREPARED') &&
                !newChartStatus.toUpperCase().includes('NOT PREPARED');
            const wasPrepared = oldChartStatus.toUpperCase().includes('PREPARED') &&
                !oldChartStatus.toUpperCase().includes('NOT PREPARED');
            const chartJustPrepared = isNowPrepared && !wasPrepared;
            // ────────────────────────────────────────────────────────────────────────
            const success = await pnrTrackingService_1.pnrTrackingService.updatePnrStatus(record.session_id, record.pnr_number, newStatus, latestData.prediction_score || undefined, latestJourneyDate, newChartStatus // persist so next cycle compares correctly
            );
            if (success) {
                if (hasChanged) {
                    logger_1.winstonLogger.info(`[PNR_WORKER] ✅ STATUS CHANGE: ${record.pnr_number} → ${newStatus}`);
                    await analyticsService_1.analyticsService.trackEvent('pnr_status_changed', record.pnr_number, {
                        old_status: record.current_status,
                        new_status: newStatus
                    });
                    const contact = await pnrTrackingService_1.pnrTrackingService.getContactForPnr(record.pnr_number);
                    await alertService_1.alertService.triggerWaitlistAlert(record.session_id, record.pnr_number, record.current_status, newStatus, contact?.email);
                }
                else {
                    logger_1.winstonLogger.debug(`[PNR_WORKER] No change for ${record.pnr_number}`);
                }
                // ── Chart Prepared alert (fires independently of status change) ────────
                if (chartJustPrepared) {
                    logger_1.winstonLogger.info(`[PNR_WORKER] 📋 CHART PREPARED: ${record.pnr_number} | ${newChartStatus}`);
                    await analyticsService_1.analyticsService.trackEvent('pnr_chart_prepared', record.pnr_number, {
                        chart_status: newChartStatus
                    });
                    const totalPassengers = normalized.passengers?.length || 0;
                    const isCnfStatus = (s) => {
                        const upper = (s || '').toUpperCase();
                        return upper.includes('CNF') || upper.includes('CONFIRM') || upper.includes('CONFIRMED') || (upper.includes('-') && !upper.includes('WL') && !upper.includes('RAC'));
                    };
                    const cnfCount = normalized.passengers?.filter((p) => isCnfStatus(p.current_status || p.booking_status)).length || 0;
                    const contact = await pnrTrackingService_1.pnrTrackingService.getContactForPnr(record.pnr_number);
                    await alertService_1.alertService.triggerChartPreparedAlert(record.session_id, record.pnr_number, newChartStatus, cnfCount, totalPassengers, contact?.email);
                }
                // ──────────────────────────────────────────────────────────────────────
            }
            return hasChanged;
        }
        catch (err) {
            logger_1.winstonLogger.warn(`[PNR_WORKER] Failed to update ${record.pnr_number}: ${err.message}`);
            return false;
        }
    }
    async cleanupExpiredPnrs() {
        try {
            logger_1.winstonLogger.info(`[PNR_WORKER] Starting expired PNR cleanup...`);
            const { data: pnrs, error } = await supabase_1.supabase.from('pnr_tracking').select('id, journey_date, last_updated, current_status');
            if (error) {
                logger_1.winstonLogger.error(`[PNR_WORKER] Cleanup fetch failed: ${error.message}`);
                return;
            }
            if (!pnrs || pnrs.length === 0)
                return;
            const now = Date.now();
            const expiredIds = [];
            for (const record of pnrs) {
                // ── Case 0: Terminal Statuses (Flushed / Not Found) ──
                const status = (record.current_status || '').toUpperCase();
                if (status.includes('FLUSHED') || status.includes('NOT FOUND') || status.includes('DELETED')) {
                    expiredIds.push(record.id);
                    continue;
                }
                // ── Case 1: No journey date — expire by last_updated (7 days) ──
                if (!record.journey_date || record.journey_date === 'N/A') {
                    if (record.last_updated) {
                        const hrsOld = (now - new Date(record.last_updated).getTime()) / (1000 * 60 * 60);
                        if (hrsOld > 168)
                            expiredIds.push(record.id);
                    }
                    continue;
                }
                // ── Case 2: Unparseable date — expire by last_updated (7 days) ──
                const d = this.parseDate(record.journey_date);
                if (!d) {
                    if (record.last_updated) {
                        const hrsOld = (now - new Date(record.last_updated).getTime()) / (1000 * 60 * 60);
                        if (hrsOld > 168)
                            expiredIds.push(record.id);
                    }
                    continue;
                }
                // ── Case 3: Valid journey date — existing 96h behaviour ──
                const hoursSinceJourney = (now - d.getTime()) / (1000 * 60 * 60);
                if (hoursSinceJourney > 96) {
                    expiredIds.push(record.id);
                }
            }
            if (expiredIds.length > 0) {
                logger_1.winstonLogger.info(`[PNR_WORKER] Deleting ${expiredIds.length} expired PNRs...`);
                // Supabase limits IN clauses, chunk if needed. Assuming <1000 for now.
                const { error: delError } = await supabase_1.supabase
                    .from('pnr_tracking')
                    .delete()
                    .in('id', expiredIds);
                if (delError) {
                    logger_1.winstonLogger.error(`[PNR_WORKER] Cleanup deletion failed: ${delError.message}`);
                }
                else {
                    logger_1.winstonLogger.info(`[PNR_WORKER] Expired PNR cleanup completed successfully`);
                }
            }
            else {
                logger_1.winstonLogger.info(`[PNR_WORKER] No expired PNRs to clean up`);
            }
        }
        catch (err) {
            logger_1.winstonLogger.error(`[PNR_WORKER] Error during expired PNR cleanup: ${err.message}`);
        }
    }
    summarizeStatus(data) {
        if (!data?.passengers?.length)
            return "UNKNOWN";
        // Most reliable way - use first passenger's current status
        const passenger = data.passengers[0];
        return passenger.current_status || "UNKNOWN";
    }
}
exports.PnrWorker = PnrWorker;
exports.pnrWorker = new PnrWorker();
