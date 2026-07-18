"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.knowledgeRepository = exports.KnowledgeRepository = void 0;
/**
 * PHASE_4C871 — Knowledge Layer repository (Supabase persistence).
 * Never throws — callers receive null/empty on failure.
 */
const supabase_1 = require("../config/supabase");
function isMissingTableError(code) {
    return code === 'PGRST205' || code === '42P01' || code === 'PGRST204';
}
class KnowledgeRepository {
    isConfigured() {
        return (0, supabase_1.isSupabaseConfigured)();
    }
    async upsertStationMapping(row) {
        if (!this.isConfigured())
            return false;
        try {
            const { error } = await supabase_1.supabase.from('train_station_mapping').upsert({
                ...row,
                updated_at: new Date().toISOString(),
            }, { onConflict: 'train_no,user_station,schedule_stop' });
            if (error) {
                if (isMissingTableError(error.code))
                    return false;
                return false;
            }
            return true;
        }
        catch {
            return false;
        }
    }
    async getStationMappings(trainNo, userStation) {
        if (!this.isConfigured())
            return [];
        try {
            const { data, error } = await supabase_1.supabase
                .from('train_station_mapping')
                .select('*')
                .eq('train_no', trainNo)
                .eq('user_station', userStation.toUpperCase().trim())
                .eq('is_active', true);
            if (error || !data)
                return [];
            return data;
        }
        catch {
            return [];
        }
    }
    async upsertHubCatalogRows(rows) {
        if (!this.isConfigured() || rows.length === 0)
            return 0;
        try {
            const { error } = await supabase_1.supabase.from('rescue_hub_catalog').upsert(rows.map((r) => ({
                ...r,
                computed_at: r.computed_at || new Date().toISOString(),
            })), { onConflict: 'train_no,source,destination,hub_station' });
            if (error) {
                if (isMissingTableError(error.code))
                    return 0;
                return 0;
            }
            return rows.length;
        }
        catch {
            return 0;
        }
    }
    async getHubCatalog(trainNo, source, destination) {
        if (!this.isConfigured())
            return [];
        try {
            const { data, error } = await supabase_1.supabase
                .from('rescue_hub_catalog')
                .select('hub_station, hub_sn, src_sn, dest_sn, rank_score, buffer_minutes, is_major_hub')
                .eq('train_no', trainNo)
                .eq('source', source.toUpperCase().trim())
                .eq('destination', destination.toUpperCase().trim())
                .order('rank_score', { ascending: false });
            if (error || !data)
                return [];
            return data;
        }
        catch {
            return [];
        }
    }
    async insertOutcomeEvent(row) {
        if (!this.isConfigured())
            return null;
        try {
            const { data, error } = await supabase_1.supabase
                .from('rescue_outcome_events')
                .insert([row])
                .select('id')
                .single();
            if (error) {
                if (isMissingTableError(error.code))
                    return null;
                return null;
            }
            return data?.id || null;
        }
        catch {
            return null;
        }
    }
    async upsertHubStats(row) {
        if (!this.isConfigured())
            return false;
        try {
            const { error } = await supabase_1.supabase.from('rescue_hub_stats').upsert({
                ...row,
                last_updated: new Date().toISOString(),
            }, { onConflict: 'train_no,source,destination,hub_station' });
            if (error) {
                if (isMissingTableError(error.code))
                    return false;
                return false;
            }
            return true;
        }
        catch {
            return false;
        }
    }
    async getHubStats(trainNo, source, destination) {
        if (!this.isConfigured())
            return [];
        try {
            const { data, error } = await supabase_1.supabase
                .from('rescue_hub_stats')
                .select('*')
                .eq('train_no', trainNo)
                .eq('source', source.toUpperCase().trim())
                .eq('destination', destination.toUpperCase().trim())
                .order('confidence_score', { ascending: false });
            if (error || !data)
                return [];
            return data;
        }
        catch {
            return [];
        }
    }
    async listDistinctTrainRoutes(limit = 500) {
        if (!this.isConfigured())
            return [];
        try {
            const { data, error } = await supabase_1.supabase
                .from('train_schedule')
                .select('Train_No, Station_Code, SN')
                .order('Train_No', { ascending: true })
                .order('SN', { ascending: true })
                .limit(10000);
            if (error || !data || data.length === 0)
                return [];
            const routes = [];
            const byTrain = new Map();
            for (const row of data) {
                const t = String(row.Train_No || '').trim();
                if (!byTrain.has(t))
                    byTrain.set(t, []);
                byTrain.get(t).push({ code: row.Station_Code, sn: row.SN });
            }
            for (const [trainNo, stops] of byTrain) {
                if (stops.length < 4)
                    continue;
                const src = stops[0].code;
                const dest = stops[stops.length - 1].code;
                routes.push({
                    train_no: trainNo,
                    source: src.toUpperCase().trim(),
                    destination: dest.toUpperCase().trim(),
                });
                if (routes.length >= limit)
                    break;
            }
            return routes;
        }
        catch {
            return [];
        }
    }
    async loadTrainStops(trainNo) {
        if (!this.isConfigured())
            return [];
        try {
            const { data, error } = await supabase_1.supabase
                .from('train_schedule')
                .select('Station_Code, SN')
                .eq('Train_No', trainNo)
                .order('SN', { ascending: true });
            if (error || !data)
                return [];
            return data;
        }
        catch {
            return [];
        }
    }
    /** PHASE_4C877 — Full schedule rows for hub hydration (matches segment engine SELECT). */
    async loadTrainScheduleFull(trainNo) {
        if (!this.isConfigured())
            return [];
        try {
            const { data, error } = await supabase_1.supabase
                .from('train_schedule')
                .select('Station_Code, SN, Station_Name, Arrival_time, Departure_Time')
                .eq('Train_No', trainNo)
                .order('SN', { ascending: true });
            if (error || !data)
                return [];
            return data;
        }
        catch {
            return [];
        }
    }
}
exports.KnowledgeRepository = KnowledgeRepository;
exports.knowledgeRepository = new KnowledgeRepository();
