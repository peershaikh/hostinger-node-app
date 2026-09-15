import fs from 'fs';
import path from 'path';

/**
 * PHASE_4C862 — Shared station alias definitions for schedule matching and IRCTC API mapping.
 * Train-aware resolution lives in trainStationResolver.ts (does NOT blindly map DR→CSMT).
 */

export const PAN_INDIA_CLUSTERS: string[][] = [
  ['CSMT', 'CSTM', 'DR', 'DDR', 'BDTS', 'MMCT', 'BCT', 'LTT', 'BVI', 'PNVL', 'KYN', 'TNA'],
  ['NDLS', 'DLI', 'NZM', 'ANVT', 'DEC', 'GZB', 'DEE'],
  ['HWH', 'SDAH', 'KOAA', 'SHM', 'SRC'],
  ['MAS', 'MS', 'PER', 'TBM', 'MMC'],
  ['SBC', 'YPR', 'SMVB', 'BNC', 'KSR', 'KJM'],
  ['SC', 'HYB', 'KCG', 'LPI'],
  ['PUNE', 'CCH', 'LNL', 'SVJR', 'KK', 'HDP'],
  ['ADI', 'SBT', 'SBIB', 'GNC'],
  ['BSB', 'BSBS', 'DDU', 'MUV', 'MGS'],
  ['PRYJ', 'PRRB', 'NYN', 'ALD', 'PCOI', 'SFG', 'COI'],
  ['PNBE', 'PPTA', 'RJPB', 'DNR'],
  ['LKO', 'LJN', 'ASH', 'BNZ', 'GTNR'],
  ['JP', 'GADJ', 'DPA', 'GTJT'],
  ['ERS', 'ERN', 'AWY'],
  ['TVC', 'KCVL'],
  ['GHY', 'KYQ'],
  ['ST', 'UDN'],
  ['BPL', 'RKMP', 'HBJ'],
  ['VGLJ', 'JHS'],
  ['AY', 'AYC', 'FD'],
  ['NGP', 'AJNI'],
  ['JBP', 'MML'],
  ['JUC', 'JRC']
];

export const TERMINAL_ALIASES: Record<string, string[]> = {};

for (const cluster of PAN_INDIA_CLUSTERS) {
  for (const stn of cluster) {
    TERMINAL_ALIASES[stn] = cluster.filter(s => s !== stn);
  }
}

/** IRCTC canonical codes for alias clusters — applied only when train schedule contains the canonical stop. */
export const IRCTC_CANONICAL: Record<string, string> = {
  CSTM: 'CSMT',
  MMC:  'MAS',
  KSR:  'SBC',
  // PHASE_5B037 — ADI cluster: Sabarmati / Gandhinagar Canton → Ahmedabad
  GNC:  'ADI',
  SBT:  'ADI',
  // PHASE_5B037 — Bengaluru: Yeshwantpur → SBC (IRCTC canonical)
  YPR:  'SBC',
  // Renamed station aliases to modern operational codes
  ALD:  'PRYJ',
  COI:  'PCOI',
  MGS:  'DDU',
  MUV:  'BSBS',
  JHS:  'VGLJ',
  HBJ:  'RKMP',
  FD:   'AYC',
};

export function areStationsCompatible(code1: string, code2: string): boolean {
  const c1 = code1.toUpperCase().trim();
  const c2 = code2.toUpperCase().trim();
  if (c1 === c2) return true;
  return (TERMINAL_ALIASES[c1] || []).includes(c2);
}

/**
 * PHASE_087N145: Verify if a final candidate destination is compatible with
 * the requested destination city cluster. If the destination resolves to a known
 * pan-India cluster (e.g. Pune), the destination MUST belong to that cluster.
 */
export function isCompatibleWithRequestedDestinations(finalTo: string, dCodes: string[]): boolean {
  const normFinal = (finalTo || '').toUpperCase().trim();
  const normDCodes = (dCodes || []).map(c => (c || '').toUpperCase().trim()).filter(Boolean);
  if (!normFinal || normDCodes.length === 0) return false;

  // Find if any requested destination code belongs to a known cluster
  for (const cluster of PAN_INDIA_CLUSTERS) {
    const clusterMatches = cluster.filter(c => normDCodes.includes(c));
    if (clusterMatches.length > 0) {
      // The requested destination is in this pan-India cluster!
      // Therefore, final destination MUST belong to this cluster.
      return cluster.includes(normFinal);
    }
  }

  // If not in a PAN_INDIA_CLUSTER, fallback to dCodes membership
  return normDCodes.includes(normFinal);
}

/**
 * Legacy blind normalization — deprecated for availability; kept for non-train-scoped callers.
 * @deprecated Use trainStationResolver.toIrctcApiCode() with schedule context.
 */
export function normalizeForAPILegacy(code: string): string {
  if (!code) return '';
  const clean = code.toUpperCase().trim();
  if (clean === 'CSTM') return 'CSMT';
  if (clean === 'DR')   return 'CSMT';
  if (clean === 'DDR')  return 'CSMT';
  if (clean === 'MMC') return 'MAS';
  if (clean === 'KSR') return 'SBC';
  return clean;
}

let KNOWN_STATION_CODES_SET: Set<string> | null = null;

export function getKnownStationCodes(): Set<string> {
  if (KNOWN_STATION_CODES_SET) return KNOWN_STATION_CODES_SET;
  KNOWN_STATION_CODES_SET = new Set<string>();
  try {
    const stationsPath = path.join(__dirname, '../data/full_stations.json');
    if (fs.existsSync(stationsPath)) {
      const rawData = JSON.parse(fs.readFileSync(stationsPath, 'utf8'));
      if (rawData?.features && Array.isArray(rawData.features)) {
        for (const f of rawData.features) {
          if (f?.properties?.code) {
            KNOWN_STATION_CODES_SET.add(String(f.properties.code).toUpperCase().trim());
          }
        }
      }
    }
  } catch (e) {
    // Graceful fallback if full_stations.json cannot be read
  }

  // Ensure major operational stations and single-letter codes are present
  KNOWN_STATION_CODES_SET.add('R'); // Raipur
  KNOWN_STATION_CODES_SET.add('G'); // Gondia
  KNOWN_STATION_CODES_SET.add('J'); // Jalna
  KNOWN_STATION_CODES_SET.add('SV'); // Siwan
  KNOWN_STATION_CODES_SET.add('MRDW'); // Murdeshwar
  KNOWN_STATION_CODES_SET.add('SNSI'); // Sainagar Shirdi
  KNOWN_STATION_CODES_SET.add('AY'); // Ayodhya Dham
  KNOWN_STATION_CODES_SET.add('AYC'); // Ayodhya Cantt

  return KNOWN_STATION_CODES_SET;
}

/**
 * Strict check if a string is an authentic Indian Railways station code.
 * Rules:
 * 1. Must be 1 to 5 uppercase alphanumeric characters (e.g. 'R', 'G', 'NDLS', 'CSMT', 'SVDK').
 * 2. If the known station codes registry is loaded (~9,740 stations), it MUST exist in the registry.
 * 3. Never accepts full city/station names (e.g. 'SIWAN', 'MURUDESHWAR', 'SHIRDI', 'GONDIA').
 */
export function isValidStationCode(code: string): boolean {
  if (!code || typeof code !== 'string') return false;
  const clean = code.toUpperCase().trim();
  if (clean.length < 1 || clean.length > 5) return false;
  if (!/^[A-Z0-9]{1,5}$/.test(clean)) return false;

  const known = getKnownStationCodes();
  if (known && known.size > 0) {
    return known.has(clean);
  }
  return /^[A-Z]{1,4}$/.test(clean);
}