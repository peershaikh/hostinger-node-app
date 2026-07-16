import fs from 'fs';
import path from 'path';
import { supabase } from '../config/supabase';
import { winstonLogger } from '../middleware/logger';
import { getStations } from '../utils/stationMapper';
import { cacheService } from './cacheService';
import { featureFlags } from '../config/featureFlags';
import { OfflineStationProvider } from './OfflineStationProvider';

// Global city mapping (loaded once as fallback)
let CITY_MAP: Record<string, string[]> = {};
let REVERSE_CITY_MAP: Record<string, string> = {};

try {
  const cityPath = path.join(__dirname, '../data/cityStations.json');
  if (fs.existsSync(cityPath)) {
    CITY_MAP = JSON.parse(fs.readFileSync(cityPath, 'utf8'));
    winstonLogger.info(`[STATION] Loaded ${Object.keys(CITY_MAP).length} cities from cityStations.json`);

    // Pre-compile reverse lookup map for O(1) synchronous lookups from JSON fallback
    for (const city in CITY_MAP) {
      for (const code of CITY_MAP[city]) {
        REVERSE_CITY_MAP[code.toUpperCase().trim()] = city.toUpperCase();
      }
    }
  }
} catch (e) {
  winstonLogger.warn('[STATION] cityStations.json load failed');
}

// Background database pre-warm: Load database city mappings into REVERSE_CITY_MAP
(async () => {
  try {
    const { data: registryRows, error } = await supabase
      .from('station_registry')
      .select('Station_Code, city_name')
      .not('city_name', 'is', null);

    if (!error && registryRows && registryRows.length > 0) {
      registryRows.forEach((r: any) => {
        const code = r.Station_Code || r.station_code;
        const city = r.city_name || r.city;
        if (code && city) {
          REVERSE_CITY_MAP[code.toUpperCase().trim()] = city.toUpperCase().trim();
        }
      });
      winstonLogger.info(`[STATION] Pre-warmed ${registryRows.length} database city mappings into REVERSE_CITY_MAP`);
    }
  } catch (err: any) {
    winstonLogger.warn(`[STATION] Database city map pre-warm failed: ${err.message}`);
  }
})();

// Global coordinates mapping loaded from local GeoJSON fallback
let COORDINATES_MAP: Record<string, { lat: number; lon: number }> = {};

try {
  const stationsPath = path.join(__dirname, '../data/full_stations.json');
  if (fs.existsSync(stationsPath)) {
    const rawData = JSON.parse(fs.readFileSync(stationsPath, 'utf8'));
    if (rawData && rawData.features) {
      rawData.features.forEach((f: any) => {
        if (f.properties && f.properties.code && f.geometry && f.geometry.coordinates) {
          COORDINATES_MAP[f.properties.code.toUpperCase().trim()] = {
            lat: Number(f.geometry.coordinates[1]),
            lon: Number(f.geometry.coordinates[0])
          };
        }
      });
      winstonLogger.info(`[STATION] Loaded ${Object.keys(COORDINATES_MAP).length} coordinates from full_stations.json`);
    }
  }
} catch (e) {
  winstonLogger.warn('[STATION] full_stations.json coordinates load failed');
}

// Initialize OfflineStationProvider
OfflineStationProvider.initialize().catch((err) => {
  winstonLogger.error(`[STATION] Failed to initialize OfflineStationProvider: ${err.message}`);
});

function resolveStationsWithShadow(input: string, legacyResult: string[]): string[] {
  try {
    const offlineResult = OfflineStationProvider.getStations(input);

    const normalize = (arr: string[]) => 
      [...new Set((arr || []).map(x => x.toUpperCase().trim()))].sort();

    const normLegacy = normalize(legacyResult);
    const normOffline = normalize(offlineResult);

    const match = normLegacy.length === normOffline.length && 
                  normLegacy.every((val, idx) => val === normOffline[idx]);

    if (!match) {
      const difference = {
        legacyOnly: normLegacy.filter(x => !normOffline.includes(x)),
        offlineOnly: normOffline.filter(x => !normLegacy.includes(x))
      };
      winstonLogger.warn(`[OFFLINE_PROVIDER_PARITY] Mismatch found for input "${input}": ` + 
        `legacy_result=[${normLegacy.join(', ')}], ` + 
        `offline_result=[${normOffline.join(', ')}], ` + 
        `difference=${JSON.stringify(difference)}`
      );
    }

    if (featureFlags.useOfflineProvider) {
      return offlineResult;
    }
  } catch (err: any) {
    winstonLogger.error(`[OFFLINE_PROVIDER_PARITY] Error during shadow comparison for input "${input}": ${err.message}`);
  }
  return legacyResult;
}

export class StationService {

  /**
   * Helper: Normalize input string to clean uppercase station/city code/name
   */
  normalizeInput(input: string): string {
    if (!input) return '';
    const match = input.match(/\(([^)]+)\)/);
    const raw = match ? match[1] : input;
    const result = raw.trim().toUpperCase();
    winstonLogger.debug(`[STATION_RESOLVE] Normalization result for "${input}" → "${result}"`);
    return result;
  }

  /**
   * Synchronous reverse city lookup using pre-compiled memory map.
   * Runs in O(1) time complexity. Bypasses database, cache, and REST queries.
   */
  getCitySync(code: string): string {
    if (!code) return '';
    const cleanCode = this.normalizeInput(code);
    return REVERSE_CITY_MAP[cleanCode] || cleanCode;
  }

  async getStationsForCity(city: string): Promise<string[]> {
    if (!city?.trim()) return [];

    const cleanCity = this.normalizeInput(city);
    const cacheKey = `city_stations_v3_${cleanCity}`;

    try {
      // Cache check (Redis/In-memory second tier)
      const cached = cacheService.get<string[]>(cacheKey);
      if (cached) {
        winstonLogger.info(`[STATION_RESOLVE] Cache hit for city "${cleanCity}"`);
        return cached;
      }

      // Helper: Expand any resolved station codes to their parent city clusters to guarantee parity!
      const expandToClusters = async (codes: string[]): Promise<string[]> => {
        if (!codes || codes.length === 0) return codes;
        const { data: registryRows } = await supabase
          .from('station_registry')
          .select('Station_Code, city_name')
          .in('Station_Code', codes);

        if (!registryRows) return codes;

        const cities = [...new Set(registryRows.map((r: any) => r.city_name).filter(Boolean))];
        if (cities.length === 0) return codes;

        const { data: clusterRows } = await supabase
          .from('station_registry')
          .select('Station_Code')
          .in('city_name', cities);

        if (!clusterRows || clusterRows.length === 0) return codes;

        const result = new Set([...codes, ...clusterRows.map((r: any) => r.Station_Code.toUpperCase())]);
        return [...result];
      };

      // 1. Exact Station Code Match (Bypassed if registered as an alias to avoid collisions)
      if (this.isCode(cleanCity)) {
        const { data: isAlias } = await supabase
          .from('station_aliases')
          .select('id')
          .eq('alias_name', cleanCity)
          .limit(1);

        if (!isAlias || isAlias.length === 0) {
          const { data: exactCodeRow } = await supabase
            .from('station_registry')
            .select('Station_Code, city_name')
            .eq('Station_Code', cleanCity)
            .maybeSingle();

          if (exactCodeRow) {
            winstonLogger.info(`[STATION_RESOLVE] Step 1 (Exact Station Code) hit for "${cleanCity}"`);
            const baseCodes = [cleanCity];
            const codes = await expandToClusters(baseCodes);
            cacheService.set(cacheKey, codes, 3600);
            return codes;
          }
        }
      }

      // 2 & 3/4. DB Alias Lookup combined with City Cluster Resolution
      const { data: aliasRows } = await supabase
        .from('station_aliases')
        .select('station_code')
        .eq('alias_name', cleanCity);

      const { data: cityRows } = await supabase
        .from('station_registry')
        .select('Station_Code')
        .eq('city_name', cleanCity);

      let dbCodes: string[] = [];
      if (aliasRows && aliasRows.length > 0) {
        dbCodes.push(...aliasRows.map((r: any) => r.station_code.toUpperCase()));
      }
      if (cityRows && cityRows.length > 0) {
        dbCodes.push(...cityRows.map((r: any) => r.Station_Code.toUpperCase()));
      }

      if (dbCodes.length > 0) {
        winstonLogger.info(`[STATION_RESOLVE] DB Alias/City hit for "${cleanCity}"`);
        const codes = await expandToClusters([...new Set(dbCodes)]);
        cacheService.set(cacheKey, codes, 3600);
        return codes;
      }

      // 4.5 JSON Fallback (Prioritized over partial name matching to prevent city collisions)
      let legacyMapped: string[] = [];
      try {
        legacyMapped = getStations(cleanCity, CITY_MAP);
      } catch (legacyErr: any) {
        winstonLogger.error(`[STATION] Step 4.5 Legacy fallback getStations failed: ${legacyErr.message}`);
      }
      const mapped = resolveStationsWithShadow(cleanCity, legacyMapped);
      // Ensure we don't just blindly accept the fallback if it's the exact same non-code string
      const validMapped = mapped.filter(m => m !== cleanCity || this.isCode(m));
      if (validMapped.length > 0) {
        winstonLogger.info(`[STATION_RESOLVE] Step 4.5 (JSON Fallback) hit for "${cleanCity}" → [${validMapped.join(', ')}]`);
        cacheService.set(cacheKey, validMapped, 3600);
        return validMapped;
      }

      // 5. Exact Station Name Match
      const { data: nameRows } = await supabase
        .from('station_registry')
        .select('Station_Code')
        .eq('Station_Name', cleanCity);

      if (nameRows && nameRows.length > 0) {
        const codes = [...new Set(nameRows.map((r: any) => r.Station_Code.toUpperCase()))];
        winstonLogger.info(`[STATION_RESOLVE] Step 5 (Exact Station Name Match) hit for "${cleanCity}" → [${codes.join(', ')}]`);
        cacheService.set(cacheKey, codes, 3600);
        return codes;
      }

      // 6. Prefix Match
      const { data: prefixRows } = await supabase
        .from('station_registry')
        .select('Station_Code')
        .like('Station_Name', `${cleanCity}%`)
        .limit(30);

      if (prefixRows && prefixRows.length > 0) {
        const codes = [...new Set(prefixRows.map((r: any) => r.Station_Code.toUpperCase()))];
        winstonLogger.info(`[STATION_RESOLVE] Step 6 (Prefix Match) hit for "${cleanCity}" → [${codes.join(', ')}]`);
        cacheService.set(cacheKey, codes, 3600);
        return codes;
      }

      // 7. Fuzzy Match
      const { data: fuzzyRows } = await supabase
        .from('station_registry')
        .select('Station_Code')
        .ilike('Station_Name', `%${cleanCity}%`)
        .limit(30);

      if (fuzzyRows && fuzzyRows.length > 0) {
        const codes = [...new Set(fuzzyRows.map((r: any) => r.Station_Code.toUpperCase()))];
        winstonLogger.info(`[STATION_RESOLVE] Step 7 (Fuzzy Match) hit for "${cleanCity}" → [${codes.join(', ')}]`);
        cacheService.set(cacheKey, codes, 3600);
        return codes;
      }

      // Default final fallback
      if (this.isCode(cleanCity)) {
        const codes = [cleanCity];
        cacheService.set(cacheKey, codes, 3600);
        return codes;
      }

      return [];
    } catch (err: any) {
      winstonLogger.error(`[STATION] getStationsForCity failed for "${city}": ${err.message}`);
      let legacyMapped: string[] = [];
      try {
        legacyMapped = getStations(cleanCity, CITY_MAP);
      } catch (legacyErr: any) {
        winstonLogger.error(`[STATION] Legacy fallback getStations failed: ${legacyErr.message}`);
      }
      return resolveStationsWithShadow(cleanCity, legacyMapped);
    }
  }

  isCode(input: string): boolean {
    if (!input) return false;
    return /^[A-Z]{2,6}$/.test(input.toUpperCase().trim());
  }

  async getStationName(code: string, apiName?: string): Promise<string> {
    const cleanCode = this.normalizeInput(code);
    const info = await this.getStationInfo(cleanCode) as any;
    return info?.station_name || apiName?.trim() || cleanCode;
  }

  async getStationInfo(code: string) {
    if (!code) return null;

    const cleanCode = this.normalizeInput(code);
    const cacheKey = `station_info_v3_${cleanCode}`;

    const cached = cacheService.get(cacheKey);
    if (cached) {
      winstonLogger.info(`[STATION_RESOLVE] Cache hit for station info "${cleanCode}"`);
      return cached;
    }

    try {
      const { data, error } = await supabase
        .from('station_registry')
        .select('*')
        .eq('Station_Code', cleanCode)
        .maybeSingle();

      if (!error && data) {
        const normalized = {
          station_code: data.Station_Code || data.station_code || cleanCode,
          station_name: data.Station_Name || data.station_name || '',
          latitude: data.latitude !== undefined ? data.latitude : null,
          longitude: data.longitude !== undefined ? data.longitude : null,
          city: data.city_name || data.city || null
        };
        winstonLogger.info(`[STATION_RESOLVE] DB hit for station info "${cleanCode}"`);
        cacheService.set(cacheKey, normalized, 3600);
        return normalized;
      }

      if (COORDINATES_MAP[cleanCode]) {
        const coords = COORDINATES_MAP[cleanCode];
        const normalized = {
          station_code: cleanCode,
          station_name: cleanCode,
          latitude: coords.lat,
          longitude: coords.lon,
          city: null
        };
        winstonLogger.info(`[STATION_RESOLVE] JSON fallback resolved for station info "${cleanCode}"`);
        cacheService.set(cacheKey, normalized, 3600);
        return normalized;
      }

      return null;
    } catch (err: any) {
      winstonLogger.error(`[STATION] getStationInfo failed for "${code}": ${err.message}`);
      return null;
    }
  }

  async getCoordinates(code: string) {
    const cleanCode = this.normalizeInput(code);
    const cacheKey = `station_coords_v3_${cleanCode}`;

    const cached = cacheService.get<{ lat: number; lon: number }>(cacheKey);
    if (cached) return cached;

    const info = await this.getStationInfo(cleanCode) as any;
    if (info && info.latitude !== null && info.longitude !== null && info.latitude !== undefined) {
      const coords = {
        lat: Number(info.latitude),
        lon: Number(info.longitude)
      };
      cacheService.set(cacheKey, coords, 3600);
      return coords;
    }

    if (COORDINATES_MAP[cleanCode]) {
      const coords = COORDINATES_MAP[cleanCode];
      winstonLogger.info(`[STATION_RESOLVE] JSON fallback coordinates resolved for "${cleanCode}"`);
      cacheService.set(cacheKey, coords, 3600);
      return coords;
    }

    if (cleanCode === 'CSMT' && COORDINATES_MAP['CSTM']) {
      return COORDINATES_MAP['CSTM'];
    }
    if (cleanCode === 'CSTM' && COORDINATES_MAP['CSMT']) {
      return COORDINATES_MAP['CSMT'];
    }

    return null;
  }

  async getNearbyStations(targetCode: string, initialRadiusKm: number = 50): Promise<any[]> {
    const cleanCode = this.normalizeInput(targetCode);
    const coords = await this.getCoordinates(cleanCode);
    if (!coords) {
      winstonLogger.warn(`[STATION] Cannot find coordinates for ${cleanCode}`);
      return [];
    }

    const RADIUS_STEPS = [initialRadiusKm, 80, 120];
    let nearby: any[] = [];

    for (const radius of RADIUS_STEPS) {
      const degreeDelta = radius / 111;

      try {
        const { data, error } = await supabase
          .from('station_registry')
          .select('*')
          .neq('Station_Code', cleanCode)
          .gte('latitude', coords.lat - degreeDelta)
          .lte('latitude', coords.lat + degreeDelta)
          .gte('longitude', coords.lon - degreeDelta)
          .lte('longitude', coords.lon + degreeDelta)
          .limit(20);

        if (error) continue;

        if (data && data.length > 0) {
          nearby = data
            .map((s: any) => {
              const distance = this._calculateHaversine(
                coords.lat,
                coords.lon,
                Number(s.latitude),
                Number(s.longitude)
              );
              return {
                station_code: s.Station_Code || s.station_code,
                station_name: s.Station_Name || s.station_name,
                distance_km: Math.round(distance * 10) / 10
              };
            })
            .filter((s) => s.distance_km <= radius)
            .sort((a, b) => a.distance_km - b.distance_km)
            .slice(0, 5);

          if (nearby.length > 0) {
            winstonLogger.info(`[STATION] Found ${nearby.length} nearby stations for ${cleanCode} within ${radius}km`);
            break;
          }
        }
      } catch (e: any) {
        winstonLogger.debug(`[STATION] Nearby search failed at radius ${radius}km: ${e.message}`);
      }
    }

    return nearby.map((s) => ({
      station_code: s.station_code,
      station_name: s.station_name,
      distance_km: s.distance_km,
      tag: "Nearby Station",
    }));
  }

  private _calculateHaversine(lat1: number, lon1: number, lat2: number, lon2: number): number {
    const R = 6371;
    const dLat = ((lat2 - lat1) * Math.PI) / 180;
    const dLon = ((lon2 - lon1) * Math.PI) / 180;

    const a =
      Math.sin(dLat / 2) * Math.sin(dLat / 2) +
      Math.cos((lat1 * Math.PI) / 180) * Math.cos((lat2 * Math.PI) / 180) *
      Math.sin(dLon / 2) * Math.sin(dLon / 2);

    const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
    return R * c;
  }
}

export const stationService = new StationService();