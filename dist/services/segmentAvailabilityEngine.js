"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.segmentAvailabilityEngine = exports.SegmentAvailabilityEngine = exports.isMajorHub = exports.normalizeForAPI = exports.areStationsCompatible = exports.TERMINAL_ALIASES = void 0;
const supabase_1 = require("../config/supabase");
const logger_1 = require("../middleware/logger");
const availabilityProvider_1 = require("./availabilityProvider");
const cacheService_1 = require("./cacheService");
const stationService_1 = require("./stationService");
const rankingService_1 = require("./rankingService");
const irctcService_1 = require("./irctcService");
const providerConfigService_1 = require("./providerConfigService");
const knowledgeMetricsService_1 = require("./knowledgeMetricsService");
// PHASE_5B085: import registry check to detect corrupted DB origins in same-train rescue
const stationResolutionUtils_1 = require("./stationResolutionUtils");
const availabilityCacheKeys_1 = require("../utils/availabilityCacheKeys");
// PHASE_4C862 — shared aliases; train-aware IRCTC mapping in trainStationResolver.ts
var stationAliases_1 = require("./stationAliases");
Object.defineProperty(exports, "TERMINAL_ALIASES", { enumerable: true, get: function () { return stationAliases_1.TERMINAL_ALIASES; } });
Object.defineProperty(exports, "areStationsCompatible", { enumerable: true, get: function () { return stationAliases_1.areStationsCompatible; } });
Object.defineProperty(exports, "normalizeForAPI", { enumerable: true, get: function () { return stationAliases_1.normalizeForAPILegacy; } });
const stationAliases_2 = require("./stationAliases");
const majorHubs_1 = require("../knowledge/majorHubs");
Object.defineProperty(exports, "isMajorHub", { enumerable: true, get: function () { return majorHubs_1.isMajorHub; } });
function incrementDate(dateStr, days) {
    let parsedDate = dateStr;
    if (/^\d{8}$/.test(parsedDate)) {
        parsedDate = `${parsedDate.slice(0, 4)}-${parsedDate.slice(4, 6)}-${parsedDate.slice(6, 8)}`;
    }
    else if (parsedDate.match(/^\d{2}-\d{2}-\d{4}$/)) {
        const [dd, mm, yyyy] = parsedDate.split('-');
        parsedDate = `${yyyy}-${mm}-${dd}`;
    }
    const date = new Date(parsedDate + 'T00:00:00.000Z');
    date.setUTCDate(date.getUTCDate() + days);
    return date.toISOString().split('T')[0];
}
function parseToMins(time) {
    if (!time || time === '--:--')
        return 0;
    const [h, m] = time.split(':').map(Number);
    return (h || 0) * 60 + (m || 0);
}
function getDaysDifference(stops, fromCode, toCode) {
    let currentDay = 1;
    let prevMins = 0;
    const dayNumberMap = new Map();
    for (let i = 0; i < stops.length; i++) {
        const station = stops[i];
        const arrMins = parseToMins(station.Arrival_time);
        const depMins = parseToMins(station.Departure_Time);
        if (i > 0) {
            if (station.Arrival_time && station.Arrival_time !== '--:--') {
                if (arrMins < prevMins) {
                    currentDay++;
                }
            }
            else if (station.Departure_Time && station.Departure_Time !== '--:--') {
                if (depMins < prevMins) {
                    currentDay++;
                }
            }
        }
        dayNumberMap.set(station.Station_Code, currentDay);
        if (depMins < arrMins) {
            currentDay++;
        }
        prevMins = depMins;
    }
    const fromDay = dayNumberMap.get(fromCode) || 1;
    const toDay = dayNumberMap.get(toCode) || 1;
    return Math.max(0, toDay - fromDay);
}
/**
 * Normalize the raw availability payload to extract the availability array.
 * The IRCTC SDK returns { data: { availability: [...] } }.
 * availabilityProvider wraps it: { success: true, data: <SDK response> }.
 * So res.data = { data: { availability: [...] } } (two levels of nesting).
 * We support all known shapes defensively.
 */
function extractAvailabilityArray(rawAvail) {
    if (!rawAvail)
        return null;
    // Shape A (IRCTC SDK via availabilityProvider): rawAvail.data.availability
    if (Array.isArray(rawAvail?.data?.availability) && rawAvail.data.availability.length > 0) {
        return rawAvail.data.availability;
    }
    // Shape B (flat, direct): rawAvail.availability
    if (Array.isArray(rawAvail?.availability) && rawAvail.availability.length > 0) {
        return rawAvail.availability;
    }
    return null;
}
function getPredictionInsight(statusText) {
    const s = statusText.toUpperCase();
    if (s.includes('AVAILABLE') || s.includes('AVL') || s.includes('CNF') || s.includes('CONFIRMED'))
        return '';
    if (s.includes('RAC'))
        return 'AI Prediction: ~95% chance of confirmation (RAC almost always gets a berth)';
    if (s.includes('GNWL') || (!s.includes('RLWL') && !s.includes('PQWL') && s.includes('WL'))) {
        const match = s.match(/\d+/);
        const pos = match ? parseInt(match[0], 10) : 0;
        if (pos <= 10)
            return 'AI Prediction: ~88% chance (Highly Likely)';
        if (pos <= 20)
            return 'AI Prediction: ~78% chance (Likely)';
        if (pos <= 35)
            return 'AI Prediction: ~62% chance (Moderate)';
        if (pos <= 60)
            return 'AI Prediction: ~42% chance (Low)';
        return 'AI Prediction: ~22% chance (Unlikely)';
    }
    if (s.includes('RLWL')) {
        const match = s.match(/\d+/);
        const pos = match ? parseInt(match[0], 10) : 0;
        if (pos <= 8)
            return 'AI Prediction: ~65% chance (Moderate)';
        if (pos <= 18)
            return 'AI Prediction: ~45% chance (Low)';
        if (pos <= 30)
            return 'AI Prediction: ~28% chance (Unlikely)';
        return 'AI Prediction: ~15% chance (Very Unlikely)';
    }
    return '';
}
/**
 * PHASE_4C728 — Strict confirmation check.
 * Business rule: only AVAILABLE / AVL / CNF / CONFIRMED count as confirmed.
 * WL of any depth is NOT confirmed — canBook=true on WL is IRCTC booking
 * permission, not a seat confirmation indicator.
 * RAC returns false here; it is handled separately by the calling context.
 */
function isConfirmedAvailability(rawAvail) {
    if (!rawAvail)
        return false;
    // Resolve availability text from all known SDK/provider shapes
    let text = '';
    const availArr = extractAvailabilityArray(rawAvail);
    if (availArr && availArr.length > 0) {
        text = availArr[0]?.availabilityText || '';
    }
    else if (rawAvail?.data?.availabilityText) {
        text = rawAvail.data.availabilityText;
    }
    else if (rawAvail.availabilityText) {
        text = rawAvail.availabilityText;
    }
    else if (rawAvail.status) {
        text = rawAvail.status;
    }
    else if (rawAvail.current_status) {
        text = rawAvail.current_status;
    }
    const status = text.toUpperCase().trim();
    // Block: empty / missing status — unknown availability is not confirmed
    if (!status)
        return false;
    // Block: non-standard waitlist variants (Tatkal, Pooled Quota, Roadside, etc.)
    if (status.includes('PQWL') ||
        status.includes('TQWL') ||
        status.includes('CKWL') ||
        status.includes('RSWL'))
        return false;
    // Block: regret / unavailable states
    if (status.includes('REGRET') ||
        status.includes('NOT AVAILABLE') ||
        status.includes('CLASS NOT AVAILABLE') ||
        status.includes('NO SEATS') ||
        status.includes('FULLY SOLD') ||
        status.includes('TRAIN DEPARTED') ||
        status === 'UNAVAILABLE')
        return false;
    // Allow: AVL / AVAILABLE / CNF / CONFIRMED / RAC / standard WL
    if (status.includes('AVAILABLE') ||
        status.includes('AVL') ||
        status.includes('CNF') ||
        status.includes('CONFIRMED') ||
        status.includes('RAC') ||
        status.includes('GNWL') ||
        status.includes('RLWL') ||
        status.includes('WAITLIST') ||
        status.includes('WL'))
        return true;
    // Default: unknown positive states — fail closed
    return false;
}
/**
 * PHASE_4C807 — RAC detection for Partial RAC Rescue feature.
 *
 * Returns true ONLY when the availability status is RAC.
 * WL is explicitly blocked — WL must NEVER qualify as a partial rescue leg.
 * Only invoked by the PARTIAL_RAC_RESCUE secondary evaluation path;
 * the primary confirmed-rescue path uses isConfirmedAvailability().
 */
function isRACAvailability(rawAvail) {
    if (!rawAvail)
        return false;
    let text = '';
    const availArr = extractAvailabilityArray(rawAvail);
    if (availArr && availArr.length > 0) {
        text = availArr[0]?.availabilityText || '';
    }
    else if (rawAvail?.data?.availabilityText) {
        text = rawAvail.data.availabilityText;
    }
    else if (rawAvail.availabilityText) {
        text = rawAvail.availabilityText;
    }
    else if (rawAvail.status) {
        text = rawAvail.status;
    }
    else if (rawAvail.current_status) {
        text = rawAvail.current_status;
    }
    const status = text.toUpperCase().trim();
    if (!status)
        return false;
    // WL in ANY form must NEVER qualify — guard first
    if (status.includes('WL') ||
        status.includes('GNWL') ||
        status.includes('RLWL') ||
        status.includes('PQWL') ||
        status.includes('TQWL') ||
        status.includes('CKWL') ||
        status.includes('RSWL') ||
        status.includes('WAITLIST'))
        return false;
    // Only RAC qualifies
    return status.includes('RAC');
}
function classifyRescueHubTier(legAAvailRaw, legBAvailRaw) {
    const leg1CNF = isConfirmedAvailability(legAAvailRaw);
    const leg2CNF = isConfirmedAvailability(legBAvailRaw);
    if (leg1CNF && leg2CNF)
        return 'CONFIRMED';
    const leg1RAC = isRACAvailability(legAAvailRaw);
    const leg2RAC = isRACAvailability(legBAvailRaw);
    // RAC+CNF or CNF+RAC — WL combinations are blocked by isRACAvailability / isConfirmedAvailability
    if ((leg1RAC && leg2CNF) || (leg1CNF && leg2RAC))
        return 'PARTIAL_RAC';
    return null;
}
function getAvailabilityText(rawAvail) {
    if (!rawAvail)
        return 'CHECK_IRCTC';
    let text = '';
    const availArr = extractAvailabilityArray(rawAvail);
    if (availArr && availArr.length > 0) {
        text = availArr[0]?.availabilityText || '';
    }
    else if (rawAvail?.data?.availabilityText) {
        text = rawAvail.data.availabilityText;
    }
    else if (rawAvail.availabilityText) {
        text = rawAvail.availabilityText;
    }
    else if (rawAvail.status) {
        text = rawAvail.status;
    }
    else if (rawAvail.current_status) {
        text = rawAvail.current_status;
    }
    else if (rawAvail.error) {
        text = rawAvail.error; // Propagate exact IRCTC error (e.g., 'Class Not Available')
    }
    return text ? text.trim() : 'CHECK_IRCTC';
}
// PHASE 5B136: upper bound on the LOCAL_E2E_NO_WRITE schedule side channel, so a
// long local run cannot grow it without limit. Local-test-mode only; never
// allocated when LOCAL_E2E_NO_WRITE is off.
const NO_WRITE_SCHEDULE_HANDOFF_MAX = 200;
class SegmentAvailabilityEngine {
    constructor() {
        this.inFlightInjections = new Map();
        // PHASE 5B136: validated IRCTC schedule rows handed from
        // _injectScheduleFromIRCTC to getMidpointHubs when LOCAL_E2E_NO_WRITE=true,
        // replacing the train_schedule upsert + DB re-read round trip. Populated
        // ONLY in no-write mode; stays permanently empty in production.
        this.noWriteInjectedSchedules = new Map();
    }
    async findSegmentSplits(source, destination, date, directTrains, classType = '3A', quota = 'GN') {
        // Feature Flag Guard
        if (process.env.ENABLE_SAME_TRAIN_SEGMENTS !== 'true') {
            logger_1.winstonLogger.info('[SEGMENT_ENGINE] Same Train Segment Availability is disabled via ENABLE_SAME_TRAIN_SEGMENTS flag');
            return [];
        }
        if (!(0, supabase_1.isSupabaseConfigured)()) {
            logger_1.winstonLogger.warn('[SEGMENT_ENGINE] Supabase is not configured. Bypassing Same Train segments.');
            return [];
        }
        const sCode = source.toUpperCase().trim();
        const dCode = destination.toUpperCase().trim();
        if (!sCode || !dCode || sCode === dCode)
            return [];
        logger_1.winstonLogger.info(`[SEGMENT_ENGINE] Starting same-train segment check for ${sCode} → ${dCode} on ${date}`);
        knowledgeMetricsService_1.knowledgeMetricsService.recordFindSegmentSplitsInvocation();
        await Promise.all([
            providerConfigService_1.providerConfigService.isProviderEnabled('IRCTC'),
            providerConfigService_1.providerConfigService.isProviderEnabled('RAILRADAR'),
        ]);
        // Evaluate all direct trains that are candidates for segment splitting
        const candidates = directTrains;
        const segmentSplits = [];
        const apiBudget = { count: 0 };
        for (const train of candidates) {
            const trainNo = train.trainNo || train.number;
            if (!trainNo)
                continue;
            logger_1.winstonLogger.info(`[SEGMENT_ENGINE] Evaluating candidate train: ${trainNo}`);
            // 1. Get midpoint hubs for the train
            const hubsWithStops = await this.getMidpointHubs(trainNo, sCode, dCode);
            if (hubsWithStops.length === 0) {
                logger_1.winstonLogger.info(`[SEGMENT_ENGINE] No intermediate major hubs found on route of train ${trainNo}`);
                continue;
            }
            for (const item of hubsWithStops) {
                const { hub, stop: hubStop, srcStop, destStop, stops } = item;
                // Calculate dates and day difference using database schedule stops
                const daysDiff = getDaysDifference(stops, srcStop.Station_Code, hubStop.Station_Code);
                const legBDate = incrementDate(date, daysDiff);
                // P0.1 (PHASE_4C811): Fetch both legs in parallel — cuts hub evaluation latency by ~50%.
                // Decision logic below is unchanged; only fetch order is parallelised.
                const [legAAvailRaw, legBAvailRaw] = await Promise.all([
                    this.getSegmentLegAvailability(trainNo, srcStop.Station_Code, hub, date, classType, quota, apiBudget),
                    this.getSegmentLegAvailability(trainNo, hub, destStop.Station_Code, legBDate, classType, quota, apiBudget),
                ]);
                // Verify if both are confirmed
                const leg1CNF = isConfirmedAvailability(legAAvailRaw);
                const leg2CNF = isConfirmedAvailability(legBAvailRaw);
                if (leg1CNF && leg2CNF) {
                    logger_1.winstonLogger.info(`[SEGMENT_ENGINE] 🎉 Confirmed same-train segment split found on train ${trainNo} via ${hub}`);
                    const text1 = getAvailabilityText(legAAvailRaw);
                    const text2 = getAvailabilityText(legBAvailRaw);
                    // Build map day numbers
                    const dayNumberMap = new Map();
                    let currentDay = 1;
                    let prevMins = 0;
                    for (let i = 0; i < stops.length; i++) {
                        const st = stops[i];
                        const arrM = parseToMins(st.Arrival_time);
                        const depM = parseToMins(st.Departure_Time);
                        if (i > 0) {
                            if (arrM < prevMins) {
                                currentDay++;
                            }
                        }
                        dayNumberMap.set(st.Station_Code, currentDay);
                        if (depM < arrM) {
                            currentDay++;
                        }
                        prevMins = depM;
                    }
                    const leg1Mins = rankingService_1.rankingService.calculateCorrectDuration(srcStop.Departure_Time, hubStop.Arrival_time, dayNumberMap.get(srcStop.Station_Code) || 1, dayNumberMap.get(hubStop.Station_Code) || 1);
                    const leg2Mins = rankingService_1.rankingService.calculateCorrectDuration(hubStop.Departure_Time, destStop.Arrival_time, dayNumberMap.get(hubStop.Station_Code) || 1, dayNumberMap.get(destStop.Station_Code) || 1);
                    const leg1AvailArr = extractAvailabilityArray(legAAvailRaw);
                    const leg2AvailArr = extractAvailabilityArray(legBAvailRaw);
                    const leg1HubCode = hubStop.Station_Code;
                    const leg1 = {
                        trainNo,
                        name: train.name || `Train ${trainNo}`,
                        trainName: train.name || `Train ${trainNo}`,
                        departure: srcStop.Departure_Time,
                        arrival: hubStop.Arrival_time,
                        dayNumber: dayNumberMap.get(hubStop.Station_Code) || 1,
                        durationMins: leg1Mins,
                        api_used: 'LIVE',
                        availability: {
                            status: text1,
                            wlCount: 0,
                            coach: leg1AvailArr?.[0]?.coach || legAAvailRaw?.data?.coach || legAAvailRaw?.coach
                        },
                        // PHASE_4C862 — leg station codes for UI availability re-check
                        fromCode: srcStop.Station_Code,
                        toCode: leg1HubCode,
                        from: srcStop.Station_Code,
                        to: leg1HubCode,
                        source: srcStop.Station_Code,
                        destination: leg1HubCode,
                        fromName: srcStop.Station_Name,
                        toName: hubStop.Station_Name,
                        travelDate: date,
                    };
                    const leg2 = {
                        trainNo,
                        name: train.name || `Train ${trainNo}`,
                        trainName: train.name || `Train ${trainNo}`,
                        departure: hubStop.Departure_Time,
                        arrival: destStop.Arrival_time,
                        dayNumber: dayNumberMap.get(destStop.Station_Code) || 1,
                        durationMins: leg2Mins,
                        api_used: 'LIVE',
                        availability: {
                            status: text2,
                            wlCount: 0,
                            coach: leg2AvailArr?.[0]?.coach || legBAvailRaw?.data?.coach || legBAvailRaw?.coach
                        },
                        fromCode: leg1HubCode,
                        toCode: destStop.Station_Code,
                        from: leg1HubCode,
                        to: destStop.Station_Code,
                        source: leg1HubCode,
                        destination: destStop.Station_Code,
                        fromName: hubStop.Station_Name,
                        toName: destStop.Station_Name,
                        travelDate: legBDate,
                    };
                    // FIX_3 (PHASE_4C728): dynamic badge from actual availability text
                    const availBadge = (() => {
                        const s1 = text1.toUpperCase();
                        const s2 = text2.toUpperCase();
                        if ((s1.includes('AVAILABLE') || s1.includes('AVL') || s1.includes('CNF')) &&
                            (s2.includes('AVAILABLE') || s2.includes('AVL') || s2.includes('CNF')))
                            return 'CONFIRMED';
                        if (s1.includes('RAC') || s2.includes('RAC'))
                            return 'RAC';
                        return 'CHECK_IRCTC';
                    })();
                    const split = {
                        hub,
                        leg1,
                        leg2,
                        bufferMinutes: 0, // stay on train
                        totalDuration: train.duration_mins || (leg1Mins + leg2Mins),
                        score: 0,
                        badges: ['SAME TRAIN SEAT CHANGE', availBadge],
                        travelDate: date,
                        leg1Date: date,
                        leg2Date: legBDate,
                        rollover: false,
                        legs: [leg1, leg2],
                        isSameTrain: true,
                        rescueType: 'SAME_TRAIN_SEGMENT',
                    };
                    const insight1 = getPredictionInsight(text1);
                    const insight2 = getPredictionInsight(text2);
                    if (insight1 || insight2) {
                        split.ai_insight = [insight1, insight2].filter(Boolean).join(' | ');
                    }
                    // Compute ranking score
                    split.score = rankingService_1.rankingService.calculateScore(split);
                    segmentSplits.push(split);
                }
            }
        }
        return segmentSplits;
    }
    async getMidpointHubs(trainNo, srcCode, destCode) {
        // P1.2 (PHASE_4C812): Cache hub results with 24h TTL.
        // The set of midpoint hubs for a (train, src, dest) triplet is derived from the static
        // train schedule — it does not change between searches. Caching eliminates the Supabase
        // train_schedule query and _buildHubsFromStops coordinate work on every repeated rescue scan.
        const hubCacheKey = `hubs_${trainNo}_${srcCode}_${destCode}`;
        const cachedHubs = cacheService_1.cacheService.get(hubCacheKey);
        if (cachedHubs) {
            logger_1.winstonLogger.info(`[RESCUE_ENGINE] Hub cache hit for train ${trainNo} ${srcCode}→${destCode}`);
            this._runB1DualReadCompare(trainNo, srcCode, destCode, cachedHubs, null);
            return cachedHubs;
        }
        try {
            const { data: dbStops, error } = await supabase_1.supabase
                .from('train_schedule')
                .select('Station_Code, SN, Station_Name, Arrival_time, Departure_Time')
                .eq('Train_No', trainNo)
                .order('SN', { ascending: true });
            if (error || !dbStops || dbStops.length <= 2) {
                // ── FIX_2: Dynamic Schedule Injection ────────────────────────────────
                // DB has no schedule for this train, or only has the 2-stop stub
                // (origin + destination only, no intermediate stops).
                // Attempt to fetch the full schedule from IRCTC API, upsert into
                // train_schedule, then retry the hub lookup once.
                // Single attempt — no loops, no recursion.
                logger_1.winstonLogger.info(`[SEGMENT_ENGINE] No DB schedule for train ${trainNo}. Attempting dynamic injection.`);
                const injectStart = Date.now();
                // Schedule Injection Request Coalescing
                let injectPromise = this.inFlightInjections.get(trainNo);
                if (!injectPromise) {
                    injectPromise = this._injectScheduleFromIRCTC(trainNo).finally(() => {
                        this.inFlightInjections.delete(trainNo);
                    });
                    this.inFlightInjections.set(trainNo, injectPromise);
                }
                else {
                    logger_1.winstonLogger.info(`[SEGMENT_ENGINE] Coalesced dynamic injection request for train ${trainNo}`);
                }
                const injected = await injectPromise;
                const injectMs = Date.now() - injectStart;
                logger_1.winstonLogger.info(`[RESCUE_TIMING] INJECT_MS=${injectMs} injected=${injected}`);
                if (!injected) {
                    this._runB1DualReadCompare(trainNo, srcCode, destCode, [], null);
                    return [];
                }
                // PHASE 5B136: in no-write mode nothing was persisted, so the DB re-read
                // below would find no rows. Consume the validated in-memory rows handed
                // over by _injectScheduleFromIRCTC instead. Entries are deliberately NOT
                // removed on read so coalesced concurrent callers all observe them.
                if ((0, supabase_1.isNoWriteMode)()) {
                    const memoryStops = this.noWriteInjectedSchedules.get(trainNo);
                    if (memoryStops && memoryStops.length > 0) {
                        logger_1.winstonLogger.warn(`[NO_WRITE] Train ${trainNo}: skipped train_schedule DB re-read; building hubs from ${memoryStops.length} in-memory validated rows.`);
                        const memoryHubs = await this._buildHubsFromStops(memoryStops, srcCode, destCode);
                        if (memoryHubs.length > 0) {
                            cacheService_1.cacheService.set(hubCacheKey, memoryHubs, 86400); // 24h — key and TTL unchanged
                        }
                        this._runB1DualReadCompare(trainNo, srcCode, destCode, memoryHubs, memoryStops);
                        return memoryHubs;
                    }
                    logger_1.winstonLogger.warn(`[NO_WRITE] Train ${trainNo}: no in-memory schedule available; falling through to DB re-read (expected to return no rows).`);
                }
                // Single retry after injection
                const { data: stopsRetry, error: retryErr } = await supabase_1.supabase
                    .from('train_schedule')
                    .select('Station_Code, SN, Station_Name, Arrival_time, Departure_Time')
                    .eq('Train_No', trainNo)
                    .order('SN', { ascending: true });
                if (retryErr || !stopsRetry || stopsRetry.length === 0) {
                    this._runB1DualReadCompare(trainNo, srcCode, destCode, [], null);
                    return [];
                }
                // Re-assign stops reference to the freshly-injected schedule
                const hubs = await this._buildHubsFromStops(stopsRetry, srcCode, destCode);
                if (hubs.length > 0) {
                    cacheService_1.cacheService.set(hubCacheKey, hubs, 86400); // 24h
                }
                this._runB1DualReadCompare(trainNo, srcCode, destCode, hubs, stopsRetry);
                return hubs;
            }
            // PHASE_5B085: Before building hubs, verify the DB stops are authoritative.
            // If the train's known physical origin (from EXPLICIT_TRAIN_ENDPOINTS registry) differs
            // from the DB SN:1 station AND they are cluster-compatible (i.e. the DB origin is a
            // synthetic/alias station for the real origin), the DB schedule may contain corrupted
            // intermediate stops (e.g. 19407 DB: ADI→AII which does not exist on the live route
            // SBIB→LGH). In this case, fetch the authoritative live schedule and use it instead.
            // If the live fetch fails (circuit breaker, API unavailable), return [] to prevent the
            // same-train rescue from building ghost cards from corrupted DB data.
            const num = (0, availabilityCacheKeys_1.normalizeTrainNumber)(trainNo);
            // PHASE_5B129 — compile-only change (wrapper retired). Behaviour is INTENTIONALLY
            // identical, including for `inferred` origins: this path never rewrites a
            // Station_Code — it either replaces the whole stop list with the live route or
            // returns [] and skips the rescue. Both outcomes are non-destructive, so the
            // inferred tier is safe here and is deliberately NOT gated on authority.
            const trueOrigin = (0, stationResolutionUtils_1.getPhysicalOriginWithConfidence)(num).code;
            const dbOriginCode = (dbStops[0].Station_Code || '').toUpperCase().trim();
            const dbOriginSuspect = !!(trueOrigin && dbOriginCode !== trueOrigin && (0, stationAliases_2.areStationsCompatible)(dbOriginCode, trueOrigin));
            let stops = dbStops;
            if (dbOriginSuspect) {
                logger_1.winstonLogger.info(`[SEGMENT_ENGINE] dbOriginSuspect=true for train ${num} (DB:${dbOriginCode} vs registry:${trueOrigin}) — fetching live schedule for same-train rescue hub construction`);
                try {
                    const liveInfo = await irctcService_1.irctcService.getTrainInfo(num);
                    if (liveInfo) {
                        const liveRoute = liveInfo.route || liveInfo.station_list || liveInfo.stops || liveInfo.stations || liveInfo.trainRoute || liveInfo.stationList || [];
                        const liveStops = liveRoute.map((s, idx) => ({
                            Station_Code: (s.stationCode || s.stnCode || s.station_code || s.Station_Code || s.code || '').toUpperCase().trim(),
                            SN: s.sn || s.SN || s.sequence || (idx + 1),
                            Station_Name: s.stationName || s.stnName || s.station_name || s.Station_Name || s.name || '',
                            Arrival_time: s.arrivalTime || s.arrival_time || s.Arrival_time || '--:--',
                            Departure_Time: s.departureTime || s.departure_time || s.Departure_Time || '--:--'
                        })).filter((s) => s.Station_Code.length > 0);
                        if (liveStops.length > 0) {
                            stops = liveStops;
                            logger_1.winstonLogger.info(`[SEGMENT_ENGINE] Using authoritative live schedule for train ${num}: ${liveStops.length} stops (replaces suspect DB)`);
                        }
                        else {
                            // Live returned no stops — reject to prevent ghost card from corrupted DB
                            logger_1.winstonLogger.warn(`[SEGMENT_ENGINE] Live schedule empty for suspect train ${num} — skipping same-train rescue to prevent ghost card`);
                            this._runB1DualReadCompare(trainNo, srcCode, destCode, [], null);
                            return [];
                        }
                    }
                    else {
                        // Live unavailable — reject rather than trust corrupted DB
                        logger_1.winstonLogger.warn(`[SEGMENT_ENGINE] Live schedule unavailable for suspect train ${num} — skipping same-train rescue to prevent ghost card`);
                        this._runB1DualReadCompare(trainNo, srcCode, destCode, [], null);
                        return [];
                    }
                }
                catch (liveErr) {
                    logger_1.winstonLogger.warn(`[SEGMENT_ENGINE] Live fetch failed for suspect train ${num}: ${liveErr.message} — skipping to prevent ghost card`);
                    this._runB1DualReadCompare(trainNo, srcCode, destCode, [], null);
                    return [];
                }
            }
            // Delegate hub-building to shared helper (also used by injection retry path)
            const hubs = await this._buildHubsFromStops(stops, srcCode, destCode);
            if (hubs.length > 0) {
                cacheService_1.cacheService.set(hubCacheKey, hubs, 86400); // 24h
            }
            this._runB1DualReadCompare(trainNo, srcCode, destCode, hubs, stops);
            return hubs;
        }
        catch (e) {
            logger_1.winstonLogger.warn(`[SEGMENT_ENGINE] Midpoint resolution failed for train ${trainNo}: ${e.message}`);
            this._runB1DualReadCompare(trainNo, srcCode, destCode, [], null);
            return [];
        }
    }
    /**
     * PHASE_4C877 — B1 dual-read: catalog hydrate + runtime compare (telemetry only, non-blocking).
     * Runtime hubs returned to callers are unchanged; gated by KNOWLEDGE_CONSUME_SHADOW only.
     * When flag OFF: zero overhead (immediate return, no service load).
     */
    _runB1DualReadCompare(trainNo, srcCode, destCode, runtimeHubs, scheduleStops) {
        try {
            const { featureFlags } = require('../config/featureFlags');
            if (!featureFlags.knowledgeConsumeShadow)
                return;
            const { knowledgeService } = require('./knowledgeService');
            knowledgeService
                .runB1DualReadCompare(trainNo, srcCode, destCode, runtimeHubs, scheduleStops)
                .catch(() => { });
        }
        catch {
            // B1 telemetry optional — never throw
        }
    }
    /**
     * Extracts the top-2 midpoint hubs from a pre-fetched stops array.
     * Used by getMidpointHubs() for both the normal DB path and the injection retry path.
     */
    async _buildHubsFromStops(stops, srcCode, destCode) {
        const srcStop = stops.find(s => s.Station_Code === srcCode || (0, stationAliases_2.areStationsCompatible)(s.Station_Code, srcCode));
        const destStop = stops.find(s => s.Station_Code === destCode || (0, stationAliases_2.areStationsCompatible)(s.Station_Code, destCode));
        if (!srcStop || !destStop)
            return [];
        const srcSn = Number(srcStop.SN);
        const destSn = Number(destStop.SN);
        // M3: forward-only — require srcSN < hubSN < destSN (no reverse geometry)
        if (srcSn >= destSn)
            return [];
        const intermediateStops = stops.filter(s => {
            const sn = Number(s.SN);
            return sn > srcSn && sn < destSn && (0, majorHubs_1.isMajorHub)(s.Station_Code);
        });
        if (intermediateStops.length === 0)
            return [];
        const coordResults = await Promise.all([
            stationService_1.stationService.getCoordinates(srcStop.Station_Code),
            stationService_1.stationService.getCoordinates(destStop.Station_Code),
            ...intermediateStops.map((stop) => stationService_1.stationService.getCoordinates(stop.Station_Code)),
        ]);
        const srcCoords = coordResults[0];
        const destCoords = coordResults[1];
        if (!srcCoords || !destCoords)
            return [];
        const midLat = (srcCoords.lat + destCoords.lat) / 2;
        const midLon = (srcCoords.lon + destCoords.lon) / 2;
        const calculateHaversine = (lat1, lon1, lat2, lon2) => {
            const R = 6371;
            const dLat = ((lat2 - lat1) * Math.PI) / 180;
            const dLon = ((lon2 - lon1) * Math.PI) / 180;
            const a = Math.sin(dLat / 2) * Math.sin(dLat / 2) +
                Math.cos((lat1 * Math.PI) / 180) * Math.cos((lat2 * Math.PI) / 180) *
                    Math.sin(dLon / 2) * Math.sin(dLon / 2);
            return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
        };
        const sortedStops = [];
        for (let i = 0; i < intermediateStops.length; i++) {
            const stopCoords = coordResults[i + 2];
            if (stopCoords) {
                const dist = calculateHaversine(stopCoords.lat, stopCoords.lon, midLat, midLon);
                sortedStops.push({ stop: intermediateStops[i], dist });
            }
        }
        sortedStops.sort((a, b) => a.dist - b.dist);
        return sortedStops.slice(0, 2).map(x => ({
            hub: x.stop.Station_Code,
            stop: x.stop,
            srcStop,
            destStop,
            stops
        }));
    }
    /**
     * FIX_2 helper: Fetches train schedule from irctcService.getTrainInfo() and upserts
     * it into train_schedule so getMidpointHubs() can retry.
     *
     * Returns true if at least one row was successfully upserted, false otherwise.
     * Single-attempt only — no loops, no recursion.
     */
    async _injectScheduleFromIRCTC(trainNo) {
        try {
            logger_1.winstonLogger.info(`[SCHEDULE_INJECT] Fetching schedule for train ${trainNo} from IRCTC API.`);
            const trainInfo = await irctcService_1.irctcService.getTrainInfo(trainNo);
            // irctc-connect v3 shape (after irctcService unwraps data?.data):
            //   { route: [...], trainInfo: {...} }  — primary
            // Older SDK shapes used "stations" or nested "data.route".
            // P0 FIX (PHASE_4C794): route checked before stations to match SDK v3 output.
            const stations = trainInfo?.route
                || trainInfo?.stations
                || trainInfo?.data?.route
                || trainInfo?.data?.stations
                || [];
            if (!stations || stations.length === 0) {
                logger_1.winstonLogger.warn(`[SCHEDULE_INJECT] No stations returned by IRCTC for train ${trainNo}.`);
                return false;
            }
            logger_1.winstonLogger.info(`[SCHEDULE_INJECT] ${stations.length} stations returned for train ${trainNo}. Upserting to DB.`);
            // Map IRCTC station shape → train_schedule row shape
            const rows = stations.map((s, idx) => ({
                Train_No: trainNo,
                Station_Code: (s.stnCode || s.stationCode || s.code || '').toUpperCase().trim(),
                Station_Name: s.stnName || s.stationName || s.name || '',
                SN: s.serialNo ?? s.sn ?? (idx + 1),
                Arrival_time: s.arrival || s.arrivalTime || '--:--',
                Departure_Time: s.departure || s.departureTime || '--:--',
            })).filter((r) => r.Station_Code.length > 0);
            if (rows.length === 0) {
                logger_1.winstonLogger.warn(`[SCHEDULE_INJECT] No valid station codes after mapping for train ${trainNo}.`);
                return false;
            }
            // PHASE_5B091 — Central Deterministic Integrity Gate
            const { trainScheduleIntegrityService } = require('./trainScheduleIntegrityService');
            const integrity = trainScheduleIntegrityService.validateScheduleRows(trainNo, rows);
            if (integrity.status === 'INVALID') {
                logger_1.winstonLogger.warn(`[SCHEDULE_INJECT_REJECTED] Train ${trainNo} failed integrity validation: ${integrity.message}`);
                return false;
            }
            // ── PHASE 5B136: LOCAL_E2E_NO_WRITE in-memory hand-off ──────────────
            // Blocking the upsert alone is not enough: this write is load-bearing for
            // a later read. _injectScheduleFromIRCTC would return false, getMidpointHubs
            // would return [] and same-train rescue would silently stop producing
            // splits — changing route selection rather than just suppressing writes.
            // So in no-write mode the already-validated rows are handed to
            // getMidpointHubs in memory: no UPSERT, no orphan DELETE, no DB re-read.
            // The IRCTC fetch and validateScheduleRows above are untouched.
            if ((0, supabase_1.isNoWriteMode)()) {
                const memoryRows = rows
                    .map((r) => ({
                    Station_Code: r.Station_Code,
                    SN: r.SN,
                    Station_Name: r.Station_Name,
                    Arrival_time: r.Arrival_time,
                    Departure_Time: r.Departure_Time,
                }))
                    .sort((a, b) => Number(a.SN) - Number(b.SN));
                if (this.noWriteInjectedSchedules.size >= NO_WRITE_SCHEDULE_HANDOFF_MAX) {
                    const oldestKey = this.noWriteInjectedSchedules.keys().next().value;
                    if (oldestKey !== undefined)
                        this.noWriteInjectedSchedules.delete(oldestKey);
                }
                this.noWriteInjectedSchedules.set(trainNo, memoryRows);
                logger_1.winstonLogger.warn(`[NO_WRITE] Train ${trainNo}: skipped train_schedule UPSERT and orphan DELETE; handing ${memoryRows.length} validated rows to _buildHubsFromStops in memory.`);
                return true;
            }
            // Upsert in batches of 100 to stay within Supabase limits
            const BATCH = 100;
            let totalInserted = 0;
            for (let i = 0; i < rows.length; i += BATCH) {
                const batch = rows.slice(i, i + BATCH);
                const { error: upsertErr } = await supabase_1.supabase
                    .from('train_schedule')
                    .upsert(batch, { onConflict: 'Train_No,SN' });
                if (upsertErr) {
                    logger_1.winstonLogger.warn(`[SCHEDULE_INJECT] Upsert batch ${i / BATCH} failed: ${upsertErr.message}`);
                }
                else {
                    totalInserted += batch.length;
                }
            }
            // PHASE_5B091 — Delete orphan stale stops if route shortened
            try {
                const maxSN = Math.max(...rows.map((r) => r.SN));
                await supabase_1.supabase
                    .from('train_schedule')
                    .delete()
                    .eq('Train_No', trainNo)
                    .gt('SN', maxSN);
            }
            catch { /* non-fatal orphan delete failure */ }
            logger_1.winstonLogger.info(`[SCHEDULE_INJECT] Upserted ${totalInserted}/${rows.length} rows for train ${trainNo}.`);
            return totalInserted > 0;
        }
        catch (e) {
            logger_1.winstonLogger.error(`[SCHEDULE_INJECT] Failed for train ${trainNo}: ${e.message}`);
            return false;
        }
    }
    async getSegmentLegAvailability(trainNo, from, to, date, classType, quota, apiBudgetCounter) {
        // PHASE_4C862 — schedule stop codes; no blind DR→CSMT normalization
        const fromNorm = from.toUpperCase().trim();
        const toNorm = to.toUpperCase().trim();
        if (apiBudgetCounter.count >= 8) {
            logger_1.winstonLogger.warn(`[SEGMENT_ENGINE] API budget exhausted (>=8 calls). Skipping query.`);
            return null;
        }
        apiBudgetCounter.count++;
        try {
            logger_1.winstonLogger.info(`[SEGMENT_ENGINE] Fetching availability from provider: ${trainNo} ${fromNorm}→${toNorm} on ${date}`);
            const res = await availabilityProvider_1.availabilityProvider.getAvailability({
                trainNo,
                from: fromNorm,
                to: toNorm,
                date,
                classType,
                quota
            });
            if (res && res.success && res.data) {
                return res.data;
            }
        }
        catch (err) {
            logger_1.winstonLogger.error(`[SEGMENT_ENGINE] Availability fetch failed: ${err.message}`);
        }
        return null;
    }
    /**
     * User-triggered Same Train Rescue.
     *
     * Operates on a SINGLE specified train (user selected). Returns
     * segment split options via midpoint hubs, calling IRCTC/RailKit
     * availability for each leg pair. API budget: 8 calls max.
     *
     * This is the dedicated backend for POST /api/trains/same-train-rescue.
     * It does NOT modify findSegmentSplits or any existing auto-scan logic.
     */
    async sameTrainRescueForTrain(trainNo, source, destination, date, classType = '3A', quota = 'GN') {
        if (!(0, supabase_1.isSupabaseConfigured)()) {
            logger_1.winstonLogger.warn('[RESCUE_ENGINE] Supabase not configured — cannot perform rescue scan.');
            return [];
        }
        const sCode = source.toUpperCase().trim();
        const dCode = destination.toUpperCase().trim();
        const tNo = String(trainNo).trim();
        if (!sCode || !dCode || !tNo || sCode === dCode)
            return [];
        logger_1.winstonLogger.info(`[RESCUE_ENGINE] User-triggered rescue scan: train ${tNo} | ${sCode} → ${dCode} | ${date}`);
        // Build a synthetic train object matching the shape findSegmentSplits expects
        const syntheticTrain = { trainNo: tNo };
        const apiBudget = { count: 0 };
        const engineStart = Date.now();
        // P1.3 (PHASE_4C812): Pre-warm provider status cache before the hub loop.
        // P0.3 added a 10s TTL cache to isProviderEnabled(). Pre-calling both providers
        // here ensures all subsequent leg fetches (up to 4) use the cached value rather
        // than each triggering a Supabase api_providers query.
        // This is request-scoped: the 10s TTL expires after the rescue scan completes.
        await Promise.all([
            providerConfigService_1.providerConfigService.isProviderEnabled('IRCTC'),
            providerConfigService_1.providerConfigService.isProviderEnabled('RAILRADAR'),
        ]);
        // P1.4: HUB timing
        const hubStart = Date.now();
        const hubsWithStops = await this.getMidpointHubs(tNo, sCode, dCode);
        const hubMs = Date.now() - hubStart;
        logger_1.winstonLogger.info(`[RESCUE_TIMING] HUB_MS=${hubMs} hubs=${hubsWithStops.length}`);
        if (hubsWithStops.length === 0) {
            logger_1.winstonLogger.info(`[RESCUE_ENGINE] No intermediate major hubs found on train ${tNo}`);
            return [];
        }
        const segmentSplits = [];
        const hubPromises = hubsWithStops.map(async (item) => {
            const { hub, stop: hubStop, srcStop, destStop, stops } = item;
            if (apiBudget.count >= 8) {
                logger_1.winstonLogger.warn(`[RESCUE_ENGINE] API budget exhausted — skipping hub ${hub}`);
                return null;
            }
            const daysDiff = getDaysDifference(stops, srcStop.Station_Code, hubStop.Station_Code);
            const legBDate = incrementDate(date, daysDiff);
            // P0.1 (PHASE_4C811): Fetch both legs in parallel — cuts hub evaluation latency by ~50%.
            // Decision logic below is unchanged; only fetch order is parallelised.
            // P1.4 (PHASE_4C812): Capture individual leg timings for diagnostics.
            const legStart = Date.now();
            const [legAAvailRaw, legBAvailRaw] = await Promise.all([
                this.getSegmentLegAvailability(tNo, srcStop.Station_Code, hub, date, classType, quota, apiBudget),
                this.getSegmentLegAvailability(tNo, hub, destStop.Station_Code, legBDate, classType, quota, apiBudget),
            ]);
            const legMs = Date.now() - legStart;
            logger_1.winstonLogger.info(`[RESCUE_TIMING] hub=${hub} LEG_MS=${legMs} (parallel)`);
            const hubTier = classifyRescueHubTier(legAAvailRaw, legBAvailRaw);
            if (hubTier === 'CONFIRMED' || hubTier === 'PARTIAL_RAC') {
                const text1 = getAvailabilityText(legAAvailRaw);
                const text2 = getAvailabilityText(legBAvailRaw);
                // Build day number map for timing references
                const dayNumberMap = new Map();
                let currentDay = 1;
                let prevMins = 0;
                for (let i = 0; i < stops.length; i++) {
                    const st = stops[i];
                    const arrM = parseToMins(st.Arrival_time);
                    const depM = parseToMins(st.Departure_Time);
                    if (i > 0 && arrM < prevMins)
                        currentDay++;
                    dayNumberMap.set(st.Station_Code, currentDay);
                    if (depM < arrM)
                        currentDay++;
                    prevMins = depM;
                }
                const srcDay = dayNumberMap.get(srcStop.Station_Code) || 1;
                const hubDay = dayNumberMap.get(hubStop.Station_Code) || 1;
                const trainDisplayName = srcStop?.Train_Name || `Train ${tNo}`;
                const isConfirmed = hubTier === 'CONFIRMED';
                // P0-2 (PHASE_4C885): hoist legs as variables so they can be referenced
                // both as named properties (leg1/leg2) and in the legs[] array.
                // Previously legs:[] was hardcoded, hiding all timing/station data from the
                // frontend renderSplitJourney which iterates split.legs to render detail rows.
                const rescueLeg1 = {
                    trainNo: tNo,
                    name: trainDisplayName,
                    trainName: trainDisplayName,
                    departure: srcStop?.Departure_Time || '',
                    arrival: hubStop?.Arrival_time || '',
                    dayNumber: srcDay,
                    availability: { status: text1, wlCount: 0, coach: undefined },
                    fromCode: srcStop.Station_Code,
                    toCode: hub,
                    from: srcStop.Station_Code,
                    to: hub,
                    source: srcStop.Station_Code,
                    destination: hub,
                    fromName: srcStop.Station_Name,
                    toName: hubStop.Station_Name,
                    travelDate: date,
                };
                const rescueLeg2 = {
                    trainNo: tNo,
                    name: trainDisplayName,
                    trainName: trainDisplayName,
                    departure: hubStop?.Departure_Time || '',
                    arrival: destStop?.Arrival_time || '',
                    dayNumber: hubDay,
                    availability: { status: text2, wlCount: 0, coach: undefined },
                    fromCode: hub,
                    toCode: destStop.Station_Code,
                    from: hub,
                    to: destStop.Station_Code,
                    source: hub,
                    destination: destStop.Station_Code,
                    fromName: hubStop.Station_Name,
                    toName: destStop.Station_Name,
                    travelDate: legBDate,
                };
                const rescue = {
                    isSameTrain: true,
                    // SAME_TRAIN_SEGMENT keeps controller pass-through (no API change required).
                    // Partial RAC tier is distinguished by score, confidence, warning, and badges.
                    rescueType: 'SAME_TRAIN_SEGMENT',
                    ...(isConfirmed ? {} : {
                        confidence: 'MEDIUM',
                        warning: 'One segment is RAC. You can board the train, but berth allocation may differ.',
                    }),
                    hub,
                    score: isConfirmed ? 90 : 60,
                    travelDate: date,
                    bufferMinutes: parseToMins(hubStop?.Departure_Time || '') - parseToMins(hubStop?.Arrival_time || ''),
                    totalDuration: 0,
                    badges: isConfirmed ? ['SAME TRAIN', 'NO TRANSFER'] : ['Potential Rescue', 'RAC + CONFIRMED'],
                    rollover: false,
                    leg1: rescueLeg1,
                    leg2: rescueLeg2,
                    legs: [rescueLeg1, rescueLeg2],
                    steps: isConfirmed
                        ? [
                            `Book 2 tickets on this same train: first from ${sCode} to ${hub}, and second from ${hub} to ${dCode}.`,
                            `When the train reaches ${hub}, simply move to your new seat. You will stay in this seat until your final destination (${dCode}). No other seat changes are required!`
                        ]
                        : [
                            `Book 2 tickets on this same train: first from ${sCode} to ${hub} (RAC/WL), and second from ${hub} to ${dCode} (Confirmed).`,
                            `When the train reaches ${hub}, simply move to your new seat. You will stay in this seat until your final destination (${dCode}). No other seat changes are required!`
                        ],
                };
                if (isConfirmed) {
                    logger_1.winstonLogger.info(`[RESCUE_ENGINE] ✅ Confirmed rescue option found via ${hub}`);
                }
                else {
                    logger_1.winstonLogger.info(`[RESCUE_ENGINE] ⚠️ Partial RAC rescue option found via ${hub} (Model B3 policy)`);
                }
                return rescue;
            }
            else {
                const t1 = getAvailabilityText(legAAvailRaw);
                const t2 = getAvailabilityText(legBAvailRaw);
                logger_1.winstonLogger.info(`[RESCUE_ENGINE] Hub ${hub} rejected — leg1=${t1} leg2=${t2} (not CNF+CNF or RAC+CNF)`);
                return null;
            }
        });
        const hubResults = await Promise.all(hubPromises);
        for (const r of hubResults) {
            if (r)
                segmentSplits.push(r);
        }
        const totalEngineMs = Date.now() - engineStart;
        logger_1.winstonLogger.info(`[RESCUE_TIMING] TOTAL_ENGINE_MS=${totalEngineMs} rescues=${segmentSplits.length} apiCalls=${apiBudget.count}`);
        logger_1.winstonLogger.info(`[RESCUE_ENGINE] Scan complete: ${segmentSplits.length} rescue option(s) found for train ${tNo}`);
        return segmentSplits;
    }
}
exports.SegmentAvailabilityEngine = SegmentAvailabilityEngine;
exports.segmentAvailabilityEngine = new SegmentAvailabilityEngine();
