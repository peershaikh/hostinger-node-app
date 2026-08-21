/**
 * PHASE_4C862 — Train-aware station resolution and pre-IRCTC segment validation.
 */
import { isSupabaseConfigured, supabase } from '../config/supabase';
import { winstonLogger } from '../middleware/logger';
import {
  isSpecialTrainNumber,
  trainOperatesOnDate,
} from '../utils/dayUtils';
import { cacheService } from './cacheService';
import { irctcService } from './irctcService';
import {
  decideOriginCorrection,
  decideScheduleContext,
  findStopOnSchedule,
  getPhysicalOriginWithConfidence,
  isAuthoritativeOrigin,
  isLiveScheduleRequired,
  mapProviderErrorToReason,
  normalizeStopSN,
  ScheduleStopLike,
  toIrctcApiCode,
  toIrctcApiCodeConservative,
} from './stationResolutionUtils';

export { mapProviderErrorToReason, toIrctcApiCode, toIrctcApiCodeConservative } from './stationResolutionUtils';

export type AvailabilityRejectReason =
  | 'INVALID_BOARDING_STATION'
  | 'INVALID_DESTINATION_STATION'
  | 'SEGMENT_NOT_BOOKABLE'
  | 'TRAIN_NOT_RUNNING'
  | 'TRAIN_CANCELLED'
  | 'CLASS_NOT_AVAILABLE'
  | 'PROVIDER_UNAVAILABLE';

export interface ResolvedSegment {
  success: true;
  scheduleFrom: string;
  scheduleTo: string;
  apiFrom: string;
  apiTo: string;
  originDepartureDate?: string;
  dayOffset?: number;
  runningDays?: string | null;
  /**
   * PHASE_5B109 — provenance of the schedule this resolution was decided from.
   *
   * 'irctc' — resolved against a live provider schedule fetched this request.
   * 'db'    — resolved against the `train_schedule` table (or its warm cache),
   *           which is a shared, multi-writer surface with no provenance column.
   * 'none'  — no schedule was available; the resolution was structural only.
   *
   * Callers must NOT treat 'db' as equivalent to 'irctc'. This mirrors the
   * existing internal `TrainScheduleContext.source` — it is not a new DB column
   * and nothing writes it back to `train_schedule`.
   */
  source: 'db' | 'irctc' | 'none';
}

export interface SegmentValidationFailure {
  success: false;
  reason: AvailabilityRejectReason;
  message: string;
}

export type SegmentResolution = ResolvedSegment | SegmentValidationFailure;

/**
 * PHASE_084H — Pre-fetched authoritative running-days entry produced by the
 * Split Engine's Phase 2.5 batch prefetch. Passed as an optional hint to
 * resolveSegmentForAvailability() so the function can reuse the already-fetched
 * live running-days data instead of calling getTrainInfo again.
 *
 * Only used within the Split Engine path. All other callers of
 * resolveSegmentForAvailability() pass no hints and behaviour is unchanged.
 */
export interface RunningDaysEntry {
  trainNo: string;
  runningDays: string | null;
  runningDaysAuthoritative: boolean;
  isCancelled: boolean | null;
  fetchedAt: number;
}

export interface ScheduleStop extends ScheduleStopLike {
  Station_Name?: string;
  Arrival_time?: string;
  Departure_Time?: string;
  Day?: number;
  day?: number;
}

interface TrainScheduleContext {
  stops: ScheduleStop[];
  runningDays: string | null;
  source: 'db' | 'irctc' | 'none';
  /** PHASE_5B161 — authoritative IRCTC service window, when the provider supplied it. */
  validFrom?: string | null;
  validTo?: string | null;
  /** PHASE_5B161 — whether `runningDays` came from a live provider (authoritative) vs stale DB. */
  runningDaysAuthoritative?: boolean;
  status?: string | null;
  is_cancelled?: boolean | null;
}

const SCHEDULE_CACHE_TTL = 7200;

export function padTrainNo(trainNo: string): string {
  const t = String(trainNo || '').trim();
  if (/^\d+$/.test(t)) return t.padStart(5, '0');
  return t;
}

async function loadTrainMeta(trainNo: string): Promise<{ running_days: string | null }> {
  const tNo = padTrainNo(trainNo);
  if (isSupabaseConfigured()) {
    try {
      const { data } = await supabase
        .from('trains')
        .select('running_days')
        .eq('number', tNo)
        .maybeSingle();
      if (data) {
        return {
          running_days: data.running_days || null,
        };
      }
    } catch { /* fall through */ }
  }
  return { running_days: null };
}

async function loadRunningDays(trainNo: string): Promise<string | null> {
  const meta = await loadTrainMeta(trainNo);
  return meta.running_days;
}

async function loadScheduleFromDb(trainNo: string): Promise<{ stops: ScheduleStop[]; originCorrected: boolean }> {
  if (!isSupabaseConfigured()) return { stops: [], originCorrected: false };
  const tNo = padTrainNo(trainNo);
  const { data, error } = await supabase
    .from('train_schedule')
    .select('Station_Code, SN, Station_Name, Arrival_time, Departure_Time')
    .eq('Train_No', tNo)
    .order('SN', { ascending: true });
  if (error || !data?.length) return { stops: [], originCorrected: false };

  const rows = data as ScheduleStop[];
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
  const decision = decideOriginCorrection(rows, tNo);
  if (decision.originCorrected && !decision.rewriteApplied) {
    winstonLogger.info(
      `[STATION_RESOLVER] DB origin mismatch for ${tNo} (db=${decision.dbOrigin} registry=${decision.registryOrigin} confidence=${decision.registryConfidence}) — rewrite SUPPRESSED (non-authoritative); DB stops left unchanged, live re-validation requested`
    );
  }

  return { stops: decision.stops, originCorrected: decision.originCorrected };
}

function mapIrctcInfoToStops(info: any): ScheduleStop[] {
  const route = info?.route || info?.station_list || info?.stops || [];
  if (!Array.isArray(route)) return [];
  return route.map((s: any, idx: number) => {
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
    const normalized = normalizeStopSN(s);

    // Positional fallback is retained ONLY so existing ordering comparisons in this
    // file (`Number(fromStop.SN) >= Number(toStop.SN)`) keep working when a provider
    // omits SN — behaviour unchanged from before this phase for that purpose.
    // `_snProvided` records that the value is synthetic so authority-bearing callers
    // (origin derivation) do not mistake array position for provider evidence.
    const snProvided = normalized.status === 'valid';
    return {
      Station_Code: (s.stationCode || s.stnCode || s.station_code || s.Station_Code || s.code || '').toUpperCase().trim(),
      SN: snProvided ? (normalized.value as number) : idx + 1,
      _snProvided: snProvided,
      Station_Name: s.stationName || s.stnName || s.station_name || s.Station_Name || '',
      Day: s.day !== undefined ? Number(s.day) : (s.Day !== undefined ? Number(s.Day) : undefined),
      day: s.day !== undefined ? Number(s.day) : (s.Day !== undefined ? Number(s.Day) : undefined),
      Arrival_time: s.arrival || s.arrival_time || s.Arrival_time || '',
      Departure_Time: s.departure || s.departure_time || s.Departure_Time || '',
    };
  }).filter((s: ScheduleStop) => s.Station_Code.length > 0);
}

async function loadTrainScheduleContext(
  trainNo: string,
  fromIn?: string,
  toIn?: string,
  runningDaysHint?: RunningDaysEntry
): Promise<TrainScheduleContext> {
  const tNo = padTrainNo(trainNo);
  // PHASE_5B129 — v2 → v3. Entries written before this phase may contain a DB origin
  // that an `inferred` (train-name parsed) code overwrote, and they carry a 7200s TTL.
  // Bumping the existing version token in the key makes every such entry unreachable
  // immediately rather than letting it be served for up to two more hours.
  // PHASE_5B161 — v3 → v4. v3 contexts carry no service-date window / runningDays
  // authority, so they must not authorise a date under the new fail-closed rule.
  const cacheKey = `sched_ctx_v4_${tNo}`;
  let cached = cacheService.get<TrainScheduleContext>(cacheKey);

  if (cached && cached.stops && cached.stops.length > 2) {
    const hasFrom = fromIn ? !!findStopOnSchedule(cached.stops, fromIn) : true;
    const hasTo   = toIn   ? !!findStopOnSchedule(cached.stops, toIn)   : true;
    if (hasFrom && hasTo) {
      return cached;
    }
    cacheService.del(cacheKey);
    cached = null;
  }

  const { stops: dbStops, originCorrected } = await loadScheduleFromDb(tNo);
  const meta = await loadTrainMeta(tNo);
  let runningDays = meta.running_days;
  let status: string | null = null;
  let is_cancelled: boolean | null = null;

  const hasFrom = fromIn ? !!findStopOnSchedule(dbStops, fromIn) : true;
  const hasTo   = toIn   ? !!findStopOnSchedule(dbStops, toIn)   : true;

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
    winstonLogger.info(`[STATION_RESOLVER] dbOriginSuspect=true for ${tNo} — DB origin was synthetically overwritten; fetching authoritative live route`);
  }

  // PHASE_5B161 — service-date truth cannot rely on a stale DB 'Daily'. A seasonal
  // special (09xxx) or a non-authoritative 'Daily' placeholder is evidence that the
  // `trains.running_days` column may simply be the ingest-time default, not a real
  // schedule. Fetch the authoritative IRCTC train-info once to recover a real
  // running_days pattern and/or a validFrom/validTo service window.
  const runningDaysLower = String(runningDays || '').toLowerCase().trim();
  const runningDaysIsDailyPlaceholder =
    runningDaysLower === 'daily' ||
    runningDaysLower === 'all days' ||
    runningDaysLower === '0,1,2,3,4,5,6' ||
    runningDaysLower === '1111111' ||
    runningDaysLower.includes('all');
  const needsServiceWindow =
    isSpecialTrainNumber(tNo) || runningDaysIsDailyPlaceholder || !runningDays;

  let liveStops: ScheduleStop[] | null = null;
  let validFrom: string | null = null;
  let validTo: string | null = null;
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
    if (runningDaysHint.isCancelled !== null) is_cancelled = runningDaysHint.isCancelled;
    runningDaysFromHint = true;
    winstonLogger.debug(
      `[STATION_RESOLVER] RD_HINT applied for ${tNo}: rd=${runningDays} auth=true isCancelled=${runningDaysHint.isCancelled}`
    );
  }

  const scheduleFetchNeeded = isLiveScheduleRequired({
    dbStopCount: dbStops.length,
    originCorrected: dbOriginSuspect,
    hasFrom,
    hasTo,
  });

  // Only call getTrainInfo when:
  // - physical stop validation needs a live schedule (scheduleFetchNeeded), OR
  // - service-date truth still needs resolving AND we have no pre-fetched hint
  const serviceWindowNeeded = needsServiceWindow && !runningDaysFromHint;

  if (scheduleFetchNeeded || serviceWindowNeeded) {
    try {
      const info = await irctcService.getTrainInfo(tNo);
      if (info) {
        const irctcStops = mapIrctcInfoToStops(info);
        if (irctcStops.length > 0) {
          liveStops = irctcStops;
        }
        const inner = info.trainInfo || info;
        const liveRunningDays =
          inner?.running_days || inner?.runningDays || info?.running_days || info?.runningDays || null;
        const liveValidFrom =
          inner?.validFrom || inner?.valid_from || info?.validFrom || info?.valid_from || null;
        const liveValidTo =
          inner?.validTo || inner?.valid_to || info?.validTo || info?.valid_to || null;
        const liveStatus =
          inner?.train_status || inner?.status || info?.train_status || info?.status || null;
        const liveCancelled =
          inner?.is_cancelled === true || inner?.isCancelled === true || info?.is_cancelled === true || info?.isCancelled === true ||
          (liveStatus && (liveStatus.toLowerCase().includes('cancel') || liveStatus.toLowerCase().includes('suspend')))
            ? true
            : (inner?.is_cancelled === false || inner?.isCancelled === false ? false : undefined);

        if (liveValidFrom) validFrom = liveValidFrom;
        if (liveValidTo) validTo = liveValidTo;
        // Only apply live running-days if we don't already have an authoritative hint
        if (liveRunningDays && !runningDaysFromHint) {
          runningDays = liveRunningDays;
          runningDaysAuthoritative = true;
        }
        if (liveStatus) status = liveStatus;
        // Only override isCancelled from live if hint didn't already set it
        if (liveCancelled !== undefined && !runningDaysFromHint) is_cancelled = liveCancelled;
      }
    } catch (e: any) {
      winstonLogger.warn(`[STATION_RESOLVER] IRCTC schedule/service-window fallback failed for ${tNo}: ${e.message}`);
    }
  }

  const decided = decideScheduleContext({
    dbStops,
    originCorrected: dbOriginSuspect,
    liveStops,
    hasFrom,
    hasTo,
  });
  if (dbOriginSuspect && !decided.liveApplied) {
    winstonLogger.warn(
      `[STATION_RESOLVER] dbOriginSuspect=true for ${tNo} but live route unavailable — keeping ORIGINAL DB stops (source=${decided.source}); no inferred origin substituted`
    );
  }

  const ctx: TrainScheduleContext = {
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
    cacheService.set(cacheKey, ctx, SCHEDULE_CACHE_TTL);
  }
  return ctx;
}

export function getDayOffsetForStop(stops: ScheduleStop[], stop: ScheduleStopLike): number {
  if ((stop as any).Day || (stop as any).day) {
    return Math.max(0, ((stop as any).Day || (stop as any).day) - 1);
  }
  let currentDay = 1;
  let prevTimeMinutes = -1;
  for (const s of stops) {
    const timeStr = (s as any).Departure_Time && (s as any).Departure_Time !== '--' ? (s as any).Departure_Time : (s as any).Arrival_time;
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
export async function resolveSegmentForAvailability(
  trainNo: string,
  from: string,
  to: string,
  date: string,
  hints?: {
    /** PHASE_084H — pre-fetched running-days from Split Engine Phase 2.5 */
    runningDaysCache?: Map<string, RunningDaysEntry>;
  }
): Promise<SegmentResolution> {
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
    winstonLogger.info(`[STATION_RESOLVER] TRAIN_CANCELLED train=${tNo} boarding=${fromIn} date=${date}`);
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
    const fromStop = findStopOnSchedule(ctx.stops, fromIn);
    const dayOffset = fromStop ? getDayOffsetForStop(ctx.stops, fromStop) : 0;
    const verdict = trainOperatesOnDate(date, ctx.runningDays, {
      validFrom: ctx.validFrom,
      validTo: ctx.validTo,
      runningDaysAuthoritative: ctx.runningDaysAuthoritative === true,
      dayOffset,
    });

    if (verdict !== 'YES') {
      const detail = verdict === 'NO' ? 'does not operate' : 'service-date truth unknown';
      winstonLogger.info(`[STATION_RESOLVER] TRAIN_NOT_RUNNING train=${tNo} boarding=${fromIn} date=${date} verdict=${verdict}`);
      return {
        success: false,
        reason: 'TRAIN_NOT_RUNNING',
        message: `Train ${tNo} ${detail} on ${date}`,
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
    const originResult = getPhysicalOriginWithConfidence(tNo);
    const knownOrigin = isAuthoritativeOrigin(originResult) ? originResult.code : null;
    if (knownOrigin) {
      // If fromIn is compatible with the known origin cluster but is NOT the
      // physical origin itself, reject — e.g. ADI is compatible with SBIB
      // but SBIB is the boarding station, not ADI.
      const fromIsAlias = knownOrigin !== fromIn && areStationsCompatible(fromIn, knownOrigin);
      if (fromIsAlias) {
        winstonLogger.info(
          `[STATION_RESOLVER] SCHEDULE_EMPTY_HUB_ALIAS_REJECTED train=${tNo} from=${fromIn} knownOrigin=${knownOrigin} — hub alias cannot substitute for physical stop`
        );
        return {
          success: false,
          reason: 'INVALID_BOARDING_STATION',
          message: `Station ${fromIn} is an alias of ${knownOrigin} but is not a confirmed physical stop on train ${tNo} (no schedule available to verify)`,
        };
      }
    }
    winstonLogger.warn(`[STATION_RESOLVER] No schedule for ${tNo} — conservative API codes only`);
    return {
      success: true,
      scheduleFrom: fromIn,
      scheduleTo: toIn,
      apiFrom: toIrctcApiCodeConservative(fromIn),
      apiTo: toIrctcApiCodeConservative(toIn),
      // PHASE_5B109 — no schedule backed this decision. Callers must not treat
      // it as verified against anything.
      source: 'none',
    };
  }

  // PHASE_5B057: Require exact physical stop on train schedule for availability checks
  const fromStop = ctx.stops.find(s => (s.Station_Code || '').toUpperCase().trim() === fromIn);
  if (!fromStop) {
    winstonLogger.info(`[STATION_RESOLVER] INVALID_BOARDING train=${tNo} from=${fromIn}`);
    return {
      success: false,
      reason: 'INVALID_BOARDING_STATION',
      message: `Station ${fromIn} is not a physical stop on train ${tNo}`,
    };
  }

  const toStop = ctx.stops.find(s => (s.Station_Code || '').toUpperCase().trim() === toIn);
  if (!toStop) {
    winstonLogger.info(`[STATION_RESOLVER] INVALID_DESTINATION train=${tNo} to=${toIn}`);
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
  const apiFrom = toIrctcApiCode(scheduleFrom, ctx.stops);
  const apiTo = toIrctcApiCode(scheduleTo, ctx.stops);

  winstonLogger.info(
    `[STATION_RESOLVER] train=${tNo} user=${fromIn}→${toIn} schedule=${scheduleFrom}→${scheduleTo} api=${apiFrom}→${apiTo}`
  );

  // PHASE_4C871 — async knowledge mapping persist (non-blocking, no API behaviour change)
  try {
    const { knowledgeService } = require('./knowledgeService');
    knowledgeService.scheduleMappingPersist(tNo, fromIn, toIn, {
      scheduleFrom,
      scheduleTo,
      apiFrom,
      apiTo,
    });
  } catch {
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

