/**
 * PHASE_5B091 — Central Deterministic Schedule Integrity Validator
 * Enforces Pan-India validation rules for train schedules and split legs.
 * Pure deterministic logic — NO AI / Gemini calls.
 */
import { stationService } from './stationService';
import { getPhysicalOriginWithConfidence, isAuthoritativeOrigin } from './stationResolutionUtils';
import { areStationsCompatible } from './stationAliases';

export type IntegrityResultReason =
  | 'INVALID_TRAIN_NO'
  | 'EMPTY_SCHEDULE'
  | 'INVALID_STATION_CODE'
  | 'NON_INCREASING_SN'
  | 'DUPLICATE_SN'
  | 'DUPLICATE_STATION'
  | 'ORIGIN_MISMATCH'
  | 'SEGMENT_STATION_MISSING'
  | 'REVERSE_STATION_ORDER'
  | 'MALFORMED_SCHEDULE';

export interface IntegrityResult {
  status: 'VALID' | 'INVALID' | 'UNCERTAIN';
  reasons: IntegrityResultReason[];
  message: string;
}

export class TrainScheduleIntegrityService {
  /**
   * Validate a full schedule stop array (e.g. before DB ingestion or authoritative use)
   */
  public validateScheduleRows(trainNo: string, stops: any[]): IntegrityResult {
    const reasons: IntegrityResultReason[] = [];
    const cleanNum = String(trainNo || '').trim().replace(/^0+/, '');

    if (!cleanNum || cleanNum.length < 4 || !/^\d+$/.test(cleanNum)) {
      reasons.push('INVALID_TRAIN_NO');
    }

    if (!Array.isArray(stops) || stops.length < 2) {
      reasons.push('EMPTY_SCHEDULE');
      return {
        status: 'INVALID',
        reasons,
        message: `Schedule for train ${trainNo} is empty or has fewer than 2 stops`,
      };
    }

    const seenSN = new Set<number>();
    const seenStations = new Set<string>();
    let prevSN = -1;

    for (let i = 0; i < stops.length; i++) {
      const stop = stops[i];
      const stnCode = String(stop.Station_Code || stop.stationCode || stop.stnCode || stop.code || '')
        .toUpperCase()
        .trim();
      const sn = Number(stop.SN ?? stop.sn ?? stop.serialNo ?? (i + 1));

      if (!stnCode || stnCode.length < 2) {
        reasons.push('INVALID_STATION_CODE');
      }

      if (isNaN(sn) || sn <= prevSN) {
        if (!reasons.includes('NON_INCREASING_SN')) reasons.push('NON_INCREASING_SN');
      }

      if (seenSN.has(sn)) {
        if (!reasons.includes('DUPLICATE_SN')) reasons.push('DUPLICATE_SN');
      }
      seenSN.add(sn);

      if (seenStations.has(stnCode)) {
        if (!reasons.includes('DUPLICATE_STATION')) reasons.push('DUPLICATE_STATION');
      }
      seenStations.add(stnCode);

      prevSN = sn;
    }

    // Origin physical compatibility check against known registry origins
    // PHASE_5B129 — ORIGIN_MISMATCH marks the whole schedule INVALID, so it requires an
    // authoritative origin. An `inferred` origin is the first word of the train NAME, and
    // many Indian train names lead with a city that is not the boarding terminal; letting
    // that raise ORIGIN_MISMATCH failed valid schedules. Explicitly verified trains are
    // unaffected.
    const originResult = getPhysicalOriginWithConfidence(cleanNum);
    const trueOrigin = isAuthoritativeOrigin(originResult) ? originResult.code : null;
    if (trueOrigin && stops.length > 0) {
      const dbOrigin = String(stops[0].Station_Code || stops[0].stationCode || stops[0].stnCode || '')
        .toUpperCase()
        .trim();
      if (dbOrigin !== trueOrigin && !areStationsCompatible(dbOrigin, trueOrigin)) {
        reasons.push('ORIGIN_MISMATCH');
      }
    }

    if (reasons.length > 0) {
      return {
        status: 'INVALID',
        reasons,
        message: `Train ${trainNo} schedule failed validation: ${reasons.join(', ')}`,
      };
    }

    return {
      status: 'VALID',
      reasons: [],
      message: `Train ${trainNo} schedule is valid (${stops.length} stops)`,
    };
  }

  /**
   * Validate if a specific leg (fromCode -> toCode) physically exists on a train schedule
   */
  public validateSegmentOnSchedule(
    trainNo: string,
    stops: any[],
    fromCode: string,
    toCode: string
  ): IntegrityResult {
    const scheduleValidation = this.validateScheduleRows(trainNo, stops);
    if (scheduleValidation.status === 'INVALID') {
      return scheduleValidation;
    }

    const cleanFrom = String(fromCode || '').toUpperCase().trim();
    const cleanTo = String(toCode || '').toUpperCase().trim();

    if (!cleanFrom || !cleanTo) {
      return {
        status: 'INVALID',
        reasons: ['MALFORMED_SCHEDULE'],
        message: `Missing fromCode or toCode for segment validation on train ${trainNo}`,
      };
    }

    let fromStop: any = null;
    let toStop: any = null;

    for (let i = 0; i < stops.length; i++) {
      const stn = String(stops[i].Station_Code || stops[i].stationCode || stops[i].stnCode || '')
        .toUpperCase()
        .trim();
      if (stn === cleanFrom) {
        fromStop = { ...stops[i], index: i, SN: Number(stops[i].SN ?? i + 1) };
      }
      if (stn === cleanTo) {
        toStop = { ...stops[i], index: i, SN: Number(stops[i].SN ?? i + 1) };
      }
    }

    if (!fromStop || !toStop) {
      const missingReasons: IntegrityResultReason[] = ['SEGMENT_STATION_MISSING'];
      return {
        status: 'INVALID',
        reasons: missingReasons,
        message: `Train ${trainNo} route does not physically contain both ${cleanFrom} and ${cleanTo}`,
      };
    }

    if (fromStop.SN >= toStop.SN || fromStop.index >= toStop.index) {
      return {
        status: 'INVALID',
        reasons: ['REVERSE_STATION_ORDER'],
        message: `On train ${trainNo}, ${cleanFrom} (SN=${fromStop.SN}) appears after or at ${cleanTo} (SN=${toStop.SN})`,
      };
    }

    return {
      status: 'VALID',
      reasons: [],
      message: `Segment ${cleanFrom}->${cleanTo} on train ${trainNo} is physically valid`,
    };
  }
}

export const trainScheduleIntegrityService = new TrainScheduleIntegrityService();
