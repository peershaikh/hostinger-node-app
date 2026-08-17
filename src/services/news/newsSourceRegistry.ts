import { NewsSource, SourceHealth, HealthStatus, SourceTier } from './newsTypes';
import { winstonLogger } from '../../middleware/logger';

/**
 * Initial Canonical Source Registry.
 * Preserves existing Google News queries as Tier 1/2 while allowing dynamic source registration.
 */
const DEFAULT_SOURCES: NewsSource[] = [
  {
    id: 'src_pib_railways',
    name: 'Ministry of Railways (PIB)',
    url: 'https://news.google.com/rss/search?q=%22Ministry+of+Railways%22+site:pib.gov.in&hl=en-IN&gl=IN&ceid=IN:en',
    tier: 'TIER_1_OFFICIAL',
    category: 'Official',
    enabled: true,
    maxItemsPerFetch: 50,
  },
  {
    id: 'src_ir_gov',
    name: 'Indian Railways Official',
    url: 'https://news.google.com/rss/search?q=%22Indian+Railways%22+site:indianrailways.gov.in&hl=en-IN&gl=IN&ceid=IN:en',
    tier: 'TIER_1_OFFICIAL',
    category: 'Official',
    enabled: true,
    maxItemsPerFetch: 50,
  },
  {
    id: 'src_railway_board',
    name: 'Railway Board Directives',
    url: 'https://news.google.com/rss/search?q=%22Railway+Board%22&hl=en-IN&gl=IN&ceid=IN:en',
    tier: 'TIER_1_OFFICIAL',
    category: 'Official',
    enabled: true,
    maxItemsPerFetch: 50,
  },
  {
    id: 'src_irctc_official',
    name: 'IRCTC Corporate Notices',
    url: 'https://news.google.com/rss/search?q=%22IRCTC%22&hl=en-IN&gl=IN&ceid=IN:en',
    tier: 'TIER_1_OFFICIAL',
    category: 'IRCTC',
    enabled: true,
    maxItemsPerFetch: 50,
  },
  {
    id: 'src_zonal_railways',
    name: 'Zonal Railway Press Bulletins',
    url: 'https://news.google.com/rss/search?q=%22Northern+Railway%22+OR+%22Western+Railway%22+OR+%22Central+Railway%22+OR+%22Southern+Railway%22+train&hl=en-IN&gl=IN&ceid=IN:en',
    tier: 'TIER_2_GOVERNMENT',
    category: 'Operations',
    enabled: true,
    maxItemsPerFetch: 50,
  },
  {
    id: 'src_national_media_rail',
    name: 'National Rail Transport Desk',
    url: 'https://news.google.com/rss/search?q=%22Vande+Bharat%22+OR+%22Amrit+Bharat%22+OR+%22train+cancellation%22+when:2d&hl=en-IN&gl=IN&ceid=IN:en',
    tier: 'TIER_3_RECOGNIZED_MEDIA',
    category: 'Railway Updates',
    enabled: true,
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
        status: 'HEALTHY',
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
   * Retrieves a source by ID.
   */
  public getSource(id: string): NewsSource | undefined {
    return this.sources.get(id);
  }

  /**
   * Checks if a source can be attempted (respects circuit breaker / retry delay).
   */
  public canAttempt(sourceId: string): boolean {
    const health = this.healthMap.get(sourceId);
    if (!health) return true;
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
   * Records a failed fetch attempt with bounded exponential backoff.
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
}

export const newsSourceRegistry = new NewsSourceRegistry();
