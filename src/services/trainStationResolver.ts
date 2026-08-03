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
  originDepartureDate?: string;
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
    Station_Code: (s.stationCode || s.stnCode || s.station_code || s.Station_Code || s.code || '').toUpperCase().trim(),
    SN: s.sn || s.SN || s.dayNum || idx + 1,
    Station_Name: s.stationName || s.stnName || s.station_name || s.Station_Name || '',

    Arrival_time: s.arrival || s.arrival_time || s.Arrival_time || '',
    Departure_Time: s.departure || s.departure_time || s.Departure_Time || '',
  })).filter((s: ScheduleStop) => s.Station_Code.length > 0);
}

async function loadTrainScheduleContext(trainNo: string, fromIn?: string, toIn?: string): Promise<TrainScheduleContext> {
  const tNo = padTrainNo(trainNo);
  const cacheKey = `sched_ctx_${tNo}`;
  const cached = cacheService.get<TrainScheduleContext>(cacheKey);

  let stops = cached?.stops || (await loadScheduleFromDb(tNo));
  let runningDays = cached?.runningDays || (await loadRunningDays(tNo));
  let source: TrainScheduleContext['source'] = stops.length > 0 ? 'db' : 'none';

  const hasFrom = fromIn ? !!findStopOnSchedule(stops, fromIn) : true;
  const hasTo   = toIn   ? !!findStopOnSchedule(stops, toIn)   : true;

  if (stops.length <= 2 || !hasFrom || !hasTo) {
    try {
      const info = await irctcService.getTrainInfo(tNo);
      if (info) {
        const irctcStops = mapIrctcInfoToStops(info);
        if (irctcStops.length > 0) {
          stops = irctcStops;
          source = 'irctc';
        }
        if (!runningDays) {
          runningDays = info.trainInfo?.running_days || info.running_days || info.trainInfo?.runningDays || null;
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

function getDayOffsetForStop(stops: ScheduleStop[], stop: ScheduleStopLike): number {
  if ((stop as any).Day || (stop as any).day) {
    return Math.max(0, ((stop as any).Day || (stop as any).day) - 1);
  }
  let currentDay = 1;
  let prevTimeMinutes = -1;
  for (const s of stops) {
    const timeStr = (s as any).Departure_Time && (s as any).Departure_Time !== '--' ? (s as any).Departure_Time : (s as any).Arrival_time;
    if (timeStr && timeStr !== '--') {
      const parts = timeStr.split(':');
      if (parts.length === 2) {
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

  const ctx = await loadTrainScheduleContext(tNo, fromIn, toIn);

  // Restored: Check if train actually runs on this specific boarding date
  if (ctx.runningDays && date) {
    const { normalizeRunningDays, isDayActiveForBoarding } = require('../utils/dayUtils');
    const binary = normalizeRunningDays(ctx.runningDays);
    const fromStop = findStopOnSchedule(ctx.stops, fromIn);
    
    if (fromStop && binary) {
      const dayOffset = getDayOffsetForStop(ctx.stops, fromStop);
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

  const dayOffset = fromStop ? getDayOffsetForStop(ctx.stops, fromStop) : 0;
  let originDepartureDate = date;
  if (date && dayOffset > 0) {
    const d = new Date(date);
    d.setDate(d.getDate() - dayOffset);
    originDepartureDate = d.toISOString().split('T')[0];
  }

  return { success: true, scheduleFrom, scheduleTo, apiFrom, apiTo, originDepartureDate };
}

