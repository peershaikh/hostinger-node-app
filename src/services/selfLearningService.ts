import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import { supabase, isSupabaseConfigured } from '../config/supabase';
import { winstonLogger } from '../middleware/logger';
import { gptRouteEnrichmentService } from './gptRouteEnrichmentService';

export interface MissingQuery {
  id: string;
  source: string;
  destination: string;
  date?: string;
  user_id?: string | null;
  count: number;
  last_seen: string;
  gpt_suggestion?: any;
  status: 'pending' | 'approved' | 'rejected' | 'merged';
  created_at: string;
}

export interface MissingRoute {
  id: string;
  source: string;
  destination: string;
  user_id?: string | null;
  count: number;
  last_seen: string;
  status: 'pending' | 'approved' | 'rejected' | 'merged';
  created_at: string;
}

export interface MissingTrain {
  id: string;
  train_no: string;
  user_id?: string | null;
  count: number;
  last_seen: string;
  status: 'pending' | 'approved' | 'rejected' | 'merged';
  created_at: string;
}

export interface MissingStation {
  id: string;
  query: string;
  user_id?: string | null;
  count: number;
  last_seen: string;
  status: 'pending' | 'approved' | 'rejected' | 'merged';
  created_at: string;
}

export interface RouteMemory {
  id: string;
  source: string;
  destination: string;
  via_hub?: string;
  train_nos: string[];
  notes?: string;
  approved_by?: string;
  is_active: boolean;
  created_at: string;
}

export interface StationAlias {
  id: string;
  station_code: string;
  alias_name: string;
  approved_by?: string;
  is_active: boolean;
  created_at: string;
}

export interface TrainAlias {
  id: string;
  train_no: string;
  alias_name: string;
  approved_by?: string;
  is_active: boolean;
  created_at: string;
}

export interface VerifiedRoute {
  id: string;
  source: string;
  destination: string;
  is_direct: boolean;
  notes?: string;
  approved_by?: string;
  created_at: string;
}

const DATA_DIR = path.join(__dirname, '../../data');

export class SelfLearningService {
  private missingQueries: MissingQuery[] = [];
  private missingRoutes: MissingRoute[] = [];
  private missingTrains: MissingTrain[] = [];
  private missingStations: MissingStation[] = [];
  private routeMemory: RouteMemory[] = [];
  private stationAliases: StationAlias[] = [];
  private trainAliases: TrainAlias[] = [];
  private verifiedRoutes: VerifiedRoute[] = [];

  // 24h deduplication cache: key -> timestamp
  private dedupCache = new Map<string, number>();
  private readonly DEDUP_TTL_MS = 24 * 60 * 60 * 1000; // 24 hours

  constructor() {
    this.ensureDataDir();
    this.init();
  }

  private async init() {
    this.loadLocalData();
    await this.syncWithSupabase();
  }

  private ensureDataDir() {
    if (!fs.existsSync(DATA_DIR)) {
      fs.mkdirSync(DATA_DIR, { recursive: true });
    }
  }

  private getFilePath(filename: string): string {
    return path.join(DATA_DIR, filename);
  }

  private loadLocalData() {
    try {
      this.missingQueries = this.loadJsonFile('missing_queries.json', []);
      this.missingRoutes = this.loadJsonFile('missing_routes.json', []);
      this.missingTrains = this.loadJsonFile('missing_trains.json', []);
      this.missingStations = this.loadJsonFile('missing_stations.json', []);
      this.routeMemory = this.loadJsonFile('route_memory.json', []);
      this.stationAliases = this.loadJsonFile('station_aliases.json', []);
      this.trainAliases = this.loadJsonFile('train_aliases.json', []);
      this.verifiedRoutes = this.loadJsonFile('verified_routes.json', []);
    } catch (e: any) {
      winstonLogger.warn(`[SELF_LEARNING] Failed to load local data: ${e.message}`);
    }
  }

  private loadJsonFile<T>(filename: string, defaultValue: T): T {
    const filePath = this.getFilePath(filename);
    if (fs.existsSync(filePath)) {
      try {
        const content = fs.readFileSync(filePath, 'utf8');
        return JSON.parse(content) as T;
      } catch (err) {
        winstonLogger.error(`[SELF_LEARNING] Error parsing local file ${filename}: ${err}`);
      }
    }
    return defaultValue;
  }

  private saveLocalData(filename: string, data: any) {
    try {
      const filePath = this.getFilePath(filename);
      fs.writeFileSync(filePath, JSON.stringify(data, null, 2), 'utf8');
    } catch (err: any) {
      winstonLogger.error(`[SELF_LEARNING] Failed to save local file ${filename}: ${err.message}`);
    }
  }

  private async syncWithSupabase() {
    if (!isSupabaseConfigured()) return;
    try {
      // 1. Sync Route Memory
      const { data: rmData, error: rmErr } = await supabase.from('route_memory').select('*');
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
      const { data: mqData, error: mqErr } = await supabase.from('missing_queries').select('*');
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
      const { data: mrData, error: mrErr } = await supabase.from('missing_routes').select('*');
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
      const { data: mtData, error: mtErr } = await supabase.from('missing_trains').select('*');
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
      const { data: msData, error: msErr } = await supabase.from('missing_stations').select('*');
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
      const { data: saData } = await supabase.from('station_aliases').select('*');
      if (saData) {
        this.stationAliases = saData;
        this.saveLocalData('station_aliases.json', this.stationAliases);
      }
      const { data: taData } = await supabase.from('train_aliases').select('*');
      if (taData) {
        this.trainAliases = taData;
        this.saveLocalData('train_aliases.json', this.trainAliases);
      }
      const { data: vrData } = await supabase.from('verified_routes').select('*');
      if (vrData) {
        this.verifiedRoutes = vrData;
        this.saveLocalData('verified_routes.json', this.verifiedRoutes);
      }
    } catch (e: any) {
      winstonLogger.warn(`[SELF_LEARNING] Failed to sync with Supabase: ${e.message}`);
    }
  }

  private isDuplicate(key: string): boolean {
    const lastTime = this.dedupCache.get(key);
    if (lastTime && (Date.now() - lastTime) < this.DEDUP_TTL_MS) {
      return true;
    }
    this.dedupCache.set(key, Date.now());
    return false;
  }

  // --- LOGGING METHODS ---

  public async logMissingQuery(source: string, destination: string, date: string, userId: string | null): Promise<void> {
    const key = `query:${source}:${destination}:${date}`;
    if (this.isDuplicate(key)) {
      winstonLogger.debug(`[SELF_LEARNING] Missing query duplicate suppressed: ${key}`);
      return;
    }

    const cleanSource = source.toUpperCase().trim();
    const cleanDestination = destination.toUpperCase().trim();

    // Look for existing pending query in local array
    let existing = this.missingQueries.find(q => q.source === cleanSource && q.destination === cleanDestination && q.status === 'pending');
    let dbId: string;

    if (existing) {
      existing.count += 1;
      existing.last_seen = new Date().toISOString();
      dbId = existing.id;
    } else {
      dbId = crypto.randomUUID();
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

    // Supabase Dual Write
    if (isSupabaseConfigured()) {
      try {
        const { data, error } = await supabase
          .from('missing_queries')
          .select('id, count')
          .eq('source', cleanSource)
          .eq('destination', cleanDestination)
          .eq('status', 'pending')
          .maybeSingle();

        if (!error && data) {
          await supabase
            .from('missing_queries')
            .update({ count: data.count + 1, last_seen: new Date().toISOString() })
            .eq('id', data.id);
          dbId = data.id;
        } else {
          await supabase
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
      } catch (err: any) {
        winstonLogger.warn(`[SELF_LEARNING] Supabase logMissingQuery error: ${err.message}`);
      }
    }

    // Trigger GPT enrichment worker asynchronously via setImmediate
    setImmediate(() => {
      gptRouteEnrichmentService.enrichMissingQuery(dbId, cleanSource, cleanDestination)
        .catch(err => winstonLogger.error(`[SELF_LEARNING] GPT enrichment failed for query ${dbId}: ${err.message}`));
    });
  }

  public async updateGptSuggestion(queryId: string, suggestion: any): Promise<void> {
    const existing = this.missingQueries.find(q => q.id === queryId);
    if (existing) {
      existing.gpt_suggestion = suggestion;
      this.saveLocalData('missing_queries.json', this.missingQueries);
    }

    if (isSupabaseConfigured()) {
      try {
        await supabase
          .from('missing_queries')
          .update({ gpt_suggestion: suggestion })
          .eq('id', queryId);
      } catch (err: any) {
        winstonLogger.warn(`[SELF_LEARNING] Supabase updateGptSuggestion failed: ${err.message}`);
      }
    }
  }

  public async logMissingRoute(source: string, destination: string, userId: string | null): Promise<void> {
    const key = `route:${source}:${destination}`;
    if (this.isDuplicate(key)) return;

    const cleanSource = source.toUpperCase().trim();
    const cleanDestination = destination.toUpperCase().trim();

    let existing = this.missingRoutes.find(r => r.source === cleanSource && r.destination === cleanDestination && r.status === 'pending');
    const dbId = existing ? existing.id : crypto.randomUUID();

    if (existing) {
      existing.count += 1;
      existing.last_seen = new Date().toISOString();
    } else {
      existing = {
        id: dbId,
        source: cleanSource,
        destination: cleanDestination,
        user_id: userId,
        count: 1,
        last_seen: new Date().toISOString(),
        status: 'pending',
        created_at: new Date().toISOString()
      };
      this.missingRoutes.push(existing);
    }
    this.saveLocalData('missing_routes.json', this.missingRoutes);

    if (isSupabaseConfigured()) {
      try {
        const { data, error } = await supabase
          .from('missing_routes')
          .select('id, count')
          .eq('source', cleanSource)
          .eq('destination', cleanDestination)
          .eq('status', 'pending')
          .maybeSingle();

        if (!error && data) {
          await supabase
            .from('missing_routes')
            .update({ count: data.count + 1, last_seen: new Date().toISOString() })
            .eq('id', data.id);
        } else {
          await supabase
            .from('missing_routes')
            .insert({
              id: dbId,
              source: cleanSource,
              destination: cleanDestination,
              user_id: userId,
              count: 1,
              status: 'pending',
              last_seen: new Date().toISOString()
            });
        }
      } catch (err: any) {
        winstonLogger.warn(`[SELF_LEARNING] Supabase logMissingRoute error: ${err.message}`);
      }
    }
  }

  public async logMissingTrain(trainNo: string, userId: string | null): Promise<void> {
    const key = `train:${trainNo}`;
    if (this.isDuplicate(key)) return;

    const cleanTrainNo = trainNo.toUpperCase().trim();

    let existing = this.missingTrains.find(t => t.train_no === cleanTrainNo && t.status === 'pending');
    const dbId = existing ? existing.id : crypto.randomUUID();

    if (existing) {
      existing.count += 1;
      existing.last_seen = new Date().toISOString();
    } else {
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

    if (isSupabaseConfigured()) {
      try {
        const { data, error } = await supabase
          .from('missing_trains')
          .select('id, count')
          .eq('train_no', cleanTrainNo)
          .eq('status', 'pending')
          .maybeSingle();

        if (!error && data) {
          await supabase
            .from('missing_trains')
            .update({ count: data.count + 1, last_seen: new Date().toISOString() })
            .eq('id', data.id);
        } else {
          await supabase
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
      } catch (err: any) {
        winstonLogger.warn(`[SELF_LEARNING] Supabase logMissingTrain error: ${err.message}`);
      }
    }
  }

  public async logMissingStation(query: string, userId: string | null): Promise<void> {
    const key = `station:${query}`;
    if (this.isDuplicate(key)) return;

    const cleanQuery = query.trim();

    let existing = this.missingStations.find(s => s.query.toLowerCase() === cleanQuery.toLowerCase() && s.status === 'pending');
    const dbId = existing ? existing.id : crypto.randomUUID();

    if (existing) {
      existing.count += 1;
      existing.last_seen = new Date().toISOString();
    } else {
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

    if (isSupabaseConfigured()) {
      try {
        const { data, error } = await supabase
          .from('missing_stations')
          .select('id, count')
          .eq('query', cleanQuery)
          .eq('status', 'pending')
          .maybeSingle();

        if (!error && data) {
          await supabase
            .from('missing_stations')
            .update({ count: data.count + 1, last_seen: new Date().toISOString() })
            .eq('id', data.id);
        } else {
          await supabase
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
      } catch (err: any) {
        winstonLogger.warn(`[SELF_LEARNING] Supabase logMissingStation error: ${err.message}`);
      }
    }
  }

  public async logPnrFailure(pnrNo: string, userId: string | null): Promise<void> {
    const key = `pnr_fail:${pnrNo}`;
    if (this.isDuplicate(key)) return;

    const cleanPnr = pnrNo.trim();
    const timestamp = new Date().toISOString();

    // Local JSONL fallback
    try {
      const pnrFailuresFile = this.getFilePath('pnr_failures.jsonl');
      const logEntry = JSON.stringify({ pnr: cleanPnr, user_id: userId, timestamp }) + '\n';
      fs.appendFileSync(pnrFailuresFile, logEntry, 'utf8');
      winstonLogger.info(`[SELF_LEARNING] Logged failed PNR lookup: ${cleanPnr}`);
    } catch (err: any) {
      winstonLogger.warn(`[SELF_LEARNING] Failed to write PNR failure locally: ${err.message}`);
    }

    // Supabase Dual Write (Optional/Fail-safe)
    if (isSupabaseConfigured()) {
      try {
        await supabase
          .from('pnr_failures')
          .insert({
            pnr: cleanPnr,
            user_id: userId,
            timestamp
          });
      } catch (err: any) {
        winstonLogger.debug(`[SELF_LEARNING] Supabase logPnrFailure ignored (table may not exist): ${err.message}`);
      }
    }
  }

  // --- ROUTE MEMORY METHODS ---

  public async getRouteMemory(source: string, destination: string): Promise<RouteMemory[]> {
    const cleanSource = source.toUpperCase().trim();
    const cleanDestination = destination.toUpperCase().trim();

    // Query in-memory/local fallback
    const localMatches = this.routeMemory.filter(
      r => r.source === cleanSource && r.destination === cleanDestination && r.is_active
    );

    if (isSupabaseConfigured()) {
      try {
        const { data, error } = await supabase
          .from('route_memory')
          .select('*')
          .eq('source', cleanSource)
          .eq('destination', cleanDestination)
          .eq('is_active', true);

        if (!error && data) {
          return data;
        }
      } catch (err: any) {
        winstonLogger.warn(`[SELF_LEARNING] Supabase getRouteMemory failed: ${err.message}`);
      }
    }

    return localMatches;
  }

  public async addRouteMemory(routeData: Omit<RouteMemory, 'id' | 'created_at'>): Promise<RouteMemory> {
    const newRoute: RouteMemory = {
      id: crypto.randomUUID(),
      ...routeData,
      source: routeData.source.toUpperCase().trim(),
      destination: routeData.destination.toUpperCase().trim(),
      created_at: new Date().toISOString()
    };

    this.routeMemory.push(newRoute);
    this.saveLocalData('route_memory.json', this.routeMemory);

    if (isSupabaseConfigured()) {
      try {
        await supabase
          .from('route_memory')
          .insert(newRoute);
      } catch (err: any) {
        winstonLogger.warn(`[SELF_LEARNING] Supabase addRouteMemory failed: ${err.message}`);
      }
    }

    return newRoute;
  }

  // --- ADMIN PANEL HANDLERS ---

  public getLocalDataForTable(table: string): any[] {
    switch (table) {
      case 'missing_queries': return this.missingQueries;
      case 'missing_routes': return this.missingRoutes;
      case 'missing_trains': return this.missingTrains;
      case 'missing_stations': return this.missingStations;
      case 'route_memory': return this.routeMemory;
      case 'station_aliases': return this.stationAliases;
      case 'train_aliases': return this.trainAliases;
      case 'verified_routes': return this.verifiedRoutes;
      default: return [];
    }
  }

  public async approveRecord(table: string, id: string, approvedBy: string): Promise<boolean> {
    winstonLogger.info(`[SELF_LEARNING] Approving record from ${table} ID: ${id}`);
    
    // Find record in local lists and update status
    let queryRecord: MissingQuery | undefined;
    let routeRecord: MissingRoute | undefined;
    let trainRecord: MissingTrain | undefined;
    let stationRecord: MissingStation | undefined;

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
    } else if (table === 'missing_routes') {
      routeRecord = this.missingRoutes.find(r => r.id === id);
      if (routeRecord) {
        routeRecord.status = 'approved';
        this.saveLocalData('missing_routes.json', this.missingRoutes);
      }
    } else if (table === 'missing_trains') {
      trainRecord = this.missingTrains.find(t => t.id === id);
      if (trainRecord) {
        trainRecord.status = 'approved';
        this.saveLocalData('missing_trains.json', this.missingTrains);
      }
    } else if (table === 'missing_stations') {
      stationRecord = this.missingStations.find(s => s.id === id);
      if (stationRecord) {
        stationRecord.status = 'approved';
        this.saveLocalData('missing_stations.json', this.missingStations);
      }
    }

    if (isSupabaseConfigured()) {
      try {
        await supabase.from(table).update({ status: 'approved' }).eq('id', id);
        
        // Also promote in DB if query and has GPT suggestion
        if (table === 'missing_queries' && queryRecord?.gpt_suggestion?.candidateRoute) {
          const sug = queryRecord.gpt_suggestion;
          await supabase.from('route_memory').insert({
            source: queryRecord.source,
            destination: queryRecord.destination,
            via_hub: sug.candidateHub || null,
            train_nos: sug.trainNos || [],
            notes: `GPT Suggestion approved: ${sug.reason || ''}`,
            approved_by: approvedBy,
            is_active: true
          });
        }
      } catch (err: any) {
        winstonLogger.warn(`[SELF_LEARNING] Supabase approveRecord failed: ${err.message}`);
      }
    }

    return true;
  }

  public async rejectRecord(table: string, id: string): Promise<boolean> {
    winstonLogger.info(`[SELF_LEARNING] Rejecting record from ${table} ID: ${id}`);
    
    if (table === 'missing_queries') {
      const rec = this.missingQueries.find(q => q.id === id);
      if (rec) {
        rec.status = 'rejected';
        this.saveLocalData('missing_queries.json', this.missingQueries);
      }
    } else if (table === 'missing_routes') {
      const rec = this.missingRoutes.find(r => r.id === id);
      if (rec) {
        rec.status = 'rejected';
        this.saveLocalData('missing_routes.json', this.missingRoutes);
      }
    } else if (table === 'missing_trains') {
      const rec = this.missingTrains.find(t => t.id === id);
      if (rec) {
        rec.status = 'rejected';
        this.saveLocalData('missing_trains.json', this.missingTrains);
      }
    } else if (table === 'missing_stations') {
      const rec = this.missingStations.find(s => s.id === id);
      if (rec) {
        rec.status = 'rejected';
        this.saveLocalData('missing_stations.json', this.missingStations);
      }
    }

    if (isSupabaseConfigured()) {
      try {
        await supabase.from(table).update({ status: 'rejected' }).eq('id', id);
      } catch (err: any) {
        winstonLogger.warn(`[SELF_LEARNING] Supabase rejectRecord failed: ${err.message}`);
      }
    }

    return true;
  }

  public async getAnalytics(): Promise<any> {
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

export const selfLearningService = new SelfLearningService();
