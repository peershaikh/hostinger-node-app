/**
 * PHASE_4C862 — Pure station resolution helpers (no I/O — safe for unit tests).
 */
import { areStationsCompatible, IRCTC_CANONICAL } from './stationAliases';

export interface ScheduleStopLike {
  Station_Code: string;
  SN: number;
}

export function stopCodesSet(stops: ScheduleStopLike[]): Set<string> {
  return new Set(stops.map(s => s.Station_Code.toUpperCase().trim()));
}

export function toIrctcApiCode(scheduleStopCode: string, stops: ScheduleStopLike[]): string {
  const code = scheduleStopCode.toUpperCase().trim();
  if (!code) return code;

  const codes = stopCodesSet(stops);

  if (codes.has('CSMT')) {
    if (code === 'CSTM' || code === 'DR' || code === 'DDR') return 'CSMT';
  }
  if (codes.has('MAS') && code === 'MMC') return 'MAS';
  if (codes.has('SBC') && code === 'KSR') return 'SBC';

  if (IRCTC_CANONICAL[code]) {
    const canonical = IRCTC_CANONICAL[code];
    if (codes.has(canonical)) return canonical;
  }

  return code;
}

export function toIrctcApiCodeConservative(code: string): string {
  const clean = code.toUpperCase().trim();
  if (IRCTC_CANONICAL[clean]) return IRCTC_CANONICAL[clean];
  return clean;
}

export function findStopOnSchedule(stops: ScheduleStopLike[], userCode: string): ScheduleStopLike | null {
  const c = userCode.toUpperCase().trim();
  if (!c) return null;
  // Prefer exact schedule code first. Alias match (e.g. CSMT↔DR) must not steal an
  // earlier intermediate stop when the true terminal exists later on the train.
  const exact = stops.find(s => s.Station_Code.toUpperCase().trim() === c);
  if (exact) return exact;
  return stops.find(s => areStationsCompatible(s.Station_Code, c)) || null;
}

export function mapProviderErrorToReason(errorMsg: string): string {
  const msg = (errorMsg || '').toLowerCase();
  if (msg.includes('intermediate station')) return 'SEGMENT_NOT_BOOKABLE';
  if (msg.includes('does not run') || msg.includes('not available for booking')) return 'TRAIN_NOT_RUNNING';
  if (msg.includes('class does not exist') || msg.includes('not available') || msg.includes('invalid train')) {
    return 'CLASS_NOT_AVAILABLE';
  }
  // Infra/auth/rate-limit errors must not become CLASS_NOT_AVAILABLE (hard "Route Unavailable" overlay).
  return 'PROVIDER_UNAVAILABLE';
}