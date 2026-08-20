import { NewsSource, SourceHealth, HealthStatus, SourceTier } from './newsTypes';
import { winstonLogger } from '../../middleware/logger';

/**
 * Production-Safe Source Registry for Indian Railways News.
 * Grouped into Tier 1 (Official / Government), Tier 2 (Zonal Operations), and Tier 3 (Recognized Media).
 */
const DEFAULT_SOURCES: NewsSource[] = [
  // ── Tier 1: Official & Policy (Highest Authority) ───────────────────────────
  {
    id: 'src_pib_railways',
    name: 'Ministry of Railways (PIB)',
    url: 'https://news.google.com/rss/search?q=%22Ministry+of+Railways%22+site:pib.gov.in&hl=en-IN&gl=IN&ceid=IN:en',
    type: 'RSS',
    tier: 'TIER_1_OFFICIAL',
    category: 'Official',
    enabled: true,
    pollIntervalMs: 1800000, // 30 mins
    maxItemsPerFetch: 50,
  },
  {
    id: 'src_ir_gov',
    name: 'Indian Railways Official Announcements',
    url: 'https://news.google.com/rss/search?q=%22Indian+Railways%22+site:indianrailways.gov.in&hl=en-IN&gl=IN&ceid=IN:en',
    type: 'RSS',
    tier: 'TIER_1_OFFICIAL',
    category: 'Official',
    enabled: true,
    pollIntervalMs: 1800000, // 30 mins
    maxItemsPerFetch: 50,
  },
  {
    id: 'src_railway_board',
    name: 'Railway Board Policy & Directives',
    url: 'https://news.google.com/rss/search?q=%22Railway+Board%22&hl=en-IN&gl=IN&ceid=IN:en',
    type: 'RSS',
    tier: 'TIER_1_OFFICIAL',
    category: 'Official',
    enabled: true,
    pollIntervalMs: 3600000, // 1 hour
    maxItemsPerFetch: 50,
  },
  {
    id: 'src_irctc_official',
    name: 'IRCTC Corporate & Ticketing Notices',
    url: 'https://news.google.com/rss/search?q=%22IRCTC%22&hl=en-IN&gl=IN&ceid=IN:en',
    type: 'RSS',
    tier: 'TIER_1_OFFICIAL',
    category: 'IRCTC',
    enabled: true,
    pollIntervalMs: 1800000, // 30 mins
    maxItemsPerFetch: 50,
  },
  {
    id: 'src_cris_tech',
    name: 'CRIS Rail Technology & Ticketing Directives',
    url: 'https://news.google.com/rss/search?q=%22Centre+for+Railway+Information+Systems%22+OR+%22CRIS%22+railway&hl=en-IN&gl=IN&ceid=IN:en',
    type: 'RSS',
    tier: 'TIER_1_OFFICIAL',
    category: 'Operations',
    enabled: true,
    pollIntervalMs: 3600000, // 1 hour
    maxItemsPerFetch: 40,
  },
  {
    id: 'src_rdso_safety',
    name: 'RDSO Safety & Track Standards',
    url: 'https://news.google.com/rss/search?q=%22RDSO%22+OR+%22Research+Designs+and+Standards+Organisation%22+railway&hl=en-IN&gl=IN&ceid=IN:en',
    type: 'RSS',
    tier: 'TIER_1_OFFICIAL',
    category: 'Safety',
    enabled: true,
    pollIntervalMs: 7200000, // 2 hours
    maxItemsPerFetch: 30,
  },

  // ── Tier 2: Government & Zonal Press Bulletins ──────────────────────────────
  {
    id: 'src_northern_railway',
    name: 'Northern Railway Zonal Bulletins',
    url: 'https://news.google.com/rss/search?q=%22Northern+Railway%22+train+OR+cancellation+OR+special&hl=en-IN&gl=IN&ceid=IN:en',
    type: 'RSS',
    tier: 'TIER_2_GOVERNMENT',
    category: 'Operations',
    enabled: true,
    pollIntervalMs: 3600000, // 1 hour
    maxItemsPerFetch: 50,
  },
  {
    id: 'src_western_railway',
    name: 'Western Railway Passenger Alerts',
    url: 'https://news.google.com/rss/search?q=%22Western+Railway%22+train+OR+cancellation+OR+special&hl=en-IN&gl=IN&ceid=IN:en',
    type: 'RSS',
    tier: 'TIER_2_GOVERNMENT',
    category: 'Operations',
    enabled: true,
    pollIntervalMs: 3600000, // 1 hour
    maxItemsPerFetch: 50,
  },
  {
    id: 'src_central_railway',
    name: 'Central Railway Suburban & Express Updates',
    url: 'https://news.google.com/rss/search?q=%22Central+Railway%22+train+OR+cancellation+OR+mega+block&hl=en-IN&gl=IN&ceid=IN:en',
    type: 'RSS',
    tier: 'TIER_2_GOVERNMENT',
    category: 'Delays',
    enabled: true,
    pollIntervalMs: 3600000, // 1 hour
    maxItemsPerFetch: 50,
  },
  {
    id: 'src_southern_railway',
    name: 'Southern Railway Operations & Special Trains',
    url: 'https://news.google.com/rss/search?q=%22Southern+Railway%22+train+OR+cancellation+OR+special&hl=en-IN&gl=IN&ceid=IN:en',
    type: 'RSS',
    tier: 'TIER_2_GOVERNMENT',
    category: 'Operations',
    enabled: true,
    pollIntervalMs: 3600000, // 1 hour
    maxItemsPerFetch: 50,
  },
  {
    id: 'src_eastern_railway',
    name: 'Eastern Railway Operations',
    url: 'https://news.google.com/rss/search?q=%22Eastern+Railway%22+train+OR+cancellation+OR+special&hl=en-IN&gl=IN&ceid=IN:en',
    type: 'RSS',
    tier: 'TIER_2_GOVERNMENT',
    category: 'Operations',
    enabled: true,
    pollIntervalMs: 3600000, // 1 hour
    maxItemsPerFetch: 50,
  },
  {
    id: 'src_konkan_railway',
    name: 'Konkan Railway Monsoon & Route Bulletins',
    url: 'https://news.google.com/rss/search?q=%22Konkan+Railway%22+train+OR+monsoon+OR+timetable&hl=en-IN&gl=IN&ceid=IN:en',
    type: 'RSS',
    tier: 'TIER_2_GOVERNMENT',
    category: 'Safety',
    enabled: true,
    pollIntervalMs: 3600000, // 1 hour
    maxItemsPerFetch: 40,
  },

  // ── Tier 3: Recognized Media & National Desks ───────────────────────────────
  {
    id: 'src_dd_news_rail',
    name: 'DD News National Rail Transport Desk',
    url: 'https://news.google.com/rss/search?q=%22Indian+Railways%22+site:ddnews.gov.in&hl=en-IN&gl=IN&ceid=IN:en',
    type: 'RSS',
    tier: 'TIER_3_RECOGNIZED_MEDIA',
    category: 'Official',
    enabled: true,
    pollIntervalMs: 7200000, // 2 hours
    maxItemsPerFetch: 50,
  },
  {
    id: 'src_air_news_rail',
    name: 'All India Radio News Railway Updates',
    url: 'https://news.google.com/rss/search?q=%22Indian+Railways%22+site:newsonair.gov.in&hl=en-IN&gl=IN&ceid=IN:en',
    type: 'RSS',
    tier: 'TIER_3_RECOGNIZED_MEDIA',
    category: 'Official',
    enabled: true,
    pollIntervalMs: 7200000, // 2 hours
    maxItemsPerFetch: 50,
  },
  {
    id: 'src_vande_bharat_network',
    name: 'National Vande Bharat & High-Speed Network',
    url: 'https://news.google.com/rss/search?q=%22Vande+Bharat%22+OR+%22Amrit+Bharat%22+when:2d&hl=en-IN&gl=IN&ceid=IN:en',
    type: 'RSS',
    tier: 'TIER_3_RECOGNIZED_MEDIA',
    category: 'Vande Bharat',
    enabled: true,
    pollIntervalMs: 7200000, // 2 hours
    maxItemsPerFetch: 50,
  },
  {
    id: 'src_rail_infra_redevelopment',
    name: 'Station Redevelopment & Rail Infra',
    url: 'https://news.google.com/rss/search?q=%22Amrit+Bharat+Station%22+OR+%22bullet+train%22+OR+%22Kavach%22+railway&hl=en-IN&gl=IN&ceid=IN:en',
    type: 'RSS',
    tier: 'TIER_3_RECOGNIZED_MEDIA',
    category: 'New Routes',
    enabled: true,
    pollIntervalMs: 7200000, // 2 hours
    maxItemsPerFetch: 50,
  },
];

export class NewsSourceRegistry {
  private sources: Map<string, NewsSource> = new Map();
  private healthMap: Map<string, SourceHealth> = new Map();

  constructor(initialSources: NewsSource[] = DEFAULT_SOURCES) {
    for (const src of initialSources) {
      this.registerSource(src);
    }
  }

  /**
   * Registers or updates a news source.
   */
  public registerSource(source: NewsSource): void {
    this.sources.set(source.id, { ...source });
    if (!this.healthMap.has(source.id)) {
      this.healthMap.set(source.id, {
        sourceId: source.id,
        name: source.name,
        tier: source.tier,
        lastFetchAt: null,
        lastSuccessAt: null,
        lastErrorAt: null,
        lastErrorMessage: null,
        httpStatus: null,
        latencyMs: 0,
        totalRequests: 0,
        totalSuccess: 0,
        totalFailures: 0,
        consecutiveFailures: 0,
        nextRetryAt: 0,
        status: source.enabled ? 'HEALTHY' : 'DISABLED',
      });
    }
  }

  /**
   * Retrieves all registered sources.
   */
  public getAllSources(): NewsSource[] {
    return Array.from(this.sources.values());
  }

  /**
   * Retrieves enabled sources.
   */
  public getEnabledSources(): NewsSource[] {
    return Array.from(this.sources.values()).filter(s => s.enabled);
  }

  /**
   * Retrieves sources by tier.
   */
  public getSourcesByTier(tier: SourceTier): NewsSource[] {
    return Array.from(this.sources.values()).filter(s => s.tier === tier && s.enabled);
  }

  /**
   * Retrieves a source by ID.
   */
  public getSource(id: string): NewsSource | undefined {
    return this.sources.get(id);
  }

  /**
   * Enables or disables a source.
   */
  public setSourceEnabled(id: string, enabled: boolean): boolean {
    const src = this.sources.get(id);
    if (!src) return false;
    src.enabled = enabled;
    const health = this.healthMap.get(id);
    if (health) {
      health.status = enabled ? (health.consecutiveFailures > 0 ? 'DEGRADED' : 'HEALTHY') : 'DISABLED';
    }
    return true;
  }

  /**
   * Checks if a source can be attempted (respects circuit breaker, enabled status, and retry backoff).
   */
  public canAttempt(sourceId: string): boolean {
    const src = this.sources.get(sourceId);
    if (!src || !src.enabled) return false;

    const health = this.healthMap.get(sourceId);
    if (!health) return true;

    if (health.status === 'DISABLED') return false;

    if (health.status === 'CIRCUIT_BROKEN' && Date.now() < health.nextRetryAt) {
      return false;
    }
    return true;
  }

  /**
   * Records a successful fetch attempt.
   */
  public recordSuccess(sourceId: string, latencyMs: number, httpStatus: number = 200): void {
    const health = this.healthMap.get(sourceId);
    if (!health) return;

    health.lastFetchAt = new Date().toISOString();
    health.lastSuccessAt = new Date().toISOString();
    health.latencyMs = latencyMs;
    health.httpStatus = httpStatus;
    health.totalRequests++;
    health.totalSuccess++;
    health.consecutiveFailures = 0;
    health.nextRetryAt = 0;
    health.status = 'HEALTHY';
  }

  /**
   * Records a failed fetch attempt with bounded exponential backoff and rate-limit handling.
   */
  public recordFailure(sourceId: string, error: string, latencyMs: number, httpStatus?: number): void {
    const health = this.healthMap.get(sourceId);
    if (!health) return;

    health.lastFetchAt = new Date().toISOString();
    health.lastErrorAt = new Date().toISOString();
    health.lastErrorMessage = error;
    health.latencyMs = latencyMs;
    if (httpStatus) health.httpStatus = httpStatus;
    health.totalRequests++;
    health.totalFailures++;
    health.consecutiveFailures++;

    // 429 Too Many Requests -> 15 min circuit break
    if (httpStatus === 429) {
      const rateLimitPauseMs = 15 * 60 * 1000;
      health.nextRetryAt = Date.now() + rateLimitPauseMs;
      health.status = 'CIRCUIT_BROKEN';
      winstonLogger.warn(`[NEWS_SOURCE_RATE_LIMITED] Source ${health.name} received 429 Too Many Requests. Circuit opened for 15m.`);
      return;
    }

    // Bounded exponential backoff: 1m, 2m, 4m, 8m, max 60m
    const backoffMs = Math.min(60000 * Math.pow(2, Math.min(health.consecutiveFailures - 1, 6)), 3600000);
    health.nextRetryAt = Date.now() + backoffMs;

    if (health.consecutiveFailures >= 5) {
      health.status = 'CIRCUIT_BROKEN';
      winstonLogger.warn(`[NEWS_SOURCE_CIRCUIT_BREAKER] Source ${health.name} tripped circuit breaker after ${health.consecutiveFailures} consecutive failures. Paused for ${backoffMs / 1000}s`);
    } else if (health.consecutiveFailures >= 2) {
      health.status = 'FAILING';
    } else {
      health.status = 'DEGRADED';
    }
  }

  /**
   * Gets a health snapshot of all sources.
   */
  public getHealthSummary(): SourceHealth[] {
    return Array.from(this.healthMap.values());
  }

  /**
   * Gets operational observability metrics for Admin dashboard.
   */
  public getMetrics() {
    const healthList = Array.from(this.healthMap.values());
    const total = this.sources.size;
    const enabled = this.getEnabledSources().length;
    const healthy = healthList.filter(h => h.status === 'HEALTHY').length;
    const degraded = healthList.filter(h => h.status === 'DEGRADED').length;
    const circuitBroken = healthList.filter(h => h.status === 'CIRCUIT_BROKEN').length;
    const disabled = healthList.filter(h => h.status === 'DISABLED').length;

    const totalRequests = healthList.reduce((acc, h) => acc + h.totalRequests, 0);
    const totalSuccess = healthList.reduce((acc, h) => acc + h.totalSuccess, 0);
    const totalFailures = healthList.reduce((acc, h) => acc + h.totalFailures, 0);

    const latestSuccess = healthList
      .map(h => h.lastSuccessAt)
      .filter(Boolean)
      .sort()
      .reverse()[0] || null;

    return {
      sources_total: total,
      sources_enabled: enabled,
      sources_healthy: healthy,
      sources_degraded: degraded,
      sources_circuit_broken: circuitBroken,
      sources_disabled: disabled,
      total_requests: totalRequests,
      total_success: totalSuccess,
      total_failures: totalFailures,
      last_successful_ingestion: latestSuccess,
    };
  }
}

export const newsSourceRegistry = new NewsSourceRegistry();
