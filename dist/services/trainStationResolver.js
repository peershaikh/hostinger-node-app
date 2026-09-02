"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.toIrctcApiCodeConservative = exports.toIrctcApiCode = exports.mapProviderErrorToReason = void 0;
exports.padTrainNo = padTrainNo;
exports.getDayOffsetForStop = getDayOffsetForStop;
exports.resolveSegmentForAvailability = resolveSegmentForAvailability;
/**
 * PHASE_4C862 — Train-aware station resolution and pre-IRCTC segment validation.
 */
const supabase_1 = require("../config/supabase");
const logger_1 = require("../middleware/logger");
const dayUtils_1 = require("../utils/dayUtils");
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
async function loadTrainMeta(trainNo) {
    const tNo = padTrainNo(trainNo);
    if ((0, supabase_1.isSupabaseConfigured)()) {
        try {
            const { data } = await supabase_1.supabase
                .from('trains')
                .select('running_days')
                .eq('number', tNo)
                .maybeSingle();
            if (data) {
                return {
                    running_days: data.running_days || null,
                };
            }
        }
        catch { /* fall through */ }
    }
    return { running_days: null };
}
async function loadRunningDays(trainNo) {
    const meta = await loadTrainMeta(trainNo);
    return meta.running_days;
}
async function loadScheduleFromDb(trainNo) {
    if (!(0, supabase_1.isSupabaseConfigured)())
        return { stops: [], originCorrected: false };
    const tNo = padTrainNo(trainNo);
    const { data, error } = await supabase_1.supabase
        .from('train_schedule')
        .select('Station_Code, SN, Station_Name, Arrival_time, Departure_Time')
        .eq('Train_No', tNo)
        .order('SN', { ascending: true });
    if (error || !data?.length)
        return { stops: [], originCorrected: false };
    const rows = data;
    // Generic Pan-India Physical-Stop Verification:
    // If DB origin (SN=1) was synthetically overwritten by legacy search logging (e.g. ADI instead of GNC),
    // correct SN=1 to true physical origin extracted from train registry.
    // PHASE_5B081: Also return originCorrected=true when a mismatch is detected — this signals
    // that the DB schedule may contain other corrupted stops (e.g. AII at SN:8 for 19407) and
    // the authoritative live route must be fetched for physical-stop validation.
    //
    // PHASE_5B129: the decision itself now lives in stationResolutionUtils.decideOriginCorrection()
    // — a pure function, so it is executable offline and shared with the split engine's contract.
    // Supabase stays here. Two behaviours the helper guarantees and this call site relies on:
    //   1. only an AUTHORITATIVE origin (verified/live/db-validated) may rewrite Station_Code;
    //      an `inferred` train-name guess must never change physical station identity.
    //   2. originCorrected is still true on a detected compatible mismatch even when the
    //      rewrite was suppressed — it is what triggers the authoritative live re-fetch below.
    const decision = (0, stationResolutionUtils_1.decideOriginCorrection)(rows, tNo);
    if (decision.originCorrected && !decision.rewriteApplied) {
        logger_1.winstonLogger.info(`[STATION_RESOLVER] DB origin mismatch for ${tNo} (db=${decision.dbOrigin} registry=${decision.registryOrigin} confidence=${decision.registryConfidence}) — rewrite SUPPRESSED (non-authoritative); DB stops left unchanged, live re-validation requested`);
    }
    return { stops: decision.stops, originCorrected: decision.originCorrected };
}
function mapIrctcInfoToStops(info) {
    const route = info?.route || info?.station_list || info?.stops || [];
    if (!Array.isArray(route))
        return [];
    return route.map((s, idx) => {
        // PHASE_5B122 — `dayNum` REMOVED from SN derivation.
        //
        // dayNum is the journey-day index (1,2,3 on a multi-day train), not a stop
        // sequence — this repo's own day arithmetic multiplies it by 1440 minutes.
        // Using it as SN collapsed a 40-stop route onto ~3 values, which then silently
        // corrupted every downstream SN comparison (segment ordering, reverse-segment
        // detection, origin derivation). It must never be a stop sequence again.
        //
        // The canonical normalizer (serialNo → sn → SN, no dayNum, no positional
        // fabrication) decides whether the provider actually supplied a sequence.
        const normalized = (0, stationResolutionUtils_1.normalizeStopSN)(s);
        // Positional fallback is retained ONLY so existing ordering comparisons in this
        // file (`Number(fromStop.SN) >= Number(toStop.SN)`) keep working when a provider
        // omits SN — behaviour unchanged from before this phase for that purpose.
        // `_snProvided` records that the value is synthetic so authority-bearing callers
        // (origin derivation) do not mistake array position for provider evidence.
        const snProvided = normalized.status === 'valid';
        return {
            Station_Code: (s.stationCode || s.stnCode || s.station_code || s.Station_Code || s.code || '').toUpperCase().trim(),
            SN: snProvided ? normalized.value : idx + 1,
            _snProvided: snProvided,
            Station_Name: s.stationName || s.stnName || s.station_name || s.Station_Name || '',
            Day: s.day !== undefined ? Number(s.day) : (s.Day !== undefined ? Number(s.Day) : undefined),
            day: s.day !== undefined ? Number(s.day) : (s.Day !== undefined ? Number(s.Day) : undefined),
            Arrival_time: s.arrival || s.arrival_time || s.Arrival_time || '',
            Departure_Time: s.departure || s.departure_time || s.Departure_Time || '',
        };
    }).filter((s) => s.Station_Code.length > 0);
}
async function loadTrainScheduleContext(trainNo, fromIn, toIn, runningDaysHint) {
    const tNo = padTrainNo(trainNo);
    // PHASE_5B129 — v2 → v3. Entries written before this phase may contain a DB origin
    // that an `inferred` (train-name parsed) code overwrote, and they carry a 7200s TTL.
    // Bumping the existing version token in the key makes every such entry unreachable
    // immediately rather than letting it be served for up to two more hours.
    // PHASE_5B161 — v3 → v4. v3 contexts carry no service-date window / runningDays
    // authority, so they must not authorise a date under the new fail-closed rule.
    const cacheKey = `sched_ctx_v4_${tNo}`;
    let cached = cacheService_1.cacheService.get(cacheKey);
    if (cached && cached.stops && cached.stops.length > 2) {
        const hasFrom = fromIn ? !!(0, stationResolutionUtils_1.findStopOnSchedule)(cached.stops, fromIn) : true;
        const hasTo = toIn ? !!(0, stationResolutionUtils_1.findStopOnSchedule)(cached.stops, toIn) : true;
        if (hasFrom && hasTo) {
            return cached;
        }
        cacheService_1.cacheService.del(cacheKey);
        cached = null;
    }
    const { stops: dbStops, originCorrected } = await loadScheduleFromDb(tNo);
    const meta = await loadTrainMeta(tNo);
    let runningDays = meta.running_days;
    let status = null;
    let is_cancelled = null;
    const hasFrom = fromIn ? !!(0, stationResolutionUtils_1.findStopOnSchedule)(dbStops, fromIn) : true;
    const hasTo = toIn ? !!(0, stationResolutionUtils_1.findStopOnSchedule)(dbStops, toIn) : true;
    // PHASE_5B081: dbOriginSuspect=true when DB SN:1 was synthetically different from the known
    // physical origin (detected in loadScheduleFromDb). This is a reliable indicator that the
    // DB schedule may contain other corrupted stops (e.g. AII at SN:8 for train 19407, which
    // does not exist on the authoritative live route SBIB->LGH). When suspect, we must fetch
    // the authoritative live route and use it for physical-stop validation — DB alone is not
    // sufficient. This does NOT affect split candidate generation or hub selection.
    //
    // PHASE_5B129: this chain is unchanged and load-bearing —
    //   originCorrected -> dbOriginSuspect -> live fallback -> live replacement when available.
    // What changed is only the failure mode: if the live fetch does not produce stops, the
    // ORIGINAL DB stops are kept (decideScheduleContext) and no inferred code was ever written
    // into them (decideOriginCorrection), so a failed fetch can no longer publish a fabricated
    // boarding station.
    const dbOriginSuspect = originCorrected;
    if (dbOriginSuspect) {
        logger_1.winstonLogger.info(`[STATION_RESOLVER] dbOriginSuspect=true for ${tNo} — DB origin was synthetically overwritten; fetching authoritative live route`);
    }
    // PHASE_5B161 — service-date truth cannot rely on a stale DB 'Daily'. A seasonal
    // special (09xxx) or a non-authoritative 'Daily' placeholder is evidence that the
    // `trains.running_days` column may simply be the ingest-time default, not a real
    // schedule. Fetch the authoritative IRCTC train-info once to recover a real
    // running_days pattern and/or a validFrom/validTo service window.
    const runningDaysLower = String(runningDays || '').toLowerCase().trim();
    const runningDaysIsDailyPlaceholder = runningDaysLower === 'daily' ||
        runningDaysLower === 'all days' ||
        runningDaysLower === '0,1,2,3,4,5,6' ||
        runningDaysLower === '1111111' ||
        runningDaysLower.includes('all');
    const needsServiceWindow = (0, dayUtils_1.isSpecialTrainNumber)(tNo) || runningDaysIsDailyPlaceholder || !runningDays;
    let liveStops = null;
    let validFrom = null;
    let validTo = null;
    let runningDaysAuthoritative = false;
    // PHASE_084H — apply pre-fetched running-days hint from Split Engine Phase 2.5
    // when available. This avoids calling getTrainInfo a second time solely for
    // service-date truth when the Split Engine already fetched it. Physical stop
    // validation (scheduleFetchNeeded) is separate and still triggers its own fetch.
    let runningDaysFromHint = false;
    if (runningDaysHint && runningDaysHint.runningDaysAuthoritative) {
        // Apply the pre-fetched authoritative running days directly.
        runningDays = runningDaysHint.runningDays;
        runningDaysAuthoritative = true;
        if (runningDaysHint.isCancelled !== null)
            is_cancelled = runningDaysHint.isCancelled;
        runningDaysFromHint = true;
        logger_1.winstonLogger.debug(`[STATION_RESOLVER] RD_HINT applied for ${tNo}: rd=${runningDays} auth=true isCancelled=${runningDaysHint.isCancelled}`);
    }
    const scheduleFetchNeeded = (0, stationResolutionUtils_1.isLiveScheduleRequired)({
        dbStopCount: dbStops.length,
        originCorrected: dbOriginSuspect,
        hasFrom,
        hasTo,
    });
    // PHASE_087I — For permanent (non-seasonal) trains with verified DB schedule rows,
    // treat "Daily" in the trains table as authoritative running-days evidence.
    //
    // Rationale: the fail-closed gate (trainOperatesOnDate returning UNKNOWN for
    // non-authoritative "Daily") was designed to block seasonal/special trains (09xxx)
    // from masquerading as daily services when getTrainInfo is unavailable. For
    // well-known, permanently-running trains (12701, 17031, 17013, etc.) that have
    // verified schedule rows in train_schedule, "Daily" is a correct description
    // and live authority is unavailable only due to IRCTC timeout/rate-limit, not
    // because the data is fabricated.
    //
    // Guards:
    //   1. !isSpecialTrainNumber(tNo) — seasonal/charter trains (09xxx) are EXCLUDED.
    //   2. dbStops.length > 0 — train must have verified schedule data before we trust run-days.
    //   3. !runningDaysFromHint — live hint already applied; don’t double-apply.
    //   4. runningDaysIsDailyPlaceholder — only for the specific "Daily" pattern.
    const isDailyAuthoritativeFromDb = !runningDaysFromHint &&
        !(0, dayUtils_1.isSpecialTrainNumber)(tNo) &&
        runningDaysIsDailyPlaceholder &&
        dbStops.length > 0;
    if (isDailyAuthoritativeFromDb) {
        runningDaysAuthoritative = true;
        logger_1.winstonLogger.debug(`[STATION_RESOLVER] RD_DB_AUTH for ${tNo}: non-special train with ${dbStops.length} DB schedule stops — treating "Daily" as authoritative (PHASE_087I)`);
    }
    // Only call getTrainInfo when:
    // - physical stop validation needs a live schedule (scheduleFetchNeeded), OR
    // - service-date truth still needs resolving AND we have no pre-fetched hint
    //   AND the DB-authoritative path did not already resolve it
    const serviceWindowNeeded = needsServiceWindow && !runningDaysFromHint && !isDailyAuthoritativeFromDb;
    if (scheduleFetchNeeded || serviceWindowNeeded) {
        try {
            const info = await irctcService_1.irctcService.getTrainInfo(tNo);
            if (info) {
                const irctcStops = mapIrctcInfoToStops(info);
                if (irctcStops.length > 0) {
                    liveStops = irctcStops;
                }
                const inner = info.trainInfo || info;
                const liveRunningDays = inner?.running_days || inner?.runningDays || info?.running_days || info?.runningDays || null;
                const liveValidFrom = inner?.validFrom || inner?.valid_from || info?.validFrom || info?.valid_from || null;
                const liveValidTo = inner?.validTo || inner?.valid_to || info?.validTo || info?.valid_to || null;
                const liveStatus = inner?.train_status || inner?.status || info?.train_status || info?.status || null;
                const liveCancelled = inner?.is_cancelled === true || inner?.isCancelled === true || info?.is_cancelled === true || info?.isCancelled === true ||
                    (liveStatus && (liveStatus.toLowerCase().includes('cancel') || liveStatus.toLowerCase().includes('suspend')))
                    ? true
                    : (inner?.is_cancelled === false || inner?.isCancelled === false ? false : undefined);
                if (liveValidFrom)
                    validFrom = liveValidFrom;
                if (liveValidTo)
                    validTo = liveValidTo;
                // Only apply live running-days if we don't already have an authoritative hint
                if (liveRunningDays && !runningDaysFromHint) {
                    runningDays = liveRunningDays;
                    runningDaysAuthoritative = true;
                }
                if (liveStatus)
                    status = liveStatus;
                // Only override isCancelled from live if hint didn't already set it
                if (liveCancelled !== undefined && !runningDaysFromHint)
                    is_cancelled = liveCancelled;
            }
        }
        catch (e) {
            logger_1.winstonLogger.warn(`[STATION_RESOLVER] IRCTC schedule/service-window fallback failed for ${tNo}: ${e.message}`);
        }
    }
    const decided = (0, stationResolutionUtils_1.decideScheduleContext)({
        dbStops,
        originCorrected: dbOriginSuspect,
        liveStops,
        hasFrom,
        hasTo,
    });
    if (dbOriginSuspect && !decided.liveApplied) {
        logger_1.winstonLogger.warn(`[STATION_RESOLVER] dbOriginSuspect=true for ${tNo} but live route unavailable — keeping ORIGINAL DB stops (source=${decided.source}); no inferred origin substituted`);
    }
    const ctx = {
        stops: decided.stops,
        runningDays,
        source: decided.source,
        validFrom,
        validTo,
        runningDaysAuthoritative,
        status,
        is_cancelled,
    };
    if (decided.stops.length > 0) {
        cacheService_1.cacheService.set(cacheKey, ctx, SCHEDULE_CACHE_TTL);
    }
    return ctx;
}
function getDayOffsetForStop(stops, stop) {
    if (stop.Day || stop.day) {
        return Math.max(0, (stop.Day || stop.day) - 1);
    }
    let currentDay = 1;
    let prevTimeMinutes = -1;
    for (const s of stops) {
        const timeStr = s.Departure_Time && s.Departure_Time !== '--' ? s.Departure_Time : s.Arrival_time;
        if (timeStr && timeStr !== '--') {
            const parts = timeStr.split(':');
            if (parts.length >= 2) {
                const mins = parseInt(parts[0], 10) * 60 + parseInt(parts[1], 10);
                if (prevTimeMinutes >= 0 && mins < prevTimeMinutes) {
                    currentDay++;
                }
                prevTimeMinutes = mins;
            }
        }
        if (s.Station_Code === stop.Station_Code || s.SN === stop.SN) {
            return Math.max(0, currentDay - 1);
        }
    }
    return 0;
}
/**
 * Validate and resolve from/to for a train segment before calling IRCTC availability.
 */
async function resolveSegmentForAvailability(trainNo, from, to, date, hints) {
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
    // PHASE_084H — look up pre-fetched running-days from Split Engine Phase 2.5
    const rdHint = hints?.runningDaysCache?.get(tNo) ?? hints?.runningDaysCache?.get(trainNo);
    const ctx = await loadTrainScheduleContext(tNo, fromIn, toIn, rdHint);
    // PHASE_5B167 — generic cancellation gate. Cancelled/suspended trains fail closed.
    if (ctx.is_cancelled === true || (ctx.status && (ctx.status.toLowerCase().includes('cancel') || ctx.status.toLowerCase().includes('suspend')))) {
        logger_1.winstonLogger.info(`[STATION_RESOLVER] TRAIN_CANCELLED train=${tNo} boarding=${fromIn} date=${date}`);
        return {
            success: false,
            reason: 'TRAIN_CANCELLED',
            message: `Train ${tNo} is cancelled`,
        };
    }
    // PHASE_5B161 — generic service-date truth. UNKNOWN must fail closed for split
    // candidate eligibility: a DB 'Daily' placeholder or missing date metadata must
    // never silently authorise "operates on this date".
    if (date) {
        const fromStop = (0, stationResolutionUtils_1.findStopOnSchedule)(ctx.stops, fromIn);
        const dayOffset = fromStop ? getDayOffsetForStop(ctx.stops, fromStop) : 0;
        const verdict = (0, dayUtils_1.trainOperatesOnDate)(date, ctx.runningDays, {
            validFrom: ctx.validFrom,
            validTo: ctx.validTo,
            runningDaysAuthoritative: ctx.runningDaysAuthoritative === true,
            dayOffset,
        });
        if (verdict !== 'YES') {
            // PHASE_084K — Distinguish between "confirmed not running" (NO) and
            // "authoritative data unavailable" (UNKNOWN). Both fail closed, but
            // UNKNOWN must NOT be labelled TRAIN_NOT_RUNNING — that implies the
            // train genuinely does not operate, which is fabricated without evidence.
            if (verdict === 'UNKNOWN') {
                logger_1.winstonLogger.info(`[STATION_RESOLVER] RUNNING_DAYS_UNKNOWN train=${tNo} boarding=${fromIn} date=${date}` +
                    ` rd=${ctx.runningDays} auth=${ctx.runningDaysAuthoritative}`);
                return {
                    success: false,
                    reason: 'RUNNING_DAYS_UNKNOWN',
                    message: `Train ${tNo} running-days not authoritative on ${date} — cannot confirm operation (DB placeholder, IRCTC unavailable)`,
                };
            }
            // verdict === 'NO' — authoritative data says train does not operate
            logger_1.winstonLogger.info(`[STATION_RESOLVER] TRAIN_NOT_RUNNING train=${tNo} boarding=${fromIn} date=${date} verdict=${verdict}`);
            return {
                success: false,
                reason: 'TRAIN_NOT_RUNNING',
                message: `Train ${tNo} does not operate on ${date}`,
            };
        }
    }
    if (ctx.stops.length === 0) {
        // PHASE_5B099 — SCHEDULE-EMPTY SECONDARY GATE
        // When neither DB nor IRCTC could supply the train schedule, a secondary
        // registry check prevents hub-alias codes (e.g. ADI) from being accepted
        // as physical boarding stations for trains whose true origin is a different
        // station in the same alias cluster (e.g. SBIB for 19031, GNC for 19411).
        const { areStationsCompatible } = require('./stationAliases');
        // PHASE_5B129 — this gate REJECTS a boarding station, so it requires an
        // authoritative origin. Its documented purpose is the explicitly verified trains
        // named above (SBIB for 19031, GNC for 19411), which are `verified` and therefore
        // unaffected. An `inferred` train-name guess must never reject a candidate — with
        // no schedule available to check it against, that produced INVALID_BOARDING_STATION
        // for journeys that were in fact valid.
        const originResult = (0, stationResolutionUtils_1.getPhysicalOriginWithConfidence)(tNo);
        const knownOrigin = (0, stationResolutionUtils_1.isAuthoritativeOrigin)(originResult) ? originResult.code : null;
        if (knownOrigin) {
            // If fromIn is compatible with the known origin cluster but is NOT the
            // physical origin itself, reject — e.g. ADI is compatible with SBIB
            // but SBIB is the boarding station, not ADI.
            const fromIsAlias = knownOrigin !== fromIn && areStationsCompatible(fromIn, knownOrigin);
            if (fromIsAlias) {
                logger_1.winstonLogger.info(`[STATION_RESOLVER] SCHEDULE_EMPTY_HUB_ALIAS_REJECTED train=${tNo} from=${fromIn} knownOrigin=${knownOrigin} — hub alias cannot substitute for physical stop`);
                return {
                    success: false,
                    reason: 'INVALID_BOARDING_STATION',
                    message: `Station ${fromIn} is an alias of ${knownOrigin} but is not a confirmed physical stop on train ${tNo} (no schedule available to verify)`,
                };
            }
        }
        logger_1.winstonLogger.warn(`[STATION_RESOLVER] No schedule for ${tNo} — conservative API codes only`);
        return {
            success: true,
            scheduleFrom: fromIn,
            scheduleTo: toIn,
            apiFrom: (0, stationResolutionUtils_1.toIrctcApiCodeConservative)(fromIn),
            apiTo: (0, stationResolutionUtils_1.toIrctcApiCodeConservative)(toIn),
            // PHASE_5B109 — no schedule backed this decision. Callers must not treat
            // it as verified against anything.
            source: 'none',
        };
    }
    // PHASE_5B057: Require exact physical stop on train schedule for availability checks
    // PHASE_084K: When the schedule came from DB and live was unavailable, a missing stop
    // may reflect incomplete DB coverage rather than a confirmed physical absence.
    // In that case emit DB_UNVERIFIED_STOP_DATA (still fail-closed) so upstream diagnostics
    // can distinguish "stop confirmed absent" from "stop absent in DB, live not checked".
    const scheduleIsDbOnly = ctx.source === 'db' && !ctx.runningDaysAuthoritative;
    const fromStop = ctx.stops.find(s => (s.Station_Code || '').toUpperCase().trim() === fromIn);
    if (!fromStop) {
        if (scheduleIsDbOnly) {
            logger_1.winstonLogger.info(`[STATION_RESOLVER] DB_UNVERIFIED_STOP_DATA train=${tNo} from=${fromIn}` +
                ` — stop absent in DB schedule, live schedule was not available`);
            return {
                success: false,
                reason: 'DB_UNVERIFIED_STOP_DATA',
                message: `Station ${fromIn} not found in DB schedule for train ${tNo} (live schedule unavailable — cannot confirm physical absence)`,
            };
        }
        logger_1.winstonLogger.info(`[STATION_RESOLVER] INVALID_BOARDING train=${tNo} from=${fromIn}`);
        return {
            success: false,
            reason: 'INVALID_BOARDING_STATION',
            message: `Station ${fromIn} is not a physical stop on train ${tNo}`,
        };
    }
    const toStop = ctx.stops.find(s => (s.Station_Code || '').toUpperCase().trim() === toIn);
    if (!toStop) {
        if (scheduleIsDbOnly) {
            logger_1.winstonLogger.info(`[STATION_RESOLVER] DB_UNVERIFIED_STOP_DATA train=${tNo} to=${toIn}` +
                ` — stop absent in DB schedule, live schedule was not available`);
            return {
                success: false,
                reason: 'DB_UNVERIFIED_STOP_DATA',
                message: `Station ${toIn} not found in DB schedule for train ${tNo} (live schedule unavailable — cannot confirm physical absence)`,
            };
        }
        logger_1.winstonLogger.info(`[STATION_RESOLVER] INVALID_DESTINATION train=${tNo} to=${toIn}`);
        return {
            success: false,
            reason: 'INVALID_DESTINATION_STATION',
            message: `Station ${toIn} is not a physical stop on train ${tNo}`,
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
    const dayOffset = fromStop ? getDayOffsetForStop(ctx.stops, fromStop) : 0;
    let originDepartureDate = date;
    if (date && dayOffset > 0) {
        const d = new Date(date);
        d.setDate(d.getDate() - dayOffset);
        originDepartureDate = d.toISOString().split('T')[0];
    }
    return {
        success: true,
        scheduleFrom,
        scheduleTo,
        apiFrom,
        apiTo,
        originDepartureDate,
        dayOffset,
        runningDays: ctx.runningDays,
        source: ctx.source
    };
}
