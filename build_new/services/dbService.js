"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.dbService = void 0;
const supabase_1 = require("../config/supabase");
const logger_1 = require("../middleware/logger");
class DbService {
    async searchTrains(from, to, date) {
        const sourceCode = this.normalizeStationCode(from);
        const destinationCode = this.normalizeStationCode(to);
        try {
            const { data, error } = await supabase_1.supabase
                .from('train_schedule')
                .select('*')
                .eq('from_station_code', sourceCode)
                .eq('to_station_code', destinationCode)
                .limit(50);
            if (!error && data && data.length > 0) {
                logger_1.winstonLogger.info(`[DB_SEARCH] Direct row match ${sourceCode} -> ${destinationCode}: ${data.length}`);
                return this.normalizeDirectRows(data, sourceCode, destinationCode, date);
            }
        }
        catch (err) {
            logger_1.winstonLogger.debug(`[DB_SEARCH] Direct query failed: ${err.message}`);
        }
        try {
            const { data, error } = await supabase_1.supabase
                .from('train_schedule')
                .select('*')
                .eq('source', sourceCode)
                .eq('destination', destinationCode)
                .limit(50);
            if (!error && data && data.length > 0) {
                logger_1.winstonLogger.info(`[DB_SEARCH] Alternate direct row match ${sourceCode} -> ${destinationCode}: ${data.length}`);
                return this.normalizeDirectRows(data, sourceCode, destinationCode, date);
            }
        }
        catch (err) {
            logger_1.winstonLogger.debug(`[DB_SEARCH] Alternate query failed: ${err.message}`);
        }
        logger_1.winstonLogger.info(`[DB_SEARCH] Performing legacy schedule lookup for ${sourceCode} -> ${destinationCode}`);
        const results = await this.searchLegacySchedule(sourceCode, destinationCode, date);
        // If CSMT yields nothing, try CSTM (both source-side and destination-side)
        if (results.length === 0) {
            if (sourceCode === 'CSMT' && destinationCode !== 'CSMT') {
                const retried = await this.searchLegacySchedule('CSTM', destinationCode, date);
                if (retried.length > 0)
                    return retried;
            }
            else if (destinationCode === 'CSMT' && sourceCode !== 'CSMT') {
                const retried = await this.searchLegacySchedule(sourceCode, 'CSTM', date);
                if (retried.length > 0)
                    return retried;
            }
        }
        return results;
    }
    normalizeStationCode(code) {
        const match = code.match(/\(([^)]+)\)/);
        const raw = match ? match[1] : code;
        const c = raw.trim().toUpperCase();
        if (c === 'MUMBAI')
            return 'CSMT';
        if (c === 'DELHI')
            return 'NDLS';
        if (c === 'CSTM')
            return 'CSMT';
        return c;
    }
    /**
     * Retrieves cached search results if valid and not expired.
     */
    async getCachedSearch(source, destination, date) {
        const routeKey = `${source}_${destination}_${date}`;
        try {
            const { data, error } = await supabase_1.supabase
                .from('api_search_cache')
                .select('response, expires_at')
                .eq('route_key', routeKey)
                .single();
            if (error || !data) {
                return null;
            }
            if (new Date(data.expires_at) < new Date()) {
                return null; // Cache expired
            }
            logger_1.winstonLogger.debug(`[DB_CACHE_HIT] ${routeKey}`);
            return JSON.parse(data.response);
        }
        catch (e) {
            logger_1.winstonLogger.warn(`Cache read error for ${routeKey}: ${e.message}`);
            return null;
        }
    }
    /**
     * Saves search results to cache and persists train data.
     */
    async saveSearchToDB(payload) {
        const routeKey = `${payload.source}_${payload.destination}_${payload.date}`;
        const expiryDate = new Date();
        expiryDate.setHours(expiryDate.getHours() + 24); // 24-hour cache
        try {
            // 1. Upsert cache
            // Check if cache exists
            const { data: existingCache } = await supabase_1.supabase
                .from('api_search_cache')
                .select('id')
                .eq('route_key', routeKey)
                .maybeSingle();
            const cachePayload = {
                route_key: routeKey,
                response: JSON.stringify(payload.trains),
                expires_at: expiryDate.toISOString(),
                created_at: new Date().toISOString(),
                api_used: payload.api_used,
            };
            let cacheError;
            if (existingCache) {
                const { error } = await supabase_1.supabase
                    .from('api_search_cache')
                    .update(cachePayload)
                    .eq('id', existingCache.id);
                cacheError = error;
            }
            else {
                const { error } = await supabase_1.supabase
                    .from('api_search_cache')
                    .insert(cachePayload);
                cacheError = error;
            }
            if (cacheError) {
                logger_1.winstonLogger.error(`Cache upsert failed for ${routeKey}: ${cacheError.message}`);
            }
            else {
                logger_1.winstonLogger.debug(`[DB_CACHE_UPDATED] ${routeKey}`);
            }
            // 2. Upsert train data (in parallel for better performance)
            await Promise.all(payload.trains
                .filter((t) => t.train_number || t.trainNo)
                .map((t) => this.upsertTrainData({
                trainNo: (t.train_number || t.trainNo).toString(),
                name: t.train_name || t.name || undefined,
                source: t.from_station_name || t.source || '',
                destination: t.to_station_name || t.destination || '',
                departure: t.departure_time || t.departure,
                arrival: t.arrival_time || t.arrival,
                date: payload.date,
            })));
        }
        catch (e) {
            logger_1.winstonLogger.error(`saveSearchToDB failed for ${routeKey}: ${e.message}`);
        }
    }
    /**
     * Public alias for upserting train results (Auto-Learning)
     */
    async upsertTrainData(trains) {
        const trainArray = Array.isArray(trains) ? trains : [trains];
        if (trainArray.length === 0)
            return;
        try {
            const trainPayloads = [];
            const stopsPayloads = [];
            for (const t of trainArray) {
                const trainNo = (t.trainNo || t.train_number || t.number)?.toString();
                if (!trainNo)
                    continue;
                trainPayloads.push({
                    number: trainNo,
                    name: t.name || t.train_name || undefined,
                    type: t.type || t.train_type || 'Express',
                });
                const journeyDate = t.travelDate || t.date || new Date().toISOString().split('T')[0];
                const source = t.source || t.from_station_name || t.fromStationCode || '';
                const destination = t.destination || t.to_station_name || t.toStationCode || '';
                if (!source || !destination)
                    continue;
                stopsPayloads.push({
                    Train_No: trainNo,
                    Station_Code: source.split('-')[0].trim().toUpperCase(),
                    Station_Name: source,
                    Arrival_time: '00:00:00',
                    Departure_Time: t.departure || '00:00:00',
                    Journey_Date: journeyDate,
                    SN: 1,
                    Route_Number: 1
                });
                stopsPayloads.push({
                    Train_No: trainNo,
                    Station_Code: destination.split('-')[0].trim().toUpperCase(),
                    Station_Name: destination,
                    Arrival_time: t.arrival || '00:00:00',
                    Departure_Time: '00:00:00',
                    Journey_Date: journeyDate,
                    SN: 99,
                    Route_Number: 1
                });
            }
            if (trainPayloads.length > 0) {
                await supabase_1.supabase.from('trains').upsert(trainPayloads, { onConflict: 'number' });
            }
            if (stopsPayloads.length > 0) {
                const trainNos = [...new Set(stopsPayloads.map(s => s.Train_No))];
                const chunkedTrainNos = [];
                for (let i = 0; i < trainNos.length; i += 100) {
                    chunkedTrainNos.push(trainNos.slice(i, i + 100));
                }
                let existingStops = [];
                for (const chunk of chunkedTrainNos) {
                    const { data } = await supabase_1.supabase
                        .from('train_schedule')
                        .select('id, Train_No, Station_Code, Journey_Date')
                        .in('Train_No', chunk);
                    if (data)
                        existingStops = existingStops.concat(data);
                }
                const existingMap = new Map();
                existingStops.forEach(s => {
                    existingMap.set(`${s.Train_No}_${s.Station_Code}_${s.Journey_Date}`, s.id);
                });
                const upsertPayloads = stopsPayloads.map(stop => {
                    const key = `${stop.Train_No}_${stop.Station_Code}_${stop.Journey_Date}`;
                    const existingId = existingMap.get(key);
                    return existingId ? { ...stop, id: existingId } : stop;
                });
                await supabase_1.supabase.from('train_schedule').upsert(upsertPayloads);
            }
        }
        catch (e) {
            logger_1.winstonLogger.error(`[DB_LEARNING] Failed to save train data: ${e.message}`);
        }
    }
    /**
     * Logs missing data for monitoring and future improvements.
     */
    async logMissingData(data) {
        try {
            await supabase_1.supabase.from('missing_data_logs').insert({
                source: data.source,
                destination: data.destination,
                target_date: data.date,
                reason: data.reason,
                reported_at: new Date().toISOString(),
            });
            logger_1.winstonLogger.warn(`[MISSING_DATA] ${data.source} → ${data.destination} on ${data.date}: ${data.reason}`);
        }
        catch (e) {
            logger_1.winstonLogger.error(`Failed to log missing data: ${e.message}`);
        }
    }
    /**
     * Retrieves train name from DB with fallback.
     */
    async dbLookupTrainName(trainNo) {
        if (!trainNo)
            return undefined;
        try {
            const { data, error } = await supabase_1.supabase
                .from('trains')
                .select('name')
                .eq('number', trainNo)
                .single();
            if (!error && data?.name) {
                return data.name;
            }
        }
        catch (e) {
            logger_1.winstonLogger.warn(`Train name lookup failed for ${trainNo}: ${e.message}`);
        }
        return undefined;
    }
    /**
     * Gets the last known location of a train from tracking data.
     */
    async getLastKnownLocation(trainNo) {
        try {
            const { data, error } = await supabase_1.supabase
                .from('pnr_tracking')
                .select('current_station, created_at')
                .eq('train_no', trainNo)
                .order('created_at', { ascending: false })
                .limit(1)
                .single();
            if (!error && data) {
                return {
                    status: 'LAST_KNOWN',
                    location: data.current_station || 'Unknown',
                    timestamp: data.created_at,
                };
            }
        }
        catch (e) {
            logger_1.winstonLogger.warn(`Last known location lookup failed for ${trainNo}`);
        }
        return {
            status: 'LAST_KNOWN',
            location: 'Unknown',
            timestamp: new Date().toISOString(),
        };
    }
    /**
     * Tracks search popularity for analytics.
     */
    async saveSearchPopularity(data) {
        const routeKey = `${data.source}_${data.destination}`;
        try {
            // Get current count
            const { data: existing } = await supabase_1.supabase
                .from('search_popularity')
                .select('count')
                .eq('route_key', routeKey)
                .single();
            const newCount = (existing?.count || 0) + (data.count || 1);
            const popularityPayload = {
                route_key: routeKey,
                source: data.source,
                destination: data.destination,
                count: newCount,
                last_searched_at: new Date().toISOString(),
            };
            if (existing) {
                await supabase_1.supabase.from('search_popularity').update(popularityPayload).eq('route_key', routeKey);
            }
            else {
                await supabase_1.supabase.from('search_popularity').insert(popularityPayload);
            }
        }
        catch (err) {
            // Silent fail for analytics - don't break main flow
            logger_1.winstonLogger.debug(`Failed to update search popularity for ${routeKey}`);
        }
    }
    normalizeDirectRows(rows, from, to, date) {
        return rows.map((row, index) => {
            const trainNo = String(row.train_number ||
                row.train_no ||
                row.Train_No ||
                row.number ||
                `UNKNOWN-${index}`);
            const durationMins = this.parseDurationToMinutes(row.duration_mins ||
                row.duration_minutes ||
                row.duration);
            return {
                id: `direct-${trainNo}-${index}`,
                trainNo,
                name: row.train_name || row.name || undefined,
                source: row.from_station_name || row.source_name || row.source || from,
                destination: row.to_station_name || row.destination_name || row.destination || to,
                departure: this.normalizeTime(row.departure_time || row.departure || row.Departure_Time),
                arrival: this.normalizeTime(row.arrival_time || row.arrival || row.Arrival_time),
                duration_mins: durationMins,
                total_journey_time: this.formatDuration(durationMins),
                type: row.train_type || row.type || 'Express',
                fromStationCode: row.from_station_code || row.source || from,
                toStationCode: row.to_station_code || row.destination || to,
                travelDate: date,
                _rawCategory: 'direct',
                _isLive: false,
            };
        });
    }
    async searchLegacySchedule(from, to, date) {
        try {
            const [sourceStops, destStops] = await Promise.all([
                supabase_1.supabase
                    .from('train_schedule')
                    .select('*')
                    .eq('Station_Code', from)
                    .order('SN', { ascending: true }),
                supabase_1.supabase
                    .from('train_schedule')
                    .select('*')
                    .eq('Station_Code', to)
                    .order('SN', { ascending: true }),
            ]);
            if (sourceStops.error) {
                throw sourceStops.error;
            }
            if (destStops.error) {
                throw destStops.error;
            }
            const sourceRows = sourceStops.data || [];
            const destRows = destStops.data || [];
            if (sourceRows.length === 0 || destRows.length === 0) {
                return [];
            }
            const trainNumbers = [
                ...new Set([...sourceRows, ...destRows]
                    .map((row) => row.Train_No?.toString())
                    .filter(Boolean)),
            ];
            const { data: trainMeta } = await supabase_1.supabase
                .from('trains')
                .select('number, name, type')
                .in('number', trainNumbers);
            const trainMetaMap = new Map((trainMeta || []).map((row) => [String(row.number), row]));
            const destMap = new Map();
            for (const row of destRows) {
                const trainNo = String(row.Train_No);
                const entries = destMap.get(trainNo) || [];
                entries.push(row);
                destMap.set(trainNo, entries);
            }
            const results = [];
            for (const sourceRow of sourceRows) {
                const trainNo = String(sourceRow.Train_No);
                const possibleDestinations = (destMap.get(trainNo) || []).filter((destRow) => Number(sourceRow.SN) < Number(destRow.SN));
                for (const destRow of possibleDestinations) {
                    const meta = trainMetaMap.get(trainNo);
                    const durationMins = this.calculateDuration(sourceRow.Departure_Time, destRow.Arrival_time, sourceRow.Distance, destRow.Distance);
                    results.push({
                        id: `direct-${trainNo}-${sourceRow.SN}-${destRow.SN}`,
                        trainNo,
                        name: meta?.name || undefined,
                        source: sourceRow.Station_Name || from,
                        destination: destRow.Station_Name || to,
                        departure: this.normalizeTime(sourceRow.Departure_Time),
                        arrival: this.normalizeTime(destRow.Arrival_time),
                        duration_mins: durationMins,
                        total_journey_time: this.formatDuration(durationMins),
                        type: meta?.type || 'Express',
                        fromStationCode: sourceRow.Station_Code || from,
                        toStationCode: destRow.Station_Code || to,
                        travelDate: date,
                        _rawCategory: 'direct',
                        _isLive: false,
                    });
                }
            }
            return results.slice(0, 50);
        }
        catch (e) {
            logger_1.winstonLogger.warn(`[DB_SEARCH] Legacy schedule lookup failed for ${from} -> ${to}: ${e.message}`);
            return [];
        }
    }
    normalizeTime(value) {
        if (!value)
            return '00:00';
        return value.toString().slice(0, 5);
    }
    parseDurationToMinutes(value) {
        if (typeof value === 'number' && Number.isFinite(value)) {
            return value;
        }
        if (typeof value !== 'string' || !value.trim()) {
            return 0;
        }
        const timeMatch = value.match(/(\d{1,2}):(\d{2})/);
        if (timeMatch) {
            return Number(timeMatch[1]) * 60 + Number(timeMatch[2]);
        }
        const numberValue = Number(value);
        return Number.isFinite(numberValue) ? numberValue : 0;
    }
    calculateDuration(departure, arrival, startDistance, endDistance) {
        const dep = this.timeToMinutes(departure);
        const arr = this.timeToMinutes(arrival);
        if (dep === null || arr === null) {
            return 0;
        }
        const clockDiff = arr >= dep ? arr - dep : 1440 - dep + arr;
        if (startDistance !== undefined && endDistance !== undefined && startDistance !== null && endDistance !== null) {
            const distDiff = Number(endDistance) - Number(startDistance);
            if (distDiff > 0) {
                // Average speed heuristic:
                // Indian trains run typically at 45 to 80 km/h.
                // We select n (0 to 4) such that the resulting speed is closest to 62 km/h.
                const baseClockDiff = arr - dep;
                const targetSpeed = 62; // km/h
                let bestN = 0;
                let minDiff = Infinity;
                for (let n = 0; n <= 4; n++) {
                    const duration = baseClockDiff + n * 1440;
                    if (duration <= 0)
                        continue;
                    const speed = distDiff / (duration / 60); // km/h
                    const diff = Math.abs(speed - targetSpeed);
                    if (diff < minDiff) {
                        minDiff = diff;
                        bestN = n;
                    }
                }
                return baseClockDiff + bestN * 1440;
            }
        }
        return clockDiff;
    }
    timeToMinutes(value) {
        if (!value)
            return null;
        const parts = value.split(':').map(Number);
        if (parts.length < 2 || Number.isNaN(parts[0]) || Number.isNaN(parts[1])) {
            return null;
        }
        return parts[0] * 60 + parts[1];
    }
    formatDuration(durationMins) {
        if (!durationMins || durationMins < 0) {
            return '';
        }
        const hours = Math.floor(durationMins / 60);
        const minutes = durationMins % 60;
        return `${hours}h ${minutes}m`;
    }
}
exports.dbService = new DbService();
