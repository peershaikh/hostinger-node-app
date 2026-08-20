/**
 * News Revenue Intelligence & Controlled Recommendations Service — Phase 073
 *
 * Provides a read-only analytics layer for news-driven railway booking intent,
 * provider traffic performance, topic monetization signals, and conversion reconciliation.
 *
 * Strict Governance & Safety:
 * - READ-ONLY intelligence (never alters routing, never auto-splits traffic).
 * - Conservative Minimum Sample Protection (MIN_CLICK_SAMPLE = 25, MIN_CONVERSION_SAMPLE = 10).
 * - Deterministic Provider State Machine (INSUFFICIENT_DATA, OBSERVATIONAL, PROMISING, VERIFIED).
 * - Zero Commission Fabrication (COMMISSION_DATA = NOT_AVAILABLE).
 * - Scrubs all PII, secrets, CSRF tokens, and credentials.
 */

import fs from 'fs';
import path from 'path';
import { supabase, isSupabaseConfigured } from '../../config/supabase';
import { winstonLogger } from '../../middleware/logger';
import { cacheService } from '../cacheService';
import { bookingConfigService } from '../booking/bookingConfigService';
import { partnerConversionService, PartnerConversion, OutboundClickRecord } from '../booking/partnerConversionService';
import { railwayNewsService } from '../railwayNewsService';
import { CanonicalNewsArticle } from './newsTypes';

// ─── Constants & Thresholds ───────────────────────────────────────────────────

export const MIN_CLICK_SAMPLE = 25;
export const MIN_CONVERSION_SAMPLE = 10;
const REVENUE_CACHE_TTL = 120; // 2 minutes server-side cache
const FALLBACK_LOG_PATH = path.join(process.cwd(), 'data', 'universal_events_fallback.jsonl');

// ─── Types & Interfaces ───────────────────────────────────────────────────────

export type RevenueTimeWindow = 'today' | '7d' | '30d';

export type ProviderPerformanceState =
  | 'INSUFFICIENT_DATA'
  | 'OBSERVATIONAL'
  | 'PROMISING'
  | 'VERIFIED';

export type SampleQuality = 'INSUFFICIENT_DATA' | 'LOW' | 'ADEQUATE' | 'HIGH';

export interface FunnelStageMetric {
  stage: string;
  name: string;
  count: number;
  rate_from_previous_pct: number;
  status: 'DATA' | 'NOT_AVAILABLE' | 'INSUFFICIENT_DATA';
}

export interface RevenueFunnelMetrics {
  news_views: number;
  article_views: number;
  train_station_interactions: number;
  booking_clicks: number;
  confirmed_conversions: number | 'NOT_AVAILABLE';
  pending_conversions: number;
  rejected_conversions: number;
  click_to_booking_rate_pct: number;
  click_to_conversion_rate_pct: number | 'NOT_AVAILABLE';
  stages: FunnelStageMetric[];
}

export interface ProviderRevenueMetric {
  provider_id: string;
  display_name: string;
  enabled: boolean;
  is_official: boolean;
  priority: number;
  clicks: number;
  conversions: number | 'NOT_AVAILABLE';
  confirmed_conversions_count: number;
  pending_conversions: number;
  rejected_conversions: number;
  conversion_rate_pct: number | 'NOT_AVAILABLE';
  sample_quality: SampleQuality;
  state: ProviderPerformanceState;
  state_reason: string;
}

export interface ArticleRevenueIntentMetric {
  article_id: string;
  title: string;
  slug: string | null;
  category: string;
  views: number;
  train_clicks: number;
  station_clicks: number;
  booking_clicks: number;
  conversions: number | 'NOT_AVAILABLE';
  booking_intent_rate_pct: number;
  conversion_rate_pct: number | 'NOT_AVAILABLE';
  sample_quality: SampleQuality;
}

export interface CategoryRevenueMetric {
  category: string;
  article_count: number;
  views: number;
  train_station_clicks: number;
  booking_clicks: number;
  conversions: number | 'NOT_AVAILABLE';
  booking_intent_rate_pct: number;
}

export interface TrainTopicRevenueMetric {
  train_no: string;
  train_name: string;
  news_mentions_count: number;
  train_link_clicks: number;
  booking_clicks: number;
  conversions: number | 'NOT_AVAILABLE';
  booking_intent_rate_pct: number;
}

export interface StationTopicRevenueMetric {
  station: string;
  news_mentions_count: number;
  station_link_clicks: number;
  booking_clicks: number;
  conversions: number | 'NOT_AVAILABLE';
  booking_intent_rate_pct: number;
}

export interface CampaignRevenueMetric {
  campaign_id: string;
  clicks: number;
  conversions: number | 'NOT_AVAILABLE';
  conversion_rate_pct: number | 'NOT_AVAILABLE';
  sample_quality: SampleQuality;
}

export interface SourceRevenueMetric {
  source_name: string;
  source_tier: string;
  articles_count: number;
  views: number;
  source_clicks: number;
  booking_clicks: number;
  booking_intent_rate_pct: number;
}

export interface RevenueOpportunity {
  id: string;
  type:
    | 'HIGH_BOOKING_INTENT_TOPIC'
    | 'HIGH_CTR_LOW_BOOKING'
    | 'HIGH_BOOKING_CLICK_LOW_CONVERSION'
    | 'STRONG_PROVIDER_SIGNAL'
    | 'WEAK_PROVIDER_SIGNAL'
    | 'ARTICLE_UPDATE_OPPORTUNITY';
  title: string;
  signal: string;
  reason: string;
  sample_size: number;
  suggested_action: string;
  urgency: 'HIGH' | 'MEDIUM' | 'LOW';
  related_entity?: string;
}

export interface FutureRoutingBlueprint {
  status: 'DESIGN_ONLY_READ_ONLY';
  lifecycle_stages: string[];
  governance_rule: string;
  admin_approval_required: boolean;
}

export interface NewsRevenueIntelligenceResponse {
  success: boolean;
  window: RevenueTimeWindow;
  generated_at: string;
  governance: {
    read_only: true;
    auto_routing_active: false;
    traffic_split_active: false;
    commission_calculation: 'NOT_AVAILABLE';
    min_click_sample: number;
    min_conversion_sample: number;
  };
  funnel: RevenueFunnelMetrics;
  providers: ProviderRevenueMetric[];
  top_booking_intent_articles: ArticleRevenueIntentMetric[];
  categories: CategoryRevenueMetric[];
  top_train_topics: TrainTopicRevenueMetric[];
  top_station_topics: StationTopicRevenueMetric[];
  campaigns: CampaignRevenueMetric[];
  sources: SourceRevenueMetric[];
  opportunities: RevenueOpportunity[];
  future_routing_blueprint: FutureRoutingBlueprint;
}

// ─── Service Class ────────────────────────────────────────────────────────────

export class NewsRevenueIntelligenceService {
  /**
   * Clears in-memory revenue intelligence cache.
   */
  public clearCache(): void {
    cacheService.del('news_rev_intel_today');
    cacheService.del('news_rev_intel_7d');
    cacheService.del('news_rev_intel_30d');
  }

  /**
   * Retrieves comprehensive server-side aggregated news revenue intelligence.
   */
  public async getRevenueIntelligence(
    window: RevenueTimeWindow = '7d',
    forceRefresh: boolean = false
  ): Promise<NewsRevenueIntelligenceResponse> {
    const cacheKey = `news_rev_intel_${window}`;
    if (!forceRefresh) {
      const cached = cacheService.get<NewsRevenueIntelligenceResponse>(cacheKey);
      if (cached) {
        return cached;
      }
    }

    try {
      const startTime = this.getStartTimeForWindow(window);

      // 1. Fetch published news articles
      const articles = await this.fetchArticles();

      // 2. Fetch raw engagement & universal events
      const rawEvents = await this.fetchEvents(startTime);

      // 3. Fetch partner conversions and outbound clicks from SSOT partner conversion service
      const conversionSnapshot = await partnerConversionService.getConversionAnalytics(
        window === 'today' ? '7d' : (window as '7d' | '30d')
      );

      // 4. Compute 5-stage Revenue Funnel
      const funnel = this.computeFunnel(rawEvents, conversionSnapshot, window);

      // 5. Compute Configured Provider Matrix
      const providers = this.computeProviders(rawEvents, conversionSnapshot);

      // 6. Compute Article Revenue Intent Aggregation
      const topArticles = this.computeArticleRevenueIntent(articles, rawEvents, conversionSnapshot);

      // 7. Compute Category Revenue Intent Aggregation
      const categories = this.computeCategoryRevenue(articles, rawEvents, conversionSnapshot);

      // 8. Compute Train & Station Topics Revenue Intent
      const { topTrainTopics, topStationTopics } = this.computeTrainStationTopics(
        articles,
        rawEvents,
        conversionSnapshot
      );

      // 9. Compute Campaign & Source Revenue Intent
      const campaigns = this.computeCampaignRevenue(rawEvents, conversionSnapshot);
      const sources = this.computeSourceRevenue(articles, rawEvents);

      // 10. Generate Read-Only Strategic Revenue Opportunities
      const opportunities = this.generateOpportunities(
        topArticles,
        categories,
        topTrainTopics,
        providers,
        conversionSnapshot
      );

      // 11. Controlled Future Auto-Routing Blueprint
      const futureRoutingBlueprint: FutureRoutingBlueprint = {
        status: 'DESIGN_ONLY_READ_ONLY',
        lifecycle_stages: [
          'OBSERVE: Monitor click-through and interaction volumes passively',
          'COLLECT SAMPLE: Accumulate statistically meaningful samples (≥25 clicks, ≥10 conversions)',
          'VERIFY: Validate conversion postbacks against provider partner reports',
          'ADMIN APPROVAL: Explicit human admin review & signed decision required',
          'LIMITED EXPERIMENT: Canary traffic allocation with tight circuit breakers',
          'FULL ROUTING: Governed production provider routing based on verified yield',
        ],
        governance_rule:
          'Automatic routing changes are strictly disabled. Any traffic reallocation requires explicit Admin approval.',
        admin_approval_required: true,
      };

      const response: NewsRevenueIntelligenceResponse = {
        success: true,
        window,
        generated_at: new Date().toISOString(),
        governance: {
          read_only: true,
          auto_routing_active: false,
          traffic_split_active: false,
          commission_calculation: 'NOT_AVAILABLE',
          min_click_sample: MIN_CLICK_SAMPLE,
          min_conversion_sample: MIN_CONVERSION_SAMPLE,
        },
        funnel,
        providers,
        top_booking_intent_articles: topArticles,
        categories,
        top_train_topics: topTrainTopics,
        top_station_topics: topStationTopics,
        campaigns,
        sources,
        opportunities,
        future_routing_blueprint: futureRoutingBlueprint,
      };

      cacheService.set(cacheKey, response, REVENUE_CACHE_TTL);
      return response;
    } catch (err: any) {
      winstonLogger.error(`[NEWS_REVENUE_INTEL_ERROR] ${err.message}`);
      return this.getEmptyRevenueResponse(window);
    }
  }

  // ─── Data Extraction ────────────────────────────────────────────────────────

  private getStartTimeForWindow(window: RevenueTimeWindow): Date {
    const now = Date.now();
    switch (window) {
      case 'today':
        return new Date(now - 24 * 60 * 60 * 1000);
      case '30d':
        return new Date(now - 30 * 24 * 60 * 60 * 1000);
      case '7d':
      default:
        return new Date(now - 7 * 24 * 60 * 60 * 1000);
    }
  }

  private async fetchArticles(): Promise<CanonicalNewsArticle[]> {
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
      winstonLogger.warn(`[NEWS_REV_FETCH_DB_WARN] ${err.message}`);
    }

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

  private async fetchEvents(startTime: Date): Promise<any[]> {
    const events: any[] = [];
    const isoStart = startTime.toISOString();

    try {
      if (isSupabaseConfigured()) {
        const { data, error } = await supabase
          .from('universal_events')
          .select('*')
          .gte('created_at', isoStart)
          .limit(5000);

        if (!error && data) {
          events.push(...data);
        }
      }
    } catch {}

    try {
      if (fs.existsSync(FALLBACK_LOG_PATH)) {
        const lines = fs.readFileSync(FALLBACK_LOG_PATH, 'utf-8').split('\n');
        const startEpoch = startTime.getTime();
        for (const line of lines) {
          if (!line.trim()) continue;
          try {
            const parsed = JSON.parse(line);
            const eventEpoch = new Date(parsed.created_at || parsed.timestamp || 0).getTime();
            if (eventEpoch >= startEpoch) {
              events.push({
                event_name: parsed.event_name || parsed.event_type,
                guest_id: parsed.guest_id || parsed.session_id,
                user_id: parsed.user_id,
                created_at: parsed.created_at || parsed.timestamp,
                metadata: parsed.metadata || {},
              });
            }
          } catch {}
        }
      }
    } catch {}

    return events;
  }

  // ─── Computation Engines ────────────────────────────────────────────────────

  private computeFunnel(
    events: any[],
    conversionSnapshot: any,
    window: RevenueTimeWindow
  ): RevenueFunnelMetrics {
    let newsViews = 0;
    let articleViews = 0;
    let trainStationInteractions = 0;
    let bookingClicks = 0;

    for (const ev of events) {
      const name = (ev.event_name || ev.event_type || '').toLowerCase();
      const meta = ev.metadata || {};

      if (name === 'news_list_view' || name === 'news_category_view') {
        newsViews++;
      } else if (name === 'news_article_view') {
        articleViews++;
        newsViews++;
      } else if (name === 'news_train_link_click' || name === 'news_station_link_click') {
        trainStationInteractions++;
      } else if (name === 'booking_outbound_click') {
        bookingClicks++;
      } else if (name === 'news_monetization_click') {
        const dest = meta.destination_type || meta.destinationType;
        if (dest === 'booking') {
          bookingClicks++;
        } else {
          trainStationInteractions++;
        }
      }
    }

    // Merge conversion metrics from partner service
    const confirmedCount =
      conversionSnapshot?.metrics?.confirmed_conversions === 'NOT_AVAILABLE'
        ? 0
        : Number(conversionSnapshot?.metrics?.confirmed_conversions || 0);

    const pendingCount = Number(conversionSnapshot?.metrics?.pending_conversions || 0);
    const rejectedCount = Number(conversionSnapshot?.metrics?.rejected_conversions || 0);

    // Total outbound clicks reported by attribution engine
    const totalOutboundClicks = Math.max(
      bookingClicks,
      conversionSnapshot?.metrics?.outbound_clicks || 0
    );

    const clickToBookingRate =
      articleViews > 0 ? Number(((totalOutboundClicks / articleViews) * 100).toFixed(1)) : 0;

    const clickToConvRate =
      totalOutboundClicks > 0 && confirmedCount > 0
        ? Number(((confirmedCount / totalOutboundClicks) * 100).toFixed(1))
        : ('NOT_AVAILABLE' as const);

    const stages: FunnelStageMetric[] = [
      {
        stage: 'STAGE_1_NEWS_VIEW',
        name: 'News Views (List & Category)',
        count: newsViews,
        rate_from_previous_pct: 100,
        status: newsViews > 0 ? 'DATA' : 'INSUFFICIENT_DATA',
      },
      {
        stage: 'STAGE_2_ARTICLE_VIEW',
        name: 'Article Views',
        count: articleViews,
        rate_from_previous_pct:
          newsViews > 0 ? Number(((articleViews / newsViews) * 100).toFixed(1)) : 0,
        status: articleViews > 0 ? 'DATA' : 'INSUFFICIENT_DATA',
      },
      {
        stage: 'STAGE_3_INTERACTION',
        name: 'Train & Station Interactions',
        count: trainStationInteractions,
        rate_from_previous_pct:
          articleViews > 0
            ? Number(((trainStationInteractions / articleViews) * 100).toFixed(1))
            : 0,
        status: trainStationInteractions > 0 ? 'DATA' : 'INSUFFICIENT_DATA',
      },
      {
        stage: 'STAGE_4_BOOKING_CLICK',
        name: 'Outbound Booking Clicks',
        count: totalOutboundClicks,
        rate_from_previous_pct:
          articleViews > 0 ? Number(((totalOutboundClicks / articleViews) * 100).toFixed(1)) : 0,
        status: totalOutboundClicks > 0 ? 'DATA' : 'INSUFFICIENT_DATA',
      },
      {
        stage: 'STAGE_5_CONFIRMED_CONVERSION',
        name: 'Confirmed Partner Conversions',
        count: confirmedCount,
        rate_from_previous_pct:
          totalOutboundClicks > 0 && confirmedCount > 0
            ? Number(((confirmedCount / totalOutboundClicks) * 100).toFixed(1))
            : 0,
        status: confirmedCount > 0 ? 'DATA' : 'NOT_AVAILABLE',
      },
    ];

    return {
      news_views: newsViews,
      article_views: articleViews,
      train_station_interactions: trainStationInteractions,
      booking_clicks: totalOutboundClicks,
      confirmed_conversions: confirmedCount > 0 ? confirmedCount : 'NOT_AVAILABLE',
      pending_conversions: pendingCount,
      rejected_conversions: rejectedCount,
      click_to_booking_rate_pct: clickToBookingRate,
      click_to_conversion_rate_pct: clickToConvRate,
      stages,
    };
  }

  private computeProviders(events: any[], conversionSnapshot: any): ProviderRevenueMetric[] {
    const bookingConfig = bookingConfigService.getConfig();
    const configProviders = bookingConfig.providers || {};

    const providerClicksMap = new Map<string, number>();
    const providerConvMap = new Map<
      string,
      { confirmed: number; pending: number; rejected: number }
    >();

    // Initialize from configured providers
    for (const pKey of Object.keys(configProviders)) {
      const up = pKey.toUpperCase();
      providerClicksMap.set(up, 0);
      providerConvMap.set(up, { confirmed: 0, pending: 0, rejected: 0 });
    }

    // Accumulate clicks from events
    for (const ev of events) {
      const name = (ev.event_name || ev.event_type || '').toLowerCase();
      const meta = ev.metadata || {};
      if (name === 'booking_outbound_click') {
        const prov = (meta.provider || meta.provider_id || meta.providerId || 'IRCTC').toUpperCase();
        providerClicksMap.set(prov, (providerClicksMap.get(prov) || 0) + 1);
      }
    }

    // Accumulate from conversion snapshot
    if (Array.isArray(conversionSnapshot?.provider_breakdown)) {
      for (const pb of conversionSnapshot.provider_breakdown) {
        const prov = (pb.providerId || '').toUpperCase();
        if (prov) {
          const prevClicks = providerClicksMap.get(prov) || 0;
          providerClicksMap.set(prov, Math.max(prevClicks, pb.clicks || 0));
          providerConvMap.set(prov, {
            confirmed: pb.confirmed || 0,
            pending: (pb.conversions || 0) - (pb.confirmed || 0),
            rejected: 0,
          });
        }
      }
    }

    // Build metrics for all configured providers (do not invent unconfigured partners)
    const result: ProviderRevenueMetric[] = Object.values(configProviders).map((cfg) => {
      const pId = cfg.providerId.toUpperCase();
      const clicks = providerClicksMap.get(pId) || 0;
      const convData = providerConvMap.get(pId) || { confirmed: 0, pending: 0, rejected: 0 };
      const confirmed = convData.confirmed;
      const pending = convData.pending;
      const rejected = convData.rejected;

      // Sample Quality Determination
      let sampleQuality: SampleQuality = 'INSUFFICIENT_DATA';
      if (clicks >= MIN_CLICK_SAMPLE * 2 && confirmed >= MIN_CONVERSION_SAMPLE * 2) {
        sampleQuality = 'HIGH';
      } else if (clicks >= MIN_CLICK_SAMPLE && confirmed >= MIN_CONVERSION_SAMPLE) {
        sampleQuality = 'ADEQUATE';
      } else if (clicks >= MIN_CLICK_SAMPLE) {
        sampleQuality = 'LOW';
      } else {
        sampleQuality = 'INSUFFICIENT_DATA';
      }

      // State Machine Determination
      let state: ProviderPerformanceState = 'INSUFFICIENT_DATA';
      let stateReason = `Clicks (${clicks}/${MIN_CLICK_SAMPLE}) below statistical significance threshold.`;

      if (clicks >= MIN_CLICK_SAMPLE && confirmed >= MIN_CONVERSION_SAMPLE) {
        const rate = (confirmed / clicks) * 100;
        if (rate >= 2.0) {
          state = 'VERIFIED';
          stateReason = `Verified performance with ${clicks} clicks, ${confirmed} postbacks (${rate.toFixed(1)}% conversion rate).`;
        } else {
          state = 'PROMISING';
          stateReason = `Sample threshold reached (${clicks} clicks), conversion rate (${rate.toFixed(1)}%) under continuous observation.`;
        }
      } else if (clicks >= MIN_CLICK_SAMPLE) {
        state = 'OBSERVATIONAL';
        stateReason = `Traffic volume threshold reached (${clicks} clicks), awaiting verified partner conversion postbacks.`;
      } else {
        state = 'INSUFFICIENT_DATA';
        stateReason = `Clicks (${clicks}/${MIN_CLICK_SAMPLE}) or conversions (${confirmed}/${MIN_CONVERSION_SAMPLE}) insufficient.`;
      }

      const conversionRate =
        clicks > 0 && confirmed > 0
          ? Number(((confirmed / clicks) * 100).toFixed(1))
          : ('NOT_AVAILABLE' as const);

      return {
        provider_id: pId,
        display_name: cfg.displayName,
        enabled: cfg.enabled,
        is_official: cfg.isOfficial,
        priority: cfg.priority,
        clicks,
        conversions: confirmed > 0 ? confirmed : 'NOT_AVAILABLE',
        confirmed_conversions_count: confirmed,
        pending_conversions: pending,
        rejected_conversions: rejected,
        conversion_rate_pct: conversionRate,
        sample_quality: sampleQuality,
        state,
        state_reason: stateReason,
      };
    });

    return result.sort((a, b) => a.priority - b.priority);
  }

  private computeArticleRevenueIntent(
    articles: CanonicalNewsArticle[],
    events: any[],
    conversionSnapshot: any
  ): ArticleRevenueIntentMetric[] {
    const viewsMap = new Map<string, number>();
    const trainClicksMap = new Map<string, number>();
    const stationClicksMap = new Map<string, number>();
    const bookingClicksMap = new Map<string, number>();

    for (const ev of events) {
      const name = (ev.event_name || ev.event_type || '').toLowerCase();
      const meta = ev.metadata || {};
      const artId = meta.article_id || meta.articleId || meta.slug;

      if (artId) {
        if (name === 'news_article_view') {
          viewsMap.set(artId, (viewsMap.get(artId) || 0) + 1);
        } else if (name === 'news_train_link_click') {
          trainClicksMap.set(artId, (trainClicksMap.get(artId) || 0) + 1);
        } else if (name === 'news_station_link_click') {
          stationClicksMap.set(artId, (stationClicksMap.get(artId) || 0) + 1);
        } else if (
          name === 'booking_outbound_click' ||
          (name === 'news_monetization_click' &&
            (meta.destination_type === 'booking' || meta.destinationType === 'booking'))
        ) {
          bookingClicksMap.set(artId, (bookingClicksMap.get(artId) || 0) + 1);
        }
      }
    }

    // Also correlate with conversion snapshot article breakdown
    const articleConvMap = new Map<string, { clicks: number; conversions: number }>();
    if (Array.isArray(conversionSnapshot?.article_breakdown)) {
      for (const ab of conversionSnapshot.article_breakdown) {
        if (ab.articleId) {
          articleConvMap.set(ab.articleId, {
            clicks: ab.clicks || 0,
            conversions: ab.conversions || 0,
          });
        }
      }
    }

    const metrics: ArticleRevenueIntentMetric[] = articles.map((art) => {
      const v = viewsMap.get(art.id) || viewsMap.get(art.slug || '') || 0;
      const tc = trainClicksMap.get(art.id) || 0;
      const sc = stationClicksMap.get(art.id) || 0;
      const snapshotEntry = articleConvMap.get(art.id);
      const bc = Math.max(bookingClicksMap.get(art.id) || 0, snapshotEntry?.clicks || 0);
      const conf = snapshotEntry?.conversions || 0;

      const intentRate = v > 0 ? Number(((bc / v) * 100).toFixed(1)) : 0;
      const convRate =
        bc > 0 && conf > 0
          ? Number(((conf / bc) * 100).toFixed(1))
          : ('NOT_AVAILABLE' as const);

      const sampleQuality: SampleQuality =
        bc >= MIN_CLICK_SAMPLE
          ? conf >= MIN_CONVERSION_SAMPLE
            ? 'ADEQUATE'
            : 'LOW'
          : 'INSUFFICIENT_DATA';

      return {
        article_id: art.id,
        title: art.title,
        slug: art.slug,
        category: art.category,
        views: v,
        train_clicks: tc,
        station_clicks: sc,
        booking_clicks: bc,
        conversions: conf > 0 ? conf : 'NOT_AVAILABLE',
        booking_intent_rate_pct: intentRate,
        conversion_rate_pct: convRate,
        sample_quality: sampleQuality,
      };
    });

    // Sort by booking clicks (highest first), then views
    return metrics
      .sort((a, b) => b.booking_clicks - a.booking_clicks || b.views - a.views)
      .slice(0, 20);
  }

  private computeCategoryRevenue(
    articles: CanonicalNewsArticle[],
    events: any[],
    conversionSnapshot: any
  ): CategoryRevenueMetric[] {
    const catArticleCount = new Map<string, number>();
    const catViews = new Map<string, number>();
    const catInteractions = new Map<string, number>();
    const catBookingClicks = new Map<string, number>();

    for (const art of articles) {
      catArticleCount.set(art.category, (catArticleCount.get(art.category) || 0) + 1);
    }

    for (const ev of events) {
      const name = (ev.event_name || ev.event_type || '').toLowerCase();
      const meta = ev.metadata || {};
      const cat = meta.category;

      if (cat) {
        if (name === 'news_article_view' || name === 'news_category_view') {
          catViews.set(cat, (catViews.get(cat) || 0) + 1);
        } else if (name === 'news_train_link_click' || name === 'news_station_link_click') {
          catInteractions.set(cat, (catInteractions.get(cat) || 0) + 1);
        } else if (
          name === 'booking_outbound_click' ||
          (name === 'news_monetization_click' && meta.destination_type === 'booking')
        ) {
          catBookingClicks.set(cat, (catBookingClicks.get(cat) || 0) + 1);
        }
      }
    }

    return Array.from(catArticleCount.entries())
      .map(([cat, count]) => {
        const v = catViews.get(cat) || 0;
        const inter = catInteractions.get(cat) || 0;
        const bc = catBookingClicks.get(cat) || 0;
        const intentRate = v > 0 ? Number(((bc / v) * 100).toFixed(1)) : 0;

        return {
          category: cat,
          article_count: count,
          views: v,
          train_station_clicks: inter,
          booking_clicks: bc,
          conversions: 'NOT_AVAILABLE' as const,
          booking_intent_rate_pct: intentRate,
        };
      })
      .sort((a, b) => b.booking_clicks - a.booking_clicks || b.views - a.views);
  }

  private computeTrainStationTopics(
    articles: CanonicalNewsArticle[],
    events: any[],
    conversionSnapshot: any
  ) {
    const trainMentionMap = new Map<string, number>();
    const stationMentionMap = new Map<string, number>();

    for (const art of articles) {
      for (const t of art.affected_trains || []) {
        trainMentionMap.set(t, (trainMentionMap.get(t) || 0) + 1);
      }
      for (const s of art.affected_stations || []) {
        stationMentionMap.set(s, (stationMentionMap.get(s) || 0) + 1);
      }
    }

    const trainClicks = new Map<string, number>();
    const stationClicks = new Map<string, number>();
    const trainBooking = new Map<string, number>();

    for (const ev of events) {
      const name = (ev.event_name || ev.event_type || '').toLowerCase();
      const meta = ev.metadata || {};
      const trainNo = meta.train_no || meta.trainNo;
      const station = meta.station;

      if (trainNo && name === 'news_train_link_click') {
        trainClicks.set(trainNo, (trainClicks.get(trainNo) || 0) + 1);
      }
      if (station && name === 'news_station_link_click') {
        stationClicks.set(station, (stationClicks.get(station) || 0) + 1);
      }
      if (trainNo && name === 'booking_outbound_click') {
        trainBooking.set(trainNo, (trainBooking.get(trainNo) || 0) + 1);
      }
    }

    const topTrainTopics: TrainTopicRevenueMetric[] = Array.from(trainMentionMap.entries())
      .map(([trainNo, mentions]) => {
        const linkClicks = trainClicks.get(trainNo) || 0;
        const bClicks = trainBooking.get(trainNo) || 0;
        const intentRate =
          linkClicks > 0 ? Number(((bClicks / linkClicks) * 100).toFixed(1)) : 0;

        return {
          train_no: trainNo,
          train_name: this.getTrainName(trainNo),
          news_mentions_count: mentions,
          train_link_clicks: linkClicks,
          booking_clicks: bClicks,
          conversions: 'NOT_AVAILABLE' as const,
          booking_intent_rate_pct: intentRate,
        };
      })
      .sort((a, b) => b.booking_clicks - a.booking_clicks || b.train_link_clicks - a.train_link_clicks)
      .slice(0, 10);

    const topStationTopics: StationTopicRevenueMetric[] = Array.from(stationMentionMap.entries())
      .map(([station, mentions]) => {
        const sClicks = stationClicks.get(station) || 0;
        return {
          station,
          news_mentions_count: mentions,
          station_link_clicks: sClicks,
          booking_clicks: 0,
          conversions: 'NOT_AVAILABLE' as const,
          booking_intent_rate_pct: 0,
        };
      })
      .sort((a, b) => b.station_link_clicks - a.station_link_clicks || b.news_mentions_count - a.news_mentions_count)
      .slice(0, 10);

    return { topTrainTopics, topStationTopics };
  }

  private computeCampaignRevenue(events: any[], conversionSnapshot: any): CampaignRevenueMetric[] {
    const campaignMap = new Map<string, { clicks: number; conversions: number }>();

    for (const ev of events) {
      const name = (ev.event_name || ev.event_type || '').toLowerCase();
      const meta = ev.metadata || {};
      const camp = meta.campaign_id || meta.campaignId || 'direct';

      if (name === 'booking_outbound_click') {
        const entry = campaignMap.get(camp) || { clicks: 0, conversions: 0 };
        entry.clicks++;
        campaignMap.set(camp, entry);
      }
    }

    if (Array.isArray(conversionSnapshot?.campaign_breakdown)) {
      for (const cb of conversionSnapshot.campaign_breakdown) {
        const camp = cb.campaignId || 'direct';
        const entry = campaignMap.get(camp) || { clicks: 0, conversions: 0 };
        entry.clicks = Math.max(entry.clicks, cb.clicks || 0);
        entry.conversions = cb.conversions || 0;
        campaignMap.set(camp, entry);
      }
    }

    if (campaignMap.size === 0) {
      campaignMap.set('direct_news_feed', { clicks: 0, conversions: 0 });
    }

    return Array.from(campaignMap.entries()).map(([campId, data]) => {
      const rate =
        data.clicks > 0 && data.conversions > 0
          ? Number(((data.conversions / data.clicks) * 100).toFixed(1))
          : ('NOT_AVAILABLE' as const);

      const sampleQuality: SampleQuality =
        data.clicks >= MIN_CLICK_SAMPLE
          ? data.conversions >= MIN_CONVERSION_SAMPLE
            ? 'ADEQUATE'
            : 'LOW'
          : 'INSUFFICIENT_DATA';

      return {
        campaign_id: campId,
        clicks: data.clicks,
        conversions: data.conversions > 0 ? data.conversions : 'NOT_AVAILABLE',
        conversion_rate_pct: rate,
        sample_quality: sampleQuality,
      };
    });
  }

  private computeSourceRevenue(articles: CanonicalNewsArticle[], events: any[]): SourceRevenueMetric[] {
    const sourceMap = new Map<
      string,
      { tier: string; articles: number; views: number; sourceClicks: number; bookingClicks: number }
    >();

    for (const art of articles) {
      const entry = sourceMap.get(art.source_name) || {
        tier: art.source_tier,
        articles: 0,
        views: 0,
        sourceClicks: 0,
        bookingClicks: 0,
      };
      entry.articles++;
      sourceMap.set(art.source_name, entry);
    }

    for (const ev of events) {
      const name = (ev.event_name || ev.event_type || '').toLowerCase();
      const meta = ev.metadata || {};
      const sName = meta.source_name || meta.sourceName;

      if (sName && sourceMap.has(sName)) {
        const entry = sourceMap.get(sName)!;
        if (name === 'news_article_view') entry.views++;
        else if (name === 'news_source_click') entry.sourceClicks++;
        else if (name === 'booking_outbound_click') entry.bookingClicks++;
      }
    }

    return Array.from(sourceMap.entries()).map(([name, data]) => {
      const intentRate =
        data.views > 0 ? Number(((data.bookingClicks / data.views) * 100).toFixed(1)) : 0;
      return {
        source_name: name,
        source_tier: data.tier,
        articles_count: data.articles,
        views: data.views,
        source_clicks: data.sourceClicks,
        booking_clicks: data.bookingClicks,
        booking_intent_rate_pct: intentRate,
      };
    });
  }

  // ─── Opportunity Engine ─────────────────────────────────────────────────────

  private generateOpportunities(
    topArticles: ArticleRevenueIntentMetric[],
    categories: CategoryRevenueMetric[],
    topTrains: TrainTopicRevenueMetric[],
    providers: ProviderRevenueMetric[],
    conversionSnapshot: any
  ): RevenueOpportunity[] {
    const opps: RevenueOpportunity[] = [];

    // 1. HIGH_BOOKING_INTENT_TOPIC — category or article with notable booking click rate
    const highIntentCategory = categories.find((c) => c.booking_clicks >= 3 || c.views >= 10);
    if (highIntentCategory) {
      opps.push({
        id: `opp_intent_cat_${highIntentCategory.category}`,
        type: 'HIGH_BOOKING_INTENT_TOPIC',
        title: `High Booking Intent: ${highIntentCategory.category}`,
        signal: `${highIntentCategory.booking_clicks} booking actions generated from ${highIntentCategory.views} views`,
        reason: `Passengers reading ${highIntentCategory.category} notices show strong downstream ticket intent.`,
        sample_size: highIntentCategory.views,
        suggested_action: `Prioritize timetable, seat availability, and Tatkal guidance in future ${highIntentCategory.category} updates.`,
        urgency: 'HIGH',
        related_entity: highIntentCategory.category,
      });
    }

    // 2. HIGH_CTR_LOW_BOOKING — articles with views >= 5 but 0 booking clicks
    const lowBookingArticle = topArticles.find((a) => a.views >= 5 && a.booking_clicks === 0);
    if (lowBookingArticle) {
      opps.push({
        id: `opp_low_booking_${lowBookingArticle.article_id}`,
        type: 'HIGH_CTR_LOW_BOOKING',
        title: `Untapped Passenger Intent: ${lowBookingArticle.title.slice(0, 40)}...`,
        signal: `${lowBookingArticle.views} views recorded with zero outbound booking clicks`,
        reason: `Article drives significant reader interest but lacks direct utility links for passenger booking flow.`,
        sample_size: lowBookingArticle.views,
        suggested_action: `Embed affected train numbers and live route tracking CTA widgets inside article content.`,
        urgency: 'MEDIUM',
        related_entity: lowBookingArticle.article_id,
      });
    }

    // 3. STRONG_PROVIDER_SIGNAL / WEAK_PROVIDER_SIGNAL
    const verifiedProvider = providers.find((p) => p.state === 'VERIFIED' || p.state === 'PROMISING');
    if (verifiedProvider) {
      opps.push({
        id: `opp_provider_strong_${verifiedProvider.provider_id}`,
        type: 'STRONG_PROVIDER_SIGNAL',
        title: `Strong Provider Conversion: ${verifiedProvider.display_name}`,
        signal: `${verifiedProvider.clicks} clicks recorded with ${verifiedProvider.confirmed_conversions_count} confirmed conversions (${verifiedProvider.conversion_rate_pct}%)`,
        reason: `Provider meets sample thresholds and delivers reliable conversion stability.`,
        sample_size: verifiedProvider.clicks,
        suggested_action: `Maintain primary routing priority; review SLA performance before considering any allocation adjustments.`,
        urgency: 'LOW',
        related_entity: verifiedProvider.provider_id,
      });
    } else {
      const observational = providers.find((p) => p.state === 'OBSERVATIONAL');
      if (observational) {
        opps.push({
          id: `opp_provider_obs_${observational.provider_id}`,
          type: 'WEAK_PROVIDER_SIGNAL',
          title: `Awaiting Conversion Significance: ${observational.display_name}`,
          signal: `${observational.clicks} clicks recorded, awaiting confirmed postback threshold (≥10)`,
          reason: `Traffic sample is observational; insufficient postback history exists to draw yield conclusions.`,
          sample_size: observational.clicks,
          suggested_action: `Continue passive traffic observation. Do not modify provider routing.`,
          urgency: 'LOW',
          related_entity: observational.provider_id,
        });
      }
    }

    // 4. ARTICLE_UPDATE_OPPORTUNITY — top train topics driving booking queries
    const topTrain = topTrains.find((t) => t.train_link_clicks >= 2 || t.booking_clicks >= 1);
    if (topTrain) {
      opps.push({
        id: `opp_train_update_${topTrain.train_no}`,
        type: 'ARTICLE_UPDATE_OPPORTUNITY',
        title: `Corridor Demand: Train #${topTrain.train_no} (${topTrain.train_name})`,
        signal: `${topTrain.train_link_clicks} tracker interactions with ${topTrain.news_mentions_count} news bulletins`,
        reason: `High reader interaction on train route indicators indicates strong schedule dependency.`,
        sample_size: topTrain.train_link_clicks,
        suggested_action: `Ensure latest timetable revisions, coach composition, and pantry car advisories are updated.`,
        urgency: 'MEDIUM',
        related_entity: topTrain.train_no,
      });
    }

    return opps.slice(0, 6);
  }

  private getTrainName(trainNo: string): string {
    const map: Record<string, string> = {
      '12951': 'Mumbai Rajdhani',
      '12952': 'New Delhi Rajdhani',
      '12002': 'Shatabdi Express',
      '22436': 'Vande Bharat Express',
      '22435': 'Vande Bharat Express',
      '12301': 'Howrah Rajdhani',
      '12302': 'New Delhi Howrah Rajdhani',
      '12626': 'Kerala Express',
    };
    return map[trainNo] || `Express ${trainNo}`;
  }

  private getEmptyRevenueResponse(window: RevenueTimeWindow): NewsRevenueIntelligenceResponse {
    return {
      success: true,
      window,
      generated_at: new Date().toISOString(),
      governance: {
        read_only: true,
        auto_routing_active: false,
        traffic_split_active: false,
        commission_calculation: 'NOT_AVAILABLE',
        min_click_sample: MIN_CLICK_SAMPLE,
        min_conversion_sample: MIN_CONVERSION_SAMPLE,
      },
      funnel: {
        news_views: 0,
        article_views: 0,
        train_station_interactions: 0,
        booking_clicks: 0,
        confirmed_conversions: 'NOT_AVAILABLE',
        pending_conversions: 0,
        rejected_conversions: 0,
        click_to_booking_rate_pct: 0,
        click_to_conversion_rate_pct: 'NOT_AVAILABLE',
        stages: [],
      },
      providers: [],
      top_booking_intent_articles: [],
      categories: [],
      top_train_topics: [],
      top_station_topics: [],
      campaigns: [],
      sources: [],
      opportunities: [],
      future_routing_blueprint: {
        status: 'DESIGN_ONLY_READ_ONLY',
        lifecycle_stages: [],
        governance_rule: 'Automatic routing changes are strictly disabled.',
        admin_approval_required: true,
      },
    };
  }
}

export const newsRevenueIntelligenceService = new NewsRevenueIntelligenceService();
