"use strict";
/**
 * GEMINI TRAIN SCHEDULE FALLBACK SERVICE
 *
 * Jab IRCTC aur DB dono fail ho jaaye, Gemini se train schedule fetch karo.
 * Fetched data automatically `train_schedule` table mein save ho jaata hai
 * taaki next request pe DB se directly milega.
 */
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.geminiTrainScheduleService = exports.GeminiTrainScheduleService = void 0;
const axios_1 = __importDefault(require("axios"));
const supabase_1 = require("../config/supabase");
const logger_1 = require("../middleware/logger");
class GeminiTrainScheduleService {
    constructor() {
        this.GEMINI_KEY = process.env.GEMINI_API_KEY || '';
        this.GEMINI_URL = 'https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent';
    }
    /**
     * Gemini se train schedule fetch karo.
     * Returns null if Gemini key missing, or train unknown to Gemini.
     */
    async getSchedule(trainNo) {
        if (!this.GEMINI_KEY) {
            logger_1.winstonLogger.warn('[GEMINI_SCHEDULE] GEMINI_API_KEY not set — skipping');
            return null;
        }
        const prompt = `You are an Indian Railways timetable expert.
Give me the complete schedule for Indian Railways train number ${trainNo}.

Return ONLY a valid JSON object in this exact format (no markdown, no extra text):
{
  "train_number": "${trainNo}",
  "train_name": "FULL TRAIN NAME",
  "stations": [
    {
      "sn": 1,
      "station_code": "XXX",
      "station_name": "Station Name",
      "arrival_time": "--:--",
      "departure_time": "HH:MM",
      "day": 1
    }
  ]
}

Rules:
- station_code must be the official Indian Railways 2-5 letter code (e.g. NDLS, CSTM, ADI)
- arrival_time and departure_time in 24-hour HH:MM format
- First station: arrival_time = "--:--"
- Last station: departure_time = "--:--"
- day = 1 for first day, 2 if train crosses midnight, etc.
- If you don't know this specific train number, return: {"train_number": "${trainNo}", "train_name": "", "stations": []}
- Do NOT make up station data. Only return if you are confident.`;
        try {
            logger_1.winstonLogger.info(`[GEMINI_SCHEDULE] Fetching schedule for train ${trainNo}`);
            const response = await axios_1.default.post(`${this.GEMINI_URL}?key=${this.GEMINI_KEY}`, {
                contents: [{ parts: [{ text: prompt }] }],
                generationConfig: {
                    temperature: 0.1,
                    responseMimeType: 'application/json',
                },
            }, { timeout: 12000 });
            const raw = response.data?.candidates?.[0]?.content?.parts?.[0]?.text;
            if (!raw) {
                logger_1.winstonLogger.warn(`[GEMINI_SCHEDULE] Empty response for ${trainNo}`);
                return null;
            }
            const cleaned = raw.replace(/```json/gi, '').replace(/```/g, '').trim();
            const parsed = JSON.parse(cleaned);
            // Validate: must have stations with station codes
            if (!parsed.stations ||
                parsed.stations.length === 0 ||
                !parsed.train_name) {
                logger_1.winstonLogger.warn(`[GEMINI_SCHEDULE] Train ${trainNo} unknown to Gemini — empty result`);
                return null;
            }
            // Validate that station codes look real (not garbage)
            const validStations = parsed.stations.filter((s) => s.station_code && s.station_code.length >= 2 && s.station_code !== '--');
            if (validStations.length < parsed.stations.length * 0.7) {
                logger_1.winstonLogger.warn(`[GEMINI_SCHEDULE] ${trainNo}: Too many invalid station codes — discarding`);
                return null;
            }
            parsed.stations = validStations;
            logger_1.winstonLogger.info(`[GEMINI_SCHEDULE] Got ${parsed.stations.length} stations for "${parsed.train_name}" (${trainNo})`);
            return parsed;
        }
        catch (err) {
            logger_1.winstonLogger.error(`[GEMINI_SCHEDULE] Failed for ${trainNo}: ${err.message}`);
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
        // ── 1. Save schedule stops ─────────────────────────────────────────────
        try {
            const rows = schedule.stations.map((s) => ({
                Train_No: Number(schedule.train_number) || schedule.train_number,
                Station_Code: (s.station_code || '').toUpperCase().trim(),
                // Always ensure Station_Name is non-empty (fallback to code)
                Station_Name: (s.station_name && s.station_name.trim()) ? s.station_name.trim() : s.station_code.toUpperCase(),
                Arrival_time: s.arrival_time || '--:--',
                Departure_Time: s.departure_time || '--:--',
                SN: s.sn,
            }));
            const { error } = await supabase_1.supabase
                .from('train_schedule')
                .upsert(rows, { onConflict: 'Train_No,Station_Code' });
            if (error) {
                logger_1.winstonLogger.warn(`[GEMINI_SCHEDULE_SAVE] Partial save error for ${schedule.train_number}: ${error.message}`);
            }
            else {
                logger_1.winstonLogger.info(`[GEMINI_SCHEDULE_SAVE] Saved ${rows.length} stops for train ${schedule.train_number} to DB`);
            }
        }
        catch (err) {
            logger_1.winstonLogger.warn(`[GEMINI_SCHEDULE_SAVE] Schedule save failed for ${schedule.train_number}: ${err.message}`);
        }
        // ── 2. Save train name to `trains` table ───────────────────────────────
        // This makes fetchDbTrainName() return the correct name on next request.
        if (schedule.train_name && schedule.train_name.trim()) {
            try {
                const trainNo = String(schedule.train_number);
                // Try `number` column first (new schema)
                const { error: e1 } = await supabase_1.supabase
                    .from('trains')
                    .upsert({ number: trainNo, name: schedule.train_name.trim() }, { onConflict: 'number' });
                if (e1) {
                    // Try legacy Train_No / Train_Name columns
                    try {
                        await supabase_1.supabase
                            .from('trains')
                            .upsert({ Train_No: trainNo, Train_Name: schedule.train_name.trim() }, { onConflict: 'Train_No' });
                    }
                    catch { /* best-effort */ }
                }
                logger_1.winstonLogger.info(`[GEMINI_SCHEDULE_SAVE] Saved train name "${schedule.train_name}" for ${trainNo} to trains table`);
            }
            catch (err) {
                logger_1.winstonLogger.warn(`[GEMINI_SCHEDULE_SAVE] Train name save failed: ${err.message}`);
            }
        }
    }
    /**
     * Main method: fetch + save + return as TimelineStop[] shape.
     * Returns null if Gemini doesn't know the train.
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
