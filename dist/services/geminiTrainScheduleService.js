"use strict";
/**
 * GEMINI TRAIN SCHEDULE FALLBACK SERVICE
 *
 * Jab IRCTC aur DB dono fail ho jaaye, AI provider se train schedule fetch karo.
 * Fetched data automatically `train_schedule` table mein save ho jaata hai
 * taaki next request pe DB se directly milega.
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.geminiTrainScheduleService = exports.GeminiTrainScheduleService = void 0;
const supabase_1 = require("../config/supabase");
const logger_1 = require("../middleware/logger");
const aiProviderResolver_1 = require("./ai/aiProviderResolver");
class GeminiTrainScheduleService {
    /**
     * AI Provider se train schedule fetch karo.
     * Returns null if key missing, or train unknown to AI.
     */
    async getSchedule(trainNo) {
        const provider = aiProviderResolver_1.aiProviderResolver.resolveProvider('generateSchedule');
        if (!provider || typeof provider.generateSchedule !== 'function') {
            logger_1.winstonLogger.warn('[AI_SCHEDULE] No capable AI provider configured — skipping');
            return null;
        }
        try {
            logger_1.winstonLogger.info(`[AI_SCHEDULE] Fetching schedule via ${provider.providerId} for train ${trainNo}`);
            const parsed = await provider.generateSchedule(trainNo);
            if (!parsed)
                return null;
            // Validate: must have stations with station codes
            if (!parsed.stations || parsed.stations.length === 0 || !parsed.train_name) {
                logger_1.winstonLogger.warn(`[AI_SCHEDULE] Train ${trainNo} unknown to AI — empty result`);
                return null;
            }
            // Validate that station codes look real
            const validStations = parsed.stations.filter((s) => s.station_code && s.station_code.length >= 2 && s.station_code !== '--');
            if (validStations.length < parsed.stations.length * 0.7) {
                logger_1.winstonLogger.warn(`[AI_SCHEDULE] ${trainNo}: Too many invalid station codes — discarding`);
                return null;
            }
            parsed.stations = validStations;
            logger_1.winstonLogger.info(`[AI_SCHEDULE] Got ${parsed.stations.length} stations for "${parsed.train_name}" (${trainNo})`);
            return parsed;
        }
        catch (err) {
            logger_1.winstonLogger.error(`[AI_SCHEDULE] Failed for ${trainNo}: ${err.message}`);
            return null;
        }
    }
    /**
     * Gemini schedule ko Supabase `train_schedule` + `trains` tables mein save karo.
     * train_schedule → stops/times (next live-track call pe DB se milega)
     * trains          → train name (fetchDbTrainName ke liye)
     */
    async saveToDatabase(schedule) {
        if (!schedule.stations || schedule.stations.length === 0)
            return;
        const dbWriteEnabled = process.env.GEMINI_SCHEDULE_DB_WRITE === 'true';
        // ── 1. Save schedule stops ─────────────────────────────────────────────
        try {
            const rows = schedule.stations.map((s) => ({
                Train_No: Number(schedule.train_number) || schedule.train_number,
                Station_Code: (s.station_code || '').toUpperCase().trim(),
                Station_Name: (s.station_name && s.station_name.trim()) ? s.station_name.trim() : s.station_code.toUpperCase(),
                Arrival_time: s.arrival_time || '--:--',
                Departure_Time: s.departure_time || '--:--',
                SN: s.sn,
            }));
            if (!dbWriteEnabled) {
                logger_1.winstonLogger.info(`[AI_SCHEDULE_SAVE_SKIPPED] AI schedule for ${schedule.train_number} not persisted to train_schedule ` +
                    `(GEMINI_SCHEDULE_DB_WRITE not enabled) — returned as advisory only`);
            }
            else {
                const { trainScheduleIntegrityService } = require('./trainScheduleIntegrityService');
                const integrity = trainScheduleIntegrityService.validateScheduleRows(schedule.train_number, rows);
                if (integrity.status === 'INVALID') {
                    logger_1.winstonLogger.warn(`[AI_SCHEDULE_SAVE_REJECTED] AI schedule for ${schedule.train_number} rejected by integrity gate: ${integrity.message}`);
                }
                else {
                    const { error } = await supabase_1.supabase
                        .from('train_schedule')
                        .upsert(rows, { onConflict: 'Train_No,Station_Code' });
                    if (error) {
                        logger_1.winstonLogger.warn(`[AI_SCHEDULE_SAVE] Partial save error for ${schedule.train_number}: ${error.message}`);
                    }
                    else {
                        logger_1.winstonLogger.info(`[AI_SCHEDULE_SAVE] Saved ${rows.length} stops for train ${schedule.train_number} to DB`);
                    }
                }
            }
        }
        catch (err) {
            logger_1.winstonLogger.warn(`[AI_SCHEDULE_SAVE] Schedule save failed for ${schedule.train_number}: ${err.message}`);
        }
        // ── 2. Save train name to `trains` table ───────────────────────────────
        if (!dbWriteEnabled) {
            if (schedule.train_name && schedule.train_name.trim()) {
                logger_1.winstonLogger.info(`[AI_TRAIN_NAME_SAVE_SKIPPED] AI train name for ${schedule.train_number} not persisted to trains ` +
                    `(GEMINI_SCHEDULE_DB_WRITE not enabled) — returned as advisory only`);
            }
            return;
        }
        if (schedule.train_name && schedule.train_name.trim()) {
            try {
                const trainNo = String(schedule.train_number);
                const { error: e1 } = await supabase_1.supabase
                    .from('trains')
                    .upsert({ number: trainNo, name: schedule.train_name.trim() }, { onConflict: 'number' });
                if (e1) {
                    try {
                        await supabase_1.supabase
                            .from('trains')
                            .upsert({ Train_No: trainNo, Train_Name: schedule.train_name.trim() }, { onConflict: 'Train_No' });
                    }
                    catch { /* best-effort */ }
                }
                logger_1.winstonLogger.info(`[AI_SCHEDULE_SAVE] Saved train name "${schedule.train_name}" for ${trainNo} to trains table`);
            }
            catch (err) {
                logger_1.winstonLogger.warn(`[AI_SCHEDULE_SAVE] Train name save failed: ${err.message}`);
            }
        }
    }
    /**
     * Main method: fetch + save + return as TimelineStop[] shape.
     * Returns null if AI doesn't know the train.
     */
    async getAndSave(trainNo) {
        const schedule = await this.getSchedule(trainNo);
        if (!schedule)
            return null;
        // Save to DB in background — don't await (don't block the response)
        this.saveToDatabase(schedule).catch(() => { });
        // Now infer current station based on current IST time
        const now = new Date();
        const utcMs = now.getTime() + now.getTimezoneOffset() * 60000;
        const nowMins = Math.floor((utcMs + 5.5 * 3600000) / 60000) % 1440; // IST minutes from midnight
        const parseToMins = (t) => {
            if (!t || t === '--:--')
                return -1;
            const [h, m] = t.split(':').map(Number);
            return (h || 0) * 60 + (m || 0);
        };
        let currentStationIdx = 0;
        let simulated = schedule.stations.map((s, idx) => {
            const depMins = parseToMins(s.departure_time);
            const arrMins = parseToMins(s.arrival_time);
            let is_departed = false;
            let is_current = false;
            if (depMins !== -1 && nowMins >= depMins) {
                is_departed = true;
                currentStationIdx = idx + 1;
            }
            else if (arrMins !== -1 && nowMins >= arrMins) {
                is_current = true;
                currentStationIdx = idx;
            }
            return {
                station_name: s.station_name,
                station_code: s.station_code,
                arrival_time: s.arrival_time,
                departure_time: s.departure_time,
                delay_minutes: 0,
                is_current: false,
                is_departed: is_departed,
                status: is_departed ? 'DEPARTED' : 'UPCOMING',
            };
        });
        if (currentStationIdx >= simulated.length) {
            currentStationIdx = simulated.length - 1;
        }
        simulated[currentStationIdx].is_current = true;
        simulated[currentStationIdx].status = 'CURRENT';
        simulated[currentStationIdx].is_departed = false;
        return {
            train_name: schedule.train_name,
            stations: simulated,
            is_ai_estimated: true,
        };
    }
}
exports.GeminiTrainScheduleService = GeminiTrainScheduleService;
exports.geminiTrainScheduleService = new GeminiTrainScheduleService();
