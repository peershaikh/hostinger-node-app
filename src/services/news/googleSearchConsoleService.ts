/**
 * Google Search Console SEO Intelligence Service — Phase 070
 *
 * Provides real Google Search Console performance metrics, Search Analytics API
 * integration for Trayago News (/news/*), period-over-period trend calculation,
 * railway search intent classification, and read-only SEO opportunities.
 *
 * Security & Governance:
 * - Read-only intelligence.
 * - Never auto-publishes or auto-generates spam pages.
 * - Strictly protects service account keys and tokens (server-side only, scrubbed from client responses).
 * - Safe fallback to NOT_CONFIGURED state when credentials are not configured.
 */

import { JWT } from 'google-auth-library';
import axios from 'axios';
import { winstonLogger } from '../../middleware/logger';
import { cacheService } from '../cacheService';

// ─── Types & Interfaces ───────────────────────────────────────────────────────

export type SearchConsoleStatus = 'CONNECTED' | 'PARTIALLY_CONFIGURED' | 'NOT_CONFIGURED';

export type SearchConsoleWindow = '7d' | '28d' | '30d';

export type RailwaySearchIntent =
  | 'TRAIN'
  | 'STATION'
  | 'ROUTE'
  | 'CANCELLATION'
  | 'DIVERSION'
  | 'SPECIAL_TRAIN'
  | 'TIMETABLE'
  | 'TATKAL'
  | 'IRCTC'
  | 'PNR'
  | 'LIVE_TRACKING'
  | 'OTHER_RAILWAY';

export interface SearchConsoleMetric {
  clicks: number;
  impressions: number;
  ctr: number;
  avg_position: number;
  clicks_delta_pct: number;
  impressions_delta_pct: number;
  ctr_delta_pct: number;
  position_delta_pct: number;
}

export interface SearchQueryItem {
  query: string;
  clicks: number;
  impressions: number;
  ctr: number;
  position: number;
  intent: RailwaySearchIntent;
  trend: 'RISING' | 'DECLINING' | 'STABLE';
  delta_clicks?: number;
  delta_impressions?: number;
}

export interface SearchPageItem {
  page_url: string;
  slug: string;
  title: string;
  clicks: number;
  impressions: number;
  ctr: number;
  position: number;
}

export interface CtrOpportunity {
  query: string;
  impressions: number;
  ctr: number;
  position: number;
  recommendation: string;
}

export interface PositionOpportunity {
  query: string;
  position: number;
  clicks: number;
  impressions: number;
  recommendation: string;
}

export interface SearchConsoleDashboardData {
  status: SearchConsoleStatus;
  is_configured: boolean;
  site_url: string;
  window: SearchConsoleWindow;
  generated_at: string;
  metrics: SearchConsoleMetric;
  top_queries: SearchQueryItem[];
  top_pages: SearchPageItem[];
  rising_queries: SearchQueryItem[];
  declining_queries: SearchQueryItem[];
  ctr_opportunities: CtrOpportunity[];
  position_opportunities: PositionOpportunity[];
  setup_requirements?: {
    status_summary: string;
    missing_keys: string[];
    steps: string[];
    documentation_url: string;
  };
}

const GSC_CACHE_TTL = 300; // 5 minutes cache for GSC analytics responses

export class GoogleSearchConsoleService {
  /**
   * Determine the current configuration status of Google Search Console.
   */
  getStatus(): SearchConsoleStatus {
    const clientEmail = process.env.GOOGLE_SEARCH_CONSOLE_CLIENT_EMAIL;
    const privateKey = process.env.GOOGLE_SEARCH_CONSOLE_PRIVATE_KEY;

    if (clientEmail && privateKey) {
      return 'CONNECTED';
    }
    if (clientEmail || privateKey) {
      return 'PARTIALLY_CONFIGURED';
    }
    return 'NOT_CONFIGURED';
  }

  /**
   * Fetch Search Console Performance data for Trayago News (/news/*).
   */
  async getPerformanceData(window: SearchConsoleWindow = '28d'): Promise<SearchConsoleDashboardData> {
    const cacheKey = `gsc_perf_news_${window}`;
    const cached = cacheService.get<SearchConsoleDashboardData>(cacheKey);
    if (cached) {
      return cached;
    }

    const status = this.getStatus();
    const siteUrl = process.env.GOOGLE_SEARCH_CONSOLE_SITE_URL || 'https://www.trayago.in/';

    if (status !== 'CONNECTED') {
      const emptyResult = this.getNotConfiguredResponse(status, window, siteUrl);
      cacheService.set(cacheKey, emptyResult, GSC_CACHE_TTL);
      return emptyResult;
    }

    try {
      const data = await this.querySearchConsoleApi(siteUrl, window);
      cacheService.set(cacheKey, data, GSC_CACHE_TTL);
      return data;
    } catch (err: any) {
      winstonLogger.warn('[GSC_API_ERROR] Failed to query Google Search Console API', {
        error: err.message,
      });
      return this.getNotConfiguredResponse('PARTIALLY_CONFIGURED', window, siteUrl, err.message);
    }
  }

  /**
   * Queries real Google Search Console Search Analytics API.
   */
  private async querySearchConsoleApi(
    siteUrl: string,
    window: SearchConsoleWindow
  ): Promise<SearchConsoleDashboardData> {
    const clientEmail = process.env.GOOGLE_SEARCH_CONSOLE_CLIENT_EMAIL!;
    const rawKey = process.env.GOOGLE_SEARCH_CONSOLE_PRIVATE_KEY!;
    const privateKey = rawKey.replace(/\\n/g, '\n');

    const auth = new JWT({
      email: clientEmail,
      key: privateKey,
      scopes: ['https://www.googleapis.com/auth/webmasters.readonly'],
    });

    const tokenResponse = await auth.authorize();
    const accessToken = tokenResponse.access_token;
    if (!accessToken) {
      throw new Error('Failed to acquire Google Search Console OAuth access token.');
    }

    const days = window === '7d' ? 7 : window === '28d' ? 28 : 30;
    const now = new Date();
    // GSC data typically has a 2-day delay
    const endDate = new Date(now.getTime() - 2 * 24 * 60 * 60 * 1000);
    const startDate = new Date(endDate.getTime() - days * 24 * 60 * 60 * 1000);
    const prevEndDate = new Date(startDate.getTime() - 1 * 24 * 60 * 60 * 1000);
    const prevStartDate = new Date(prevEndDate.getTime() - days * 24 * 60 * 60 * 1000);

    const formatDate = (d: Date) => d.toISOString().split('T')[0];

    const currentUrl = `https://www.googleapis.com/webmasters/v3/sites/${encodeURIComponent(
      siteUrl
    )}/searchAnalytics/query`;

    // 1. Fetch current window queries & pages for news
    const [currentQueriesRes, prevQueriesRes, currentPagesRes] = await Promise.all([
      axios.post(
        currentUrl,
        {
          startDate: formatDate(startDate),
          endDate: formatDate(endDate),
          dimensions: ['query'],
          dimensionFilterGroups: [
            {
              filters: [
                {
                  dimension: 'page',
                  operator: 'contains',
                  expression: '/news',
                },
              ],
            },
          ],
          rowLimit: 100,
        },
        {
          headers: { Authorization: `Bearer ${accessToken}` },
          timeout: 10000,
        }
      ),
      axios.post(
        currentUrl,
        {
          startDate: formatDate(prevStartDate),
          endDate: formatDate(prevEndDate),
          dimensions: ['query'],
          dimensionFilterGroups: [
            {
              filters: [
                {
                  dimension: 'page',
                  operator: 'contains',
                  expression: '/news',
                },
              ],
            },
          ],
          rowLimit: 100,
        },
        {
          headers: { Authorization: `Bearer ${accessToken}` },
          timeout: 10000,
        }
      ),
      axios.post(
        currentUrl,
        {
          startDate: formatDate(startDate),
          endDate: formatDate(endDate),
          dimensions: ['page'],
          dimensionFilterGroups: [
            {
              filters: [
                {
                  dimension: 'page',
                  operator: 'contains',
                  expression: '/news',
                },
              ],
            },
          ],
          rowLimit: 50,
        },
        {
          headers: { Authorization: `Bearer ${accessToken}` },
          timeout: 10000,
        }
      ),
    ]);

    const currentRows: any[] = currentQueriesRes.data?.rows || [];
    const prevRows: any[] = prevQueriesRes.data?.rows || [];
    const pageRows: any[] = currentPagesRes.data?.rows || [];

    // Aggregate overall metrics
    let totalClicks = 0;
    let totalImpressions = 0;
    let sumPositionTimesImpressions = 0;

    for (const r of currentRows) {
      totalClicks += r.clicks || 0;
      totalImpressions += r.impressions || 0;
      sumPositionTimesImpressions += (r.position || 0) * (r.impressions || 1);
    }

    let prevClicks = 0;
    let prevImpressions = 0;
    for (const r of prevRows) {
      prevClicks += r.clicks || 0;
      prevImpressions += r.impressions || 0;
    }

    const avgCtr = totalImpressions > 0 ? (totalClicks / totalImpressions) * 100 : 0;
    const prevCtr = prevImpressions > 0 ? (prevClicks / prevImpressions) * 100 : 0;
    const avgPos = totalImpressions > 0 ? sumPositionTimesImpressions / totalImpressions : 0;

    const clicksDeltaPct = this.computeDeltaPct(totalClicks, prevClicks);
    const impressionsDeltaPct = this.computeDeltaPct(totalImpressions, prevImpressions);
    const ctrDeltaPct = this.computeDeltaPct(avgCtr, prevCtr);

    // Build previous lookup for trend calculation
    const prevMap = new Map<string, { clicks: number; impressions: number; position: number }>();
    for (const r of prevRows) {
      const q = (r.keys?.[0] || '').toLowerCase().trim();
      if (q) {
        prevMap.set(q, {
          clicks: r.clicks || 0,
          impressions: r.impressions || 0,
          position: r.position || 0,
        });
      }
    }

    const topQueries: SearchQueryItem[] = currentRows.map((r) => {
      const query = r.keys?.[0] || '';
      const clicks = r.clicks || 0;
      const impressions = r.impressions || 0;
      const ctr = Number(((r.ctr || (impressions > 0 ? clicks / impressions : 0)) * 100).toFixed(2));
      const position = Number((r.position || 0).toFixed(1));
      const intent = this.classifyRailwayIntent(query);

      const prev = prevMap.get(query.toLowerCase().trim());
      const deltaClicks = prev ? clicks - prev.clicks : clicks;
      const deltaImpressions = prev ? impressions - prev.impressions : impressions;

      let trend: 'RISING' | 'DECLINING' | 'STABLE' = 'STABLE';
      if (deltaClicks > 0 || deltaImpressions > 10) trend = 'RISING';
      else if (deltaClicks < 0 || deltaImpressions < -10) trend = 'DECLINING';

      return {
        query,
        clicks,
        impressions,
        ctr,
        position,
        intent,
        trend,
        delta_clicks: deltaClicks,
        delta_impressions: deltaImpressions,
      };
    });

    const risingQueries = topQueries
      .filter((q) => q.trend === 'RISING')
      .sort((a, b) => (b.delta_clicks || 0) - (a.delta_clicks || 0))
      .slice(0, 10);

    const decliningQueries = topQueries
      .filter((q) => q.trend === 'DECLINING')
      .sort((a, b) => (a.delta_clicks || 0) - (b.delta_clicks || 0))
      .slice(0, 10);

    const topPages: SearchPageItem[] = pageRows.map((r) => {
      const pageUrl = r.keys?.[0] || '';
      const slug = pageUrl.split('/news/')[1]?.split('?')[0]?.replace(/\/$/, '') || '';
      return {
        page_url: pageUrl,
        slug,
        title: this.formatPageTitleFromSlug(slug),
        clicks: r.clicks || 0,
        impressions: r.impressions || 0,
        ctr: Number(((r.ctr || (r.impressions > 0 ? r.clicks / r.impressions : 0)) * 100).toFixed(2)),
        position: Number((r.position || 0).toFixed(1)),
      };
    });

    // Content & SEO Opportunities
    const ctrOpportunities: CtrOpportunity[] = topQueries
      .filter((q) => q.impressions >= 20 && q.ctr < 2.5 && q.position <= 20)
      .map((q) => ({
        query: q.query,
        impressions: q.impressions,
        ctr: q.ctr,
        position: q.position,
        recommendation: `High visibility (${q.impressions} impressions, rank #${q.position}) but low CTR (${q.ctr}%). Refine article title and meta description with clear action hook.`,
      }))
      .slice(0, 5);

    const positionOpportunities: PositionOpportunity[] = topQueries
      .filter((q) => q.position >= 11 && q.position <= 25 && q.impressions >= 15)
      .map((q) => ({
        query: q.query,
        position: q.position,
        clicks: q.clicks,
        impressions: q.impressions,
        recommendation: `Page 2 ranking (#${q.position}). Add specific FAQs, affected train numbers, and internal links from live status pages to push into top 5 search positions.`,
      }))
      .slice(0, 5);

    return {
      status: 'CONNECTED',
      is_configured: true,
      site_url: siteUrl,
      window,
      generated_at: new Date().toISOString(),
      metrics: {
        clicks: totalClicks,
        impressions: totalImpressions,
        ctr: Number(avgCtr.toFixed(2)),
        avg_position: Number(avgPos.toFixed(1)),
        clicks_delta_pct: clicksDeltaPct,
        impressions_delta_pct: impressionsDeltaPct,
        ctr_delta_pct: ctrDeltaPct,
        position_delta_pct: 0,
      },
      top_queries: topQueries,
      top_pages: topPages,
      rising_queries: risingQueries,
      declining_queries: decliningQueries,
      ctr_opportunities: ctrOpportunities,
      position_opportunities: positionOpportunities,
    };
  }

  /**
   * Deterministic railway search intent classification rules.
   */
  classifyRailwayIntent(query: string): RailwaySearchIntent {
    const q = query.toLowerCase().trim();

    if (/\b(live status|running status|where is my train|delay status|current location)\b/.test(q)) return 'LIVE_TRACKING';
    if (/\b(pnr|pnr status|rac|waitlist|waiting list|charting)\b/.test(q)) return 'PNR';
    if (/\b(tatkal|premium tatkal|tatkal timing|tatkal quota)\b/.test(q)) return 'TATKAL';
    if (/\b(irctc|irctc login|refund rule|ticket refund|tbr|master list)\b/.test(q)) return 'IRCTC';
    if (/\b(special trains?|summer special|festival special|puja special|diwali special|holi special|clone)\b/.test(q)) return 'SPECIAL_TRAIN';
    if (/\b(cancel|cancelled|radd|cancellation)\b/.test(q)) return 'CANCELLATION';
    if (/\b(divert|diverted|diversion|route change)\b/.test(q)) return 'DIVERSION';
    if (/\b\d{5}\b/.test(q) || /\b(vande bharat|amrit bharat|rajdhani|shatabdi|duronto|garib rath|tejas|express|superfast|mail)\b/.test(q))
      return 'TRAIN';
    if (/\b(station|junction|terminal|cantt|platform|ndls|cstm|bct|sbc|mas|hwh|pnbe|gkp)\b/.test(q)) return 'STATION';
    if (/\b(timetable|time table|schedule|timing|departure|arrival)\b/.test(q)) return 'TIMETABLE';
    if (/\b(to|between|route|distance|fare)\b/.test(q)) return 'ROUTE';

    return 'OTHER_RAILWAY';
  }

  /**
   * Percentage change helper between two numeric periods.
   */
  computeDeltaPct(current: number, previous: number): number {
    if (previous === 0) {
      return current > 0 ? 100 : 0;
    }
    return Number((((current - previous) / previous) * 100).toFixed(1));
  }

  /**
   * Safe empty response when Search Console is not configured or in setup state.
   */
  private getNotConfiguredResponse(
    status: SearchConsoleStatus,
    window: SearchConsoleWindow,
    siteUrl: string,
    errorHint?: string
  ): SearchConsoleDashboardData {
    return {
      status,
      is_configured: false,
      site_url: siteUrl,
      window,
      generated_at: new Date().toISOString(),
      metrics: {
        clicks: 0,
        impressions: 0,
        ctr: 0,
        avg_position: 0,
        clicks_delta_pct: 0,
        impressions_delta_pct: 0,
        ctr_delta_pct: 0,
        position_delta_pct: 0,
      },
      top_queries: [],
      top_pages: [],
      rising_queries: [],
      declining_queries: [],
      ctr_opportunities: [],
      position_opportunities: [],
      setup_requirements: {
        status_summary:
          status === 'PARTIALLY_CONFIGURED'
            ? `Search Console credentials are partially configured (${errorHint || 'one or more keys missing/invalid'}).`
            : 'Google Search Console Search Analytics API is ready to connect.',
        missing_keys: [
          !process.env.GOOGLE_SEARCH_CONSOLE_CLIENT_EMAIL ? 'GOOGLE_SEARCH_CONSOLE_CLIENT_EMAIL' : null,
          !process.env.GOOGLE_SEARCH_CONSOLE_PRIVATE_KEY ? 'GOOGLE_SEARCH_CONSOLE_PRIVATE_KEY' : null,
        ].filter(Boolean) as string[],
        steps: [
          '1. Verify domain ownership for https://www.trayago.in in Google Search Console.',
          '2. In Google Cloud Console, enable "Google Search Console API" (Webmasters API).',
          '3. Create a Service Account with JSON credentials and add its email as a "Restricted User" or "Full User" in Search Console.',
          '4. Add GOOGLE_SEARCH_CONSOLE_CLIENT_EMAIL and GOOGLE_SEARCH_CONSOLE_PRIVATE_KEY to server/.env.',
        ],
        documentation_url: 'https://developers.google.com/webmaster-tools/v1/searchanalytics/query',
      },
    };
  }

  private formatPageTitleFromSlug(slug: string): string {
    if (!slug) return 'Trayago Railway News Bulletin';
    return slug
      .split('-')
      .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
      .join(' ');
  }
}

export const googleSearchConsoleService = new GoogleSearchConsoleService();
