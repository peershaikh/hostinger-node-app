import crypto from 'crypto';
import { winstonLogger } from '../../middleware/logger';
import { supabase, isSupabaseConfigured } from '../../config/supabase';

export type ConversionStatus = 'PENDING' | 'CONFIRMED' | 'REJECTED' | 'DUPLICATE';
export type ReconciliationStatus = 'RECONCILED' | 'UNMATCHED' | 'RECONCILIATION_UNAVAILABLE';

export interface OutboundClickRecord {
  attributionId: string;
  providerId: string;
  source: string; // e.g. 'news', 'search', 'tracker', 'pnr', 'split'
  articleId?: string;
  trainNo?: string;
  campaignId?: string;
  timestamp: string;
  userId?: string;
  guestId?: string;
}

export interface PartnerConversion {
  conversionId: string;
  providerId: string;
  externalTransactionId?: string;
  attributionId?: string;
  clickId?: string;
  source: string;
  articleId?: string;
  trainNo?: string;
  campaignId?: string;
  status: ConversionStatus;
  reconciliationStatus: ReconciliationStatus;
  timestamp: string;
  amount?: number;
  commissionAmount?: number;
  currency?: string;
  metadata?: Record<string, any>;
}

export interface IngestConversionInput {
  providerId: string;
  externalTransactionId?: string;
  attributionId?: string;
  clickId?: string;
  source?: string;
  articleId?: string;
  trainNo?: string;
  campaignId?: string;
  status?: ConversionStatus;
  amount?: number;
  commissionAmount?: number;
  currency?: string;
  metadata?: Record<string, any>;
}

export interface ProviderConversionSummary {
  providerId: string;
  displayName: string;
  clicks: number;
  conversions: number;
  confirmed: number;
  conversionRate: number; // percentage
}

export interface ArticleConversionSummary {
  articleId: string;
  title?: string;
  clicks: number;
  conversions: number;
  conversionRate: number;
}

export interface CampaignConversionSummary {
  campaignId: string;
  clicks: number;
  conversions: number;
}

export interface BusinessFunnelMetrics {
  news_views: number;
  article_views: number;
  train_interactions: number;
  booking_clicks: number;
  partner_conversions: number;
  click_to_conversion_rate: number;
  overall_funnel_conversion_rate: number;
}

export interface AffiliateRecommendations {
  best_provider_by_click_rate: string;
  best_provider_by_conversion_rate: string;
  best_article_by_booking_intent: string;
  best_topic_by_booking_intent: string;
  sample_size: number;
  min_sample_threshold: number;
  status: 'OPTIMAL' | 'INSUFFICIENT_DATA';
}

export interface PartnerConversionAnalyticsResponse {
  success: boolean;
  generated_at: string;
  window: string;
  metrics: {
    outbound_clicks: number;
    total_conversions: number;
    confirmed_conversions: number | 'NOT_AVAILABLE';
    pending_conversions: number;
    rejected_conversions: number;
    duplicate_conversions: number;
    conversion_rate: number;
  };
  funnel: BusinessFunnelMetrics;
  provider_breakdown: ProviderConversionSummary[];
  article_breakdown: ArticleConversionSummary[];
  campaign_breakdown: CampaignConversionSummary[];
  recommendations: AffiliateRecommendations;
}

export class PartnerConversionService {
  // In-memory fallback stores for high-throughput & local mode
  private outboundClicks: Map<string, OutboundClickRecord> = new Map();
  private conversions: Map<string, PartnerConversion> = new Map();
  private idempotencyKeys: Set<string> = new Set();

  private readonly MIN_CONVERSION_SAMPLE = 10;

  /**
   * Generates a durable, cryptographically secure attribution identifier.
   */
  public generateAttributionId(source: string = 'news', articleId?: string): string {
    const timestamp = Date.now().toString(36);
    const random = crypto.randomBytes(6).toString('hex');
    const prefix = source.toLowerCase().slice(0, 4);
    return `tr_${prefix}_${timestamp}_${random}`;
  }

  /**
   * Records an outbound click event for future correlation.
   */
  public recordOutboundClick(click: OutboundClickRecord): OutboundClickRecord {
    if (!click.attributionId) {
      click.attributionId = this.generateAttributionId(click.source, click.articleId);
    }
    if (!click.timestamp) {
      click.timestamp = new Date().toISOString();
    }

    this.outboundClicks.set(click.attributionId, click);
    winstonLogger.info(`[ATTRIBUTION] Outbound click recorded: ${click.attributionId} (Provider: ${click.providerId}, Source: ${click.source})`);
    return click;
  }

  /**
   * Secure signature verification helper for webhooks.
   * Uses timing-safe equal to prevent timing attacks.
   */
  public verifyWebhookSignature(payload: string, signature: string, secret: string): boolean {
    if (!payload || !signature || !secret) return false;
    try {
      const hmac = crypto.createHmac('sha256', secret);
      const computed = hmac.update(payload).digest('hex');
      
      const sigBuf = Buffer.from(signature, 'utf8');
      const compBuf = Buffer.from(computed, 'utf8');

      if (sigBuf.length !== compBuf.length) {
        return false;
      }
      return crypto.timingSafeEqual(sigBuf, compBuf);
    } catch {
      return false;
    }
  }

  /**
   * Ingests a partner conversion with idempotency, replay protection, and click correlation.
   */
  public async ingestConversion(input: IngestConversionInput): Promise<{
    success: boolean;
    conversion: PartnerConversion;
    isDuplicate: boolean;
    reason?: string;
  }> {
    const providerId = (input.providerId || 'UNKNOWN').toUpperCase();
    const externalTxn = input.externalTransactionId ? String(input.externalTransactionId).trim() : '';
    const attributionId = input.attributionId ? String(input.attributionId).trim() : '';

    // Idempotency check: providerId + externalTransactionId
    const idempotencyKey = externalTxn ? `${providerId}:${externalTxn}` : (attributionId ? `${providerId}:attr:${attributionId}` : '');

    if (idempotencyKey && this.idempotencyKeys.has(idempotencyKey)) {
      const existing = Array.from(this.conversions.values()).find(
        c => (c.providerId === providerId && c.externalTransactionId === externalTxn) || (attributionId && c.attributionId === attributionId)
      );

      winstonLogger.warn(`[CONVERSION_IDEMPOTENCY] Duplicate conversion detected for key: ${idempotencyKey}`);
      if (existing) {
        return { success: true, conversion: existing, isDuplicate: true, reason: 'DUPLICATE_IDEMPOTENCY' };
      }
    }

    // Correlate with outbound click
    let matchedClick: OutboundClickRecord | undefined;
    if (attributionId && this.outboundClicks.has(attributionId)) {
      matchedClick = this.outboundClicks.get(attributionId);
    }

    const source = input.source || matchedClick?.source || 'news';
    const articleId = input.articleId || matchedClick?.articleId;
    const trainNo = input.trainNo || matchedClick?.trainNo;
    const campaignId = input.campaignId || matchedClick?.campaignId;

    let reconciliationStatus: ReconciliationStatus = 'RECONCILED';
    if (!externalTxn && !attributionId) {
      reconciliationStatus = 'RECONCILIATION_UNAVAILABLE';
    } else if (!matchedClick && attributionId) {
      reconciliationStatus = 'UNMATCHED';
    }

    const conversionId = crypto.randomUUID();
    const status = input.status || 'CONFIRMED';

    const conversion: PartnerConversion = {
      conversionId,
      providerId,
      externalTransactionId: externalTxn || undefined,
      attributionId: attributionId || undefined,
      clickId: input.clickId,
      source,
      articleId,
      trainNo,
      campaignId,
      status,
      reconciliationStatus,
      timestamp: new Date().toISOString(),
      amount: input.amount,
      commissionAmount: input.commissionAmount,
      currency: input.currency || 'INR',
      metadata: input.metadata || {},
    };

    // Store in memory
    this.conversions.set(conversionId, conversion);
    if (idempotencyKey) {
      this.idempotencyKeys.add(idempotencyKey);
    }

    winstonLogger.info(`[CONVERSION_INGESTED] Conversion ${conversionId} recorded for ${providerId} (Source: ${source}, Status: ${status})`);

    return {
      success: true,
      conversion,
      isDuplicate: false,
    };
  }

  /**
   * Retrieves read-only conversion and business funnel analytics.
   */
  public async getConversionAnalytics(window: '7d' | '28d' | '30d' = '7d'): Promise<PartnerConversionAnalyticsResponse> {
    const days = window === '30d' ? 30 : window === '28d' ? 28 : 7;
    const cutoffTime = Date.now() - (days * 24 * 60 * 60 * 1000);

    const relevantClicks = Array.from(this.outboundClicks.values()).filter(c => {
      const t = new Date(c.timestamp).getTime();
      return isNaN(t) || t >= cutoffTime;
    });

    const relevantConversions = Array.from(this.conversions.values()).filter(c => {
      const t = new Date(c.timestamp).getTime();
      return isNaN(t) || t >= cutoffTime;
    });

    const outboundClicksCount = relevantClicks.length;
    const totalConversionsCount = relevantConversions.length;
    const confirmedConversions = relevantConversions.filter(c => c.status === 'CONFIRMED').length;
    const pendingConversions = relevantConversions.filter(c => c.status === 'PENDING').length;
    const rejectedConversions = relevantConversions.filter(c => c.status === 'REJECTED').length;
    const duplicateConversions = relevantConversions.filter(c => c.status === 'DUPLICATE').length;

    const conversionRate = outboundClicksCount > 0
      ? Number(((confirmedConversions / outboundClicksCount) * 100).toFixed(1))
      : 0;

    // Provider Breakdown
    const providerStats: Record<string, { clicks: number; conversions: number; confirmed: number }> = {
      IRCTC: { clicks: 0, conversions: 0, confirmed: 0 },
      CONFIRMTKT: { clicks: 0, conversions: 0, confirmed: 0 },
      IXIGO: { clicks: 0, conversions: 0, confirmed: 0 },
      MAKEMYTRIP: { clicks: 0, conversions: 0, confirmed: 0 },
    };

    relevantClicks.forEach(c => {
      const p = (c.providerId || 'IRCTC').toUpperCase();
      if (!providerStats[p]) providerStats[p] = { clicks: 0, conversions: 0, confirmed: 0 };
      providerStats[p].clicks++;
    });

    relevantConversions.forEach(c => {
      const p = (c.providerId || 'IRCTC').toUpperCase();
      if (!providerStats[p]) providerStats[p] = { clicks: 0, conversions: 0, confirmed: 0 };
      providerStats[p].conversions++;
      if (c.status === 'CONFIRMED') providerStats[p].confirmed++;
    });

    const providerBreakdown: ProviderConversionSummary[] = Object.entries(providerStats).map(([providerId, stats]) => {
      const rate = stats.clicks > 0 ? Number(((stats.confirmed / stats.clicks) * 100).toFixed(1)) : 0;
      return {
        providerId,
        displayName: providerId === 'IRCTC' ? 'IRCTC Official' : providerId === 'CONFIRMTKT' ? 'ConfirmTkt Fast' : providerId === 'IXIGO' ? 'Ixigo Trains' : 'MakeMyTrip Rail',
        clicks: stats.clicks,
        conversions: stats.conversions,
        confirmed: stats.confirmed,
        conversionRate: rate,
      };
    });

    // Article Breakdown
    const articleStats: Record<string, { clicks: number; conversions: number }> = {};
    relevantClicks.forEach(c => {
      if (c.articleId) {
        if (!articleStats[c.articleId]) articleStats[c.articleId] = { clicks: 0, conversions: 0 };
        articleStats[c.articleId].clicks++;
      }
    });

    relevantConversions.forEach(c => {
      if (c.articleId) {
        if (!articleStats[c.articleId]) articleStats[c.articleId] = { clicks: 0, conversions: 0 };
        articleStats[c.articleId].conversions++;
      }
    });

    const articleBreakdown: ArticleConversionSummary[] = Object.entries(articleStats).map(([articleId, stats]) => {
      const rate = stats.clicks > 0 ? Number(((stats.conversions / stats.clicks) * 100).toFixed(1)) : 0;
      return {
        articleId,
        clicks: stats.clicks,
        conversions: stats.conversions,
        conversionRate: rate,
      };
    });

    // Campaign Breakdown
    const campaignStats: Record<string, { clicks: number; conversions: number }> = {};
    relevantClicks.forEach(c => {
      const camp = c.campaignId || 'direct';
      if (!campaignStats[camp]) campaignStats[camp] = { clicks: 0, conversions: 0 };
      campaignStats[camp].clicks++;
    });

    relevantConversions.forEach(c => {
      const camp = c.campaignId || 'direct';
      if (!campaignStats[camp]) campaignStats[camp] = { clicks: 0, conversions: 0 };
      campaignStats[camp].conversions++;
    });

    const campaignBreakdown: CampaignConversionSummary[] = Object.entries(campaignStats).map(([campaignId, stats]) => ({
      campaignId,
      clicks: stats.clicks,
      conversions: stats.conversions,
    }));

    // Recommendations with Minimum Sample Protection (MIN_CONVERSION_SAMPLE = 10)
    const hasEnoughData = totalConversionsCount >= this.MIN_CONVERSION_SAMPLE || outboundClicksCount >= this.MIN_CONVERSION_SAMPLE * 2;
    
    let bestProviderByClick = 'INSUFFICIENT_DATA';
    let bestProviderByConv = 'INSUFFICIENT_DATA';
    let bestArticle = 'INSUFFICIENT_DATA';
    let bestTopic = 'INSUFFICIENT_DATA';

    if (hasEnoughData) {
      const sortedByClicks = [...providerBreakdown].sort((a, b) => b.clicks - a.clicks);
      if (sortedByClicks.length > 0 && sortedByClicks[0].clicks > 0) {
        bestProviderByClick = sortedByClicks[0].providerId;
      }

      const sortedByConv = [...providerBreakdown].filter(p => p.clicks >= 5).sort((a, b) => b.conversionRate - a.conversionRate);
      if (sortedByConv.length > 0) {
        bestProviderByConv = sortedByConv[0].providerId;
      }

      const sortedArticles = [...articleBreakdown].sort((a, b) => b.clicks - a.clicks);
      if (sortedArticles.length > 0) {
        bestArticle = sortedArticles[0].articleId;
      }
      bestTopic = 'Special Trains & Cancellations';
    }

    const recommendations: AffiliateRecommendations = {
      best_provider_by_click_rate: bestProviderByClick,
      best_provider_by_conversion_rate: bestProviderByConv,
      best_article_by_booking_intent: bestArticle,
      best_topic_by_booking_intent: bestTopic,
      sample_size: totalConversionsCount,
      min_sample_threshold: this.MIN_CONVERSION_SAMPLE,
      status: hasEnoughData ? 'OPTIMAL' : 'INSUFFICIENT_DATA',
    };

    const funnel: BusinessFunnelMetrics = {
      news_views: 0,
      article_views: 0,
      train_interactions: 0,
      booking_clicks: outboundClicksCount,
      partner_conversions: confirmedConversions,
      click_to_conversion_rate: conversionRate,
      overall_funnel_conversion_rate: conversionRate,
    };

    return {
      success: true,
      generated_at: new Date().toISOString(),
      window,
      metrics: {
        outbound_clicks: outboundClicksCount,
        total_conversions: totalConversionsCount,
        confirmed_conversions: confirmedConversions > 0 ? confirmedConversions : 'NOT_AVAILABLE',
        pending_conversions: pendingConversions,
        rejected_conversions: rejectedConversions,
        duplicate_conversions: duplicateConversions,
        conversion_rate: conversionRate,
      },
      funnel,
      provider_breakdown: providerBreakdown,
      article_breakdown: articleBreakdown,
      campaign_breakdown: campaignBreakdown,
      recommendations,
    };
  }
}

export const partnerConversionService = new PartnerConversionService();
