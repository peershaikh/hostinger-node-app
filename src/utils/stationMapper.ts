import { winstonLogger } from '../middleware/logger';
import { cacheService } from '../services/cacheService';

/**
 * Common name aliases → one or more station codes
 * Covers historical names, misspellings, popular nicknames
 */
const ALIASES: Record<string, string | string[]> = {
  // Mumbai region
  'BOMBAY': ['CSMT', 'LTT', 'BDTS', 'DR', 'DDR', 'MMCT'],
  'VT': 'CSMT',
  'CSTM': 'CSMT',
  'VICTORIA TERMINUS': 'CSMT',
  'MUMBAI': ['CSMT', 'LTT', 'BDTS', 'DR', 'DDR', 'MMCT'],
  'MUMBAI CENTRAL': 'MMCT',
  'BANDRA': 'BDTS',
  'DADAR': ['DR', 'DDR'],
  'LOKMANYA TILAK': 'LTT',

  // Delhi region
  'NEW DELHI': ['NDLS', 'NZM', 'DLI'],
  'OLD DELHI': 'DLI',
  'DELHI': ['NDLS', 'DLI', 'NZM'],
  'HAZRAT NIZAMUDDIN': 'NZM',
  'ANAND VIHAR': 'ANVT',

  // South India
  'BANGALORE': ['SBC', 'YPR', 'SMVB'],
  'BENGALURU': ['SBC', 'YPR', 'SMVB'],
  'BENGLURU': ['SBC', 'YPR', 'SMVB'],
  'MADRAS': 'MAS',
  'CHENNAI': ['MAS', 'MS'],
  'MYSORE': 'MYS',
  'MYSURU': 'MYS',
  'COIMBATORE': 'CBE',
  'MADURAI': 'MDU',
  'TRIVANDRUM': 'TVC',
  'THIRUVANANTHAPURAM': 'TVC',
  'ERNAKULAM': 'ERS',
  'KOCHI': 'ERS',
  'CALICUT': 'CLT',
  'KOZHIKODE': 'CLT',

  // East India
  'CALCUTTA': 'HWH',
  'KOLKATA': ['HWH', 'SDAH'],
  'KOLKATTA': 'HWH',
  'HOWRAH': 'HWH',
  'SEALDAH': 'SDAH',
  'BANARAS': 'BSB',
  'VARANASI': 'BSB',
  'PATNA': 'PNBE',
  'GUWAHATI': 'GHY',

  // Other major cities
  'HYDERABAD': ['SC', 'HYB', 'KCG'],
  'SECUNDERABAD': 'SC',
  'VIJAYAWADA': 'BZA',
  'VIZAG': 'VSKP',
  'VISAKHAPATNAM': 'VSKP',
  'NAGPUR': 'NGP',
  'BHOPAL': 'BPL',
  'KANPUR': 'CNB',
  'LUCKNOW': 'LKO',
  'PRAYAGRAJ': 'PRYJ',
  'ALLAHABAD': 'PRYJ',
  'GORAKHPUR': 'GKP',
  'JAIPUR': 'JP',
  'JODHPUR': 'JU',
  'AHMEDABAD': 'ADI',
  'SURAT': 'ST',
  'VADODARA': 'BRC',
  'BARODA': 'BRC',
  'RAJKOT': 'RJT',
  'AMRITSAR': 'ASR',
  'LUDHIANA': 'LDH',
  'CHANDIGARH': 'CDG',
  'DEHRADUN': 'DDN',
  'HARIDWAR': 'HW',
};

/**
 * PHASE 2 — DDR (Dadar) Layer-A fan-out alias.
 *
 * A bare "DDR" input previously fell through to the raw passthrough branch and
 * reached IRCTC / the DB fallback unchanged, yielding empty search results.
 * Approved fix: fan "DDR" out to the Mumbai-cluster codes so search resolves to a
 * valid primary code (getStations()[0] === 'CSMT') while PRESERVING Dadar's own
 * codes ('DR','DDR') in the cluster — mirroring the existing DADAR/MUMBAI aliases.
 *
 * Deliberately gated OFF by default behind ENABLE_DDR_ALIAS (repo convention:
 * process.env.ENABLE_X === 'true', cf. ENABLE_SAME_TRAIN_SEGMENTS). This changes
 * ONLY Layer-A discovery resolution; it does not touch Layer-B (schedule-aware)
 * IRCTC canonicalization used by availability / split / same-train rescue.
 */
const DDR_ALIAS_CODES: string[] = ['CSMT', 'DR', 'DDR'];
const isDdrAliasEnabled = (): boolean => process.env.ENABLE_DDR_ALIAS === 'true';

/**
 * Resolves a user-input station name or code to actual IRCTC station codes.
 * Priority order:
 * 1. Alias mapping (historical names, nicknames, misspellings)
 * 2. Direct lookup in cityStations mapping
 * 3. Raw input (if it's already a valid station code)
 */
export const getStations = (input: string, mapping: Record<string, string[]>): string[] => {
  if (!input || typeof input !== 'string') return [];

  const match = input.match(/\(([^)]+)\)/);
  const rawKey = match ? match[1] : input;
  const key = rawKey.toUpperCase().trim();

  // PHASE 2: DDR fan-out only when the feature flag is ON (default OFF).
  const ddrActive = key === 'DDR' && isDdrAliasEnabled();

  // Fast cache check — key is flag-scoped for DDR so ON/OFF results never collide.
  const cacheKey = `station_resolve_${key}${ddrActive ? '_ddr1' : ''}`;
  const cached = cacheService.get<string[]>(cacheKey);
  if (cached) return cached;

  let results: string[] = [];

  // 1. Check aliases first (most common user inputs)
  const alias = ddrActive ? DDR_ALIAS_CODES : ALIASES[key];
  if (alias) {
    const aliasCodes = Array.isArray(alias) ? alias : [alias];
    for (const code of aliasCodes) {
      if (mapping[code]) {
        results.push(...mapping[code]);
      } else {
        results.push(code); // direct station code
      }
    }
  }

  // 2. Direct mapping lookup (city name from cityStations.json)
  if (results.length === 0 && mapping[key] && mapping[key].length > 0) {
    results = mapping[key].slice(0, 5); // limit to top 5 stations per city
  }

  // 3. Fallback: treat input as station code itself
  if (results.length === 0) {
    results = [key];
  }

  // Remove duplicates and limit results
  const uniqueResults = [...new Set(results)].slice(0, 8);

  // Cache for 1 hour (station mappings rarely change)
  cacheService.set(cacheKey, uniqueResults, 3600);

  winstonLogger.debug(`[STATION_RESOLVE] "${input}" → ${uniqueResults.join(', ')}`);
  return uniqueResults;
};

/**
 * Helper: Resolve single station (returns first match)
 * Useful when you expect only one primary station
 */
export const getPrimaryStation = (input: string, mapping: Record<string, string[]>): string => {
  const stations = getStations(input, mapping);
  return stations[0] || input.toUpperCase().trim();
};