"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.liveTrackingService = exports.LiveTrackingService = void 0;
exports.parseDelayString = parseDelayString;
const supabase_1 = require("../config/supabase");
const logger_1 = require("../middleware/logger");
const apiPriority_1 = require("../utils/apiPriority");
const dayUtils_1 = require("../utils/dayUtils");
const cacheService_1 = require("./cacheService");
const irctcService_1 = require("./irctcService");
const stationService_1 = require("./stationService");
const geminiTrainScheduleService_1 = require("./geminiTrainScheduleService");
// ── Known major railway junction codes (India) ───────────────────────────────
const MAJOR_JUNCTION_CODES = new Set([
    // Mumbai zone
    'CSMT', 'CSTM', 'LTT', 'DR', 'TNA', 'KYN', 'KSRA', 'BSR', 'PNVL', 'BVI', 'MMCT',
    // Delhi zone
    'NDLS', 'NZM', 'DLI', 'DSA', 'ANVT', 'ANDI', 'MTJ', 'AGC', 'MB', 'UMB', 'AMRT',
    // Central / MP / Vidarbha / Jhansi
    'BSL', 'ET', 'NGP', 'JBP', 'BPL', 'HBJ', 'KOTA', 'GWL', 'JHS', 'VGLJ', 'STA', 'AK', 'WR', 'BD', 'BPQ',
    // South
    'SC', 'HYB', 'MAS', 'SBC', 'YPR', 'MYS', 'CBE', 'MDU', 'CAPE', 'VSKP', 'BZA', 'GTL', 'RU',
    // Gujarat
    'ADI', 'BRC', 'ST', 'GNC', 'VG', 'RTM',
    // North / UP
    'CNB', 'ALD', 'LKO', 'BSB', 'GKP', 'MFP', 'CPR', 'AWB', 'SEE',
    // Indore / Ujjain
    'INDB', 'UJN',
    // Rajasthan
    'JP', 'AJM', 'JU', 'BKN', 'JOD', 'UDZ',
    // East
    'HWH', 'SDAH', 'ASN', 'RNC', 'GAYA', 'PNBE', 'SPJ', 'DHN', 'GHY', 'DBRG',
]);
/**
 * Classify a timeline stop into TERMINAL, MAJOR_JUNCTION, or MINOR_STATION.
 * Uses station code lookup + name keyword matching.
 * idx=0 and idx=total-1 are always TERMINAL.
 */
function classifyStation(code, name, idx, total) {
    if (idx === 0 || idx === total - 1)
        return 'TERMINAL';
    const uc = (code || '').toUpperCase().trim();
    const un = (name || '').toUpperCase();
    if (MAJOR_JUNCTION_CODES.has(uc))
        return 'MAJOR_JUNCTION';
    if (/\bJUNCTION\b|\bJN\.?\b|\bJCN\b/.test(un))
        return 'MAJOR_JUNCTION';
    return 'MINOR_STATION';
}
/**
 * Parse the delay string returned by irctc-connect trackTrain().
 * Examples:
 *   "On Time"           → 0
 *   "Right Time"        → 0
 *   ""                  → 0
 *   "15 Min Late"       → 15
 *   "22 Min Late"       → 22
 *   "1 Hr 10 Min Late"  → 70
 */
function parseDelayString(delayStr) {
    if (!delayStr)
        return 0;
    const s = delayStr.trim();
    if (!s || /^(on time|right time)$/i.test(s))
        return 0;
    const hrMatch = s.match(/(\d+)\s*Hr/i);
    const minMatch = s.match(/(\d+)\s*Min/i);
    const hrs = hrMatch ? parseInt(hrMatch[1], 10) : 0;
    const mins = minMatch ? parseInt(minMatch[1], 10) : 0;
    return hrs * 60 + mins;
}
class LiveTrackingService {
    // ── Fetch the DB schedule as timeline (always available) ─────────────────────
    async fetchDbSchedule(trainNo) {
        try {
            const { data: stops, error } = await supabase_1.supabase
                .from('train_schedule')
                .select('Station_Code, Station_Name, Arrival_time, Departure_Time, SN')
                .eq('Train_No', trainNo)
                .order('SN', { ascending: true });
            if (error || !stops || stops.length === 0)
                return [];
            return stops.map((s, idx) => ({
                station_name: s.Station_Name || s.Station_Code || 'Station',
                station_code: s.Station_Code || '--',
                arrival_time: s.Arrival_time || '--:--',
                departure_time: s.Departure_Time || '--:--',
                delay_minutes: 0,
                is_current: false,
                is_departed: false
            }));
        }
        catch (err) {
            logger_1.winstonLogger.warn(`[LIVE_DB_SCHED] ${trainNo}: ${err.message}`);
            return [];
        }
    }
    async fetchDbScheduleWithDays(trainNo) {
        try {
            let stops = [];
            // Try DB first — both numeric and string match for Train_No column
            const { data: dbStops } = await supabase_1.supabase
                .from('train_schedule')
                .select('Station_Code, Station_Name, Arrival_time, Departure_Time, SN')
                .eq('Train_No', Number(trainNo) || trainNo)
                .order('SN', { ascending: true });
            if (dbStops && dbStops.length > 0) {
                stops = dbStops;
            }
            else {
                // Try string match too (some DBs store as text)
                const { data: dbStops2 } = await supabase_1.supabase
                    .from('train_schedule')
                    .select('Station_Code, Station_Name, Arrival_time, Departure_Time, SN')
                    .eq('Train_No', String(trainNo))
                    .order('SN', { ascending: true });
                if (dbStops2 && dbStops2.length > 0) {
                    stops = dbStops2;
                }
                else {
                    logger_1.winstonLogger.info(`[LIVE_DB_SCHED] ${trainNo} not in DB, falling back to IRCTC getTrainInfo`);
                    const info = await irctcService_1.irctcService.getTrainInfo(trainNo);
                    if (info) {
                        // IRCTC getTrainInfo can return route data under many field names
                        const rawRoute = info.route ||
                            info.station_list ||
                            info.stops ||
                            info.stations ||
                            info.trainRoute ||
                            info.stationList ||
                            [];
                        if (Array.isArray(rawRoute) && rawRoute.length > 0) {
                            stops = rawRoute.map((s, idx) => ({
                                Station_Code: (s.stationCode || s.stnCode || s.station_code ||
                                    s.Station_Code || s.code || '').toUpperCase().trim() || '--',
                                Station_Name: s.stationName || s.stnName || s.station_name ||
                                    s.Station_Name || s.name || '',
                                Arrival_time: s.arrivalTime || s.arrival_time || s.arrival ||
                                    s.Arrival_time || '--:--',
                                Departure_Time: s.departureTime || s.departure_time || s.departure ||
                                    s.Departure_Time || '--:--',
                                SN: s.sn || s.SN || idx + 1
                            }));
                            logger_1.winstonLogger.info(`[LIVE_DB_SCHED] ${trainNo}: got ${stops.length} stops from IRCTC getTrainInfo`);
                        }
                    }
                }
            }
            if (!stops || stops.length === 0)
                return [];
            const parseToMins = (time) => {
                if (!time || time === '--:--')
                    return 0;
                const [h, m] = time.split(':').map(Number);
                return (h || 0) * 60 + (m || 0);
            };
            let currentDay = 1;
            let prevMins = 0;
            return stops.map((s, idx) => {
                const arrMins = parseToMins(s.Arrival_time);
                const depMins = parseToMins(s.Departure_Time);
                if (idx > 0) {
                    if (arrMins < prevMins) {
                        currentDay++;
                    }
                }
                const code = (s.Station_Code || '--').trim();
                const rawName = (s.Station_Name || '').trim();
                const stop = {
                    station_code: code,
                    // If Station_Name is null/empty in DB, fall back to code so UI never shows '--'
                    station_name: rawName || code,
                    arrival_time: s.Arrival_time || '--:--',
                    departure_time: s.Departure_Time || '--:--',
                    day: currentDay,
                    sn: s.SN
                };
                if (depMins < arrMins) {
                    currentDay++;
                }
                prevMins = depMins;
                return stop;
            });
        }
        catch (err) {
            logger_1.winstonLogger.warn(`[LIVE_DB_SCHED_WITH_DAYS] ${trainNo}: ${err.message}`);
            return [];
        }
    }
    async getActiveJourneyDate(trainNo, prefetchedSchedule) {
        try {
            const schedule = prefetchedSchedule && prefetchedSchedule.length > 0
                ? prefetchedSchedule
                : await this.fetchDbScheduleWithDays(trainNo);
            if (!schedule || schedule.length === 0) {
                return null;
            }
            const trainRes = await supabase_1.supabase.from('trains').select('running_days').eq('number', trainNo).maybeSingle();
            const runningDays = trainRes?.data?.running_days;
            const binary = (0, dayUtils_1.normalizeRunningDays)(runningDays) ?? [1, 1, 1, 1, 1, 1, 1];
            const now = new Date();
            const utcMs = now.getTime() + now.getTimezoneOffset() * 60000;
            const istNowMs = utcMs + 5.5 * 3600000;
            const getIstDateForOffset = (offset) => {
                const targetMs = istNowMs + offset * 86400000;
                const d = new Date(targetMs);
                const yyyy = d.getFullYear();
                const mm = String(d.getMonth() + 1).padStart(2, '0');
                const dd = String(d.getDate()).padStart(2, '0');
                const dateStr = `${yyyy}-${mm}-${dd}`;
                const dateObj = new Date(`${dateStr}T00:00:00+05:30`);
                return { dateStr, dateObj };
            };
            const candidates = [-3, -2, -1, 0];
            const parseTimeToMins = (time) => {
                if (!time || time === '--:--')
                    return 0;
                const [h, m] = time.split(':').map(Number);
                return (h || 0) * 60 + (m || 0);
            };
            const firstStop = schedule[0];
            const lastStop = schedule[schedule.length - 1];
            if (!firstStop || !lastStop)
                return null;
            const firstDepMins = parseTimeToMins(firstStop.departure_time);
            const lastArrMins = parseTimeToMins(lastStop.arrival_time);
            const lastDay = lastStop.day || 1;
            for (const offset of candidates) {
                const { dateStr, dateObj } = getIstDateForOffset(offset);
                if (!(0, dayUtils_1.isDayActive)(binary, dateStr)) {
                    continue;
                }
                const depMs = dateObj.getTime() + firstDepMins * 60 * 1000;
                const arrMs = dateObj.getTime() + ((lastDay - 1) * 24 * 60 + lastArrMins) * 60 * 1000;
                const startRange = depMs - 1 * 60 * 60 * 1000;
                const endRange = arrMs + 6 * 60 * 60 * 1000;
                if (now.getTime() >= startRange && now.getTime() <= endRange) {
                    return dateStr;
                }
            }
            const { dateStr: todayStr } = getIstDateForOffset(0);
            return todayStr;
        }
        catch (err) {
            logger_1.winstonLogger.warn(`[ACTIVE_JOURNEY_DATE] Failed for ${trainNo}: ${err.message}`);
            return null;
        }
    }
    // ── Fetch train name from DB ──────────────────────────────────────────────────
    async fetchDbTrainName(trainNo) {
        try {
            const { data } = await supabase_1.supabase
                .from('trains')
                .select('name')
                .eq('number', trainNo)
                .maybeSingle();
            if (data?.name)
                return data.name;
        }
        catch {
            // Fall through to legacy shape.
        }
        try {
            const { data } = await supabase_1.supabase
                .from('trains')
                .select('Train_Name')
                .eq('Train_No', trainNo)
                .maybeSingle();
            return data?.Train_Name || '';
        }
        catch {
            return '';
        }
    }
    extractTimeString(timeVal) {
        if (!timeVal)
            return '--:--';
        if (typeof timeVal === 'string')
            return timeVal;
        if (typeof timeVal === 'object') {
            const val = timeVal.scheduled || timeVal.time || timeVal.actual || timeVal.arrivalTime || timeVal.departureTime || timeVal.departure_time || timeVal.arrival_time;
            if (val) {
                if (typeof val === 'string')
                    return val;
                if (typeof val === 'object')
                    return this.extractTimeString(val);
            }
        }
        return '--:--';
    }
    // ── Normalize a raw timeline from live API ────────────────────────────────────
    async normalizeTimeline(raw, delayMins) {
        if (!Array.isArray(raw) || raw.length === 0)
            return [];
        return Promise.all(raw.map(async (s, idx) => {
            let name = s.station_name || s.stationName || s.name || s.Station_Name || s.stnName || '';
            let code = s.station_code || s.stationCode || s.code || s.Station_Code || s.stnCode || '';
            if (!name && code) {
                const resolved = await stationService_1.stationService.getStationName(code).catch(() => '');
                name = resolved || code;
            }
            return {
                station_name: name || 'Station',
                station_code: code || '--',
                arrival_time: this.extractTimeString(s.arrival_time || s.arrivalTime || s.arrival || s.Arrival_time),
                departure_time: this.extractTimeString(s.departure_time || s.departureTime || s.departure || s.Departure_Time),
                // Resolve delay — numeric fields first, then trackTrain() string sub-objects
                delay_minutes: (() => {
                    const numericDelay = s.delay_minutes ?? s.delay_in_mins ??
                        (typeof s.delay === 'number' ? s.delay : undefined);
                    if (numericDelay !== undefined && numericDelay !== null)
                        return numericDelay;
                    // trackTrain shape: s.departure.delay and s.arrival.delay are strings
                    const strDelay = parseDelayString(s.departure?.delay) ||
                        parseDelayString(s.arrival?.delay) || 0;
                    return strDelay || delayMins || 0;
                })(),
                is_current: s.is_current || false,
                is_departed: s.is_departed || false,
                status: s.status || (s.is_departed ? 'DEPARTED' : 'UPCOMING'),
                station_type: classifyStation(code, name, idx, raw.length),
                platform: s.platform || s.platform_number || s.platform_no || s.platformNumber || null
            };
        }));
    }
    // ── Resolve a station code/name to a human readable name ─────────────────────
    async resolveStationName(raw) {
        if (!raw || raw === 'Transit' || raw === 'Unknown Station')
            return '';
        // Short codes → look up
        if (raw.length <= 5) {
            const resolved = await stationService_1.stationService.getStationName(raw).catch(() => '');
            if (resolved)
                return resolved;
        }
        return raw;
    }
    // ── Main method ───────────────────────────────────────────────────────────────
    async getTrainRunningStatus(trainNo, date) {
        const cacheKey = `live_v2_${trainNo}_${date || 'default'}`;
        const cached = cacheService_1.cacheService.get(cacheKey);
        if (cached) {
            logger_1.winstonLogger.info(`[LIVE_CACHE_HIT] ${trainNo}`);
            return cached;
        }
        // Single schedule query — reused for timeline + active journey date (PHASE_4C880)
        const [scheduleWithDaysResult, dbTrainNameResult] = await Promise.allSettled([
            this.fetchDbScheduleWithDays(trainNo),
            this.fetchDbTrainName(trainNo),
        ]);
        const scheduleWithDays = scheduleWithDaysResult.status === 'fulfilled' ? scheduleWithDaysResult.value : [];
        const dbSchedule = scheduleWithDays.map((s) => ({
            station_name: s.station_name || s.Station_Name || s.station_code || s.Station_Code || 'Station',
            station_code: s.station_code || s.Station_Code || '--',
            arrival_time: s.arrival_time || s.Arrival_time || s.Arrival_Time || '--:--',
            departure_time: s.departure_time || s.Departure_Time || s.Departure_time || '--:--',
            delay_minutes: 0,
            is_current: false,
            is_departed: false,
        }));
        const dbTrainName = dbTrainNameResult.status === 'fulfilled' ? dbTrainNameResult.value : '';
        const activeDate = await this.getActiveJourneyDate(trainNo, scheduleWithDays);
        let usedApi = 'DATABASE_SCHEDULE';
        try {
            logger_1.winstonLogger.info(`[LIVE_TRACE] Priority fetch for ${trainNo}`);
            const liveData = await (0, apiPriority_1.fetchWithPriority)({
                irctc: async () => {
                    // getLiveStatus() uses trackTrain() — returns real-time delay data.
                    // getTrainInfo() returns only static schedule (no delay) — do NOT use for live.
                    const res = await irctcService_1.irctcService.getLiveStatus(trainNo, date);
                    if (res) {
                        usedApi = 'IRCTC';
                        return res;
                    }
                    return null;
                },
                // confirmtkt: async () => {
                //   const res = await confirmtktService.getTrainStatus(trainNo, date);
                //   if (res) { usedApi = 'CONFIRMTKT'; return res; }
                //   return null;
                // },
                db: async () => {
                    if (scheduleWithDays.length > 0) {
                        usedApi = 'DATABASE_SCHEDULE';
                        logger_1.winstonLogger.info(`[PROVIDER_FALLBACK_DATABASE] All live APIs failed for ${trainNo} -> Falling back to database schedule`);
                        logger_1.winstonLogger.info(`[DB_SCHED_FALLBACK] ${trainNo}: simulating live status from ${scheduleWithDays.length} stops`);
                        const targetDateStr = date || activeDate || new Date().toLocaleDateString('en-CA');
                        const targetDate = new Date(`${targetDateStr}T00:00:00+05:30`);
                        const now = new Date();
                        const nowMs = now.getTime() + (now.getTimezoneOffset() * 60000) + (5.5 * 3600000); // IST now
                        const parseToMins = (time) => {
                            if (!time || time === '--:--')
                                return 0;
                            const [h, m] = time.split(':').map(Number);
                            return (h || 0) * 60 + (m || 0);
                        };
                        let currentStationIdx = 0;
                        const simulatedStations = dbSchedule.map((s, idx) => {
                            const arrMins = parseToMins(s.arrival_time);
                            const depMins = parseToMins(s.departure_time);
                            const dayOffset = (scheduleWithDays[idx]?.day || 1) - 1;
                            const arrTimeMs = targetDate.getTime() + dayOffset * 86400000 + arrMins * 60000;
                            const depTimeMs = targetDate.getTime() + dayOffset * 86400000 + depMins * 60000;
                            let is_departed = false;
                            let is_current = false;
                            if (nowMs >= depTimeMs) {
                                is_departed = true;
                                currentStationIdx = idx + 1;
                            }
                            else if (nowMs >= arrTimeMs) {
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
                                day: scheduleWithDays[idx]?.day
                            };
                        });
                        if (currentStationIdx >= simulatedStations.length) {
                            currentStationIdx = simulatedStations.length - 1;
                            simulatedStations[currentStationIdx].is_current = true;
                        }
                        else {
                            simulatedStations[currentStationIdx].is_current = true;
                        }
                        return {
                            stations: simulatedStations,
                            train_name: dbTrainName || `Train ${trainNo}`,
                            is_running: true,
                            current_station: simulatedStations[currentStationIdx]?.station_name || '',
                            next_station: simulatedStations[currentStationIdx + 1]?.station_name || '',
                        };
                    }
                    return null;
                }
            });
            // ── GEMINI AI FALLBACK ────────────────────────────────────────────────────
            // Triggered only when: IRCTC failed + train NOT in DB (scheduleWithDays empty)
            // Gemini fetches static schedule from its training knowledge, saves to DB in
            // background so the next request hits DB directly (no Gemini call needed).
            if (!liveData && scheduleWithDays.length === 0) {
                logger_1.winstonLogger.info(`[GEMINI_SCHEDULE_FALLBACK] Train ${trainNo} not in DB and IRCTC failed — trying Gemini`);
                try {
                    const geminiResult = await geminiTrainScheduleService_1.geminiTrainScheduleService.getAndSave(trainNo);
                    if (geminiResult) {
                        usedApi = 'GEMINI_AI';
                        logger_1.winstonLogger.info(`[GEMINI_SCHEDULE_SUCCESS] Train ${trainNo}: ${geminiResult.stations.length} stops from Gemini`);
                        // Build LiveTrainStatus directly from Gemini result
                        const currentIdx = geminiResult.stations.findIndex((s) => s.is_current);
                        const safeIdx = currentIdx >= 0 ? currentIdx : 0;
                        const geminiStatus = {
                            train_number: trainNo,
                            train_name: geminiResult.train_name || `Train ${trainNo}`,
                            current_station: geminiResult.stations[safeIdx]?.station_name || 'En Route',
                            next_station: geminiResult.stations[safeIdx + 1]?.station_name || 'Unknown',
                            current_station_index: safeIdx,
                            train_location: null,
                            delay_minutes: 0,
                            status_summary: 'AI Estimated Schedule',
                            last_updated: new Date().toLocaleTimeString('en-IN'),
                            is_running: true,
                            journey_timeline: geminiResult.stations.map((s, idx) => ({
                                station_name: s.station_name,
                                station_code: s.station_code,
                                arrival_time: s.arrival_time,
                                departure_time: s.departure_time,
                                delay_minutes: 0,
                                is_current: s.is_current,
                                is_departed: s.is_departed,
                                status: s.status,
                                station_type: classifyStation(s.station_code, s.station_name, idx, geminiResult.stations.length),
                                platform: null,
                            })),
                            api_used: 'GEMINI_AI',
                            active_journey_date: activeDate || undefined,
                            is_ai_estimated: true,
                        };
                        cacheService_1.cacheService.set(cacheKey, geminiStatus, 300); // 5 min cache for AI data
                        return geminiStatus;
                    }
                }
                catch (geminiErr) {
                    logger_1.winstonLogger.warn(`[GEMINI_SCHEDULE_FALLBACK_FAIL] ${trainNo}: ${geminiErr.message}`);
                }
            }
            // ── BACKGROUND GEMINI POPULATE ─────────────────────────────────────────────
            // Even when IRCTC is working, if DB has NO schedule for this train,
            // trigger Gemini in background to save station names/schedule for future requests.
            if (scheduleWithDays.length === 0 && liveData) {
                logger_1.winstonLogger.info(`[GEMINI_BG_POPULATE] Train ${trainNo} has no DB schedule — triggering Gemini to populate in background`);
                geminiTrainScheduleService_1.geminiTrainScheduleService.getAndSave(trainNo).catch((e) => logger_1.winstonLogger.warn(`[GEMINI_BG_POPULATE_FAIL] ${trainNo}: ${e.message}`));
            }
            if (!liveData)
                throw new Error('No live data from any API');
            // --- station name ---
            let currentStation = liveData.current_station_name ||
                liveData.current_station ||
                liveData.station_name ||
                liveData.currentStation || '';
            currentStation = await this.resolveStationName(currentStation);
            if (!currentStation)
                currentStation = dbSchedule[0]?.station_name || 'En Route';
            let nextStation = liveData.next_station_name ||
                liveData.next_station || '';
            nextStation = await this.resolveStationName(nextStation);
            if (!nextStation && dbSchedule.length > 1)
                nextStation = dbSchedule[1].station_name;
            // Extract top-level delay (numeric field from various API shapes)
            // trackTrain() stores delay per-station as strings — handled in normalizeTimeline below.
            let delayMins = liveData.arrival_delay ??
                liveData.delay ??
                liveData.departure_delay ??
                liveData.lateBy ??
                liveData.delay_in_mins ??
                liveData.delayInArrival ?? 0;
            // If still 0, try extracting from the last departed station's delay string
            // (covers trackTrain() format where delay is embedded per-station)
            if (!delayMins) {
                const stationsArr = liveData.stations || liveData.timeline || liveData.journey_timeline || liveData.route || [];
                if (stationsArr.length > 0) {
                    // Walk backwards to find the most recent station with a delay string
                    for (let i = stationsArr.length - 1; i >= 0; i--) {
                        const st = stationsArr[i];
                        const d = parseDelayString(st?.departure?.delay) ||
                            parseDelayString(st?.arrival?.delay) || 0;
                        if (d > 0) {
                            delayMins = d;
                            break;
                        }
                    }
                }
            }
            // --- timeline: prefer live, fallback to DB ---
            const rawTimeline = liveData.stations ||
                liveData.timeline ||
                liveData.journey_timeline ||
                liveData.route ||
                [];
            let liveTimeline = await this.normalizeTimeline(rawTimeline, delayMins);
            // Provider Quality Validation
            if (usedApi !== 'DATABASE_SCHEDULE') {
                if (!liveTimeline || liveTimeline.length === 0) {
                    logger_1.winstonLogger.warn(`[PROVIDER_QUALITY_CHECK_FAILED] ${trainNo} via ${usedApi} rejected: Timeline is empty.`);
                    throw new Error('PROVIDER_DATA_CORRUPTED');
                }
                const emptyCodeCount = liveTimeline.filter(s => !s.station_code || s.station_code === '--').length;
                const emptyCodeRatio = emptyCodeCount / liveTimeline.length;
                if (emptyCodeRatio > 0.20) {
                    logger_1.winstonLogger.warn(`[PROVIDER_QUALITY_CHECK_FAILED] ${trainNo} via ${usedApi} rejected: Empty station codes ratio too high (${(emptyCodeRatio * 100).toFixed(1)}%).`);
                    throw new Error('PROVIDER_DATA_CORRUPTED');
                }
                const stationCodes = liveTimeline.map(s => s.station_code).filter(c => c && c !== '--');
                const uniqueCodes = new Set(stationCodes);
                const duplicateRatio = stationCodes.length > 0 ? (stationCodes.length - uniqueCodes.size) / stationCodes.length : 0;
                if (duplicateRatio > 0.20 && liveTimeline.length > 5) {
                    logger_1.winstonLogger.warn(`[PROVIDER_QUALITY_CHECK_FAILED] ${trainNo} via ${usedApi} rejected: Duplicate station codes ratio too high (${(duplicateRatio * 100).toFixed(1)}%).`);
                    throw new Error('PROVIDER_DATA_CORRUPTED');
                }
                const stationPlaceholderCount = liveTimeline.filter(s => s.station_name === 'Station').length;
                const placeholderRatio = liveTimeline.length > 0 ? (stationPlaceholderCount / liveTimeline.length) : 0;
                if (placeholderRatio > 0.50) {
                    logger_1.winstonLogger.warn(`[PROVIDER_QUALITY_CHECK_FAILED] ${trainNo} via ${usedApi} rejected: Placeholder names ratio too high (${(placeholderRatio * 100).toFixed(1)}%).`);
                    throw new Error('PROVIDER_DATA_CORRUPTED');
                }
            }
            // ── FIX(ROUTE_BLOAT): DB schedule is authoritative for route structure ──
            // IRCTC sometimes returns 80-100 station "extended" runs that include
            // the train's previous/next loco journey (e.g. 12116 carries CSMT→SUR
            // run data inside its SUR→CSMT response, inflating station count and
            // making the wrong city appear as origin).
            // Strategy:
            //   • If DB has a schedule → use it as the route skeleton (correct stops).
            //   • Merge IRCTC live data (is_current, is_departed, delay) by code match.
            //   • If DB is empty → fall back to IRCTC timeline as before.
            //   • In both cases: resolve missing station names via stationService.
            let schedule;
            if (dbSchedule.length > 0) {
                // DB route is authoritative — IRCTC only contributes live status fields.
                schedule = dbSchedule.map((dbStop) => {
                    const code = (dbStop.station_code || dbStop.Station_Code || '').toUpperCase();
                    const live = liveTimeline.find((l) => l.station_code && l.station_code.toUpperCase() === code);
                    // Prefer live station name if DB has only a code-as-name placeholder
                    const liveName = live?.station_name && live.station_name !== code ? live.station_name : '';
                    const dbName = dbStop.station_name || dbStop.Station_Name || '';
                    return {
                        Station_Code: code || '--',
                        Station_Name: liveName || dbName || code || '--',
                        Arrival_time: dbStop.arrival_time || dbStop.Arrival_time || '--:--',
                        Departure_Time: dbStop.departure_time || dbStop.Departure_Time || '--:--',
                        // Overlay live fields if IRCTC has a matching stop
                        is_current: live?.is_current || false,
                        is_departed: live?.is_departed || false,
                        delay_minutes: live?.delay_minutes ?? delayMins ?? 0,
                        platform: live?.platform || null,
                    };
                });
                logger_1.winstonLogger.info(`[SCHEDULE_SOURCE] ${trainNo}: using DB schedule (${schedule.length} stops) over IRCTC (${liveTimeline.length} stops)`);
            }
            else {
                // No DB data — fall back to IRCTC timeline
                const routeSchedule = Array.isArray(liveData.route)
                    ? liveData.route.map((stop) => ({
                        Station_Code: stop.stnCode || stop.station_code || stop.code || '--',
                        Station_Name: stop.stnName || stop.station_name || stop.name || '',
                        Arrival_time: stop.arrival || stop.arrival_time || '--:--',
                        Departure_Time: stop.departure || stop.departure_time || '--:--',
                    }))
                    : [];
                schedule = routeSchedule.length > 0
                    ? routeSchedule
                    : liveTimeline.length > 0
                        ? liveTimeline.map((stop) => ({
                            Station_Code: stop.station_code || '--',
                            Station_Name: stop.station_name || stop.station_code || '--',
                            Arrival_time: stop.arrival_time,
                            Departure_Time: stop.departure_time,
                        }))
                        : [];
                logger_1.winstonLogger.info(`[SCHEDULE_SOURCE] ${trainNo}: DB empty, using IRCTC timeline (${schedule.length} stops)`);
            }
            // ── Resolve any remaining missing station names via stationService ──
            // Runs async for any stop where Station_Name == Station_Code or is '--'.
            await Promise.all(schedule.map(async (stop) => {
                const code = (stop.Station_Code || '').toUpperCase();
                const name = stop.Station_Name || '';
                // Resolve if name looks like a raw code (short, all caps) or is '--'
                if (code && code !== '--' && (name === code || name === '--' || !name || name.length <= 5)) {
                    const resolved = await stationService_1.stationService.getStationName(code).catch(() => '');
                    if (resolved && resolved !== code) {
                        stop.Station_Name = resolved;
                    }
                }
            }));
            let currentCode = liveData.current_station_code ||
                liveData.station_code ||
                liveData.currentStation ||
                liveData.currentStationCode ||
                '';
            let usedScheduleFallback = false;
            const startStationCode = (schedule[0]?.Station_Code || schedule[0]?.station_code || '').toUpperCase().trim();
            if (!currentCode || currentCode.toUpperCase().trim() === startStationCode) {
                usedScheduleFallback = true;
                logger_1.winstonLogger.debug(`[LIVE_TRACK] Using schedule fallback for currentCode (start station fix)`);
                const routeStartCode = liveData.route?.[0]?.stnCode ||
                    liveData.route?.[0]?.station_code ||
                    liveData.route?.[0]?.code ||
                    '';
                const trainInfoCode = liveData.trainInfo?.from_stn_code ||
                    liveData.train_info?.from_stn_code ||
                    '';
                const nextActive = schedule.find((s) => {
                    const dep = s.Departure_Time || s.departure_time;
                    return dep && dep !== '--';
                });
                currentCode =
                    routeStartCode ||
                        trainInfoCode ||
                        nextActive?.Station_Code ||
                        nextActive?.station_code ||
                        schedule[0]?.Station_Code ||
                        schedule[0]?.station_code ||
                        '';
            }
            // ── SMART INDEX DETECTOR AND TIME-BASED INFERENCE ──────────────────────────────
            const nowMs = Date.now();
            let currentDayOffsetMs = 0;
            let lastTimeMs = -1;
            const inferredIdx = schedule.findIndex((s) => {
                const dep = s.Departure_Time || s.departure_time || s.Arrival_time || s.arrival_time;
                if (!dep || dep === '--:--')
                    return false;
                const [h, m] = dep.split(':').map(Number);
                let msFromMidnight = (h * 3600 + m * 60) * 1000;
                if (lastTimeMs !== -1 && msFromMidnight < lastTimeMs - 43200000) {
                    currentDayOffsetMs += 86400000;
                }
                lastTimeMs = msFromMidnight;
                const depTime = (() => {
                    if (date) {
                        if (/^\d{4}-\d{2}-\d{2}$/.test(date)) {
                            return new Date(`${date}T00:00:00+05:30`);
                        }
                        const parsed = new Date(date);
                        if (!isNaN(parsed.getTime())) {
                            const y = parsed.getFullYear();
                            const m = String(parsed.getMonth() + 1).padStart(2, '0');
                            const d = String(parsed.getDate()).padStart(2, '0');
                            return new Date(`${y}-${m}-${d}T00:00:00+05:30`);
                        }
                    }
                    const now = new Date();
                    const utcMs = now.getTime() + now.getTimezoneOffset() * 60000;
                    const istNow = new Date(utcMs + 5.5 * 3600000);
                    const yyyy = istNow.getFullYear();
                    const mm = String(istNow.getMonth() + 1).padStart(2, '0');
                    const dd = String(istNow.getDate()).padStart(2, '0');
                    return new Date(`${yyyy}-${mm}-${dd}T00:00:00+05:30`);
                })();
                const absoluteDepMs = depTime.getTime() + msFromMidnight + currentDayOffsetMs;
                return absoluteDepMs > nowMs;
            });
            let timeBasedIdx = 0;
            let isTimeCompleted = false;
            if (inferredIdx > 0) {
                timeBasedIdx = inferredIdx - 1;
            }
            else if (inferredIdx === 0) {
                timeBasedIdx = 0;
            }
            else if (inferredIdx === -1 && schedule.length > 1) {
                timeBasedIdx = schedule.length - 1; // Completed
                isTimeCompleted = true;
            }
            let currentIndex = -1;
            if (usedApi === 'DATABASE_SCHEDULE') {
                currentIndex = timeBasedIdx;
            }
            else if (schedule.length > 0 && currentCode) {
                const code = currentCode.toUpperCase().trim();
                currentIndex = schedule.findIndex((s) => {
                    const dbCode = (s.Station_Code || s.station_code || '').toUpperCase().trim();
                    const dbName = (s.Station_Name || s.station_name || '').toUpperCase().trim();
                    const currentName = (currentStation || '').toUpperCase().trim();
                    return (dbCode === code ||
                        (!!currentName && dbName === currentName) ||
                        (!!currentName && dbName.includes(currentName)) ||
                        (!!dbCode && code.includes(dbCode)));
                });
            }
            // ── SMART INDEX DETECTOR ─────────────────────────────────────
            // Avoid naive time-based inference which breaks on multi-day journeys (midnight rollovers).
            let detectedIndex = -1;
            // 1. Trust API is_current flags first
            if (liveTimeline.length > 0) {
                detectedIndex = liveTimeline.findIndex(s => s.is_current);
                if (detectedIndex === -1) {
                    // Find last departed without using ES2023 findLastIndex
                    let lastDeparted = -1;
                    for (let i = liveTimeline.length - 1; i >= 0; i--) {
                        if (liveTimeline[i].is_departed) {
                            lastDeparted = i;
                            break;
                        }
                    }
                    if (lastDeparted !== -1)
                        detectedIndex = lastDeparted;
                }
            }
            if (detectedIndex !== -1 && (currentIndex === -1 || currentCode === 'CSMT' || usedScheduleFallback)) {
                currentIndex = detectedIndex;
            }
            // If train has completed journey, ignore stale API tracking at source and force to destination
            if (isTimeCompleted && (currentIndex <= 0 || usedScheduleFallback || usedApi === 'DATABASE_SCHEDULE')) {
                currentIndex = timeBasedIdx;
            }
            if (currentIndex === -1) {
                currentIndex = 0;
            }
            // ── Build FULL timeline (never slice) ────────────────────────────────
            // Use the full schedule so the user can see all departed + upcoming stops.
            // Only `is_current` / `is_departed` flags change to reflect position.
            const fullSchedule = schedule.length > 0 ? schedule : dbSchedule;
            const actualCurrentIndex = currentIndex >= 0 ? currentIndex : 0;
            const resolveValidTime = (liveVal, schedVal) => {
                if (!liveVal || liveVal === '--:--')
                    return schedVal || '--:--';
                return liveVal;
            };
            const finalTimeline = fullSchedule.map((stop, idx) => {
                const stopCode = stop.Station_Code || stop.station_code || stop.station_code || '--';
                const liveStop = liveTimeline.find((l) => l.station_code && stopCode && l.station_code.toUpperCase() === stopCode.toUpperCase());
                const isCurrent = idx === actualCurrentIndex;
                const isDeparted = idx < actualCurrentIndex;
                const stopName = stop.Station_Name || stop.station_name || liveStop?.station_name || 'Station';
                return {
                    station_name: stopName,
                    station_code: stopCode,
                    arrival_time: resolveValidTime(liveStop?.arrival_time, stop.Arrival_time || stop.arrival_time),
                    departure_time: resolveValidTime(liveStop?.departure_time, stop.Departure_Time || stop.departure_time),
                    delay_minutes: liveStop?.delay_minutes || delayMins || 0,
                    is_current: isCurrent,
                    is_departed: isDeparted,
                    status: isCurrent ? 'CURRENT' : isDeparted ? 'DEPARTED' : 'UPCOMING',
                    station_type: classifyStation(stopCode, stopName, idx, fullSchedule.length),
                    platform: liveStop?.platform || null
                };
            });
            logger_1.winstonLogger.debug(`[LIVE_TRACK_FIX] currentCode=${currentCode} matchedIdx=${actualCurrentIndex} totalStops=${fullSchedule.length} currentStation=${finalTimeline[actualCurrentIndex]?.station_name}`);
            const finalCurrentStation = fullSchedule[actualCurrentIndex]?.Station_Name ||
                fullSchedule[actualCurrentIndex]?.station_name ||
                currentStation ||
                trainNo;
            const finalNextStation = fullSchedule[actualCurrentIndex + 1]?.Station_Name ||
                fullSchedule[actualCurrentIndex + 1]?.station_name ||
                nextStation ||
                finalCurrentStation;
            const trainName = liveData.train_name || liveData.name || dbTrainName || `Train ${trainNo}`;
            const isJourneyCompleted = isTimeCompleted || actualCurrentIndex === fullSchedule.length - 1;
            const result = {
                train_number: trainNo,
                train_name: trainName,
                current_station: finalCurrentStation,
                next_station: isJourneyCompleted ? 'Destination Reached' : finalNextStation,
                current_station_index: actualCurrentIndex,
                latitude: liveData.latitude || liveData.current_lat || liveData.lat,
                longitude: liveData.longitude || liveData.current_lng || liveData.lng,
                train_location: liveData.latitude || liveData.current_lat || liveData.lat
                    ? {
                        lat: Number(liveData.latitude || liveData.current_lat || liveData.lat),
                        lon: Number(liveData.longitude || liveData.current_lng || liveData.lng),
                    }
                    : null,
                delay_minutes: delayMins,
                status_summary: isJourneyCompleted ? 'Train has reached destination' : (liveData.status_as_of || liveData.position || liveData.current_status || 'Running'),
                last_updated: liveData.last_updated_time || liveData.updated_at || new Date().toLocaleTimeString('en-IN'),
                is_running: isJourneyCompleted ? false : (liveData.is_running ?? true),
                journey_timeline: finalTimeline,
                api_used: usedApi,
                active_journey_date: activeDate || undefined
            };
            cacheService_1.cacheService.set(cacheKey, result, 60);
            logger_1.winstonLogger.info(`[LIVE_SUCCESS] ${trainNo} "${trainName}" @ ${finalCurrentStation} | Delay:${delayMins}m | TL:${finalTimeline.length} stops | API:${usedApi}`);
            return result;
        }
        catch (err) {
            logger_1.winstonLogger.error(`[LIVE_FAIL] ${trainNo}: ${err.message} — falling back to DB schedule`);
            const trainName = dbTrainName || `Train ${trainNo}`;
            // In DB-only fallback: use time-based inference to find current stop
            const nowMs = Date.now();
            let fallbackIdx = 0;
            // Calculate absolute times by rolling over midnight
            let currentDayOffsetMs = 0;
            let lastTimeMs = -1;
            const inferredIdx = dbSchedule.findIndex((s) => {
                const dep = s.departure_time;
                if (!dep || dep === '--:--')
                    return false;
                const [h, m] = dep.split(':').map(Number);
                let msFromMidnight = (h * 3600 + m * 60) * 1000;
                // If time goes backwards (e.g. 23:00 to 01:00), we crossed midnight
                if (lastTimeMs !== -1 && msFromMidnight < lastTimeMs - 43200000) {
                    currentDayOffsetMs += 86400000; // +1 day
                }
                lastTimeMs = msFromMidnight;
                const depTime = (() => {
                    if (date) {
                        if (/^\d{4}-\d{2}-\d{2}$/.test(date)) {
                            return new Date(`${date}T00:00:00+05:30`);
                        }
                        const parsed = new Date(date);
                        if (!isNaN(parsed.getTime())) {
                            const y = parsed.getFullYear();
                            const m = String(parsed.getMonth() + 1).padStart(2, '0');
                            const d = String(parsed.getDate()).padStart(2, '0');
                            return new Date(`${y}-${m}-${d}T00:00:00+05:30`);
                        }
                    }
                    const now = new Date();
                    const utcMs = now.getTime() + now.getTimezoneOffset() * 60000;
                    const istNow = new Date(utcMs + 5.5 * 3600000);
                    const yyyy = istNow.getFullYear();
                    const mm = String(istNow.getMonth() + 1).padStart(2, '0');
                    const dd = String(istNow.getDate()).padStart(2, '0');
                    return new Date(`${yyyy}-${mm}-${dd}T00:00:00+05:30`);
                })();
                const absoluteDepMs = depTime.getTime() + msFromMidnight + currentDayOffsetMs;
                return absoluteDepMs > nowMs;
            });
            if (inferredIdx > 0) {
                fallbackIdx = inferredIdx - 1;
            }
            else if (inferredIdx === -1 && dbSchedule.length > 1) {
                // All stops are in the past — journey is complete.
                fallbackIdx = dbSchedule.length - 1;
            }
            // inferredIdx === 0: fallbackIdx stays 0 (train just departed origin)
            const isJourneyCompletedFallback = fallbackIdx === dbSchedule.length - 1;
            const fallbackTimeline = dbSchedule.map((s, idx) => ({
                ...s,
                is_current: idx === fallbackIdx,
                is_departed: idx < fallbackIdx,
                status: idx === fallbackIdx ? 'CURRENT' : idx < fallbackIdx ? 'DEPARTED' : 'UPCOMING'
            }));
            const fallback = {
                train_number: trainNo,
                train_name: trainName,
                current_station: dbSchedule[fallbackIdx]?.station_name || 'En Route',
                next_station: isJourneyCompletedFallback ? 'Destination Reached' : (dbSchedule[fallbackIdx + 1]?.station_name || 'Unknown'),
                current_station_index: fallbackIdx,
                delay_minutes: 0,
                status_summary: isJourneyCompletedFallback ? 'Train has reached destination' : (fallbackTimeline.length > 0 ? 'Running' : 'Status unavailable'),
                last_updated: new Date().toLocaleTimeString('en-IN'),
                is_running: isJourneyCompletedFallback ? false : true,
                journey_timeline: fallbackTimeline,
                api_used: 'DATABASE_SCHEDULE',
                active_journey_date: activeDate || undefined
            };
            cacheService_1.cacheService.set(cacheKey, fallback, 180);
            return fallback;
        }
    }
}
exports.LiveTrackingService = LiveTrackingService;
exports.liveTrackingService = new LiveTrackingService();
