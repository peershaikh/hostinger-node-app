/**
 * PHASE_4C862 — Train-aware station resolution and pre-IRCTC segment validation.
 */
import { isSupabaseConfigured, supabase } from '../config/supabase';
import { winstonLogger } from '../middleware/logger';
import { isDayActive, normalizeRunningDays } from '../utils/dayUtils';
import { cacheService } from './cacheService';
import { irctcService } from './irctcService';
import {
  findStopOnSchedule,
  mapProviderErrorToReason,
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
  | 'CLASS_NOT_AVAILABLE'
  | 'PROVIDER_UNAVAILABLE';

export interface ResolvedSegment {
  success: true;
  scheduleFrom: string;
  scheduleTo: string;
  apiFrom: string;
  apiTo: string;
}

export interface SegmentValidationFailure {
  success: false;
  reason: AvailabilityRejectReason;
  message: string;
}

export type SegmentResolution = ResolvedSegment | SegmentValidationFailure;

export interface ScheduleStop extends ScheduleStopLike {
  Station_Name?: string;
  Arrival_time?: string;
  Departure_Time?: string;
}

interface TrainScheduleContext {
  stops: ScheduleStop[];
  runningDays: string | null;
  source: 'db' | 'irctc' | 'none';
}

const SCHEDULE_CACHE_TTL = 7200;

export function padTrainNo(trainNo: string): string {
  const t = String(trainNo || '').trim();
  if (/^\d+$/.test(t)) return t.padStart(5, '0');
  return t;
}

async function loadRunningDays(trainNo: string): Promise<string | null> {
  const tNo = padTrainNo(trainNo);
  if (isSupabaseConfigured()) {
    try {
      const { data } = await supabase
        .from('trains')
        .select('running_days')
        .eq('number', tNo)
        .maybeSingle();
      if (data?.running_days) return data.running_days;
    } catch { /* fall through */ }
  }
  return null;
}

async function loadScheduleFromDb(trainNo: string): Promise<ScheduleStop[]> {
  if (!isSupabaseConfigured()) return [];
  const tNo = padTrainNo(trainNo);
  const { data, error } = await supabase
    .from('train_schedule')
    .select('Station_Code, SN, Station_Name, Arrival_time, Departure_Time')
    .eq('Train_No', tNo)
    .order('SN', { ascending: true });
  if (error || !data?.length) return [];
  return data as ScheduleStop[];
}

function mapIrctcInfoToStops(info: any): ScheduleStop[] {
  const route = info?.route || info?.station_list || info?.stops || [];
  if (!Array.isArray(route)) return [];
  return route.map((s: any, idx: number) => ({
    Station_Code: (s.stnCode || s.station_code || s.Station_Code || s.code || '').toUpperCase().trim(),
    SN: s.sn || s.SN || s.dayNum || idx + 1,
    Station_Name: s.stnName || s.station_name || s.Station_Name || '',
    Arrival_time: s.arrival || s.arrival_time || s.Arrival_time || '',
    Departure_Time: s.departure || s.departure_time || s.Departure_Time || '',
  })).filter((s: ScheduleStop) => s.Station_Code.length > 0);
}

async function loadTrainScheduleContext(trainNo: string): Promise<TrainScheduleContext> {
  const tNo = padTrainNo(trainNo);
  const cacheKey = `sched_ctx_${tNo}`;
  const cached = cacheService.get<TrainScheduleContext>(cacheKey);
  if (cached) return cached;

  let stops = await loadScheduleFromDb(tNo);
  let runningDays = await loadRunningDays(tNo);
  let source: TrainScheduleContext['source'] = stops.length > 0 ? 'db' : 'none';

  if (stops.length <= 2) {
    try {
      const info = await irctcService.getTrainInfo(tNo);
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
    } catch (e: any) {
      winstonLogger.warn(`[STATION_RESOLVER] IRCTC schedule fallback failed for ${tNo}: ${e.message}`);
    }
  }

  const ctx: TrainScheduleContext = { stops, runningDays, source };
  if (stops.length > 0) {
    cacheService.set(cacheKey, ctx, SCHEDULE_CACHE_TTL);
  }
  return ctx;
}

/**
 * Validate and resolve from/to for a train segment before calling IRCTC availability.
 */
export async function resolveSegmentForAvailability(
  trainNo: string,
  from: string,
  to: string,
  date: string
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

  const ctx = await loadTrainScheduleContext(tNo);

  // Restored: Check if train actually runs on this specific boarding date
  if (ctx.runningDays && date) {
    const { normalizeRunningDays, isDayActiveForBoarding } = require('../utils/dayUtils');
    const binary = normalizeRunningDays(ctx.runningDays);
    const fromStop = findStopOnSchedule(ctx.stops, fromIn);
    
    if (fromStop && binary) {
      const dayOffset = ((fromStop as any).Day || (fromStop as any).day || 1) - 1;
      if (!isDayActiveForBoarding(binary, date, dayOffset)) {
        winstonLogger.info(`[STATION_RESOLVER] TRAIN_NOT_RUNNING train=${tNo} boarding=${fromIn} date=${date}`);
        return {
          success: false,
          reason: 'TRAIN_NOT_RUNNING',
          message: `Train ${tNo} does not depart its origin on the required date to arrive at ${fromIn} on ${date}`,
        };
      }
    }
  }

  if (ctx.stops.length === 0) {
    winstonLogger.warn(`[STATION_RESOLVER] No schedule for ${tNo} — conservative API codes only`);
    return {
      success: true,
      scheduleFrom: fromIn,
      scheduleTo: toIn,
      apiFrom: toIrctcApiCodeConservative(fromIn),
      apiTo: toIrctcApiCodeConservative(toIn),
    };
  }

  const fromStop = findStopOnSchedule(ctx.stops, fromIn);
  if (!fromStop) {
    winstonLogger.info(`[STATION_RESOLVER] INVALID_BOARDING train=${tNo} from=${fromIn}`);
    return {
      success: false,
      reason: 'INVALID_BOARDING_STATION',
      message: `Station ${fromIn} is not a stop on train ${tNo}`,
    };
  }

  const toStop = findStopOnSchedule(ctx.stops, toIn);
  if (!toStop) {
    winstonLogger.info(`[STATION_RESOLVER] INVALID_DESTINATION train=${tNo} to=${toIn}`);
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

  return { success: true, scheduleFrom, scheduleTo, apiFrom, apiTo };
}

