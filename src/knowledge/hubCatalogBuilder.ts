/**
 * PHASE_4C871 — Hub catalog builder (mirrors segmentAvailabilityEngine._buildHubsFromStops).
 * Isolated copy — does not modify rescue engine logic.
 */
import { areStationsCompatible } from '../services/stationAliases';
import { stationService } from '../services/stationService';
import { isMajorHub } from './majorHubs';

export interface ScheduleStopRow {
  Station_Code: string;
  SN: number;
  Station_Name?: string;
  Arrival_time?: string;
  Departure_Time?: string;
}

function haversineKm(lat1: number, lon1: number, lat2: number, lon2: number): number {
  const R = 6371;
  const dLat = ((lat2 - lat1) * Math.PI) / 180;
  const dLon = ((lon2 - lon1) * Math.PI) / 180;
  const a =
    Math.sin(dLat / 2) * Math.sin(dLat / 2) +
    Math.cos((lat1 * Math.PI) / 180) * Math.cos((lat2 * Math.PI) / 180) *
    Math.sin(dLon / 2) * Math.sin(dLon / 2);
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

export interface BuiltHubCandidate {
  hub_station: string;
  hub_sn: number;
  src_sn: number;
  dest_sn: number;
  rank_score: number;
  buffer_minutes: number | null;
  is_major_hub: boolean;
}

/**
 * Build top-2 midpoint hubs from schedule stops (same algorithm as rescue engine).
 */
export async function buildHubCandidatesFromStops(
  stops: ScheduleStopRow[],
  srcCode: string,
  destCode: string
): Promise<BuiltHubCandidate[]> {
  const srcStop = stops.find(
    (s) => s.Station_Code === srcCode || areStationsCompatible(s.Station_Code, srcCode)
  );
  const destStop = stops.find(
    (s) => s.Station_Code === destCode || areStationsCompatible(s.Station_Code, destCode)
  );
  if (!srcStop || !destStop) return [];

  const srcSn = srcStop.SN;
  const destSn = destStop.SN;

  const intermediateStops = stops.filter((s) => {
    const isBetween = srcSn < destSn
      ? s.SN > srcSn && s.SN < destSn
      : s.SN < srcSn && s.SN > destSn;
    return isBetween && isMajorHub(s.Station_Code);
  });

  if (intermediateStops.length === 0) return [];

  const srcCoords = await stationService.getCoordinates(srcStop.Station_Code);
  const destCoords = await stationService.getCoordinates(destStop.Station_Code);
  if (!srcCoords || !destCoords) return [];

  const midLat = (srcCoords.lat + destCoords.lat) / 2;
  const midLon = (srcCoords.lon + destCoords.lon) / 2;

  const scored: { stop: ScheduleStopRow; dist: number }[] = [];
  for (const stop of intermediateStops) {
    const stopCoords = await stationService.getCoordinates(stop.Station_Code);
    if (stopCoords) {
      const dist = haversineKm(stopCoords.lat, stopCoords.lon, midLat, midLon);
      scored.push({ stop, dist });
    }
  }

  scored.sort((a, b) => a.dist - b.dist);

  return scored.slice(0, 2).map((x, idx) => ({
    hub_station: x.stop.Station_Code.toUpperCase().trim(),
    hub_sn: x.stop.SN,
    src_sn: srcSn,
    dest_sn: destSn,
    rank_score: Math.max(0, 100 - x.dist - idx * 0.1),
    buffer_minutes: null,
    is_major_hub: true,
  }));
}