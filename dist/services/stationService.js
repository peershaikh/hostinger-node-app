"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.stationService = exports.StationService = void 0;
const fs_1 = __importDefault(require("fs"));
const path_1 = __importDefault(require("path"));
const supabase_1 = require("../config/supabase");
const logger_1 = require("../middleware/logger");
const stationMapper_1 = require("../utils/stationMapper");
const cacheService_1 = require("./cacheService");
const featureFlags_1 = require("../config/featureFlags");
const OfflineStationProvider_1 = require("./OfflineStationProvider");
// Global city mapping (loaded once as fallback)
let CITY_MAP = {};
let REVERSE_CITY_MAP = {};
try {
    const cityPath = path_1.default.join(__dirname, '../data/cityStations.json');
    if (fs_1.default.existsSync(cityPath)) {
        CITY_MAP = JSON.parse(fs_1.default.readFileSync(cityPath, 'utf8'));
        logger_1.winstonLogger.info(`[STATION] Loaded ${Object.keys(CITY_MAP).length} cities from cityStations.json`);
        // Pre-compile reverse lookup map for O(1) synchronous lookups from JSON fallback
        for (const city in CITY_MAP) {
            for (const code of CITY_MAP[city]) {
                REVERSE_CITY_MAP[code.toUpperCase().trim()] = city.toUpperCase();
            }
        }
    }
}
catch (e) {
    logger_1.winstonLogger.warn('[STATION] cityStations.json load failed');
}
// Background database pre-warm: Load database city mappings into REVERSE_CITY_MAP
(async () => {
    try {
        const { data: registryRows, error } = await supabase_1.supabase
            .from('station_registry')
            .select('Station_Code, city_name')
            .not('city_name', 'is', null);
        if (!error && registryRows && registryRows.length > 0) {
            registryRows.forEach((r) => {
                const code = r.Station_Code || r.station_code;
                const city = r.city_name || r.city;
                if (code && city) {
                    REVERSE_CITY_MAP[code.toUpperCase().trim()] = city.toUpperCase().trim();
                }
            });
            logger_1.winstonLogger.info(`[STATION] Pre-warmed ${registryRows.length} database city mappings into REVERSE_CITY_MAP`);
        }
    }
    catch (err) {
        logger_1.winstonLogger.warn(`[STATION] Database city map pre-warm failed: ${err.message}`);
    }
})();
// Global coordinates mapping loaded from local GeoJSON fallback
let COORDINATES_MAP = {};
try {
    const stationsPath = path_1.default.join(__dirname, '../data/full_stations.json');
    if (fs_1.default.existsSync(stationsPath)) {
        const rawData = JSON.parse(fs_1.default.readFileSync(stationsPath, 'utf8'));
        if (rawData && rawData.features) {
            rawData.features.forEach((f) => {
                if (f.properties && f.properties.code && f.geometry && f.geometry.coordinates) {
                    COORDINATES_MAP[f.properties.code.toUpperCase().trim()] = {
                        lat: Number(f.geometry.coordinates[1]),
                        lon: Number(f.geometry.coordinates[0])
                    };
                }
            });
            logger_1.winstonLogger.info(`[STATION] Loaded ${Object.keys(COORDINATES_MAP).length} coordinates from full_stations.json`);
        }
    }
}
catch (e) {
    logger_1.winstonLogger.warn('[STATION] full_stations.json coordinates load failed');
}
// Initialize OfflineStationProvider
OfflineStationProvider_1.OfflineStationProvider.initialize().catch((err) => {
    logger_1.winstonLogger.error(`[STATION] Failed to initialize OfflineStationProvider: ${err.message}`);
});
function resolveStationsWithShadow(input, legacyResult) {
    try {
        const offlineResult = OfflineStationProvider_1.OfflineStationProvider.getStations(input);
        const normalize = (arr) => [...new Set((arr || []).map(x => x.toUpperCase().trim()))].sort();
        const normLegacy = normalize(legacyResult);
        const normOffline = normalize(offlineResult);
        const match = normLegacy.length === normOffline.length &&
            normLegacy.every((val, idx) => val === normOffline[idx]);
        if (!match) {
            const difference = {
                legacyOnly: normLegacy.filter(x => !normOffline.includes(x)),
                offlineOnly: normOffline.filter(x => !normLegacy.includes(x))
            };
            logger_1.winstonLogger.warn(`[OFFLINE_PROVIDER_PARITY] Mismatch found for input "${input}": ` +
                `legacy_result=[${normLegacy.join(', ')}], ` +
                `offline_result=[${normOffline.join(', ')}], ` +
                `difference=${JSON.stringify(difference)}`);
        }
        if (featureFlags_1.featureFlags.useOfflineProvider) {
            return offlineResult;
        }
    }
    catch (err) {
        logger_1.winstonLogger.error(`[OFFLINE_PROVIDER_PARITY] Error during shadow comparison for input "${input}": ${err.message}`);
    }
    return legacyResult;
}
class StationService {
    /**
     * Helper: Normalize input string to clean uppercase station/city code/name
     */
    normalizeInput(input) {
        if (!input)
            return '';
        const match = input.match(/\(([^)]+)\)/);
        const raw = match ? match[1] : input;
        const result = raw.trim().toUpperCase();
        logger_1.winstonLogger.debug(`[STATION_RESOLVE] Normalization result for "${input}" → "${result}"`);
        return result;
    }
    /**
     * Synchronous reverse city lookup using pre-compiled memory map.
     * Runs in O(1) time complexity. Bypasses database, cache, and REST queries.
     */
    getCitySync(code) {
        if (!code)
            return '';
        const cleanCode = this.normalizeInput(code);
        return REVERSE_CITY_MAP[cleanCode] || cleanCode;
    }
    async getStationsForCity(city) {
        if (!city?.trim())
            return [];
        const cleanCity = this.normalizeInput(city);
        const cacheKey = `city_stations_v3_${cleanCity}`;
        try {
            // Cache check (Redis/In-memory second tier)
            const cached = cacheService_1.cacheService.get(cacheKey);
            if (cached) {
                logger_1.winstonLogger.info(`[STATION_RESOLVE] Cache hit for city "${cleanCity}"`);
                return cached;
            }
            // Helper: Expand any resolved station codes to their parent city clusters to guarantee parity!
            const expandToClusters = async (codes) => {
                if (!codes || codes.length === 0)
                    return codes;
                const { data: registryRows } = await supabase_1.supabase
                    .from('station_registry')
                    .select('Station_Code, city_name')
                    .in('Station_Code', codes);
                if (!registryRows)
                    return codes;
                const cities = [...new Set(registryRows.map((r) => r.city_name).filter(Boolean))];
                if (cities.length === 0)
                    return codes;
                const { data: clusterRows } = await supabase_1.supabase
                    .from('station_registry')
                    .select('Station_Code')
                    .in('city_name', cities);
                if (!clusterRows || clusterRows.length === 0)
                    return codes;
                const result = new Set([...codes, ...clusterRows.map((r) => r.Station_Code.toUpperCase())]);
                return [...result];
            };
            // 1. Exact Station Code Match (Bypassed if registered as an alias to avoid collisions)
            if (this.isCode(cleanCity)) {
                const { data: isAlias } = await supabase_1.supabase
                    .from('station_aliases')
                    .select('id')
                    .eq('alias_name', cleanCity)
                    .limit(1);
                if (!isAlias || isAlias.length === 0) {
                    const { data: exactCodeRow } = await supabase_1.supabase
                        .from('station_registry')
                        .select('Station_Code, city_name')
                        .eq('Station_Code', cleanCity)
                        .maybeSingle();
                    if (exactCodeRow) {
                        logger_1.winstonLogger.info(`[STATION_RESOLVE] Step 1 (Exact Station Code) hit for "${cleanCity}"`);
                        const baseCodes = [cleanCity];
                        const codes = await expandToClusters(baseCodes);
                        cacheService_1.cacheService.set(cacheKey, codes, 3600);
                        return codes;
                    }
                }
            }
            // 2 & 3/4. DB Alias Lookup combined with City Cluster Resolution
            const { data: aliasRows } = await supabase_1.supabase
                .from('station_aliases')
                .select('station_code')
                .eq('alias_name', cleanCity);
            const { data: cityRows } = await supabase_1.supabase
                .from('station_registry')
                .select('Station_Code')
                .eq('city_name', cleanCity);
            let dbCodes = [];
            if (aliasRows && aliasRows.length > 0) {
                dbCodes.push(...aliasRows.map((r) => r.station_code.toUpperCase()));
            }
            if (cityRows && cityRows.length > 0) {
                dbCodes.push(...cityRows.map((r) => r.Station_Code.toUpperCase()));
            }
            if (dbCodes.length > 0) {
                logger_1.winstonLogger.info(`[STATION_RESOLVE] DB Alias/City hit for "${cleanCity}"`);
                const codes = await expandToClusters([...new Set(dbCodes)]);
                cacheService_1.cacheService.set(cacheKey, codes, 3600);
                return codes;
            }
            // 4.5 JSON Fallback (Prioritized over partial name matching to prevent city collisions)
            let legacyMapped = [];
            try {
                legacyMapped = (0, stationMapper_1.getStations)(cleanCity, CITY_MAP);
            }
            catch (legacyErr) {
                logger_1.winstonLogger.error(`[STATION] Step 4.5 Legacy fallback getStations failed: ${legacyErr.message}`);
            }
            const mapped = resolveStationsWithShadow(cleanCity, legacyMapped);
            // Ensure we don't just blindly accept the fallback if it's the exact same non-code string
            const validMapped = mapped.filter(m => m !== cleanCity || this.isCode(m));
            if (validMapped.length > 0) {
                logger_1.winstonLogger.info(`[STATION_RESOLVE] Step 4.5 (JSON Fallback) hit for "${cleanCity}" → [${validMapped.join(', ')}]`);
                cacheService_1.cacheService.set(cacheKey, validMapped, 3600);
                return validMapped;
            }
            // 5. Exact Station Name Match
            const { data: nameRows } = await supabase_1.supabase
                .from('station_registry')
                .select('Station_Code')
                .eq('Station_Name', cleanCity);
            if (nameRows && nameRows.length > 0) {
                const codes = [...new Set(nameRows.map((r) => r.Station_Code.toUpperCase()))];
                logger_1.winstonLogger.info(`[STATION_RESOLVE] Step 5 (Exact Station Name Match) hit for "${cleanCity}" → [${codes.join(', ')}]`);
                cacheService_1.cacheService.set(cacheKey, codes, 3600);
                return codes;
            }
            // 6. Prefix Match
            const { data: prefixRows } = await supabase_1.supabase
                .from('station_registry')
                .select('Station_Code')
                .like('Station_Name', `${cleanCity}%`)
                .limit(30);
            if (prefixRows && prefixRows.length > 0) {
                const codes = [...new Set(prefixRows.map((r) => r.Station_Code.toUpperCase()))];
                logger_1.winstonLogger.info(`[STATION_RESOLVE] Step 6 (Prefix Match) hit for "${cleanCity}" → [${codes.join(', ')}]`);
                cacheService_1.cacheService.set(cacheKey, codes, 3600);
                return codes;
            }
            // 7. Fuzzy Match
            const { data: fuzzyRows } = await supabase_1.supabase
                .from('station_registry')
                .select('Station_Code')
                .ilike('Station_Name', `%${cleanCity}%`)
                .limit(30);
            if (fuzzyRows && fuzzyRows.length > 0) {
                const codes = [...new Set(fuzzyRows.map((r) => r.Station_Code.toUpperCase()))];
                logger_1.winstonLogger.info(`[STATION_RESOLVE] Step 7 (Fuzzy Match) hit for "${cleanCity}" → [${codes.join(', ')}]`);
                cacheService_1.cacheService.set(cacheKey, codes, 3600);
                return codes;
            }
            // Default final fallback
            if (this.isCode(cleanCity)) {
                const codes = [cleanCity];
                cacheService_1.cacheService.set(cacheKey, codes, 3600);
                return codes;
            }
            return [];
        }
        catch (err) {
            logger_1.winstonLogger.error(`[STATION] getStationsForCity failed for "${city}": ${err.message}`);
            let legacyMapped = [];
            try {
                legacyMapped = (0, stationMapper_1.getStations)(cleanCity, CITY_MAP);
            }
            catch (legacyErr) {
                logger_1.winstonLogger.error(`[STATION] Legacy fallback getStations failed: ${legacyErr.message}`);
            }
            return resolveStationsWithShadow(cleanCity, legacyMapped);
        }
    }
    isCode(input) {
        if (!input)
            return false;
        return /^[A-Z]{2,6}$/.test(input.toUpperCase().trim());
    }
    async getStationName(code, apiName) {
        const cleanCode = this.normalizeInput(code);
        const info = await this.getStationInfo(cleanCode);
        return info?.station_name || apiName?.trim() || cleanCode;
    }
    async getStationInfo(code) {
        if (!code)
            return null;
        const cleanCode = this.normalizeInput(code);
        const cacheKey = `station_info_v3_${cleanCode}`;
        const cached = cacheService_1.cacheService.get(cacheKey);
        if (cached) {
            logger_1.winstonLogger.info(`[STATION_RESOLVE] Cache hit for station info "${cleanCode}"`);
            return cached;
        }
        try {
            const { data, error } = await supabase_1.supabase
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
                logger_1.winstonLogger.info(`[STATION_RESOLVE] DB hit for station info "${cleanCode}"`);
                cacheService_1.cacheService.set(cacheKey, normalized, 3600);
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
                logger_1.winstonLogger.info(`[STATION_RESOLVE] JSON fallback resolved for station info "${cleanCode}"`);
                cacheService_1.cacheService.set(cacheKey, normalized, 3600);
                return normalized;
            }
            return null;
        }
        catch (err) {
            logger_1.winstonLogger.error(`[STATION] getStationInfo failed for "${code}": ${err.message}`);
            return null;
        }
    }
    async getCoordinates(code) {
        const cleanCode = this.normalizeInput(code);
        const cacheKey = `station_coords_v3_${cleanCode}`;
        const cached = cacheService_1.cacheService.get(cacheKey);
        if (cached)
            return cached;
        const info = await this.getStationInfo(cleanCode);
        if (info && info.latitude !== null && info.longitude !== null && info.latitude !== undefined) {
            const coords = {
                lat: Number(info.latitude),
                lon: Number(info.longitude)
            };
            cacheService_1.cacheService.set(cacheKey, coords, 3600);
            return coords;
        }
        if (COORDINATES_MAP[cleanCode]) {
            const coords = COORDINATES_MAP[cleanCode];
            logger_1.winstonLogger.info(`[STATION_RESOLVE] JSON fallback coordinates resolved for "${cleanCode}"`);
            cacheService_1.cacheService.set(cacheKey, coords, 3600);
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
    async getNearbyStations(targetCode, initialRadiusKm = 50) {
        const cleanCode = this.normalizeInput(targetCode);
        const coords = await this.getCoordinates(cleanCode);
        if (!coords) {
            logger_1.winstonLogger.warn(`[STATION] Cannot find coordinates for ${cleanCode}`);
            return [];
        }
        const RADIUS_STEPS = [initialRadiusKm, 80, 120];
        let nearby = [];
        for (const radius of RADIUS_STEPS) {
            const degreeDelta = radius / 111;
            try {
                const { data, error } = await supabase_1.supabase
                    .from('station_registry')
                    .select('*')
                    .neq('Station_Code', cleanCode)
                    .gte('latitude', coords.lat - degreeDelta)
                    .lte('latitude', coords.lat + degreeDelta)
                    .gte('longitude', coords.lon - degreeDelta)
                    .lte('longitude', coords.lon + degreeDelta)
                    .limit(20);
                if (error)
                    continue;
                if (data && data.length > 0) {
                    nearby = data
                        .map((s) => {
                        const distance = this._calculateHaversine(coords.lat, coords.lon, Number(s.latitude), Number(s.longitude));
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
                        logger_1.winstonLogger.info(`[STATION] Found ${nearby.length} nearby stations for ${cleanCode} within ${radius}km`);
                        break;
                    }
                }
            }
            catch (e) {
                logger_1.winstonLogger.debug(`[STATION] Nearby search failed at radius ${radius}km: ${e.message}`);
            }
        }
        return nearby.map((s) => ({
            station_code: s.station_code,
            station_name: s.station_name,
            distance_km: s.distance_km,
            tag: "Nearby Station",
        }));
    }
    _calculateHaversine(lat1, lon1, lat2, lon2) {
        const R = 6371;
        const dLat = ((lat2 - lat1) * Math.PI) / 180;
        const dLon = ((lon2 - lon1) * Math.PI) / 180;
        const a = Math.sin(dLat / 2) * Math.sin(dLat / 2) +
            Math.cos((lat1 * Math.PI) / 180) * Math.cos((lat2 * Math.PI) / 180) *
                Math.sin(dLon / 2) * Math.sin(dLon / 2);
        const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
        return R * c;
    }
}
exports.StationService = StationService;
exports.stationService = new StationService();
