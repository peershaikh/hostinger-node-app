import { supabase } from '../config/supabase';
import { winstonLogger } from '../middleware/logger';
import fs from 'fs';
import path from 'path';
import { rateService } from './rateService';

// Local fallback if Supabase tables don't exist yet
const DATA_DIR = path.join(__dirname, '../../data');
if (!fs.existsSync(DATA_DIR)) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
}

/**
 * Minimum number of confirmed outcome samples required before a learning aggregate
 * is trusted as a prediction signal. Records below this threshold are statistically
 * unreliable (a single confirmed PNR produces 100% success_rate) and are ignored,
 * falling back to the calibrated heuristic table in pnrController instead.
 */
const MIN_SAMPLE_SIZE = 5;

function saveLocalFallback(table: string, data: any) {
  try {
    const filePath = path.join(DATA_DIR, `${table}_fallback.jsonl`);
    const line = JSON.stringify({ ...data, _created_at: new Date().toISOString() }) + '\n';
    fs.appendFileSync(filePath, line, 'utf8');
  } catch (err) {
    winstonLogger.error(`[LEARNING_SERVICE] Local fallback save failed for ${table}`);
  }
}

export class LearningService {
  // ─── STEP 1: Search Learning ─────────────────────────────────────────────
  async logSearch(source: string, destination: string, date: string, deviceId: string, userId: string | null, resultsShown: number, timeTakenMs: number): Promise<void> {
    if ((global as any).SYSTEM_MODE === 'MODE_A') return;
    try {
      const payload = {
        source,
        destination,
        date,
        device_id: deviceId || 'anonymous',
        user_id: userId || null,
        search_count: 1,
        results_shown: resultsShown,
        time_taken_ms: timeTakenMs,
      };

      const { error } = await supabase.from('search_history').insert([payload]);
      
      if (error) {
        if (error.code === 'PGRST205' || error.code === '42P01') {
          saveLocalFallback('search_history', payload);
        } else {
          winstonLogger.error(`[SEARCH_LEARNING] DB error: ${error.message}`);
        }
      } else {
        winstonLogger.debug(`[SEARCH_LEARNING] Saved search ${source} -> ${destination}`);
      }

      // Log transaction cost dynamically (fail-safe)
      rateService.logTransaction('IRCTC', 'search', userId).catch(() => {});
    } catch (err: any) {
      winstonLogger.error(`[SEARCH_LEARNING] Error: ${err.message}`);
    }
  }

  // ─── STEP 2: Split Learning ─────────────────────────────────────────────
  async logSplitRecommendation(source: string, destination: string, hub: string, waitTimeMins: number, totalDurationMins: number, successProb: number): Promise<string | null> {
    if ((global as any).SYSTEM_MODE === 'MODE_A') return null;
    try {
      const payload = {
        source,
        destination,
        hub,
        wait_time_mins: waitTimeMins,
        total_duration_mins: totalDurationMins,
        success_probability: successProb,
        user_clicked: false,
        user_refreshed: false
      };

      // Log transaction cost dynamically (fail-safe)
      rateService.logTransaction('IRCTC', 'split', null).catch(() => {});

      const { data, error } = await supabase.from('split_learning').insert([payload]).select('id').single();
      
      if (error) {
        if (error.code === 'PGRST205' || error.code === '42P01') {
          saveLocalFallback('split_learning', payload);
          return 'fallback-id';
        }
        winstonLogger.error(`[SPLIT_LEARNING] DB error: ${error.message}`);
        return null;
      }
      return data?.id || null;
    } catch (err: any) {
      winstonLogger.error(`[SPLIT_LEARNING] Error: ${err.message}`);
      return null;
    }
  }

  async updateSplitInteraction(id: string, clicked: boolean, refreshed: boolean): Promise<void> {
    if ((global as any).SYSTEM_MODE === 'MODE_A') return;
    if (id === 'fallback-id' || !id) return;
    try {
      const { error } = await supabase.from('split_learning').update({
        user_clicked: clicked,
        user_refreshed: refreshed,
        updated_at: new Date().toISOString()
      }).eq('id', id);
      
      if (error && error.code !== 'PGRST205' && error.code !== '42P01') {
        winstonLogger.error(`[SPLIT_LEARNING] Update error: ${error.message}`);
      }
    } catch (err: any) {
      winstonLogger.error(`[SPLIT_LEARNING] Update error: ${err.message}`);
    }
  }

  // ─── STEP 3: PNR Learning ─────────────────────────────────────────────
  async logPnrCheck(pnr: string, initialStatus: string, finalStatus: string, chartPrepared: boolean): Promise<void> {
    if ((global as any).SYSTEM_MODE === 'MODE_A') return;
    try {
      const payload = {
        pnr,
        initial_status: initialStatus,
        final_status: finalStatus,
        chart_prepared: chartPrepared,
        time_checked: new Date().toISOString()
      };

      // Log transaction cost dynamically (fail-safe)
      rateService.logTransaction('IRCTC', 'pnr', null).catch(() => {});

      const { error } = await supabase.from('pnr_learning').insert([payload]);
      
      if (error) {
        if (error.code === 'PGRST205' || error.code === '42P01') {
          saveLocalFallback('pnr_learning', payload);
        } else {
          winstonLogger.error(`[PNR_LEARNING] DB error: ${error.message}`);
        }
      }
    } catch (err: any) {
      winstonLogger.error(`[PNR_LEARNING] Error: ${err.message}`);
    }
  }

  // ─── STEP 4: Live Train Learning ──────────────────────────────────────
  async logLiveTrain(trainNo: string, station: string, delayMins: number, speedKmh: number, actualArrival: string, actualDeparture: string, providerName?: string): Promise<void> {
    if ((global as any).SYSTEM_MODE === 'MODE_A') return;
    try {
      const payload = {
        train_no: trainNo,
        station,
        delay_mins: delayMins,
        speed_kmh: speedKmh,
        actual_arrival: actualArrival,
        actual_departure: actualDeparture
      };

      // Log transaction cost dynamically (fail-safe)
      const provider = (providerName || 'RAILRADAR').trim().toUpperCase();
      if (provider !== 'DATABASE_SCHEDULE') {
        rateService.logTransaction(provider, 'live', null).catch(() => {});
      }

      const { error } = await supabase.from('live_learning').insert([payload]);
      
      if (error) {
        if (error.code === 'PGRST205' || error.code === '42P01') {
          saveLocalFallback('live_learning', payload);
        } else {
          winstonLogger.error(`[LIVE_LEARNING] DB error: ${error.message}`);
        }
      }
    } catch (err: any) {
      winstonLogger.error(`[LIVE_LEARNING] Error: ${err.message}`);
    }
  }

  // ─── STEP 8: Cost Optimization ────────────────────────────────────────
  async trackApiUsage(endpoint: string): Promise<void> {
    if ((global as any).SYSTEM_MODE === 'MODE_A') return;
    try {
      // Use RPC if available, otherwise just use fallback
      const { error } = await supabase.rpc('increment_api_usage', { endpoint_name: endpoint });
      
      if (error) {
        // Fallback or ignore if table/rpc missing
        saveLocalFallback('api_metrics', { endpoint, timestamp: new Date().toISOString() });
      }
    } catch (err: any) {
      // Silent fail
    }
  }

  // ─── GET TRENDS (Admin) ──────────────────────────────────────────────
  async getDashboardAnalytics() {
    try {
      const { count: searches } = await supabase.from('search_history').select('*', { count: 'exact', head: true });
      const { count: splits } = await supabase.from('split_learning').select('*', { count: 'exact', head: true });
      const { count: pnrs } = await supabase.from('pnr_learning').select('*', { count: 'exact', head: true });
      const { count: lives } = await supabase.from('live_learning').select('*', { count: 'exact', head: true });
      const { data: apis } = await supabase.from('api_metrics').select('*');

      return {
        status: 'learning_engine_active',
        tracking: {
          search_events: searches || this.getLocalCount('search_history'),
          split_events: splits || this.getLocalCount('split_learning'),
          pnr_events: pnrs || this.getLocalCount('pnr_learning'),
          live_events: lives || this.getLocalCount('live_learning')
        },
        api_usage: apis || []
      };
    } catch (err) {
      return { status: 'learning_engine_fallback_only' };
    }
  }

  private getLocalCount(table: string): number {
    try {
      const file = path.join(DATA_DIR, `${table}_fallback.jsonl`);
      if (!fs.existsSync(file)) return 0;
      return fs.readFileSync(file, 'utf8').trim().split('\n').length;
    } catch (e) {
      return 0;
    }
  }

  // ─── STEP 6: Historical Prediction ──────────────────────────────────
  async getHistoricalConfirmationRate(initialStatus: string): Promise<number | null> {
    try {
      // E.g., 'TQWL-3'
      if (!initialStatus) return null;
      
      const { data, error } = await supabase
        .from('pnr_learning')
        .select('final_status')
        .eq('initial_status', initialStatus)
        .eq('chart_prepared', true);
        
      if (error || !data || data.length < 5) return null; // Need enough data points

      const confirmed = data.filter(r => r.final_status === 'CNF').length;
      return Math.round((confirmed / data.length) * 100);
    } catch (err) {
      return null;
    }
  }

  // ─── STEP 5: Smart Split Ranking ────────────────────────────────────
  async getHubSuccessModifier(hub: string): Promise<number> {
    try {
      const { data, error } = await supabase
        .from('split_learning')
        .select('user_clicked')
        .eq('hub', hub);
        
      if (error || !data || data.length === 0) return 0;

      const clicked = data.filter(r => r.user_clicked).length;
      const rate = clicked / data.length;
      
      // If hub has > 50% click rate, it's popular
      if (rate > 0.5) return 10;
      if (rate < 0.1) return -5;
      return 0;
    } catch (err) {
      return 0;
    }
  }

  // ─── STEP 9: PNR Self-Improving Learning Loop ────────────────────────
  async logPrediction(
    pnr: string,
    trainNumber: string,
    route: string,
    quota: string,
    travelClass: string,
    wlType: string,
    wlPosition: number,
    probability: number,
    modelVersion: string
  ): Promise<void> {
    if ((global as any).SYSTEM_MODE === 'MODE_A') return;
    try {
      const payload = {
        pnr,
        train_number: trainNumber,
        route,
        quota,
        class: travelClass,
        wl_type: wlType,
        wl_position: wlPosition,
        probability,
        model_version: modelVersion
      };

      const { error } = await supabase.from('pnr_predictions_log').insert([payload]);
      
      if (error) {
        if (error.code === 'PGRST205' || error.code === '42P01') {
          saveLocalFallback('pnr_predictions_log', payload);
        } else {
          winstonLogger.error(`[PNR_PREDICTION_LOG] DB error: ${error.message}`);
        }
      }
    } catch (err: any) {
      winstonLogger.error(`[PNR_PREDICTION_LOG] Error: ${err.message}`);
    }
  }

  /**
   * Returns a learning aggregate for the given entity type and value.
   * IMPORTANT: records with sample_size < MIN_SAMPLE_SIZE (currently 5) are treated as
   * statistically unreliable and discarded — this function returns null for them so the
   * caller falls back to the calibrated heuristic table in pnrController.
   * A single confirmed PNR produces success_rate=100 with sample_size=1, which would
   * otherwise contaminate the GPT prompt and cause wildly inflated predictions.
   */
  async getLearningAggregate(type: string, value: string): Promise<{ successRate: number; sampleSize: number } | null> {
    try {
      // 1. Try Supabase
      const { data, error } = await supabase
        .from('pnr_learning_aggregates')
        .select('success_rate, sample_size')
        .eq('entity_type', type)
        .eq('entity_value', value)
        .maybeSingle();
        
      if (!error && data) {
        const sampleSize = Number(data.sample_size) || 0;
        // ── Sample-size floor (4C301) ──────────────────────────────────────────
        // Reject sparse aggregates — they are not statistically meaningful.
        if (sampleSize < MIN_SAMPLE_SIZE) {
          winstonLogger.debug(`[LEARNING_AGGREGATE] Rejected ${type}=${value}: sample_size=${sampleSize} < MIN_SAMPLE_SIZE=${MIN_SAMPLE_SIZE}`);
          return null;
        }
        return {
          successRate: Number(data.success_rate),
          sampleSize
        };
      }
    } catch (err) {}
    
    // 2. Try local fallback file
    try {
      const localPath = path.join(DATA_DIR, 'pnr_learning_aggregates_fallback.json');
      if (fs.existsSync(localPath)) {
        const content = fs.readFileSync(localPath, 'utf8');
        const list = JSON.parse(content);
        const match = list.find((item: any) => item.entity_type === type && item.entity_value === value);
        if (match) {
          const sampleSize = Number(match.sample_size) || 0;
          // ── Sample-size floor (local fallback) ────────────────────────────
          if (sampleSize < MIN_SAMPLE_SIZE) {
            winstonLogger.debug(`[LEARNING_AGGREGATE] Rejected (local) ${type}=${value}: sample_size=${sampleSize} < MIN_SAMPLE_SIZE=${MIN_SAMPLE_SIZE}`);
            return null;
          }
          return {
            successRate: Number(match.success_rate),
            sampleSize
          };
        }
      }
    } catch (err) {}
    
    return null;
  }

  async getFeedbackDrift(): Promise<string> {
    try {
      let feedbacks: any[] = [];
      
      // Try Supabase
      try {
        const { data } = await supabase.from('pnr_prediction_feedback').select('*').limit(50);
        feedbacks = data || [];
      } catch (err) {}
      
      // Try local fallback
      const localPath = path.join(DATA_DIR, 'pnr_prediction_feedback_fallback.jsonl');
      if (fs.existsSync(localPath)) {
        const lines = fs.readFileSync(localPath, 'utf8').trim().split('\n');
        for (const line of lines) {
          if (line) {
            try { feedbacks.push(JSON.parse(line)); } catch(e){}
          }
        }
      }
      
      if (feedbacks.length === 0) {
        return "No recent feedback discrepancies reported.";
      }
      
      const thumbsUp = feedbacks.filter(f => f.user_feedback === true).length;
      const thumbsDown = feedbacks.filter(f => f.user_feedback === false).length;
      const total = thumbsUp + thumbsDown;
      const accuracy = total > 0 ? Math.round((thumbsUp / total) * 100) : 100;
      
      const tatkalFeedback = feedbacks.filter(f => f.current_status?.toUpperCase().includes('TQWL'));
      const tatkalThumbsDown = tatkalFeedback.filter(f => f.user_feedback === false).length;
      
      let trendStr = `Overall feedback accuracy: ${accuracy}% (${thumbsUp} thumbs up, ${thumbsDown} thumbs down).`;
      if (tatkalThumbsDown > 2) {
        trendStr += " WARNING: Users report Tatkal (TQWL) predictions are too optimistic.";
      }
      
      return trendStr;
    } catch (err) {
      return "No recent feedback discrepancies reported.";
    }
  }

  async aggregateLearning(): Promise<void> {
    try {
      winstonLogger.info('[LEARNING_AGGREGATION] Starting learning aggregation...');
      
      let logs: any[] = [];
      let outcomes: any[] = [];
      
      try {
        const { data: dbLogs } = await supabase.from('pnr_predictions_log').select('*');
        const { data: dbOutcomes } = await supabase.from('pnr_learning').select('*');
        logs = dbLogs || [];
        outcomes = dbOutcomes || [];
      } catch (err) {
        winstonLogger.warn('[LEARNING_AGGREGATION] Supabase fetch failed, trying local fallback files');
      }
      
      const logFallbackPath = path.join(DATA_DIR, 'pnr_predictions_log_fallback.jsonl');
      const learningFallbackPath = path.join(DATA_DIR, 'pnr_learning_fallback.jsonl');
      
      if (fs.existsSync(logFallbackPath)) {
        const lines = fs.readFileSync(logFallbackPath, 'utf8').trim().split('\n');
        for (const line of lines) {
          if (line) {
            try { logs.push(JSON.parse(line)); } catch(e){}
          }
        }
      }
      if (fs.existsSync(learningFallbackPath)) {
        const lines = fs.readFileSync(learningFallbackPath, 'utf8').trim().split('\n');
        for (const line of lines) {
          if (line) {
            try { outcomes.push(JSON.parse(line)); } catch(e){}
          }
        }
      }
      
      if (logs.length === 0) {
        winstonLogger.info('[LEARNING_AGGREGATION] No prediction logs found. Skipping aggregation.');
        return;
      }
      
      const pnrOutcomes = new Map<string, string>();
      for (const outcome of outcomes) {
        const isResolved = outcome.chart_prepared || outcome.final_status?.toUpperCase().includes('CNF') || outcome.final_status?.toUpperCase().includes('RAC');
        if (isResolved && outcome.pnr) {
          pnrOutcomes.set(outcome.pnr, outcome.final_status.toUpperCase());
        }
      }
      
      const aggregations = {
        route: new Map<string, { success: number, total: number }>(),
        train: new Map<string, { success: number, total: number }>(),
        quota: new Map<string, { success: number, total: number }>(),
        wl_type: new Map<string, { success: number, total: number }>()
      };
      
      for (const log of logs) {
        const outcome = pnrOutcomes.get(log.pnr);
        if (!outcome) continue;
        
        const isSuccess = outcome.includes('CNF') || outcome.includes('CONFIRMED') || outcome.includes('RAC');
        
        const addSample = (type: 'route' | 'train' | 'quota' | 'wl_type', value: string) => {
          if (!value) return;
          const map = aggregations[type];
          const curr = map.get(value) || { success: 0, total: 0 };
          curr.total++;
          if (isSuccess) curr.success++;
          map.set(value, curr);
        };
        
        addSample('route', log.route);
        addSample('train', log.train_number);
        addSample('quota', log.quota);
        addSample('wl_type', log.wl_type);
      }
      
      const entitiesToUpsert: any[] = [];
      
      const processMap = (type: 'route' | 'train' | 'quota' | 'wl_type') => {
        for (const [value, stats] of aggregations[type].entries()) {
          const successRate = Math.round((stats.success / stats.total) * 100);
          entitiesToUpsert.push({
            entity_type: type,
            entity_value: value,
            success_rate: successRate,
            sample_size: stats.total,
            updated_at: new Date().toISOString()
          });
        }
      };
      
      processMap('route');
      processMap('train');
      processMap('quota');
      processMap('wl_type');
      
      winstonLogger.info(`[LEARNING_AGGREGATION] Aggregated ${entitiesToUpsert.length} entities.`);
      
      let upsertCount = 0;
      if (entitiesToUpsert.length > 0) {
        try {
          const { error } = await supabase
            .from('pnr_learning_aggregates')
            .upsert(entitiesToUpsert, { onConflict: 'entity_type,entity_value' });
            
          if (!error) {
            upsertCount = entitiesToUpsert.length;
          }
        } catch (e) {}
      }
      
      try {
        const localPath = path.join(DATA_DIR, 'pnr_learning_aggregates_fallback.json');
        fs.writeFileSync(localPath, JSON.stringify(entitiesToUpsert, null, 2), 'utf8');
        winstonLogger.info(`[LEARNING_AGGREGATION] Saved aggregates to local fallback: ${localPath}`);
      } catch (err: any) {
        winstonLogger.error(`[LEARNING_AGGREGATION] Local fallback save failed: ${err.message}`);
      }
      
      winstonLogger.info(`[LEARNING_AGGREGATION] Successfully completed. Upserted ${upsertCount} records to Supabase.`);
    } catch (err: any) {
      winstonLogger.error(`[LEARNING_AGGREGATION] Critical Error: ${err.message}`);
    }
  }

  // ─── PHASE_4C871: Rescue Outcome Dual-Write ───────────────────────────────
  /**
   * Dual-write rescue telemetry to rescue_outcome_events when KNOWLEDGE_STATS or shadow ON.
   * Does not modify existing split_learning behaviour.
   */
  async logRescueOutcome(params: {
    eventType: 'SHOWN' | 'EXPANDED' | 'AVAIL_CHECK' | 'IRCTC_CLICK' | 'FEEDBACK';
    trainNo: string;
    source: string;
    destination: string;
    hubStation?: string;
    journeyDate?: string;
    classCode?: string;
    userId?: string | null;
    deviceId?: string;
  }): Promise<void> {
    if ((global as any).SYSTEM_MODE === 'MODE_A') return;
    try {
      const { knowledgeService } = require('./knowledgeService');
      await knowledgeService.recordRescueEvent(params.eventType, {
        trainNo: params.trainNo,
        source: params.source,
        destination: params.destination,
        hubStation: params.hubStation,
        journeyDate: params.journeyDate,
        classCode: params.classCode,
        userId: params.userId || undefined,
        deviceId: params.deviceId,
      });
    } catch (err: any) {
      winstonLogger.debug(`[RESCUE_OUTCOME_KNOWLEDGE] skipped: ${err.message}`);
    }
  }
}

export const learningService = new LearningService();
