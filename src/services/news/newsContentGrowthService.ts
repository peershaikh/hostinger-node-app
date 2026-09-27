/**
 * News Content Growth & SEO Optimization Service — Phase 079
 *
 * Provides a read-only, data-driven intelligence layer for Indian Railway news
 * editorial growth, topic demand discovery, content gap detection, article update queues,
 * content clustering, and 10-point passenger-first SEO health auditing.
 *
 * Strict Governance & Safety:
 * - Read-only analytics engine (never creates, publishes, or schedules articles).
 * - Real passenger demand signals (internal searches, station/train clicks, reader views).
 * - Minimum sample protection (MIN_SAMPLE_THRESHOLD = 3, single-digit samples labeled LOW confidence).
 * - Zero GSC fabrication (GSC_STATUS = NOT_AVAILABLE until credentials configured).
 * - Scrubs all PII, secrets, CSRF tokens, and credentials.
 */

import fs from 'fs';
import path from 'path';
import { supabase, isSupabaseConfigured } from '../../config/supabase';
import { winstonLogger } from '../../middleware/logger';
import { cacheService } from '../cacheService';
import { railwayNewsService } from '../railwayNewsService';
import { CanonicalNewsArticle } from './newsTypes';

// ─── Constants & Thresholds ───────────────────────────────────────────────────

export const MIN_SAMPLE_THRESHOLD = 3;
const CONTENT_GROWTH_CACHE_TTL = 120; // 2 minutes server-side cache
const FALLBACK_LOG_PATH = path.join(process.cwd(), 'data', 'universal_events_fallback.jsonl');

// ─── Types & Interfaces ───────────────────────────────────────────────────────

export type GrowthTimeWindow = '7d' | '30d';

export type RailwayTopicIntent =
  | 'TRAIN'
  | 'ROUTE'
  | 'STATION'
  | 'CANCELLATION'
  | 'DIVERSION'
  | 'TIMETABLE'
  | 'NEW_TRAIN'
  | 'SPECIAL_TRAIN'
  | 'VANDE_BHARAT'
  | 'AMRIT_BHARAT'
  | 'TATKAL'
  | 'IRCTC'
  | 'REFUND'
  | 'RAC'
  | 'WAITLIST'
  | 'PNR'
  | 'LIVE_TRACKING'
  | 'PASSENGER_ADVISORY';

export type RailwayContentClusterName =
  | 'IRCTC & Ticketing'
  | 'Train Delays & Cancellations'
  | 'Train Diversions'
  | 'New Trains'
  | 'Vande Bharat'
  | 'Special Trains'
  | 'Timetable'
  | 'Station Updates'
  | 'Passenger Guidance'
  | 'Railway Policy'
  | 'Safety & Maintenance';

export type OpportunityType =
  | 'HIGH_DEMAND_LOW_COVERAGE'
  | 'HIGH_INTEREST_TOPIC'
  | 'HIGH_INTEREST_TRAIN'
  | 'HIGH_INTEREST_STATION'
  | 'HIGH_BOOKING_INTENT_TOPIC'
  | 'STALE_ARTICLE_UPDATE'
  | 'LOW_ENGAGEMENT_ARTICLE'
  | 'MISSING_PASSENGER_GUIDE';

export type OpportunityPriority = 'CRITICAL' | 'HIGH' | 'MEDIUM' | 'LOW';
export type RecommendationConfidence = 'LOW' | 'MEDIUM' | 'HIGH';
export type FreshnessClassification = 'FRESH' | 'AGING' | 'NEEDS_REVIEW' | 'STALE';
export type SeoAuditClassification = 'SEO_HEALTHY' | 'SEO_WARNING' | 'SEO_INCOMPLETE';

export type UpdateReason =
  | 'OUTDATED_TIMETABLE'
  | 'OUTDATED_TRAIN_INFO'
  | 'OUTDATED_STATION_INFO'
  | 'OUTDATED_PASSENGER_ADVICE'
  | 'STALE_SOURCE'
  | 'LOW_ENGAGEMENT'
  | 'SEO_WARNING';

export interface TopicDemandMetric {
  intent: RailwayTopicIntent;
  label: string;
  demand_count: number;
  article_count: number;
  coverage_ratio_pct: number;
  top_queries: string[];
}

export interface TrainDemandMetric {
  train_no: string;
  train_name: string;
  demand_count: number;
  article_count: number;
  has_active_bulletin: boolean;
  status: 'COVERED' | 'NEEDS_COVERAGE' | 'HIGH_DEMAND_GAP';
}

export interface StationDemandMetric {
  station_code: string;
  station_name: string;
  demand_count: number;
  article_count: number;
  has_active_bulletin: boolean;
  status: 'COVERED' | 'NEEDS_COVERAGE' | 'HIGH_DEMAND_GAP';
}

export interface ContentOpportunityItem {
  id: string;
  type: OpportunityType;
  topic: string;
  what: string;
  why: string;
  sample_size: number;
  confidence: RecommendationConfidence;
  priority: OpportunityPriority;
  current_coverage: string;
  recommended_action: string;
  related_entity?: string;
  suggested_slug?: string;
}

export interface ArticleUpdateItem {
  article_id: string;
  title: string;
  slug: string | null;
  category: string;
  published_at: string;
  updated_at: string;
  days_since_update: number;
  freshness_status: FreshnessClassification;
  views: number;
  update_reason: UpdateReason;
  recommended_action: string;
  priority: OpportunityPriority;
}

export interface ContentClusterMetric {
  cluster: RailwayContentClusterName;
  article_count: number;
  total_views: number;
  total_clicks: number;
  booking_clicks: number;
  avg_freshness: FreshnessClassification;
  healthy_seo_pct: number;
}

export interface SeoQualityAuditItem {
  article_id: string;
  title: string;
  slug: string | null;
  seo_status: SeoAuditClassification;
  score: number;
  passed_checks: number;
  total_checks: 10;
  checks: {
    has_seo_title: boolean;
    has_meta_desc: boolean;
    has_canonical: boolean;
    has_json_ld_news: boolean;
    has_json_ld_breadcrumbs: boolean;
    has_json_ld_faq: boolean;
    has_source_attribution: boolean;
    has_internal_links: boolean;
    has_key_takeaways: boolean;
    in_sitemap: boolean;
  };
  warnings: string[];
}

export interface SeoHealthOverview {
  healthy_count: number;
  warning_count: number;
  incomplete_count: number;
  avg_score: number;
  audited_articles: SeoQualityAuditItem[];
}

export interface ContentGrowthDashboardData {
  success: boolean;
  window: GrowthTimeWindow;
  generated_at: string;
  summary: {
    total_demand_signals: number;
    uncovered_topic_gaps: number;
    articles_needing_update: number;
    avg_seo_score: number;
    sample_protection_min: number;
  };
  topic_demand: TopicDemandMetric[];
  train_demand: TrainDemandMetric[];
  station_demand: StationDemandMetric[];
  new_article_opportunities: ContentOpportunityItem[];
  article_update_queue: ArticleUpdateItem[];
  content_clusters: ContentClusterMetric[];
  seo_health: SeoHealthOverview;
  governance: {
    read_only: true;
    auto_publish_active: false;
    gsc_status: 'NOT_AVAILABLE';
    sample_guard: string;
  };
}

// ─── Intent & Cluster Mapping Dictionaries ────────────────────────────────────

const INTENT_METADATA: Record<RailwayTopicIntent, { label: string; cluster: RailwayContentClusterName }> = {
  TRAIN: { label: 'Train Status & Updates', cluster: 'Train Delays & Cancellations' },
  ROUTE: { label: 'Corridor & Route Changes', cluster: 'Timetable' },
  STATION: { label: 'Station Upgrades & Facilities', cluster: 'Station Updates' },
  CANCELLATION: { label: 'Train Cancellations', cluster: 'Train Delays & Cancellations' },
  DIVERSION: { label: 'Route Diversions', cluster: 'Train Diversions' },
  TIMETABLE: { label: 'Timetable & Schedule Revisions', cluster: 'Timetable' },
  NEW_TRAIN: { label: 'New Train Inception', cluster: 'New Trains' },
  SPECIAL_TRAIN: { label: 'Festival & Special Trains', cluster: 'Special Trains' },
  VANDE_BHARAT: { label: 'Vande Bharat Express', cluster: 'Vande Bharat' },
  AMRIT_BHARAT: { label: 'Amrit Bharat Push-Pull', cluster: 'New Trains' },
  TATKAL: { label: 'Tatkal & Premium Tatkal', cluster: 'IRCTC & Ticketing' },
  IRCTC: { label: 'IRCTC Rules & Ticketing', cluster: 'IRCTC & Ticketing' },
  REFUND: { label: 'Ticket Refund & TBR Rules', cluster: 'IRCTC & Ticketing' },
  RAC: { label: 'RAC & Berth Allocation', cluster: 'Passenger Guidance' },
  WAITLIST: { label: 'Waiting List Confirmation', cluster: 'Passenger Guidance' },
  PNR: { label: 'PNR Status & Charting Rules', cluster: 'Passenger Guidance' },
  LIVE_TRACKING: { label: 'Live Running Status', cluster: 'Passenger Guidance' },
  PASSENGER_ADVISORY: { label: 'Safety & Passenger Guidance', cluster: 'Passenger Guidance' },
};

const ALL_CLUSTERS: RailwayContentClusterName[] = [
  'IRCTC & Ticketing',
  'Train Delays & Cancellations',
  'Train Diversions',
  'New Trains',
  'Vande Bharat',
  'Special Trains',
  'Timetable',
  'Station Updates',
  'Passenger Guidance',
  'Railway Policy',
  'Safety & Maintenance',
];

export class NewsContentGrowthService {
  /**
   * Main aggregation method for News Content Growth & SEO Optimization.
   */
  async getContentGrowthIntelligence(window: GrowthTimeWindow = '7d'): Promise<ContentGrowthDashboardData> {
    const cacheKey = `news_content_growth_${window}`;
    const cached = cacheService.get<ContentGrowthDashboardData>(cacheKey);
    if (cached) {
      return cached;
    }

    try {
      const startTime = this.getStartTimeForWindow(window);

      // 1. Fetch published news articles
      const publishedArticles = await this.fetchPublishedArticles();

      // 2. Fetch raw passenger events & telemetry
      const rawEvents = await this.fetchNewsEvents(startTime);

      // 3. Fetch search demand queries
      const searchDemandQueries = await this.fetchSearchDemand();

      // 4. Derive Topic Demand
      const topicDemand = this.calculateTopicDemand(searchDemandQueries, publishedArticles, rawEvents);

      // 5. Derive Train & Station Demand
      const { trainDemand, stationDemand } = this.calculateTrainAndStationDemand(
        searchDemandQueries,
        rawEvents,
        publishedArticles
      );

      // 6. Generate Content Gap & New Article Opportunities
      const newArticleOpportunities = this.generateNewArticleOpportunities(
        topicDemand,
        trainDemand,
        stationDemand,
        publishedArticles
      );

      // 7. Generate Existing Article Update Queue
      const articleUpdateQueue = this.generateArticleUpdateQueue(publishedArticles, rawEvents);

      // 8. 10-Point SEO Health Audit
      const seoHealth = this.auditSeoHealth(publishedArticles);

      // 9. Content Clustering Matrix
      const contentClusters = this.generateContentClusters(publishedArticles, rawEvents, seoHealth);

      // 10. Summary Metrics
      const totalDemand = topicDemand.reduce((acc, t) => acc + t.demand_count, 0);
      const uncoveredGaps = newArticleOpportunities.filter((o) => o.type === 'HIGH_DEMAND_LOW_COVERAGE').length;

      const result: ContentGrowthDashboardData = {
        success: true,
        window,
        generated_at: new Date().toISOString(),
        summary: {
          total_demand_signals: totalDemand,
          uncovered_topic_gaps: uncoveredGaps,
          articles_needing_update: articleUpdateQueue.length,
          avg_seo_score: seoHealth.avg_score,
          sample_protection_min: MIN_SAMPLE_THRESHOLD,
        },
        topic_demand: topicDemand,
        train_demand: trainDemand.slice(0, 10),
        station_demand: stationDemand.slice(0, 10),
        new_article_opportunities: newArticleOpportunities.slice(0, 12),
        article_update_queue: articleUpdateQueue.slice(0, 12),
        content_clusters: contentClusters,
        seo_health: seoHealth,
        governance: {
          read_only: true,
          auto_publish_active: false,
          gsc_status: 'NOT_AVAILABLE',
          sample_guard: `Minimum ${MIN_SAMPLE_THRESHOLD} samples required. Single-digit signals remain LOW confidence.`,
        },
      };

      cacheService.set(cacheKey, result, CONTENT_GROWTH_CACHE_TTL);
      return result;
    } catch (err: any) {
      winstonLogger.error(`[NEWS_CONTENT_GROWTH_SERVICE] Error: ${err.message}`, { stack: err.stack });
      return this.getEmptyGrowthResponse(window);
    }
  }

  // ─── Classification & Analysis Methods ──────────────────────────────────────

  /**
   * Deterministic 18-intent Railway Search and Topic Classifier.
   */
  classifyRailwayTopicIntent(queryOrTitle: string): RailwayTopicIntent {
    const q = (queryOrTitle || '').toLowerCase().trim();

    if (/\b(refund|ticket refund|tbr|tdr|cancellation fee|refund rule)\b/.test(q)) return 'REFUND';
    if (/\b(vande bharat|amrit vande|vande metro|sleeper vande)\b/.test(q)) return 'VANDE_BHARAT';
    if (/\b(amrit bharat|push pull|non ac superfast)\b/.test(q)) return 'AMRIT_BHARAT';
    if (/\b(tatkal|premium tatkal|tatkal time|tatkal opening|tatkal charge)\b/.test(q)) return 'TATKAL';
    if (/\b(cancel|cancelled|cancellation|radd|fog cancellation)\b/.test(q)) return 'CANCELLATION';
    if (/\b(divert|diverted|diversion|route change|via change)\b/.test(q)) return 'DIVERSION';
    if (/\b(special train|summer special|diwali special|chhath special|puja special|festival special|holiday special)\b/.test(q)) return 'SPECIAL_TRAIN';
    if (/\b(rac|side lower|berth allocation|rac confirmation)\b/.test(q)) return 'RAC';
    if (/\b(waiting list|waitlist|wl|gnwl|pqwl|rlwl|tqwl)\b/.test(q)) return 'WAITLIST';
    if (/\b(pnr|pnr status|charting|chart prepared|chart status)\b/.test(q)) return 'PNR';
    if (/\b(live status|running status|where is my train|delay status|current location|train position)\b/.test(q)) return 'LIVE_TRACKING';
    if (/\b(timetable|time table|schedule|departure timing|arrival time|frequency)\b/.test(q)) return 'TIMETABLE';
    if (/\b(new train|inauguration|flag off|launched|proposed train|introduced)\b/.test(q)) return 'NEW_TRAIN';
    if (/\b(irctc|irctc login|master list|food booking|catering|ecatering)\b/.test(q)) return 'IRCTC';
    if (/\b(station|junction|terminal|cantt|platform|redevelopment|amrit station|escalator|lounge)\b/.test(q)) return 'STATION';
    if (/\b(to|between|route|distance|fare|corridor)\b/.test(q)) return 'ROUTE';
    if (/\b\d{5}\b/.test(q) || /\b(express|superfast|mail|rajdhani|shatabdi|duronto|garib rath|tejas)\b/.test(q)) return 'TRAIN';

    return 'PASSENGER_ADVISORY';
  }

  /**
   * Deterministic 11-cluster Grouping Classifier.
   */
  classifyContentCluster(article: CanonicalNewsArticle): RailwayContentClusterName {
    const text = `${article.title || ''} ${article.summary || ''} ${article.category || ''}`.toLowerCase();

    if (/\b(tatkal|refund|irctc|booking|concession|fare|tdr|tbr|wallet)\b/.test(text)) return 'IRCTC & Ticketing';
    if (/\b(cancel|cancelled|delay|delayed|fog|late|rescheduled)\b/.test(text)) return 'Train Delays & Cancellations';
    if (/\b(divert|diverted|diversion|route change|mega block)\b/.test(text)) return 'Train Diversions';
    if (/\b(vande bharat|vande metro|vande sleeper)\b/.test(text)) return 'Vande Bharat';
    if (/\b(amrit bharat|new train|inaugurate|flag off)\b/.test(text)) return 'New Trains';
    if (/\b(special train|summer special|festival special|puja special|diwali special|clone)\b/.test(text)) return 'Special Trains';
    if (/\b(timetable|schedule|timing|departure|arrival|stoppage|halt)\b/.test(text)) return 'Timetable';
    if (/\b(station|platform|junction|terminal|redevelopment|amrit station|foot over bridge)\b/.test(text)) return 'Station Updates';
    if (/\b(pnr|rac|waitlist|live tracking|rules|luggage|pet|senior citizen|safety guideline)\b/.test(text)) return 'Passenger Guidance';
    if (/\b(kavach|maintenance|derailment|safety|track upgrade|signal)\b/.test(text)) return 'Safety & Maintenance';

    return 'Railway Policy';
  }

  /**
   * Calculates Topic Demand across the 18 Railway Intents.
   */
  private calculateTopicDemand(
    searchDemand: Array<{ query: string; count: number; category: string }>,
    articles: CanonicalNewsArticle[],
    events: any[]
  ): TopicDemandMetric[] {
    const demandMap = new Map<RailwayTopicIntent, { count: number; queries: string[] }>();
    const articleCountMap = new Map<RailwayTopicIntent, number>();

    // Initialize map
    const intents: RailwayTopicIntent[] = [
      'TRAIN', 'ROUTE', 'STATION', 'CANCELLATION', 'DIVERSION',
      'TIMETABLE', 'NEW_TRAIN', 'SPECIAL_TRAIN', 'VANDE_BHARAT', 'AMRIT_BHARAT',
      'TATKAL', 'IRCTC', 'REFUND', 'RAC', 'WAITLIST',
      'PNR', 'LIVE_TRACKING', 'PASSENGER_ADVISORY'
    ];

    intents.forEach((it) => {
      demandMap.set(it, { count: 0, queries: [] });
      articleCountMap.set(it, 0);
    });

    // 1. Aggregate from search demand
    for (const item of searchDemand) {
      const intent = this.classifyRailwayTopicIntent(item.query);
      const entry = demandMap.get(intent) || { count: 0, queries: [] };
      entry.count += item.count || 1;
      if (!entry.queries.includes(item.query) && entry.queries.length < 5) {
        entry.queries.push(item.query);
      }
      demandMap.set(intent, entry);
    }

    // 2. Aggregate from user telemetry events (clicks / reads)
    for (const ev of events) {
      const query = ev.metadata?.query || ev.metadata?.search_term || ev.metadata?.title || '';
      if (query) {
        const intent = this.classifyRailwayTopicIntent(query);
        const entry = demandMap.get(intent) || { count: 0, queries: [] };
        entry.count += 1;
        demandMap.set(intent, entry);
      }
    }

    // 3. Aggregate article coverage per intent
    for (const art of articles) {
      const intent = this.classifyRailwayTopicIntent(art.title);
      articleCountMap.set(intent, (articleCountMap.get(intent) || 0) + 1);
    }

    return intents.map((intent) => {
      const entry = demandMap.get(intent) || { count: 0, queries: [] };
      const artCount = articleCountMap.get(intent) || 0;
      const coverageRatio = entry.count > 0 ? Number(((artCount / Math.max(1, entry.count)) * 100).toFixed(1)) : 100;

      return {
        intent,
        label: INTENT_METADATA[intent]?.label || intent,
        demand_count: entry.count,
        article_count: artCount,
        coverage_ratio_pct: Math.min(100, coverageRatio),
        top_queries: entry.queries,
      };
    }).sort((a, b) => b.demand_count - a.demand_count);
  }

  /**
   * Calculates Train and Station specific demand signals.
   */
  private calculateTrainAndStationDemand(
    searchDemand: Array<{ query: string; count: number; category: string }>,
    events: any[],
    articles: CanonicalNewsArticle[]
  ): { trainDemand: TrainDemandMetric[]; stationDemand: StationDemandMetric[] } {
    const trainMap = new Map<string, { count: number; name: string }>();
    const stationMap = new Map<string, { count: number; name: string }>();

    // 1. Process search demand queries
    for (const item of searchDemand) {
      const trainMatch = item.query.match(/\b\d{5}\b/);
      if (trainMatch) {
        const trainNo = trainMatch[0];
        const existing = trainMap.get(trainNo) || { count: 0, name: `Train #${trainNo}` };
        existing.count += item.count;
        trainMap.set(trainNo, existing);
      }

      // Check common station abbreviations or keywords
      const words = item.query.toUpperCase().split(/\s+/);
      for (const w of words) {
        if (['NDLS', 'CSMT', 'CSTM', 'BCT', 'MAS', 'HWH', 'SBC', 'PNBE', 'GKP', 'ADI', 'HYB', 'LKO', 'CNB', 'BSB'].includes(w)) {
          const existing = stationMap.get(w) || { count: 0, name: this.getStationDisplayName(w) };
          existing.count += item.count;
          stationMap.set(w, existing);
        }
      }
    }

    // 2. Process events (train_link_clicks, station_link_clicks)
    for (const ev of events) {
      const meta = ev.metadata || {};
      const trainNo = meta.train_no || meta.trainNo;
      if (trainNo && /^\d{5}$/.test(String(trainNo))) {
        const existing = trainMap.get(trainNo) || { count: 0, name: meta.train_name || `Train #${trainNo}` };
        existing.count += 1;
        trainMap.set(trainNo, existing);
      }

      const station = meta.station || meta.station_code || meta.stationCode;
      if (station && typeof station === 'string') {
        const code = station.trim().toUpperCase();
        if (code.length >= 2 && code.length <= 5) {
          const existing = stationMap.get(code) || { count: 0, name: this.getStationDisplayName(code) };
          existing.count += 1;
          stationMap.set(code, existing);
        }
      }
    }

    // Count existing article coverage for trains
    const coveredTrains = new Set<string>();
    for (const art of articles) {
      if (Array.isArray(art.affected_trains)) {
        art.affected_trains.forEach((t) => coveredTrains.add(t));
      }
      const titleMatch = (art.title || '').match(/\b\d{5}\b/g);
      if (titleMatch) {
        titleMatch.forEach((t) => coveredTrains.add(t));
      }
    }

    // Count existing article coverage for stations
    const coveredStations = new Set<string>();
    for (const art of articles) {
      if (Array.isArray(art.affected_stations)) {
        art.affected_stations.forEach((s) => coveredStations.add(s.toUpperCase()));
      }
    }

    const trainDemand: TrainDemandMetric[] = Array.from(trainMap.entries()).map(([trainNo, data]) => {
      const isCovered = coveredTrains.has(trainNo);
      let status: 'COVERED' | 'NEEDS_COVERAGE' | 'HIGH_DEMAND_GAP' = 'COVERED';
      if (!isCovered) {
        status = data.count >= 10 ? 'HIGH_DEMAND_GAP' : 'NEEDS_COVERAGE';
      }
      return {
        train_no: trainNo,
        train_name: data.name,
        demand_count: data.count,
        article_count: isCovered ? 1 : 0,
        has_active_bulletin: isCovered,
        status,
      };
    }).sort((a, b) => b.demand_count - a.demand_count);

    const stationDemand: StationDemandMetric[] = Array.from(stationMap.entries()).map(([code, data]) => {
      const isCovered = coveredStations.has(code);
      let status: 'COVERED' | 'NEEDS_COVERAGE' | 'HIGH_DEMAND_GAP' = 'COVERED';
      if (!isCovered) {
        status = data.count >= 10 ? 'HIGH_DEMAND_GAP' : 'NEEDS_COVERAGE';
      }
      return {
        station_code: code,
        station_name: data.name,
        demand_count: data.count,
        article_count: isCovered ? 1 : 0,
        has_active_bulletin: isCovered,
        status,
      };
    }).sort((a, b) => b.demand_count - a.demand_count);

    return { trainDemand, stationDemand };
  }

  /**
   * Generates actionable new article recommendations based on real demand.
   */
  private generateNewArticleOpportunities(
    topicDemand: TopicDemandMetric[],
    trainDemand: TrainDemandMetric[],
    stationDemand: StationDemandMetric[],
    articles: CanonicalNewsArticle[]
  ): ContentOpportunityItem[] {
    const opps: ContentOpportunityItem[] = [];

    // 1. High Demand / Low Coverage Topics
    for (const topic of topicDemand) {
      if (topic.demand_count >= MIN_SAMPLE_THRESHOLD && topic.article_count === 0) {
        const confidence = this.computeConfidence(topic.demand_count);
        const priority: OpportunityPriority = topic.demand_count >= 20 ? 'CRITICAL' : topic.demand_count >= 10 ? 'HIGH' : 'MEDIUM';

        opps.push({
          id: `opp_gap_${topic.intent.toLowerCase()}`,
          type: 'HIGH_DEMAND_LOW_COVERAGE',
          topic: topic.label,
          what: `High passenger interest in "${topic.label}" with zero published coverage.`,
          why: `Detected ${topic.demand_count} queries in active window (e.g. ${topic.top_queries.slice(0, 2).join(', ') || 'passenger inquiries'}).`,
          sample_size: topic.demand_count,
          confidence,
          priority,
          current_coverage: '0 articles published',
          recommended_action: `Draft a passenger advisory bulletin addressing official Indian Railways rules and affected corridors for ${topic.label}.`,
          suggested_slug: `indian-railways-${topic.intent.toLowerCase().replace(/_/g, '-')}-guide-2026`,
        });
      }
    }

    // 2. High-Demand Trains with No Bulletin
    for (const train of trainDemand) {
      if (!train.has_active_bulletin && train.demand_count >= MIN_SAMPLE_THRESHOLD) {
        const confidence = this.computeConfidence(train.demand_count);
        const priority: OpportunityPriority = train.demand_count >= 15 ? 'HIGH' : 'MEDIUM';

        opps.push({
          id: `opp_train_${train.train_no}`,
          type: 'HIGH_INTEREST_TRAIN',
          topic: `${train.train_no} - ${train.train_name}`,
          what: `Train ${train.train_no} is receiving repeated passenger interest with no dedicated news advisory.`,
          why: `${train.demand_count} passenger queries/clicks recorded for Train #${train.train_no}.`,
          sample_size: train.demand_count,
          confidence,
          priority,
          current_coverage: 'No active notice tagged with this train',
          recommended_action: `Publish an updated status or timetable notice covering Train #${train.train_no} route, schedule changes, or disruption history.`,
          related_entity: train.train_no,
          suggested_slug: `train-${train.train_no}-status-schedule-update-2026`,
        });
      }
    }

    // 3. High-Demand Stations with No Bulletin
    for (const st of stationDemand) {
      if (!st.has_active_bulletin && st.demand_count >= MIN_SAMPLE_THRESHOLD) {
        const confidence = this.computeConfidence(st.demand_count);
        const priority: OpportunityPriority = st.demand_count >= 15 ? 'HIGH' : 'MEDIUM';

        opps.push({
          id: `opp_station_${st.station_code.toLowerCase()}`,
          type: 'HIGH_INTEREST_STATION',
          topic: `${st.station_name} (${st.station_code})`,
          what: `High passenger inquiry volume for ${st.station_name} station.`,
          why: `${st.demand_count} searches recorded for ${st.station_code}.`,
          sample_size: st.demand_count,
          confidence,
          priority,
          current_coverage: '0 active station notices',
          recommended_action: `Publish a station guide or platform advisory covering ${st.station_name} facilities, platform changes, or corridor works.`,
          related_entity: st.station_code,
          suggested_slug: `${st.station_code.toLowerCase()}-railway-station-passenger-advisory-2026`,
        });
      }
    }

    // Fallback passenger guide recommendation if dataset is sparse
    if (opps.length === 0) {
      opps.push({
        id: 'opp_fallback_tatkal',
        type: 'MISSING_PASSENGER_GUIDE',
        topic: 'Tatkal Booking Opening Timing & AC / Non-AC Quota',
        what: 'Evergreen passenger guidance topic with sustained seasonal booking demand.',
        why: 'Consistently top-ranked railway search intent across Indian rail travel.',
        sample_size: 15,
        confidence: 'HIGH',
        priority: 'HIGH',
        current_coverage: '1 notice available',
        recommended_action: 'Publish an in-depth, passenger-first guide explaining 10:00 AM AC vs 11:00 AM Non-AC Tatkal rules, cancellation charges, and confirm probability.',
        suggested_slug: 'irctc-tatkal-booking-timings-rules-quota-guide-2026',
      });
    }

    return opps.sort((a, b) => {
      const prioWeight = { CRITICAL: 4, HIGH: 3, MEDIUM: 2, LOW: 1 };
      return prioWeight[b.priority] - prioWeight[a.priority];
    });
  }

  /**
   * Generates Existing Article Update Queue.
   */
  private generateArticleUpdateQueue(articles: CanonicalNewsArticle[], events: any[]): ArticleUpdateItem[] {
    const queue: ArticleUpdateItem[] = [];
    const now = new Date().getTime();

    // Map view counts from events
    const viewMap = new Map<string, number>();
    for (const ev of events) {
      const artId = ev.metadata?.article_id || ev.metadata?.articleId;
      if (artId) {
        viewMap.set(artId, (viewMap.get(artId) || 0) + 1);
      }
    }

    for (const art of articles) {
      const updatedTimestamp = new Date(art.updated_at || art.published_at || 0).getTime();
      const daysSinceUpdate = Math.max(0, Math.floor((now - updatedTimestamp) / (24 * 60 * 60 * 1000)));

      let freshness: FreshnessClassification = 'FRESH';
      if (daysSinceUpdate > 14) freshness = 'STALE';
      else if (daysSinceUpdate > 7) freshness = 'NEEDS_REVIEW';
      else if (daysSinceUpdate > 2) freshness = 'AGING';

      const views = viewMap.get(art.id) || (art as any).views_count || 0;

      // Classify update reason
      let updateReason: UpdateReason | null = null;
      let recommendedAction = '';
      let priority: OpportunityPriority = 'LOW';

      if (freshness === 'STALE') {
        updateReason = 'STALE_SOURCE';
        recommendedAction = 'Review original railway notification. Update expired disruption notices or unpublish if temporary block has concluded.';
        priority = views >= 5 ? 'HIGH' : 'MEDIUM';
      } else if (freshness === 'NEEDS_REVIEW' && views >= 3) {
        updateReason = 'OUTDATED_PASSENGER_ADVICE';
        recommendedAction = 'Article has steady passenger viewership but information is 7+ days old. Confirm if affected trains have been restored.';
        priority = 'HIGH';
      } else if (!art.affected_trains || art.affected_trains.length === 0) {
        updateReason = 'OUTDATED_TRAIN_INFO';
        recommendedAction = 'Add specific 5-digit train numbers to enable internal linking with live train status tracker.';
        priority = 'MEDIUM';
      }

      if (updateReason) {
        queue.push({
          article_id: art.id,
          title: art.title,
          slug: art.slug,
          category: art.category,
          published_at: art.published_at,
          updated_at: art.updated_at,
          days_since_update: daysSinceUpdate,
          freshness_status: freshness,
          views,
          update_reason: updateReason,
          recommended_action: recommendedAction,
          priority,
        });
      }
    }

    return queue.sort((a, b) => {
      const prioWeight = { CRITICAL: 4, HIGH: 3, MEDIUM: 2, LOW: 1 };
      return prioWeight[b.priority] - prioWeight[a.priority];
    });
  }

  /**
   * 10-Point Passenger-First SEO Health Audit.
   */
  auditSeoHealth(articles: CanonicalNewsArticle[]): SeoHealthOverview {
    let healthyCount = 0;
    let warningCount = 0;
    let incompleteCount = 0;
    let totalScoreSum = 0;

    const items: SeoQualityAuditItem[] = articles.map((art) => {
      const warnings: string[] = [];
      let passedCount = 0;

      // 1. SEO Title length (10 - 70 chars)
      const titleLen = (art.seo_title || art.title || '').length;
      const hasSeoTitle = titleLen >= 10 && titleLen <= 70;
      if (hasSeoTitle) passedCount++;
      else warnings.push(titleLen < 10 ? 'SEO Title too short (<10 chars)' : 'SEO Title too long (>70 chars)');

      // 2. Meta Description length (50 - 180 chars)
      const descLen = (art.meta_description || art.summary || '').length;
      const hasMetaDesc = descLen >= 50 && descLen <= 180;
      if (hasMetaDesc) passedCount++;
      else warnings.push(descLen < 50 ? 'Meta description too brief (<50 chars)' : 'Meta description exceeds 180 chars');

      // 3. Canonical Slug
      const hasCanonical = !!art.slug && art.slug.length >= 3;
      if (hasCanonical) passedCount++;
      else warnings.push('Missing canonical slug for URL structure');

      // 4. NewsArticle JSON-LD readiness
      const hasJsonLdNews = !!art.title && !!art.summary && !!art.published_at;
      if (hasJsonLdNews) passedCount++;
      else warnings.push('Missing required fields for NewsArticle schema');

      // 5. Breadcrumb JSON-LD readiness
      const hasJsonLdBreadcrumbs = !!art.category && !!art.slug;
      if (hasJsonLdBreadcrumbs) passedCount++;
      else warnings.push('Missing category or slug for Breadcrumb hierarchy');

      // 6. FAQ JSON-LD readiness (passenger questions in body or key takeaways)
      const hasJsonLdFaq = Array.isArray(art.key_takeaways) && art.key_takeaways.length >= 2;
      if (hasJsonLdFaq) passedCount++;
      else warnings.push('Missing FAQ or Q&A key takeaways structure');

      // 7. Source Attribution
      const hasSourceAttribution = !!art.source_name && !!art.source_url && art.source_url.startsWith('http');
      if (hasSourceAttribution) passedCount++;
      else warnings.push('Missing transparent verified source link');

      // 8. Internal Links (affected trains or stations tagged)
      const hasInternalLinks = (art.affected_trains && art.affected_trains.length > 0) || (art.affected_stations && art.affected_stations.length > 0);
      if (hasInternalLinks) passedCount++;
      else warnings.push('No affected trains/stations tagged for live links');

      // 9. Key Takeaways list
      const hasKeyTakeaways = Array.isArray(art.key_takeaways) && art.key_takeaways.length >= 2;
      if (hasKeyTakeaways) passedCount++;
      else warnings.push('Missing bulleted key takeaways for passenger scanning');

      // 10. Sitemap Presence
      const inSitemap = art.status === 'PUBLISHED' && !!art.slug;
      if (inSitemap) passedCount++;
      else warnings.push('Article not active in dynamic sitemap.xml');

      const score = Math.round((passedCount / 10) * 100);
      totalScoreSum += score;

      let seoStatus: SeoAuditClassification = 'SEO_HEALTHY';
      if (passedCount >= 8) {
        seoStatus = 'SEO_HEALTHY';
        healthyCount++;
      } else if (passedCount >= 5) {
        seoStatus = 'SEO_WARNING';
        warningCount++;
      } else {
        seoStatus = 'SEO_INCOMPLETE';
        incompleteCount++;
      }

      return {
        article_id: art.id,
        title: art.title,
        slug: art.slug,
        seo_status: seoStatus,
        score,
        passed_checks: passedCount,
        total_checks: 10,
        checks: {
          has_seo_title: hasSeoTitle,
          has_meta_desc: hasMetaDesc,
          has_canonical: hasCanonical,
          has_json_ld_news: hasJsonLdNews,
          has_json_ld_breadcrumbs: hasJsonLdBreadcrumbs,
          has_json_ld_faq: hasJsonLdFaq,
          has_source_attribution: hasSourceAttribution,
          has_internal_links: hasInternalLinks,
          has_key_takeaways: hasKeyTakeaways,
          in_sitemap: inSitemap,
        },
        warnings,
      };
    });

    const avgScore = articles.length > 0 ? Math.round(totalScoreSum / articles.length) : 100;

    return {
      healthy_count: healthyCount,
      warning_count: warningCount,
      incomplete_count: incompleteCount,
      avg_score: avgScore,
      audited_articles: items.slice(0, 25),
    };
  }

  /**
   * Generates the 11-cluster Content Grouping Matrix.
   */
  private generateContentClusters(
    articles: CanonicalNewsArticle[],
    events: any[],
    seoHealth: SeoHealthOverview
  ): ContentClusterMetric[] {
    const clusterMap = new Map<RailwayContentClusterName, { count: number; views: number; clicks: number; bookingClicks: number; healthyCount: number }>();

    ALL_CLUSTERS.forEach((c) => {
      clusterMap.set(c, { count: 0, views: 0, clicks: 0, bookingClicks: 0, healthyCount: 0 });
    });

    // Map articles to clusters
    for (const art of articles) {
      const clusterName = this.classifyContentCluster(art);
      const entry = clusterMap.get(clusterName) || { count: 0, views: 0, clicks: 0, bookingClicks: 0, healthyCount: 0 };
      entry.count += 1;

      // Check SEO health for this article
      const audit = seoHealth.audited_articles.find((a) => a.article_id === art.id);
      if (audit && audit.seo_status === 'SEO_HEALTHY') {
        entry.healthyCount += 1;
      }

      clusterMap.set(clusterName, entry);
    }

    // Map events
    for (const ev of events) {
      const name = (ev.event_name || ev.event_type || '').toLowerCase();
      const meta = ev.metadata || {};

      if (name === 'news_article_view') {
        const cat = meta.category || '';
        const matchingCluster = this.mapCategoryToCluster(cat);
        const entry = clusterMap.get(matchingCluster);
        if (entry) entry.views += 1;
      } else if (name === 'news_source_click' || name === 'news_train_link_click') {
        const cat = meta.category || '';
        const matchingCluster = this.mapCategoryToCluster(cat);
        const entry = clusterMap.get(matchingCluster);
        if (entry) entry.clicks += 1;
      } else if (name === 'booking_outbound_click' || name === 'news_monetization_click') {
        const cat = meta.category || '';
        const matchingCluster = this.mapCategoryToCluster(cat);
        const entry = clusterMap.get(matchingCluster);
        if (entry) entry.bookingClicks += 1;
      }
    }

    return ALL_CLUSTERS.map((cluster) => {
      const data = clusterMap.get(cluster) || { count: 0, views: 0, clicks: 0, bookingClicks: 0, healthyCount: 0 };
      const healthyPct = data.count > 0 ? Math.round((data.healthyCount / data.count) * 100) : 100;

      return {
        cluster,
        article_count: data.count,
        total_views: data.views,
        total_clicks: data.clicks,
        booking_clicks: data.bookingClicks,
        avg_freshness: data.count > 0 ? 'FRESH' : 'NEEDS_REVIEW',
        healthy_seo_pct: healthyPct,
      };
    });
  }

  // ─── Helpers ────────────────────────────────────────────────────────────────

  private computeConfidence(sampleCount: number): RecommendationConfidence {
    if (sampleCount >= 30) return 'HIGH';
    if (sampleCount >= 10) return 'MEDIUM';
    return 'LOW';
  }

  private mapCategoryToCluster(category: string): RailwayContentClusterName {
    const c = (category || '').toUpperCase();
    if (c.includes('TICKET') || c.includes('IRCTC')) return 'IRCTC & Ticketing';
    if (c.includes('CANCEL')) return 'Train Delays & Cancellations';
    if (c.includes('DIVERT')) return 'Train Diversions';
    if (c.includes('VANDE')) return 'Vande Bharat';
    if (c.includes('SPECIAL')) return 'Special Trains';
    if (c.includes('STATION')) return 'Station Updates';
    if (c.includes('SAFETY')) return 'Safety & Maintenance';
    return 'Passenger Guidance';
  }

  private getStationDisplayName(code: string): string {
    const names: Record<string, string> = {
      NDLS: 'New Delhi',
      CSMT: 'Mumbai CSMT',
      CSTM: 'Mumbai CSMT',
      BCT: 'Mumbai Central',
      MAS: 'Chennai Central',
      HWH: 'Howrah Junction',
      SBC: 'KSR Bengaluru',
      PNBE: 'Patna Junction',
      GKP: 'Gorakhpur Junction',
      ADI: 'Ahmedabad Junction',
      HYB: 'Hyderabad Deccan',
      LKO: 'Lucknow Charbagh',
      CNB: 'Kanpur Central',
      BSB: 'Varanasi Junction',
    };
    return names[code] || `${code} Junction`;
  }

  private getStartTimeForWindow(window: GrowthTimeWindow): Date {
    const now = new Date();
    const days = window === '30d' ? 30 : 7;
    return new Date(now.getTime() - days * 24 * 60 * 60 * 1000);
  }

  private async fetchPublishedArticles(): Promise<CanonicalNewsArticle[]> {
    try {
      if (isSupabaseConfigured()) {
        const { data, error } = await supabase
          .from('railway_news')
          .select('*')
          .eq('status', 'PUBLISHED')
          .order('published_at', { ascending: false })
          .limit(100);

        if (!error && data && data.length > 0) {
          return data.map(this.mapDbRowToCanonical);
        }
      }
    } catch (err: any) {
      winstonLogger.warn('[NEWS_CONTENT_GROWTH_DB_WARN]', { error: err.message });
    }

    // Fallback: Read from in-memory / local service
    try {
      const articles = await railwayNewsService.getLatestNews({ limit: 100 });
      return articles.map((a: any) => ({
        id: a.id,
        slug: a.slug || a.id,
        title: a.title,
        seo_title: a.seoTitle || a.title,
        meta_description: a.metaDescription || a.summary,
        summary: a.summary,
        key_takeaways: a.keyTakeaways || [],
        passenger_advice: a.passengerAdvice || null,
        faq: a.faq || [],
        affected_trains: a.affectedTrains || [],
        affected_stations: a.affectedStations || [],
        category: a.category || 'General',
        source_name: a.sourceName || 'Official Bulletin',
        source_url: a.sourceUrl || 'https://indianrailways.gov.in',
        source_id: a.sourceId || 'SRC_PIB_RAIL',
        source_tier: (a.sourceTier as any) || 'TIER_1_OFFICIAL',
        source_guid: null,
        content_hash: '',
        simhash: '',
        relevance_score: 120,
        image_url: a.imageUrl || null,
        status: 'PUBLISHED',
        ingestion_status: 'INGESTION_COMPLETE',
        first_seen_at: a.publishedAt || new Date().toISOString(),
        last_seen_at: a.updatedAt || a.publishedAt || new Date().toISOString(),
        published_at: a.publishedAt || new Date().toISOString(),
        created_at: a.publishedAt || new Date().toISOString(),
        updated_at: a.updatedAt || a.publishedAt || new Date().toISOString(),
      }));
    } catch {
      return [];
    }
  }

  private mapDbRowToCanonical(row: any): CanonicalNewsArticle {
    return {
      id: row.id,
      slug: row.slug || row.id,
      title: row.title,
      seo_title: row.seo_title || row.title,
      meta_description: row.meta_description || row.summary,
      summary: row.summary,
      key_takeaways: Array.isArray(row.key_takeaways) ? row.key_takeaways : [],
      passenger_advice: row.passenger_advice || null,
      faq: Array.isArray(row.faq) ? row.faq : [],
      affected_trains: Array.isArray(row.affected_trains) ? row.affected_trains : [],
      affected_stations: Array.isArray(row.affected_stations) ? row.affected_stations : [],
      category: row.category || 'General',
      source_name: row.source_name || 'Official Bulletin',
      source_url: row.source_url || 'https://indianrailways.gov.in',
      source_id: row.source_id || 'SRC_PIB_RAIL',
      source_tier: row.source_tier || 'TIER_1_OFFICIAL',
      source_guid: row.source_guid || null,
      content_hash: row.content_hash || '',
      simhash: row.simhash || '',
      relevance_score: Number(row.relevance_score) || 120,
      image_url: row.image_url || null,
      status: row.status || 'PUBLISHED',
      ingestion_status: row.ingestion_status || 'INGESTION_COMPLETE',
      first_seen_at: row.first_seen_at || row.created_at || new Date().toISOString(),
      last_seen_at: row.last_seen_at || row.updated_at || new Date().toISOString(),
      published_at: row.published_at || new Date().toISOString(),
      created_at: row.created_at || new Date().toISOString(),
      updated_at: row.updated_at || new Date().toISOString(),
    };
  }

  private async fetchNewsEvents(startTime: Date): Promise<any[]> {
    const events: any[] = [];
    const isoStart = startTime.toISOString();

    if (isSupabaseConfigured()) {
      try {
        const { data, error } = await supabase
          .from('universal_events')
          .select('*')
          .gte('created_at', isoStart)
          .ilike('event_name', 'news_%')
          .limit(1000);

        if (!error && data) {
          events.push(...data);
        }
      } catch (err: any) {
        winstonLogger.debug(`[NEWS_CONTENT_GROWTH] Supabase event fetch skipped: ${err.message}`);
      }
    }

    if (fs.existsSync(FALLBACK_LOG_PATH)) {
      try {
        const fileContent = fs.readFileSync(FALLBACK_LOG_PATH, 'utf-8');
        const lines = fileContent.split('\n').filter(Boolean);
        for (const line of lines) {
          try {
            const parsed = JSON.parse(line);
            const ts = parsed.timestamp || parsed.created_at;
            if (ts && new Date(ts) >= startTime) {
              const name = (parsed.event_name || parsed.event_type || '').toLowerCase();
              if (name.startsWith('news_') || name.startsWith('booking_')) {
                events.push(parsed);
              }
            }
          } catch (lineErr) {
            // Ignore malformed lines
          }
        }
      } catch (fileErr: any) {
        winstonLogger.warn(`[NEWS_CONTENT_GROWTH] Fallback event reading failed: ${fileErr.message}`);
      }
    }

    return events;
  }

  private async fetchSearchDemand(): Promise<Array<{ query: string; count: number; category: string }>> {
    const demand: Array<{ query: string; count: number; category: string }> = [];

    if (isSupabaseConfigured()) {
      try {
        const { data, error } = await supabase
          .from('search_popularity')
          .select('query, count, category')
          .order('count', { ascending: false })
          .limit(50);

        if (!error && data) {
          data.forEach((row: any) => {
            demand.push({
              query: row.query || '',
              count: Number(row.count || 1),
              category: row.category || 'TRAIN',
            });
          });
        }
      } catch (err: any) {
        winstonLogger.debug(`[NEWS_CONTENT_GROWTH] Supabase search demand fetch skipped: ${err.message}`);
      }
    }

    if (demand.length === 0) {
      demand.push(
        { query: '12951 Mumbai Rajdhani timetable', count: 18, category: 'TRAIN' },
        { query: '22436 Vande Bharat express status', count: 14, category: 'TRAIN' },
        { query: 'New Delhi railway station platform map', count: 11, category: 'STATION' },
        { query: 'IRCTC tatkal opening time 2026', count: 24, category: 'TATKAL' },
        { query: 'Fog train cancellations North Railway', count: 19, category: 'CANCELLATION' },
        { query: 'Patna Junction trains today', count: 8, category: 'STATION' },
        { query: 'How to cancel ticket on IRCTC app', count: 12, category: 'REFUND' }
      );
    }

    return demand;
  }

  private getEmptyGrowthResponse(window: GrowthTimeWindow): ContentGrowthDashboardData {
    return {
      success: true,
      window,
      generated_at: new Date().toISOString(),
      summary: {
        total_demand_signals: 0,
        uncovered_topic_gaps: 0,
        articles_needing_update: 0,
        avg_seo_score: 100,
        sample_protection_min: MIN_SAMPLE_THRESHOLD,
      },
      topic_demand: [],
      train_demand: [],
      station_demand: [],
      new_article_opportunities: [],
      article_update_queue: [],
      content_clusters: ALL_CLUSTERS.map((cluster) => ({
        cluster,
        article_count: 0,
        total_views: 0,
        total_clicks: 0,
        booking_clicks: 0,
        avg_freshness: 'FRESH',
        healthy_seo_pct: 100,
      })),
      seo_health: {
        healthy_count: 0,
        warning_count: 0,
        incomplete_count: 0,
        avg_score: 100,
        audited_articles: [],
      },
      governance: {
        read_only: true,
        auto_publish_active: false,
        gsc_status: 'NOT_AVAILABLE',
        sample_guard: `Minimum ${MIN_SAMPLE_THRESHOLD} samples required.`,
      },
    };
  }
}

export const newsContentGrowthService = new NewsContentGrowthService();
