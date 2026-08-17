import fs from 'fs';
import path from 'path';
import { supabase, isSupabaseConfigured } from '../config/supabase';
import { winstonLogger } from '../middleware/logger';
import { learningService } from './learningService';
import { selfLearningService } from './selfLearningService';
import { trainReliabilityService } from './trainReliabilityService';
import { userFeedbackIntelligenceService } from './userFeedbackIntelligenceService';

export type CanonicalLearningState = 'COLLECTING' | 'LEARNING' | 'VERIFIED' | 'ACTIVE' | 'REJECTED' | 'QUARANTINED';
export type ConfidenceLevel = 'HIGH' | 'MEDIUM' | 'LOW' | 'UNTRUSTED';

export interface SubsystemLearningCard {
  id: string;
  name: string;
  category: string;
  status: 'ONLINE' | 'CALIBRATING' | 'OFFLINE';
  learningState: CanonicalLearningState;
  sampleCount: number;
  confidence: ConfidenceLevel;
  confidenceScore: number; // 0 - 100
  freshness: string;
  isProductionActive: boolean;
  consumedBy: string[];
  impactType: string;
  lastUpdated: string;
  description: string;
  lowSampleWarning: boolean;
}

export interface WhatWeLearnedHighlight {
  id: string;
  subsystem: string;
  title: string;
  keyMetric: string;
  summary: string;
  observations: number;
  confidence: ConfidenceLevel;
  productionConsumer: string;
  lastUpdated: string;
  evidence: Record<string, any>;
}

export interface RejectedSignalItem {
  id: string;
  subsystem: string;
  reason: 'LOW_SAMPLE' | 'VALIDATION_FAILURE' | 'PENDING_APPROVAL' | 'SPAM_FLAGGED' | 'STALE_DATA';
  description: string;
  source: string;
  timestamp: string;
  metadata?: Record<string, any>;
}

export interface LearningTimelineEvent {
  id: string;
  timestamp: string;
  subsystem: string;
  event: string;
  status: CanonicalLearningState;
  confidence: ConfidenceLevel;
  detail: string;
}

export interface IntelligenceHealthOverview {
  activeSystemsCount: number;
  totalSystemsCount: number;
  eventsCollectedTotal: number;
  samplesAvailableTotal: number;
  itemsLearnedTotal: number;
  itemsVerifiedTotal: number;
  itemsActiveTotal: number;
  itemsRejectedTotal: number;
  itemsQuarantinedTotal: number;
  lastLearningUpdate: string;
  overallHealth: 'HEALTHY' | 'CALIBRATING' | 'DEGRADED';
}

export interface LearningIntelligenceData {
  overview: IntelligenceHealthOverview;
  subsystems: SubsystemLearningCard[];
  highlights: WhatWeLearnedHighlight[];
  rejectedSignals: RejectedSignalItem[];
  timeline: LearningTimelineEvent[];
  dataQuality: {
    staleDataCount: number;
    sparseSampleCount: number;
    validationFailuresCount: number;
    diagnostics: string[];
  };
  glossary: Record<string, string>;
  generatedAt: string;
}

const DATA_DIR = path.join(__dirname, '../../data');
const MIN_SAMPLE_SIZE = 5;

export class LearningObservabilityService {
  private readFallbackLines(table: string): any[] {
    try {
      const file = path.join(DATA_DIR, `${table}_fallback.jsonl`);
      if (!fs.existsSync(file)) return [];
      const lines = fs.readFileSync(file, 'utf8').trim().split('\n').filter(Boolean);
      return lines.map(line => {
        try {
          return JSON.parse(line);
        } catch {
          return null;
        }
      }).filter(Boolean);
    } catch {
      return [];
    }
  }

  private readJsonFile<T>(filename: string): T[] {
    try {
      const file = path.join(DATA_DIR, filename);
      if (!fs.existsSync(file)) return [];
      const content = fs.readFileSync(file, 'utf8');
      return JSON.parse(content) || [];
    } catch {
      return [];
    }
  }

  private deriveConfidence(sampleSize: number, verifiedRatio: number = 1.0): { level: ConfidenceLevel; score: number } {
    if (sampleSize === 0) return { level: 'UNTRUSTED', score: 0 };
    if (sampleSize < MIN_SAMPLE_SIZE) return { level: 'UNTRUSTED', score: Math.round((sampleSize / MIN_SAMPLE_SIZE) * 30) };

    const baseScore = Math.min(100, Math.round(50 + (sampleSize / 50) * 30 + verifiedRatio * 20));
    if (baseScore >= 80) return { level: 'HIGH', score: baseScore };
    if (baseScore >= 50) return { level: 'MEDIUM', score: baseScore };
    return { level: 'LOW', score: baseScore };
  }

  public async getLearningIntelligence(): Promise<LearningIntelligenceData> {
    const now = new Date();
    const nowIso = now.toISOString();

    // 1. Gather raw counts & records across local fallback & Supabase
    const searchFallbacks = this.readFallbackLines('search_history');
    const splitFallbacks = this.readFallbackLines('split_learning');
    const pnrFallbacks = this.readFallbackLines('pnr_learning');
    const liveFallbacks = this.readFallbackLines('live_learning');

    const missingQueries = this.readJsonFile<any>('missing_queries.json');
    const missingRoutes = this.readJsonFile<any>('missing_routes.json');
    const missingStations = this.readJsonFile<any>('missing_stations.json');
    const routeMemory = this.readJsonFile<any>('route_memory.json');
    const stationAliases = this.readJsonFile<any>('station_aliases.json');

    let dbSearchCount = searchFallbacks.length;
    let dbSplitCount = splitFallbacks.length;
    let dbPnrCount = pnrFallbacks.length;
    let dbLiveCount = liveFallbacks.length;
    let dbFeedbackCount = 0;

    let liveRows: any[] = [...liveFallbacks];
    let pnrRows: any[] = [...pnrFallbacks];
    let splitRows: any[] = [...splitFallbacks];
    let feedbackRows: any[] = [];

    if (isSupabaseConfigured()) {
      try {
        const results = await Promise.allSettled([
          supabase.from('search_history').select('*', { count: 'exact', head: true }),
          supabase.from('split_learning').select('*', { count: 'exact', head: true }),
          supabase.from('pnr_learning').select('*', { count: 'exact', head: true }),
          supabase.from('live_learning').select('*', { count: 'exact', head: true }),
          supabase.from('user_feedback').select('*', { count: 'exact', head: true })
        ]);

        if (results[0].status === 'fulfilled' && results[0].value.count !== null && results[0].value.count > 0) {
          dbSearchCount = Math.max(dbSearchCount, results[0].value.count);
        }
        if (results[1].status === 'fulfilled' && results[1].value.count !== null && results[1].value.count > 0) {
          dbSplitCount = Math.max(dbSplitCount, results[1].value.count);
        }
        if (results[2].status === 'fulfilled' && results[2].value.count !== null && results[2].value.count > 0) {
          dbPnrCount = Math.max(dbPnrCount, results[2].value.count);
        }
        if (results[3].status === 'fulfilled' && results[3].value.count !== null && results[3].value.count > 0) {
          dbLiveCount = Math.max(dbLiveCount, results[3].value.count);
        }
        if (results[4].status === 'fulfilled' && results[4].value.count !== null && results[4].value.count > 0) {
          dbFeedbackCount = results[4].value.count;
        }

        // Fetch recent sample slices for "What Did We Learn" with independent settlements
        const sliceResults = await Promise.allSettled([
          supabase.from('live_learning').select('*').order('created_at', { ascending: false }).limit(25),
          supabase.from('pnr_learning').select('*').order('time_checked', { ascending: false }).limit(25),
          supabase.from('split_learning').select('*').order('created_at', { ascending: false }).limit(25),
          supabase.from('user_feedback').select('*').order('created_at', { ascending: false }).limit(25)
        ]);

        if (sliceResults[0].status === 'fulfilled' && sliceResults[0].value.data?.length) {
          liveRows = sliceResults[0].value.data;
        }
        if (sliceResults[1].status === 'fulfilled' && sliceResults[1].value.data?.length) {
          pnrRows = sliceResults[1].value.data;
        }
        if (sliceResults[2].status === 'fulfilled' && sliceResults[2].value.data?.length) {
          splitRows = sliceResults[2].value.data;
        }
        if (sliceResults[3].status === 'fulfilled' && sliceResults[3].value.data?.length) {
          feedbackRows = sliceResults[3].value.data;
        }
      } catch (err: any) {
        winstonLogger.warn(`[LEARNING_OBSERVATORY] Supabase query notice: ${err.message}`);
      }
    }

    const totalEvents = dbSearchCount + dbSplitCount + dbPnrCount + dbLiveCount + dbFeedbackCount + missingQueries.length;
    const samplesAvailable = dbSplitCount + dbPnrCount + dbLiveCount + dbFeedbackCount;

    // 2. Build Subsystem Cards
    const subsystems: SubsystemLearningCard[] = [];

    // Subsystem 1: Split Engine Learning
    {
      const sampleCount = dbSplitCount;
      const { level, score } = this.deriveConfidence(sampleCount);
      const isVerified = sampleCount >= MIN_SAMPLE_SIZE;
      const isProduction = true;
      const state: CanonicalLearningState = isProduction ? 'ACTIVE' : (isVerified ? 'VERIFIED' : (sampleCount > 0 ? 'COLLECTING' : 'LEARNING'));

      subsystems.push({
        id: 'SUB-SPLIT',
        name: 'Split Engine Learning',
        category: 'Route & Corridor Optimization',
        status: 'ONLINE',
        learningState: state,
        sampleCount,
        confidence: level,
        confidenceScore: score,
        freshness: splitRows[0]?._created_at || splitRows[0]?.created_at || nowIso,
        isProductionActive: isProduction,
        consumedBy: ['Split Journey Planner', 'Hub Success Modifier'],
        impactType: 'Ranks split transfer options by historical acceptance rate and buffer safety margin',
        lastUpdated: splitRows[0]?._created_at || splitRows[0]?.created_at || nowIso,
        description: 'Learns user hub selection patterns, transfer buffer margins, and split route success rates.',
        lowSampleWarning: sampleCount < MIN_SAMPLE_SIZE
      });
    }

    // Subsystem 2: Live Train Learning
    {
      const sampleCount = dbLiveCount;
      const { level, score } = this.deriveConfidence(sampleCount);
      const isVerified = sampleCount >= MIN_SAMPLE_SIZE;
      const isProduction = true;
      const state: CanonicalLearningState = isProduction ? 'ACTIVE' : (isVerified ? 'VERIFIED' : (sampleCount > 0 ? 'COLLECTING' : 'LEARNING'));

      subsystems.push({
        id: 'SUB-LIVE',
        name: 'Live Train Delay Intelligence',
        category: 'Telemetry & Punctuality',
        status: 'ONLINE',
        learningState: state,
        sampleCount,
        confidence: level,
        confidenceScore: score,
        freshness: liveRows[0]?._created_at || liveRows[0]?.created_at || nowIso,
        isProductionActive: isProduction,
        consumedBy: ['Live Tracking Service', 'Train Reliability Engine'],
        impactType: 'Computes rolling 30-day on-time percentage and average station delay profiles',
        lastUpdated: liveRows[0]?._created_at || liveRows[0]?.created_at || nowIso,
        description: 'Records real-time GPS telemetry to compute station-by-station delay variance and speed metrics.',
        lowSampleWarning: sampleCount < MIN_SAMPLE_SIZE
      });
    }

    // Subsystem 3: PNR Prediction Learning
    {
      const sampleCount = dbPnrCount;
      const { level, score } = this.deriveConfidence(sampleCount);
      const isVerified = sampleCount >= MIN_SAMPLE_SIZE;
      const isProduction = true;
      const state: CanonicalLearningState = isProduction ? 'ACTIVE' : (isVerified ? 'VERIFIED' : (sampleCount > 0 ? 'COLLECTING' : 'LEARNING'));

      subsystems.push({
        id: 'SUB-PNR',
        name: 'PNR Prediction & Outcome Learning',
        category: 'Machine Learning & Probabilities',
        status: 'ONLINE',
        learningState: state,
        sampleCount,
        confidence: level,
        confidenceScore: score,
        freshness: pnrRows[0]?._created_at || pnrRows[0]?.time_checked || nowIso,
        isProductionActive: isProduction,
        consumedBy: ['PNR Confirmation Probability Meter', 'Historical Transition Model'],
        impactType: 'Feeds confirmation probability estimates for waitlisted tickets based on chart outcomes',
        lastUpdated: pnrRows[0]?._created_at || pnrRows[0]?.time_checked || nowIso,
        description: 'Tracks waitlist status transitions to final chart preparation outcomes across train classes.',
        lowSampleWarning: sampleCount < MIN_SAMPLE_SIZE
      });
    }

    // Subsystem 4: User Feedback Intelligence
    {
      const sampleCount = dbFeedbackCount;
      const { level, score } = this.deriveConfidence(sampleCount);
      const isVerified = sampleCount >= MIN_SAMPLE_SIZE;
      const isProduction = true;
      const state: CanonicalLearningState = isProduction ? 'ACTIVE' : (isVerified ? 'VERIFIED' : (sampleCount > 0 ? 'COLLECTING' : 'LEARNING'));

      subsystems.push({
        id: 'SUB-FEEDBACK',
        name: 'User Feedback Intelligence',
        category: 'Sentiment & Experience Signals',
        status: 'ONLINE',
        learningState: state,
        sampleCount,
        confidence: level,
        confidenceScore: score,
        freshness: feedbackRows[0]?.created_at || nowIso,
        isProductionActive: isProduction,
        consumedBy: ['Train Reliability Score', 'Support Complaint Triage'],
        impactType: 'Applies net sentiment (+/- 15 pts) modifiers to train reliability ratings',
        lastUpdated: feedbackRows[0]?.created_at || nowIso,
        description: 'Ingests explicit passenger punctuality ratings and Twitter complaints into operational scores.',
        lowSampleWarning: sampleCount < MIN_SAMPLE_SIZE
      });
    }

    // Subsystem 5: Train Reliability Engine
    {
      const sampleCount = dbLiveCount + dbFeedbackCount;
      const { level, score } = this.deriveConfidence(sampleCount);
      const isVerified = sampleCount >= MIN_SAMPLE_SIZE;
      const isProduction = true;
      const state: CanonicalLearningState = isProduction ? 'ACTIVE' : (isVerified ? 'VERIFIED' : 'LEARNING');

      subsystems.push({
        id: 'SUB-RELIABILITY',
        name: 'Train Reliability Engine',
        category: 'Composite Dependability',
        status: 'ONLINE',
        learningState: state,
        sampleCount,
        confidence: level,
        confidenceScore: score,
        freshness: nowIso,
        isProductionActive: isProduction,
        consumedBy: ['Smart Ranking Engine', 'Train Search Result Badges'],
        impactType: 'Badges dependable trains (RELIABLE) and penalizes chronically delayed services in search',
        lastUpdated: nowIso,
        description: 'Combines multi-day live tracking delay curves and rider feedback into a deterministic 0-100 score.',
        lowSampleWarning: sampleCount < MIN_SAMPLE_SIZE
      });
    }

    // Subsystem 6: Smart Ranking Engine
    {
      const sampleCount = dbSearchCount + dbSplitCount;
      const { level, score } = this.deriveConfidence(sampleCount);
      const isVerified = sampleCount >= MIN_SAMPLE_SIZE;
      const isProduction = true;
      const state: CanonicalLearningState = isProduction ? 'ACTIVE' : (isVerified ? 'VERIFIED' : 'LEARNING');

      subsystems.push({
        id: 'SUB-RANKING',
        name: 'Smart Ranking Engine',
        category: 'Multi-Factor Decision Matrix',
        status: 'ONLINE',
        learningState: state,
        sampleCount,
        confidence: level,
        confidenceScore: score,
        freshness: nowIso,
        isProductionActive: isProduction,
        consumedBy: ['Train Results Search Page', 'Split Engine Optimizer'],
        impactType: 'Dynamically reorders search results weighting travel duration, cost, availability and reliability',
        lastUpdated: nowIso,
        description: 'Harmonizes fare, duration, confirmation odds, and reliability score into an optimal travel rank.',
        lowSampleWarning: sampleCount < MIN_SAMPLE_SIZE
      });
    }

    // Subsystem 7: Route & Station Self-Learning
    {
      const pendingCount = missingQueries.filter(q => q.status === 'pending').length + missingRoutes.filter(r => r.status === 'pending').length;
      const approvedCount = routeMemory.filter(r => r.is_active).length + stationAliases.filter(s => s.is_active).length;
      const sampleCount = missingQueries.length + missingRoutes.length + approvedCount;
      const { level, score } = this.deriveConfidence(sampleCount);
      const isProduction = approvedCount > 0;
      const state: CanonicalLearningState = pendingCount > 0 ? 'QUARANTINED' : (isProduction ? 'ACTIVE' : 'LEARNING');

      subsystems.push({
        id: 'SUB-SELF-LEARN',
        name: 'Route & Station Self-Learning',
        category: 'Corridor & Catalog Enrichment',
        status: 'ONLINE',
        learningState: state,
        sampleCount,
        confidence: level,
        confidenceScore: score,
        freshness: nowIso,
        isProductionActive: isProduction,
        consumedBy: ['Search Autocomplete', 'Route Resolver Engine'],
        impactType: 'Expands station alias dictionaries and corridor routing memory from user query gaps',
        lastUpdated: nowIso,
        description: 'Discovers unserved origin-destination pairs and station name variations for administrative review.',
        lowSampleWarning: sampleCount < MIN_SAMPLE_SIZE
      });
    }

    // 3. Generate "What Did We Learn?" Real Evidence Summaries
    const highlights: WhatWeLearnedHighlight[] = [];

    // Live delay summary if rows exist
    if (liveRows.length > 0) {
      const trainMap = new Map<string, number[]>();
      liveRows.forEach(r => {
        const tNo = r.train_no || r.trainNumber;
        if (tNo) {
          const delays = trainMap.get(tNo) || [];
          delays.push(Number(r.delay_mins || r.delayMinutes || 0));
          trainMap.set(tNo, delays);
        }
      });

      trainMap.forEach((delays, tNo) => {
        const avgDelay = Math.round(delays.reduce((a, b) => a + b, 0) / delays.length);
        const onTimeCount = delays.filter(d => d <= 15).length;
        const onTimeRate = Math.round((onTimeCount / delays.length) * 100);
        const conf = delays.length >= MIN_SAMPLE_SIZE ? 'HIGH' : 'LOW';

        highlights.push({
          id: `HL-LIVE-${tNo}`,
          subsystem: 'Live Train Delay Intelligence',
          title: `Train ${tNo} Delay Profile`,
          keyMetric: `${onTimeRate}% On-Time (${avgDelay}m avg delay)`,
          summary: `Recorded ${delays.length} live observations. Historical on-time rate is ${onTimeRate}% with an average station delay of ${avgDelay} minutes.`,
          observations: delays.length,
          confidence: conf,
          productionConsumer: 'Train Reliability & Smart Ranking',
          lastUpdated: nowIso,
          evidence: { trainNo: tNo, sampleSize: delays.length, avgDelayMins: avgDelay, onTimeRatePct: onTimeRate }
        });
      });
    }

    // PNR summary if rows exist
    if (pnrRows.length > 0) {
      const confirmedCount = pnrRows.filter(r => r.final_status === 'CNF' || r.finalStatus === 'CNF').length;
      const rate = Math.round((confirmedCount / pnrRows.length) * 100);
      highlights.push({
        id: 'HL-PNR-OUTCOMES',
        subsystem: 'PNR Prediction & Outcome Learning',
        title: 'Waitlist Confirmation Rates',
        keyMetric: `${rate}% Historical Confirmation`,
        summary: `Evaluated ${pnrRows.length} PNR chart preparation outcomes. ${confirmedCount} transitioned from waitlist to confirmed berth.`,
        observations: pnrRows.length,
        confidence: pnrRows.length >= MIN_SAMPLE_SIZE ? 'MEDIUM' : 'LOW',
        productionConsumer: 'PNR Probability Meter',
        lastUpdated: nowIso,
        evidence: { evaluatedSamples: pnrRows.length, confirmedCount, confirmationRatePct: rate }
      });
    }

    // Split summary if rows exist
    if (splitRows.length > 0) {
      const hubMap = new Map<string, { total: number; clicked: number }>();
      splitRows.forEach(r => {
        const hub = r.hub || 'Direct';
        const curr = hubMap.get(hub) || { total: 0, clicked: 0 };
        curr.total++;
        if (r.user_clicked) curr.clicked++;
        hubMap.set(hub, curr);
      });

      hubMap.forEach((val, hub) => {
        const clickRate = Math.round((val.clicked / val.total) * 100);
        highlights.push({
          id: `HL-SPLIT-${hub}`,
          subsystem: 'Split Engine Learning',
          title: `Split Corridor via ${hub}`,
          keyMetric: `${clickRate}% Rider Acceptance Rate`,
          summary: `Aggregated ${val.total} split recommendations through junction ${hub}. Rider acceptance rate is ${clickRate}%.`,
          observations: val.total,
          confidence: val.total >= MIN_SAMPLE_SIZE ? 'MEDIUM' : 'LOW',
          productionConsumer: 'Split Journey Engine',
          lastUpdated: nowIso,
          evidence: { hub, recommendations: val.total, accepted: val.clicked, acceptanceRatePct: clickRate }
        });
      });
    }

    // Route self-learning highlight
    if (routeMemory.length > 0 || stationAliases.length > 0) {
      highlights.push({
        id: 'HL-ROUTE-MEMORY',
        subsystem: 'Route & Station Self-Learning',
        title: 'Verified Route Memory & Station Aliases',
        keyMetric: `${routeMemory.length} Routes, ${stationAliases.length} Aliases Active`,
        summary: `Self-learning engine has verified ${routeMemory.length} corridor memories and ${stationAliases.length} station aliases in production search resolver.`,
        observations: routeMemory.length + stationAliases.length,
        confidence: 'HIGH',
        productionConsumer: 'Search Autocomplete & Route Resolver',
        lastUpdated: nowIso,
        evidence: { activeRoutes: routeMemory.length, activeAliases: stationAliases.length }
      });
    }

    // 4. Rejected & Quarantined Signals
    const rejectedSignals: RejectedSignalItem[] = [];

    // Filter low sample live records
    liveRows.forEach((r, idx) => {
      const delay = Number(r.delay_mins || r.delayMinutes || 0);
      if (delay < -60 || delay > 1440) {
        rejectedSignals.push({
          id: `REJ-LIVE-${idx}`,
          subsystem: 'Live Train Delay Intelligence',
          reason: 'VALIDATION_FAILURE',
          description: `Telemetry observation for train ${r.train_no || 'N/A'} rejected: delay (${delay}m) exceeds physiological bounds (-60m to +1440m).`,
          source: 'Live GPS Telemetry Ingest',
          timestamp: r.created_at || nowIso,
          metadata: { trainNo: r.train_no, rawDelay: delay }
        });
      }
    });

    // PNR records with sample < 5
    if (pnrRows.length > 0 && pnrRows.length < MIN_SAMPLE_SIZE) {
      rejectedSignals.push({
        id: 'REJ-PNR-SPARSE',
        subsystem: 'PNR Prediction & Outcome Learning',
        reason: 'LOW_SAMPLE',
        description: `PNR outcome cluster (${pnrRows.length} samples) held below statistical floor (< ${MIN_SAMPLE_SIZE} samples). Fallback calibrated heuristics active.`,
        source: 'PNR Learning Pipeline',
        timestamp: nowIso,
        metadata: { sampleCount: pnrRows.length, minFloor: MIN_SAMPLE_SIZE }
      });
    }

    // Quarantined missing queries / routes pending approval
    missingQueries.filter(q => q.status === 'pending').slice(0, 5).forEach((q, idx) => {
      rejectedSignals.push({
        id: `QUAR-QUERY-${idx}`,
        subsystem: 'Route & Station Self-Learning',
        reason: 'PENDING_APPROVAL',
        description: `Unserved search query '${q.source} → ${q.destination}' (searched ${q.count} times) quarantined pending human admin review.`,
        source: 'User Search Gap Logger',
        timestamp: q.created_at || nowIso,
        metadata: { source: q.source, destination: q.destination, searchCount: q.count }
      });
    });

    // 5. Build Chronological Learning Timeline
    const timeline: LearningTimelineEvent[] = [];

    liveRows.slice(0, 4).forEach((r, idx) => {
      timeline.push({
        id: `TL-LIVE-${idx}`,
        timestamp: r.created_at || nowIso,
        subsystem: 'Live Train Delay Intelligence',
        event: `Ingested live delay telemetry for Train ${r.train_no || 'N/A'}`,
        status: 'ACTIVE',
        confidence: 'HIGH',
        detail: `Station: ${r.station || 'EN_ROUTE'}, Delay: ${r.delay_mins || 0}m`
      });
    });

    pnrRows.slice(0, 3).forEach((r, idx) => {
      timeline.push({
        id: `TL-PNR-${idx}`,
        timestamp: r.time_checked || nowIso,
        subsystem: 'PNR Prediction & Outcome Learning',
        event: 'Recorded waitlist status transition outcome',
        status: 'VERIFIED',
        confidence: 'MEDIUM',
        detail: `Initial: ${r.initial_status || 'WL'} → Final: ${r.final_status || 'CNF'}`
      });
    });

    routeMemory.slice(0, 3).forEach((r, idx) => {
      timeline.push({
        id: `TL-ROUTE-${idx}`,
        timestamp: r.created_at || nowIso,
        subsystem: 'Route & Station Self-Learning',
        event: `Verified route memory for ${r.source} → ${r.destination}`,
        status: 'ACTIVE',
        confidence: 'HIGH',
        detail: `Via Hub: ${r.via_hub || 'Direct'}, Trains: ${r.train_nos?.join(', ') || 'N/A'}`
      });
    });

    timeline.sort((a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime());

    // 6. Overall Intelligence Health
    const itemsLearned = highlights.length;
    const itemsVerified = subsystems.filter(s => s.learningState === 'VERIFIED' || s.learningState === 'ACTIVE').length;
    const itemsActive = subsystems.filter(s => s.isProductionActive).length;
    const itemsRejected = rejectedSignals.filter(r => r.reason !== 'PENDING_APPROVAL').length;
    const itemsQuarantined = rejectedSignals.filter(r => r.reason === 'PENDING_APPROVAL').length;

    const overview: IntelligenceHealthOverview = {
      activeSystemsCount: subsystems.filter(s => s.status === 'ONLINE').length,
      totalSystemsCount: subsystems.length,
      eventsCollectedTotal: totalEvents,
      samplesAvailableTotal: samplesAvailable,
      itemsLearnedTotal: itemsLearned,
      itemsVerifiedTotal: itemsVerified,
      itemsActiveTotal: itemsActive,
      itemsRejectedTotal: itemsRejected,
      itemsQuarantinedTotal: itemsQuarantined,
      lastLearningUpdate: nowIso,
      overallHealth: totalEvents > 0 ? 'HEALTHY' : 'CALIBRATING'
    };

    // 7. Data Quality Diagnostics
    const sparseCount = subsystems.filter(s => s.lowSampleWarning).length;
    const diagnostics: string[] = [];
    if (sparseCount > 0) diagnostics.push(`${sparseCount} learning subsystem(s) operating below statistical sample floor (<${MIN_SAMPLE_SIZE} samples).`);
    if (itemsQuarantined > 0) diagnostics.push(`${itemsQuarantined} self-learning item(s) quarantined awaiting administrative review.`);
    if (diagnostics.length === 0) diagnostics.push('All statistical thresholds and data validation constraints optimal.');

    return {
      overview,
      subsystems,
      highlights,
      rejectedSignals,
      timeline,
      dataQuality: {
        staleDataCount: 0,
        sparseSampleCount: sparseCount,
        validationFailuresCount: itemsRejected,
        diagnostics
      },
      glossary: {
        'Samples': 'The total number of real-world historical observation events used to evaluate this pattern.',
        'Confidence': 'How strongly the available statistical evidence supports the learned model. Scale: HIGH, MEDIUM, LOW, UNTRUSTED.',
        'Learning State': 'Current lifecycle phase: COLLECTING (gathering data), LEARNING (evaluating), VERIFIED (validated), ACTIVE (serving in production), REJECTED (discarded), or QUARANTINED (pending admin review).',
        'Active in Production': 'Whether the learned weights and outcome statistics are actively influencing live search, PNR confirmation, or split ranking results.',
        'Rejected Signal': 'An observation discarded due to low sample count (< 5), outlier telemetry, or format validation failure.',
        'Quarantined Signal': 'A newly discovered route or station candidate placed on hold for human admin review before production activation.'
      },
      generatedAt: nowIso
    };
  }
}

export const learningObservabilityService = new LearningObservabilityService();
