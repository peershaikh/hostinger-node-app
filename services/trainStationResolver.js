"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.toIrctcApiCodeConservative = exports.toIrctcApiCode = exports.mapProviderErrorToReason = void 0;
exports.padTrainNo = padTrainNo;
exports.resolveSegmentForAvailability = resolveSegmentForAvailability;
/**
 * PHASE_4C862 — Train-aware station resolution and pre-IRCTC segment validation.
 */
const supabase_1 = require("../config/supabase");
const logger_1 = require("../middleware/logger");
const cacheService_1 = require("./cacheService");
const irctcService_1 = require("./irctcService");
const stationResolutionUtils_1 = require("./stationResolutionUtils");
var stationResolutionUtils_2 = require("./stationResolutionUtils");
Object.defineProperty(exports, "mapProviderErrorToReason", { enumerable: true, get: function () { return stationResolutionUtils_2.mapProviderErrorToReason; } });
Object.defineProperty(exports, "toIrctcApiCode", { enumerable: true, get: function () { return stationResolutionUtils_2.toIrctcApiCode; } });
Object.defineProperty(exports, "toIrctcApiCodeConservative", { enumerable: true, get: function () { return stationResolutionUtils_2.toIrctcApiCodeConservative; } });
const SCHEDULE_CACHE_TTL = 7200;
function padTrainNo(trainNo) {
    const t = String(trainNo || '').trim();
    if (/^\d+$/.test(t))
        return t.padStart(5, '0');
    return t;
}
async function loadRunningDays(trainNo) {
    const tNo = padTrainNo(trainNo);
    if ((0, supabase_1.isSupabaseConfigured)()) {
        try {
            const { data } = await supabase_1.supabase
                .from('trains')
                .select('running_days')
                .eq('number', tNo)
                .maybeSingle();
            if (data?.running_days)
                return data.running_days;
        }
        catch { /* fall through */ }
    }
    return null;
}
async function loadScheduleFromDb(trainNo) {
    if (!(0, supabase_1.isSupabaseConfigured)())
        return [];
    const tNo = padTrainNo(trainNo);
    const { data, error } = await supabase_1.supabase
        .from('train_schedule')
        .select('Station_Code, SN, Station_Name, Arrival_time, Departure_Time')
        .eq('Train_No', tNo)
        .order('SN', { ascending: true });
    if (error || !data?.length)
        return [];
    return data;
}
function mapIrctcInfoToStops(info) {
    const route = info?.route || info?.station_list || info?.stops || [];
    if (!Array.isArray(route))
        return [];
    return route.map((s, idx) => ({
        Station_Code: (s.stnCode || s.station_code || s.Station_Code || s.code || '').toUpperCase().trim(),
        SN: s.sn || s.SN || s.dayNum || idx + 1,
        Station_Name: s.stnName || s.station_name || s.Station_Name || '',
        Arrival_time: s.arrival || s.arrival_time || s.Arrival_time || '',
        Departure_Time: s.departure || s.departure_time || s.Departure_Time || '',
    })).filter((s) => s.Station_Code.length > 0);
}
async function loadTrainScheduleContext(trainNo) {
    const tNo = padTrainNo(trainNo);
    const cacheKey = `sched_ctx_${tNo}`;
    const cached = cacheService_1.cacheService.get(cacheKey);
    if (cached)
        return cached;
    let stops = await loadScheduleFromDb(tNo);
    let runningDays = await loadRunningDays(tNo);
    let source = stops.length > 0 ? 'db' : 'none';
    if (stops.length <= 2) {
        try {
            const info = await irctcService_1.irctcService.getTrainInfo(tNo);
            if (info) {
                const irctcStops = mapIrctcInfoToStops(info);
                if (irctcStops.length > stops.length) {
                    stops = irctcStops;
                    source = 'irctc';
                }
                if (!runningDays) {
                    runningDays = info.trainInfo?.running_days || info.running_days || null;
                }
            }
        }
        catch (e) {
            logger_1.winstonLogger.warn(`[STATION_RESOLVER] IRCTC schedule fallback failed for ${tNo}: ${e.message}`);
        }
    }
    const ctx = { stops, runningDays, source };
    if (stops.length > 0) {
        cacheService_1.cacheService.set(cacheKey, ctx, SCHEDULE_CACHE_TTL);
    }
    return ctx;
}
/**
 * Validate and resolve from/to for a train segment before calling IRCTC availability.
 */
async function resolveSegmentForAvailability(trainNo, from, to, date) {
    const tNo = padTrainNo(trainNo);
    const fromIn = from.toUpperCase().trim();
    const toIn = to.toUpperCase().trim();
    if (!tNo || !fromIn || !toIn) {
        return {
            success: false,
            reason: 'SEGMENT_NOT_BOOKABLE',
            message: 'Missing train number or station codes',
        };
    }
    const ctx = await loadTrainScheduleContext(tNo);
    // Restored: Check if train actually runs on this specific boarding date
    if (ctx.runningDays && date) {
        const { normalizeRunningDays, isDayActiveForBoarding } = require('../utils/dayUtils');
        const binary = normalizeRunningDays(ctx.runningDays);
        const fromStop = (0, stationResolutionUtils_1.findStopOnSchedule)(ctx.stops, fromIn);
        if (fromStop && binary) {
            const dayOffset = (fromStop.Day || fromStop.day || 1) - 1;
            if (!isDayActiveForBoarding(binary, date, dayOffset)) {
                logger_1.winstonLogger.info(`[STATION_RESOLVER] TRAIN_NOT_RUNNING train=${tNo} boarding=${fromIn} date=${date}`);
                return {
                    success: false,
                    reason: 'TRAIN_NOT_RUNNING',
                    message: `Train ${tNo} does not depart its origin on the required date to arrive at ${fromIn} on ${date}`,
                };
            }
        }
    }
    if (ctx.stops.length === 0) {
        logger_1.winstonLogger.warn(`[STATION_RESOLVER] No schedule for ${tNo} — conservative API codes only`);
        return {
            success: true,
            scheduleFrom: fromIn,
            scheduleTo: toIn,
            apiFrom: (0, stationResolutionUtils_1.toIrctcApiCodeConservative)(fromIn),
            apiTo: (0, stationResolutionUtils_1.toIrctcApiCodeConservative)(toIn),
        };
    }
    const fromStop = (0, stationResolutionUtils_1.findStopOnSchedule)(ctx.stops, fromIn);
    if (!fromStop) {
        logger_1.winstonLogger.info(`[STATION_RESOLVER] INVALID_BOARDING train=${tNo} from=${fromIn}`);
        return {
            success: false,
            reason: 'INVALID_BOARDING_STATION',
            message: `Station ${fromIn} is not a stop on train ${tNo}`,
        };
    }
    const toStop = (0, stationResolutionUtils_1.findStopOnSchedule)(ctx.stops, toIn);
    if (!toStop) {
        logger_1.winstonLogger.info(`[STATION_RESOLVER] INVALID_DESTINATION train=${tNo} to=${toIn}`);
        return {
            success: false,
            reason: 'INVALID_DESTINATION_STATION',
            message: `Station ${toIn} is not a stop on train ${tNo}`,
        };
    }
    if (Number(fromStop.SN) >= Number(toStop.SN)) {
        return {
            success: false,
            reason: 'SEGMENT_NOT_BOOKABLE',
            message: `Cannot book ${fromStop.Station_Code}→${toStop.Station_Code} on train ${tNo} — destination must be after boarding`,
        };
    }
    const scheduleFrom = fromStop.Station_Code.toUpperCase().trim();
    const scheduleTo = toStop.Station_Code.toUpperCase().trim();
    const apiFrom = (0, stationResolutionUtils_1.toIrctcApiCode)(scheduleFrom, ctx.stops);
    const apiTo = (0, stationResolutionUtils_1.toIrctcApiCode)(scheduleTo, ctx.stops);
    logger_1.winstonLogger.info(`[STATION_RESOLVER] train=${tNo} user=${fromIn}→${toIn} schedule=${scheduleFrom}→${scheduleTo} api=${apiFrom}→${apiTo}`);
    // PHASE_4C871 — async knowledge mapping persist (non-blocking, no API behaviour change)
    try {
        const { knowledgeService } = require('./knowledgeService');
        knowledgeService.scheduleMappingPersist(tNo, fromIn, toIn, {
            scheduleFrom,
            scheduleTo,
            apiFrom,
            apiTo,
        });
    }
    catch {
        // knowledge layer optional
    }
    return { success: true, scheduleFrom, scheduleTo, apiFrom, apiTo };
}
