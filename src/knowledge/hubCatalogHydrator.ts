/**
 * PHASE_4C877 — Hydrate rescue_hub_catalog rows into runtime hub shape.
 * Used by B1 dual-read only; does not alter production hub selection.
 */
import { areStationsCompatible } from '../services/stationAliases';
import {
  CatalogHydrationResult,
  HubCatalogEntry,
  HydratedHubEntry,
  ScheduleStopFull,
} from './types';

const MAX_HUBS = 2;

function findStopByCode(stops: ScheduleStopFull[], code: string): ScheduleStopFull | undefined {
  return stops.find(
    (s) => s.Station_Code === code || areStationsCompatible(s.Station_Code, code)
  );
}

function findStopBySn(stops: ScheduleStopFull[], sn: number): ScheduleStopFull | undefined {
  return stops.find((s) => s.SN === sn);
}

function isHubBetween(
  hubSn: number,
  srcSn: number,
  destSn: number
): boolean {
  return srcSn < destSn
    ? hubSn > srcSn && hubSn < destSn
    : hubSn < srcSn && hubSn > destSn;
}

/**
 * Join catalog SN fields to schedule stops; emit the same object shape as _buildHubsFromStops.
 */
export function hydrateCatalogEntries(
  catalog: HubCatalogEntry[],
  stops: ScheduleStopFull[],
  srcCode: string,
  destCode: string
): CatalogHydrationResult {
  if (!catalog.length) {
    return { success: false, hubs: [], failureReason: 'empty_catalog' };
  }
  if (!stops || stops.length <= 2) {
    return { success: false, hubs: [], failureReason: 'insufficient_schedule' };
  }

  const srcStop = findStopByCode(stops, srcCode);
  const destStop = findStopByCode(stops, destCode);
  if (!srcStop || !destStop) {
    return { success: false, hubs: [], failureReason: 'src_dest_not_on_schedule' };
  }

  const sortedCatalog = [...catalog]
    .sort((a, b) => b.rank_score - a.rank_score)
    .slice(0, MAX_HUBS);

  const hydrated: HydratedHubEntry[] = [];

  for (const entry of sortedCatalog) {
    if (entry.src_sn !== srcStop.SN || entry.dest_sn !== destStop.SN) {
      continue;
    }

    const hubStop = findStopBySn(stops, entry.hub_sn);
    if (!hubStop) {
      continue;
    }

    const hubCode = hubStop.Station_Code.toUpperCase().trim();
    if (hubCode !== entry.hub_station.toUpperCase().trim()) {
      continue;
    }

    if (!isHubBetween(hubStop.SN, srcStop.SN, destStop.SN)) {
      continue;
    }

    hydrated.push({
      hub: hubStop.Station_Code,
      stop: hubStop,
      srcStop,
      destStop,
      stops,
    });
  }

  if (hydrated.length === 0) {
    return { success: false, hubs: [], failureReason: 'no_valid_catalog_rows' };
  }

  return { success: true, hubs: hydrated };
}

export function extractHubCodes(hubs: { hub?: string }[]): string[] {
  return hubs
    .map((h) => (h.hub || '').toUpperCase().trim())
    .filter(Boolean);
}

export function computeHubDiff(
  runtimeCodes: string[],
  catalogCodes: string[]
): { runtime_only: string[]; catalog_only: string[] } {
  const runtimeSet = new Set(runtimeCodes);
  const catalogSet = new Set(catalogCodes);
  return {
    runtime_only: runtimeCodes.filter((h) => !catalogSet.has(h)),
    catalog_only: catalogCodes.filter((h) => !runtimeSet.has(h)),
  };
}