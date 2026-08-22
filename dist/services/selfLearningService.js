"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.selfLearningService = exports.SelfLearningService = void 0;
const crypto_1 = __importDefault(require("crypto"));
const fs_1 = __importDefault(require("fs"));
const path_1 = __importDefault(require("path"));
const supabase_1 = require("../config/supabase");
const logger_1 = require("../middleware/logger");
const gptRouteEnrichmentService_1 = require("./gptRouteEnrichmentService");
const DATA_DIR = path_1.default.join(__dirname, '../../data');
class SelfLearningService {
    constructor() {
        this.missingQueries = [];
        this.missingRoutes = [];
        this.missingTrains = [];
        this.missingStations = [];
        this.routeMemory = [];
        this.stationAliases = [];
        this.trainAliases = [];
        this.verifiedRoutes = [];
        // 24h deduplication cache: key -> timestamp
        this.dedupCache = new Map();
        this.DEDUP_TTL_MS = 24 * 60 * 60 * 1000; // 24 hours
        this.ensureDataDir();
        this.init();
    }
    async init() {
        this.loadLocalData();
        await this.syncWithSupabase();
    }
    ensureDataDir() {
        if (!fs_1.default.existsSync(DATA_DIR)) {
            (0, supabase_1.safeMkdirSync)(DATA_DIR, { recursive: true });
        }
    }
    getFilePath(filename) {
        return path_1.default.join(DATA_DIR, filename);
    }
    loadLocalData() {
        try {
            this.missingQueries = this.loadJsonFile('missing_queries.json', []);
            this.missingRoutes = this.loadJsonFile('missing_routes.json', []);
            this.missingTrains = this.loadJsonFile('missing_trains.json', []);
            this.missingStations = this.loadJsonFile('missing_stations.json', []);
            this.routeMemory = this.loadJsonFile('route_memory.json', []);
            this.stationAliases = this.loadJsonFile('station_aliases.json', []);
            this.trainAliases = this.loadJsonFile('train_aliases.json', []);
            this.verifiedRoutes = this.loadJsonFile('verified_routes.json', []);
        }
        catch (e) {
            logger_1.winstonLogger.warn(`[SELF_LEARNING] Failed to load local data: ${e.message}`);
        }
    }
    loadJsonFile(filename, defaultValue) {
        const filePath = this.getFilePath(filename);
        if (fs_1.default.existsSync(filePath)) {
            try {
                const content = fs_1.default.readFileSync(filePath, 'utf8');
                return JSON.parse(content);
            }
            catch (err) {
                logger_1.winstonLogger.error(`[SELF_LEARNING] Error parsing local file ${filename}: ${err}`);
            }
        }
        return defaultValue;
    }
    saveLocalData(filename, data) {
        try {
            const filePath = this.getFilePath(filename);
            // PHASE 5B136: suppressed when LOCAL_E2E_NO_WRITE=true (existing file untouched)
            (0, supabase_1.safeWriteFileSync)(filePath, JSON.stringify(data, null, 2), 'utf8');
        }
        catch (err) {
            logger_1.winstonLogger.error(`[SELF_LEARNING] Failed to save local file ${filename}: ${err.message}`);
        }
    }
    async syncWithSupabase() {
        if (!(0, supabase_1.isSupabaseConfigured)())
            return;
        try {
            // 1. Sync Route Memory
            const { data: rmData, error: rmErr } = await supabase_1.supabase.from('route_memory').select('*');
            if (!rmErr && rmData) {
                this.routeMemory = rmData.map(r => ({
                    id: r.id,
                    source: r.source,
                    destination: r.destination,
                    via_hub: r.via_hub,
                    train_nos: r.train_nos || [],
                    notes: r.notes,
                    approved_by: r.approved_by,
                    is_active: r.is_active,
                    created_at: r.created_at
                }));
                this.saveLocalData('route_memory.json', this.routeMemory);
            }
            // 2. Sync Missing Queries
            const { data: mqData, error: mqErr } = await supabase_1.supabase.from('missing_queries').select('*');
            if (!mqErr && mqData) {
                this.missingQueries = mqData.map(q => ({
                    id: q.id,
                    source: q.source,
                    destination: q.destination,
                    date: q.date,
                    user_id: q.user_id,
                    count: q.count,
                    last_seen: q.last_seen,
                    gpt_suggestion: q.gpt_suggestion,
                    status: q.status || 'pending',
                    created_at: q.created_at
                }));
                this.saveLocalData('missing_queries.json', this.missingQueries);
            }
            // 3. Sync Missing Routes
            const { data: mrData, error: mrErr } = await supabase_1.supabase.from('missing_routes').select('*');
            if (!mrErr && mrData) {
                this.missingRoutes = mrData.map(r => ({
                    id: r.id,
                    source: r.source,
                    destination: r.destination,
                    user_id: r.user_id,
                    count: r.count,
                    last_seen: r.last_seen,
                    status: r.status || 'pending',
                    created_at: r.created_at
                }));
                this.saveLocalData('missing_routes.json', this.missingRoutes);
            }
            // 4. Sync Missing Trains
            const { data: mtData, error: mtErr } = await supabase_1.supabase.from('missing_trains').select('*');
            if (!mtErr && mtData) {
                this.missingTrains = mtData.map(t => ({
                    id: t.id,
                    train_no: t.train_no,
                    user_id: t.user_id,
                    count: t.count,
                    last_seen: t.last_seen,
                    status: t.status || 'pending',
                    created_at: t.created_at
                }));
                this.saveLocalData('missing_trains.json', this.missingTrains);
            }
            // 5. Sync Missing Stations
            const { data: msData, error: msErr } = await supabase_1.supabase.from('missing_stations').select('*');
            if (!msErr && msData) {
                this.missingStations = msData.map(s => ({
                    id: s.id,
                    query: s.query,
                    user_id: s.user_id,
                    count: s.count,
                    last_seen: s.last_seen,
                    status: s.status || 'pending',
                    created_at: s.created_at
                }));
                this.saveLocalData('missing_stations.json', this.missingStations);
            }
            // 6. Sync aliases and verified routes
            const { data: saData } = await supabase_1.supabase.from('station_aliases').select('*');
            if (saData) {
                this.stationAliases = saData;
                this.saveLocalData('station_aliases.json', this.stationAliases);
            }
            const { data: taData } = await supabase_1.supabase.from('train_aliases').select('*');
            if (taData) {
                this.trainAliases = taData;
                this.saveLocalData('train_aliases.json', this.trainAliases);
            }
            const { data: vrData } = await supabase_1.supabase.from('verified_routes').select('*');
            if (vrData) {
                this.verifiedRoutes = vrData;
                this.saveLocalData('verified_routes.json', this.verifiedRoutes);
            }
        }
        catch (e) {
            logger_1.winstonLogger.warn(`[SELF_LEARNING] Failed to sync with Supabase: ${e.message}`);
        }
    }
    isDuplicate(key) {
        const lastTime = this.dedupCache.get(key);
        if (lastTime && (Date.now() - lastTime) < this.DEDUP_TTL_MS) {
            return true;
        }
        this.dedupCache.set(key, Date.now());
        return false;
    }
    // --- LOGGING METHODS ---
    async logMissingQuery(source, destination, date, userId) {
        const key = `query:${source}:${destination}:${date}`;
        if (this.isDuplicate(key)) {
            logger_1.winstonLogger.debug(`[SELF_LEARNING] Missing query duplicate suppressed: ${key}`);
            return;
        }
        const cleanSource = source.toUpperCase().trim();
        const cleanDestination = destination.toUpperCase().trim();
        // Look for existing pending query in local array
        let existing = this.missingQueries.find(q => q.source === cleanSource && q.destination === cleanDestination && q.status === 'pending');
        let dbId;
        if (existing) {
            existing.count += 1;
            existing.last_seen = new Date().toISOString();
            dbId = existing.id;
        }
        else {
            dbId = crypto_1.default.randomUUID();
            existing = {
                id: dbId,
                source: cleanSource,
                destination: cleanDestination,
                date,
                user_id: userId,
                count: 1,
                last_seen: new Date().toISOString(),
                status: 'pending',
                created_at: new Date().toISOString()
            };
            this.missingQueries.push(existing);
        }
        this.saveLocalData('missing_queries.json', this.missingQueries);
        // Telemetry Integration
        try {
            const { universalEventEmitter } = require('./universalEventEmitter');
            const { UniversalEventNames } = require('../constants/eventTaxonomy');
            universalEventEmitter.emit({
                eventName: UniversalEventNames.MISSING_ROUTE_DETECTED,
                searchId: dbId,
                userId: userId || undefined,
                mode: 'rail',
                route: `${cleanSource}-${cleanDestination}`,
                metadata: { source: cleanSource, destination: cleanDestination, date, query_id: dbId }
            });
        }
        catch {
            // Non-blocking telemetry
        }
        // Supabase Dual Write
        if ((0, supabase_1.isSupabaseConfigured)()) {
            try {
                const { data, error } = await supabase_1.supabase
                    .from('missing_queries')
                    .select('id, count')
                    .eq('source', cleanSource)
                    .eq('destination', cleanDestination)
                    .eq('status', 'pending')
                    .maybeSingle();
                if (!error && data) {
                    await supabase_1.supabase
                        .from('missing_queries')
                        .update({ count: data.count + 1, last_seen: new Date().toISOString() })
                        .eq('id', data.id);
                    dbId = data.id;
                }
                else {
                    await supabase_1.supabase
                        .from('missing_queries')
                        .insert({
                        id: dbId,
                        source: cleanSource,
                        destination: cleanDestination,
                        date,
                        user_id: userId,
                        count: 1,
                        status: 'pending',
                        last_seen: new Date().toISOString()
                    });
                }
            }
            catch (err) {
                logger_1.winstonLogger.warn(`[SELF_LEARNING] Supabase logMissingQuery error: ${err.message}`);
            }
        }
        // Trigger GPT enrichment worker asynchronously via setImmediate
        setImmediate(() => {
            gptRouteEnrichmentService_1.gptRouteEnrichmentService.enrichMissingQuery(dbId, cleanSource, cleanDestination)
                .catch(err => logger_1.winstonLogger.error(`[SELF_LEARNING] GPT enrichment failed for query ${dbId}: ${err.message}`));
        });
    }
    async updateGptSuggestion(queryId, suggestion) {
        const existing = this.missingQueries.find(q => q.id === queryId);
        if (existing) {
            existing.gpt_suggestion = suggestion;
            this.saveLocalData('missing_queries.json', this.missingQueries);
        }
        if ((0, supabase_1.isSupabaseConfigured)()) {
            try {
                await supabase_1.supabase
                    .from('missing_queries')
                    .update({ gpt_suggestion: suggestion })
                    .eq('id', queryId);
            }
            catch (err) {
                logger_1.winstonLogger.warn(`[SELF_LEARNING] Supabase updateGptSuggestion failed: ${err.message}`);
            }
        }
    }
    async logMissingRoute(source, destination, userId, meta) {
        const cleanSource = source.toUpperCase().trim();
        const cleanDestination = destination.toUpperCase().trim();
        const category = meta?.category || 'SPLIT_ROUTE_MISS';
        const key = `route:${category}:${cleanSource}:${cleanDestination}`;
        if (this.isDuplicate(key))
            return;
        let existing = this.missingRoutes.find(r => r.source === cleanSource &&
            r.destination === cleanDestination &&
            r.status === 'pending' &&
            (r.category === category || (!r.category && category === 'SPLIT_ROUTE_MISS')));
        const dbId = existing ? existing.id : crypto_1.default.randomUUID();
        if (existing) {
            existing.count += 1;
            existing.last_seen = new Date().toISOString();
            if (meta?.date)
                existing.date = meta.date;
            if (meta?.direct_count != null)
                existing.direct_count = meta.direct_count;
            if (meta?.source_code)
                existing.source_code = meta.source_code;
            if (meta?.destination_code)
                existing.destination_code = meta.destination_code;
            if (meta?.top_rejection_reason)
                existing.top_rejection_reason = meta.top_rejection_reason;
            if (meta?.rejection_reasons && meta.rejection_reasons.length > 0) {
                const mergedReasons = Array.from(new Set([...(existing.rejection_reasons || []), ...meta.rejection_reasons]));
                existing.rejection_reasons = mergedReasons;
            }
        }
        else {
            existing = {
                id: dbId,
                source: cleanSource,
                destination: cleanDestination,
                category,
                date: meta?.date,
                source_code: meta?.source_code,
                destination_code: meta?.destination_code,
                direct_count: meta?.direct_count ?? 0,
                rejection_reasons: meta?.rejection_reasons || (meta?.top_rejection_reason ? [meta.top_rejection_reason] : []),
                top_rejection_reason: meta?.top_rejection_reason || 'ROUTE_NOT_FOUND',
                user_id: userId,
                count: 1,
                last_seen: new Date().toISOString(),
                status: 'pending',
                created_at: new Date().toISOString()
            };
            this.missingRoutes.push(existing);
        }
        this.saveLocalData('missing_routes.json', this.missingRoutes);
        // Telemetry Integration
        try {
            const { universalEventEmitter } = require('./universalEventEmitter');
            const { UniversalEventNames } = require('../constants/eventTaxonomy');
            universalEventEmitter.emit({
                eventName: UniversalEventNames.MISSING_ROUTE_DETECTED,
                searchId: dbId,
                userId: userId || undefined,
                mode: 'rail',
                route: `${cleanSource}-${cleanDestination}`,
                metadata: {
                    source: cleanSource,
                    destination: cleanDestination,
                    category,
                    date: meta?.date,
                    top_rejection_reason: existing.top_rejection_reason,
                    query_id: dbId
                }
            });
        }
        catch {
            // Non-blocking telemetry
        }
        if ((0, supabase_1.isSupabaseConfigured)()) {
            try {
                const { data, error } = await supabase_1.supabase
                    .from('missing_routes')
                    .select('id, count')
                    .eq('source', cleanSource)
                    .eq('destination', cleanDestination)
                    .eq('status', 'pending')
                    .maybeSingle();
                if (!error && data) {
                    await supabase_1.supabase
                        .from('missing_routes')
                        .update({
                        count: data.count + 1,
                        last_seen: new Date().toISOString(),
                        top_rejection_reason: existing.top_rejection_reason,
                        category
                    })
                        .eq('id', data.id);
                }
                else {
                    await supabase_1.supabase
                        .from('missing_routes')
                        .insert({
                        id: dbId,
                        source: cleanSource,
                        destination: cleanDestination,
                        category,
                        date: meta?.date,
                        direct_count: meta?.direct_count ?? 0,
                        top_rejection_reason: existing.top_rejection_reason,
                        user_id: userId,
                        count: 1,
                        status: 'pending',
                        last_seen: new Date().toISOString()
                    });
                }
            }
            catch (err) {
                logger_1.winstonLogger.warn(`[SELF_LEARNING] Supabase logMissingRoute error: ${err.message}`);
            }
        }
    }
    async logMissingTrain(trainNo, userId) {
        const key = `train:${trainNo}`;
        if (this.isDuplicate(key))
            return;
        const cleanTrainNo = trainNo.toUpperCase().trim();
        let existing = this.missingTrains.find(t => t.train_no === cleanTrainNo && t.status === 'pending');
        const dbId = existing ? existing.id : crypto_1.default.randomUUID();
        if (existing) {
            existing.count += 1;
            existing.last_seen = new Date().toISOString();
        }
        else {
            existing = {
                id: dbId,
                train_no: cleanTrainNo,
                user_id: userId,
                count: 1,
                last_seen: new Date().toISOString(),
                status: 'pending',
                created_at: new Date().toISOString()
            };
            this.missingTrains.push(existing);
        }
        this.saveLocalData('missing_trains.json', this.missingTrains);
        if ((0, supabase_1.isSupabaseConfigured)()) {
            try {
                const { data, error } = await supabase_1.supabase
                    .from('missing_trains')
                    .select('id, count')
                    .eq('train_no', cleanTrainNo)
                    .eq('status', 'pending')
                    .maybeSingle();
                if (!error && data) {
                    await supabase_1.supabase
                        .from('missing_trains')
                        .update({ count: data.count + 1, last_seen: new Date().toISOString() })
                        .eq('id', data.id);
                }
                else {
                    await supabase_1.supabase
                        .from('missing_trains')
                        .insert({
                        id: dbId,
                        train_no: cleanTrainNo,
                        user_id: userId,
                        count: 1,
                        status: 'pending',
                        last_seen: new Date().toISOString()
                    });
                }
            }
            catch (err) {
                logger_1.winstonLogger.warn(`[SELF_LEARNING] Supabase logMissingTrain error: ${err.message}`);
            }
        }
    }
    async logMissingStation(query, userId) {
        const key = `station:${query}`;
        if (this.isDuplicate(key))
            return;
        const cleanQuery = query.trim();
        let existing = this.missingStations.find(s => s.query.toLowerCase() === cleanQuery.toLowerCase() && s.status === 'pending');
        const dbId = existing ? existing.id : crypto_1.default.randomUUID();
        if (existing) {
            existing.count += 1;
            existing.last_seen = new Date().toISOString();
        }
        else {
            existing = {
                id: dbId,
                query: cleanQuery,
                user_id: userId,
                count: 1,
                last_seen: new Date().toISOString(),
                status: 'pending',
                created_at: new Date().toISOString()
            };
            this.missingStations.push(existing);
        }
        this.saveLocalData('missing_stations.json', this.missingStations);
        // Telemetry Integration
        try {
            const { universalEventEmitter } = require('./universalEventEmitter');
            const { UniversalEventNames } = require('../constants/eventTaxonomy');
            universalEventEmitter.emit({
                eventName: UniversalEventNames.MISSING_STATION_DETECTED,
                searchId: dbId,
                userId: userId || undefined,
                mode: 'rail',
                metadata: { query: cleanQuery, query_id: dbId }
            });
        }
        catch {
            // Non-blocking telemetry
        }
        if ((0, supabase_1.isSupabaseConfigured)()) {
            try {
                const { data, error } = await supabase_1.supabase
                    .from('missing_stations')
                    .select('id, count')
                    .eq('query', cleanQuery)
                    .eq('status', 'pending')
                    .maybeSingle();
                if (!error && data) {
                    await supabase_1.supabase
                        .from('missing_stations')
                        .update({ count: data.count + 1, last_seen: new Date().toISOString() })
                        .eq('id', data.id);
                }
                else {
                    await supabase_1.supabase
                        .from('missing_stations')
                        .insert({
                        id: dbId,
                        query: cleanQuery,
                        user_id: userId,
                        count: 1,
                        status: 'pending',
                        last_seen: new Date().toISOString()
                    });
                }
            }
            catch (err) {
                logger_1.winstonLogger.warn(`[SELF_LEARNING] Supabase logMissingStation error: ${err.message}`);
            }
        }
    }
    async logPnrFailure(pnrNo, userId) {
        const key = `pnr_fail:${pnrNo}`;
        if (this.isDuplicate(key))
            return;
        const cleanPnr = pnrNo.trim();
        const timestamp = new Date().toISOString();
        // Local JSONL fallback
        try {
            const pnrFailuresFile = this.getFilePath('pnr_failures.jsonl');
            const logEntry = JSON.stringify({ pnr: cleanPnr, user_id: userId, timestamp }) + '\n';
            (0, supabase_1.safeAppendFileSync)(pnrFailuresFile, logEntry, 'utf8');
            logger_1.winstonLogger.info(`[SELF_LEARNING] Logged failed PNR lookup: ${cleanPnr}`);
        }
        catch (err) {
            logger_1.winstonLogger.warn(`[SELF_LEARNING] Failed to write PNR failure locally: ${err.message}`);
        }
        // Supabase Dual Write (Optional/Fail-safe)
        if ((0, supabase_1.isSupabaseConfigured)()) {
            try {
                await supabase_1.supabase
                    .from('pnr_failures')
                    .insert({
                    pnr: cleanPnr,
                    user_id: userId,
                    timestamp
                });
            }
            catch (err) {
                logger_1.winstonLogger.debug(`[SELF_LEARNING] Supabase logPnrFailure ignored (table may not exist): ${err.message}`);
            }
        }
    }
    // --- ROUTE MEMORY METHODS ---
    async getRouteMemory(source, destination) {
        const cleanSource = source.toUpperCase().trim();
        const cleanDestination = destination.toUpperCase().trim();
        // Query in-memory/local fallback
        const localMatches = this.routeMemory.filter(r => r.source === cleanSource && r.destination === cleanDestination && r.is_active);
        if ((0, supabase_1.isSupabaseConfigured)()) {
            try {
                const { data, error } = await supabase_1.supabase
                    .from('route_memory')
                    .select('*')
                    .eq('source', cleanSource)
                    .eq('destination', cleanDestination)
                    .eq('is_active', true);
                if (!error && data) {
                    return data;
                }
            }
            catch (err) {
                logger_1.winstonLogger.warn(`[SELF_LEARNING] Supabase getRouteMemory failed: ${err.message}`);
            }
        }
        return localMatches;
    }
    async addRouteMemory(routeData) {
        const newRoute = {
            id: crypto_1.default.randomUUID(),
            ...routeData,
            source: routeData.source.toUpperCase().trim(),
            destination: routeData.destination.toUpperCase().trim(),
            created_at: new Date().toISOString()
        };
        this.routeMemory.push(newRoute);
        this.saveLocalData('route_memory.json', this.routeMemory);
        if ((0, supabase_1.isSupabaseConfigured)()) {
            try {
                await supabase_1.supabase
                    .from('route_memory')
                    .insert(newRoute);
            }
            catch (err) {
                logger_1.winstonLogger.warn(`[SELF_LEARNING] Supabase addRouteMemory failed: ${err.message}`);
            }
        }
        return newRoute;
    }
    // --- ADMIN PANEL HANDLERS ---
    getLocalDataForTable(table) {
        switch (table) {
            case 'missing_queries': return this.missingQueries;
            case 'missing_routes': {
                const now = Date.now();
                const SEVEN_DAYS_MS = 7 * 24 * 3600 * 1000;
                return this.missingRoutes.map(r => {
                    let currentState = 'HISTORICAL_MISS';
                    if (r.last_verified_at) {
                        const ageMs = now - new Date(r.last_verified_at).getTime();
                        if (ageMs > SEVEN_DAYS_MS) {
                            currentState = 'STALE';
                        }
                        else if (r.valid_split_count != null && r.valid_split_count > 0) {
                            currentState = 'RESOLVED';
                        }
                        else {
                            currentState = 'CURRENT_MISS';
                        }
                    }
                    else if (r.status === 'approved' || r.status === 'merged') {
                        currentState = 'RESOLVED';
                    }
                    else {
                        currentState = 'HISTORICAL_MISS';
                    }
                    return {
                        ...r,
                        current_state: r.current_state || currentState,
                        // Do NOT show 0 direct for unverified historical records
                        direct_count: r.last_verified_at ? r.direct_count : undefined,
                        top_rejection_reason: r.last_verified_at
                            ? (r.top_rejection_reason || ((r.valid_split_count && r.valid_split_count > 0) ? 'NONE' : 'DIAGNOSTIC_UNAVAILABLE'))
                            : (r.top_rejection_reason || 'NOT_REVALIDATED')
                    };
                });
            }
            case 'missing_trains': return this.missingTrains;
            case 'missing_stations': return this.missingStations;
            case 'route_memory': return this.routeMemory;
            case 'station_aliases': return this.stationAliases;
            case 'train_aliases': return this.trainAliases;
            case 'verified_routes': return this.verifiedRoutes;
            default: return [];
        }
    }
    async approveRecord(table, id, approvedBy) {
        logger_1.winstonLogger.info(`[SELF_LEARNING] Approving record from ${table} ID: ${id}`);
        // Find record in local lists and update status
        let queryRecord;
        let routeRecord;
        let trainRecord;
        let stationRecord;
        if (table === 'missing_queries') {
            queryRecord = this.missingQueries.find(q => q.id === id);
            if (queryRecord) {
                queryRecord.status = 'approved';
                this.saveLocalData('missing_queries.json', this.missingQueries);
                // If it has a GPT suggestion containing a candidate route, promote it to Route Memory
                if (queryRecord.gpt_suggestion && queryRecord.gpt_suggestion.candidateRoute) {
                    const sug = queryRecord.gpt_suggestion;
                    const trainNos = sug.trainNos || [];
                    await this.addRouteMemory({
                        source: queryRecord.source,
                        destination: queryRecord.destination,
                        via_hub: sug.candidateHub || undefined,
                        train_nos: trainNos,
                        notes: `GPT Suggestion approved: ${sug.reason || ''}`,
                        approved_by: approvedBy,
                        is_active: true
                    });
                }
            }
        }
        else if (table === 'missing_routes') {
            routeRecord = this.missingRoutes.find(r => r.id === id);
            if (routeRecord) {
                routeRecord.status = 'approved';
                this.saveLocalData('missing_routes.json', this.missingRoutes);
            }
        }
        else if (table === 'missing_trains') {
            trainRecord = this.missingTrains.find(t => t.id === id);
            if (trainRecord) {
                trainRecord.status = 'approved';
                this.saveLocalData('missing_trains.json', this.missingTrains);
            }
        }
        else if (table === 'missing_stations') {
            stationRecord = this.missingStations.find(s => s.id === id);
            if (stationRecord) {
                stationRecord.status = 'approved';
                this.saveLocalData('missing_stations.json', this.missingStations);
            }
        }
        if ((0, supabase_1.isSupabaseConfigured)()) {
            try {
                await supabase_1.supabase.from(table).update({ status: 'approved' }).eq('id', id);
                // Also promote in DB if query and has GPT suggestion
                if (table === 'missing_queries' && queryRecord?.gpt_suggestion?.candidateRoute) {
                    const sug = queryRecord.gpt_suggestion;
                    await supabase_1.supabase.from('route_memory').insert({
                        source: queryRecord.source,
                        destination: queryRecord.destination,
                        via_hub: sug.candidateHub || null,
                        train_nos: sug.trainNos || [],
                        notes: `GPT Suggestion approved: ${sug.reason || ''}`,
                        approved_by: approvedBy,
                        is_active: true
                    });
                }
            }
            catch (err) {
                logger_1.winstonLogger.warn(`[SELF_LEARNING] Supabase approveRecord failed: ${err.message}`);
            }
        }
        return true;
    }
    async rejectRecord(table, id) {
        logger_1.winstonLogger.info(`[SELF_LEARNING] Rejecting record from ${table} ID: ${id}`);
        if (table === 'missing_queries') {
            const rec = this.missingQueries.find(q => q.id === id);
            if (rec) {
                rec.status = 'rejected';
                this.saveLocalData('missing_queries.json', this.missingQueries);
            }
        }
        else if (table === 'missing_routes') {
            const rec = this.missingRoutes.find(r => r.id === id);
            if (rec) {
                rec.status = 'rejected';
                this.saveLocalData('missing_routes.json', this.missingRoutes);
            }
        }
        else if (table === 'missing_trains') {
            const rec = this.missingTrains.find(t => t.id === id);
            if (rec) {
                rec.status = 'rejected';
                this.saveLocalData('missing_trains.json', this.missingTrains);
            }
        }
        else if (table === 'missing_stations') {
            const rec = this.missingStations.find(s => s.id === id);
            if (rec) {
                rec.status = 'rejected';
                this.saveLocalData('missing_stations.json', this.missingStations);
            }
        }
        if ((0, supabase_1.isSupabaseConfigured)()) {
            try {
                await supabase_1.supabase.from(table).update({ status: 'rejected' }).eq('id', id);
            }
            catch (err) {
                logger_1.winstonLogger.warn(`[SELF_LEARNING] Supabase rejectRecord failed: ${err.message}`);
            }
        }
        return true;
    }
    async revalidateSplitRoute(params) {
        const { id, source, destination, date } = params;
        const { stationService } = require('./stationService');
        const { trainService } = require('./trainService');
        const { splitJourneyEngine } = require('./splitJourneyEngine');
        let matchingRecords = [];
        if (id) {
            const rec = this.missingRoutes.find(r => r.id === id);
            if (rec)
                matchingRecords.push(rec);
        }
        else if (source && destination) {
            const cleanSrc = stationService.normalizeInput(source);
            const cleanDst = stationService.normalizeInput(destination);
            matchingRecords = this.missingRoutes.filter(r => (r.source === source || r.source_code === cleanSrc || stationService.normalizeInput(r.source) === cleanSrc || (cleanSrc === 'CSMT' && stationService.normalizeInput(r.source) === 'CSTM') || (cleanSrc === 'CSTM' && stationService.normalizeInput(r.source) === 'CSMT')) &&
                (r.destination === destination || r.destination_code === cleanDst || stationService.normalizeInput(r.destination) === cleanDst));
        }
        const rawSource = source || matchingRecords[0]?.source;
        const rawDestination = destination || matchingRecords[0]?.destination;
        if (!rawSource || !rawDestination) {
            throw new Error('Source and destination are required for split route revalidation');
        }
        const cleanSource = stationService.normalizeInput(rawSource);
        const cleanDestination = stationService.normalizeInput(rawDestination);
        const travelDate = date || matchingRecords[0]?.date || '2026-08-28';
        logger_1.winstonLogger.info(`[REVALIDATE_SPLIT] Running read-only diagnostic for ${cleanSource} → ${cleanDestination} on ${travelDate}`);
        // 1. Fetch direct trains
        const directRes = await trainService.getTrainData(cleanSource, cleanDestination, travelDate);
        const directTrains = directRes?.direct || [];
        const directCount = directTrains.length;
        // 2. Run Split Engine in diagnostic mode (read-only)
        const splitRes = await splitJourneyEngine.findCombinedRoutes(cleanSource, cleanDestination, travelDate, directTrains, undefined, { classType: '3A', quota: 'GN' });
        const validSplits = splitRes?.split || splitRes?.smart_routes || [];
        const validSplitCount = Array.isArray(validSplits) ? validSplits.length : 0;
        const diag = splitRes?.diagnostic || {};
        const candidateCount = diag.candidateCount || 0;
        const rejectionStats = diag.rejectionStats || {};
        let topRejectionReason = 'NONE';
        if (validSplitCount === 0) {
            // PHASE_084K — check inner rejection stats before falling back to ROUTE_NOT_FOUND.
            // The diagnostic block from _runFindCombinedRoutes now carries granular counts;
            // prefer the most specific reason available.
            const runningDaysUnknown = diag.runningDaysUnknown || rejectionStats.running_days_unknown || 0;
            const trainNotRunning = diag.runningDaysRejected ? Math.max(0, (diag.runningDaysRejected || 0) - runningDaysUnknown) : (rejectionStats.train_not_running || 0);
            const dbUnverified = diag.dbUnverifiedStopData || rejectionStats.db_unverified_stop_data || 0;
            const stopNotFound = diag.stopNotFound || rejectionStats.stop_not_found || 0;
            if (candidateCount === 0) {
                topRejectionReason = 'ROUTE_NOT_FOUND';
            }
            else if (runningDaysUnknown > 0) {
                topRejectionReason = 'RUNNING_DAYS_UNKNOWN';
            }
            else if (trainNotRunning > 0) {
                topRejectionReason = 'TRAIN_NOT_RUNNING';
            }
            else if (dbUnverified > 0) {
                topRejectionReason = 'DB_UNVERIFIED_STOP_DATA';
            }
            else if (stopNotFound > 0) {
                topRejectionReason = 'STOP_NOT_FOUND';
            }
            else if (diag.topRejectionReason && diag.topRejectionReason !== 'NONE') {
                topRejectionReason = diag.topRejectionReason;
            }
            else {
                topRejectionReason = 'TRANSFER_BUFFER_FAILURE';
            }
        }
        const currentState = validSplitCount > 0 ? 'RESOLVED' : 'CURRENT_MISS';
        const verificationTimestamp = new Date().toISOString();
        // 3. Update the matching record in telemetry if it exists (OBSERVABILITY ONLY — no auto learning)
        for (const rec of matchingRecords) {
            rec.source_code = cleanSource;
            rec.destination_code = cleanDestination;
            rec.date = travelDate;
            rec.direct_count = directCount;
            rec.valid_split_count = validSplitCount;
            rec.candidate_count = candidateCount;
            rec.top_rejection_reason = topRejectionReason;
            rec.rejection_stats = rejectionStats;
            rec.rejection_reasons = Object.keys(rejectionStats).filter(k => rejectionStats[k] > 0);
            rec.current_state = currentState;
            rec.last_verified_at = verificationTimestamp;
            if (validSplitCount > 0) {
                rec.last_successful_at = verificationTimestamp;
            }
        }
        if (matchingRecords.length > 0) {
            this.saveLocalData('missing_routes.json', this.missingRoutes);
            if ((0, supabase_1.isSupabaseConfigured)()) {
                try {
                    for (const rec of matchingRecords) {
                        await supabase_1.supabase
                            .from('missing_routes')
                            .update({
                            direct_count: directCount,
                            candidate_count: candidateCount,
                            valid_split_count: validSplitCount,
                            top_rejection_reason: topRejectionReason,
                            rejection_stats: rejectionStats,
                            last_seen: verificationTimestamp
                        })
                            .eq('id', rec.id);
                    }
                }
                catch (err) {
                    logger_1.winstonLogger.warn(`[SELF_LEARNING] Supabase revalidate update failed: ${err.message}`);
                }
            }
        }
        return {
            success: true,
            record: matchingRecords[0],
            diagnostic: {
                directCount,
                candidateCount,
                validSplitCount,
                topRejectionReason,
                rejectionStats,
                verificationTimestamp,
                currentState
            }
        };
    }
    async getAnalytics() {
        // Computes analytics: counts + top N elements
        const topQueries = [...this.missingQueries]
            .sort((a, b) => b.count - a.count)
            .slice(0, 10)
            .map(q => ({ source: q.source, destination: q.destination, count: q.count }));
        const topRoutes = [...this.missingRoutes]
            .sort((a, b) => b.count - a.count)
            .slice(0, 10)
            .map(r => ({ source: r.source, destination: r.destination, count: r.count }));
        const topTrains = [...this.missingTrains]
            .sort((a, b) => b.count - a.count)
            .slice(0, 10)
            .map(t => ({ train_no: t.train_no, count: t.count }));
        const topStations = [...this.missingStations]
            .sort((a, b) => b.count - a.count)
            .slice(0, 10)
            .map(s => ({ query: s.query, count: s.count }));
        return {
            counts: {
                missing_queries: this.missingQueries.length,
                missing_routes: this.missingRoutes.length,
                missing_trains: this.missingTrains.length,
                missing_stations: this.missingStations.length,
                route_memory: this.routeMemory.length,
                station_aliases: this.stationAliases.length,
                train_aliases: this.trainAliases.length,
                verified_routes: this.verifiedRoutes.length
            },
            topQueries,
            topRoutes,
            topTrains,
            topStations
        };
    }
}
exports.SelfLearningService = SelfLearningService;
exports.selfLearningService = new SelfLearningService();
