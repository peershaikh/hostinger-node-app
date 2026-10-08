/**
 * ============================================================================
 * FINOPS LEDGER AGGREGATION SERVICE
 * Phase: STEP 2D — Cost & Usage Aggregation
 * Target: public.api_provider_transaction_ledger
 * 
 * CANONICAL POSTGRESQL AGGREGATION SPECIFICATION:
 * ----------------------------------------------------------------------------
 * SELECT
 *   COUNT(*) AS total_attempts,
 *   COUNT(*) FILTER (WHERE success = true) AS successful_attempts,
 *   COUNT(*) FILTER (WHERE success = false) AS failed_attempts,
 *   COUNT(*) FILTER (WHERE is_retry = false AND is_fallback = false) AS q1_primary_first,
 *   COUNT(*) FILTER (WHERE is_retry = false AND is_fallback = true)  AS q2_fallback_first,
 *   COUNT(*) FILTER (WHERE is_retry = true  AND is_fallback = false) AS q3_primary_retry,
 *   COUNT(*) FILTER (WHERE is_retry = true  AND is_fallback = true)  AS q4_fallback_retry,
 *   COUNT(*) FILTER (WHERE is_retry = true)  AS total_retries,
 *   COUNT(*) FILTER (WHERE is_fallback = true) AS total_fallbacks,
 *   SUM(COALESCE(tokens_in, 0))  FILTER (WHERE event_type = 'ai') AS total_tokens_in,
 *   SUM(COALESCE(tokens_out, 0)) FILTER (WHERE event_type = 'ai') AS total_tokens_out,
 *   SUM(COALESCE(applied_rate, 0)) FILTER (WHERE event_type = 'ai') AS ai_cost_usd
 * FROM public.api_provider_transaction_ledger
 * WHERE latency_ms IS NOT NULL
 *   AND caller_feature IS NOT NULL
 *   AND event_type != 'split'
 *   AND timestamp >= $1 AND timestamp <= $2;
 * ============================================================================
 */

import { supabase, isSupabaseConfigured } from '../../config/supabase';
import { winstonLogger } from '../../middleware/logger';
import { smartAvailabilityMetrics } from '../smartAvailabilityMetrics';

export const WIRE_BOUNDARY_CLAUSE = "latency_ms IS NOT NULL AND caller_feature IS NOT NULL AND event_type != 'split'";

export interface QuadrantCounts {
  /** Q1: First attempt on primary provider (no retry, no fallback) */
  q1_primary_first: number;
  /** Q2: First attempt on fallback provider */
  q2_fallback_first: number;
  /** Q3: Repeated retry on primary provider */
  q3_primary_retry: number;
  /** Q4: Repeated retry on fallback provider */
  q4_fallback_retry: number;
}

export interface FinOpsAttempts {
  total_gross_attempts: number;
  successful_attempts: number;
  failed_attempts: number;
  success_rate_pct: number;
  quadrants: QuadrantCounts;
  /** Q3 + Q4 (Mutually exclusive sum, zero double-counting) */
  total_retries: number;
  /** Q2 + Q4 (Mutually exclusive sum, zero double-counting) */
  total_fallbacks: number;
  retry_rate_pct: number;
  fallback_rate_pct: number;
}

export interface FinOpsCosts {
  total_metered_cost_usd: number;
  total_metered_cost_inr?: number;
  ai_metered_cost_usd: number;
  railway_metered_cost_usd: number;
  railway_pricing_status: string;
  railway_upstream_call_count: number;
}

export interface FinOpsAiModelDetails {
  attempts: number;
  successful_attempts: number;
  failed_attempts: number;
  tokens_in: number;
  tokens_out: number;
  cost_usd: number;
}

export interface FinOpsAiDetails {
  total_ai_attempts: number;
  successful_ai_attempts: number;
  failed_ai_attempts: number;
  total_tokens_in: number;
  total_tokens_out: number;
  total_tokens: number;
  ai_cost_usd: number;
  by_model: Record<string, FinOpsAiModelDetails>;
}

export interface FinOpsProviderDetails {
  provider_name: string;
  total_attempts: number;
  successful_attempts: number;
  failed_attempts: number;
  retry_attempts: number;
  fallback_attempts: number;
  avg_latency_ms: number;
  metered_cost_usd: number;
  pricing_status: string;
}

export interface FinOpsEventDetails {
  event_type: string;
  total_attempts: number;
  successful_attempts: number;
  failed_attempts: number;
  metered_cost_usd: number;
}

export interface FinOpsFeatureDetails {
  caller_feature: string;
  total_attempts: number;
  successful_attempts: number;
  failed_attempts: number;
  metered_cost_usd: number;
}

export interface FinOpsUserTierSummary {
  attempts: number;
  metered_cost_usd: number;
}

export interface FinOpsUserSegmentation {
  safar_pro_paid: FinOpsUserTierSummary;
  free_registered: FinOpsUserTierSummary;
  beta_users: FinOpsUserTierSummary;
  admin_internal: FinOpsUserTierSummary;
  background_cron: FinOpsUserTierSummary;
  guest_anonymous: FinOpsUserTierSummary;
}

export interface FinOpsCacheMetrics {
  l1_hits: number;
  l2_hits: number;
  provider_calls: number;
  singleflight_hits: number;
  redis_failures: number;
  cache_latency_avg_ms: number;
  cache_hit_ratio_pct: number;
  source: string;
}

export interface FinOpsDailyBucket {
  date: string;
  total_attempts: number;
  successful_attempts: number;
  failed_attempts: number;
  retries: number;
  fallbacks: number;
  metered_cost_usd: number;
}

export interface FinOpsMonthlyBucket {
  month: string;
  total_attempts: number;
  successful_attempts: number;
  failed_attempts: number;
  retries: number;
  fallbacks: number;
  metered_cost_usd: number;
}

export interface FinOpsOverview {
  period: {
    start: string;
    end: string;
    window: '24h' | 'today' | 'month' | 'custom';
  };
  wire_boundary: string;
  attempts: FinOpsAttempts;
  costs: FinOpsCosts;
  ai: FinOpsAiDetails;
  by_provider: Record<string, FinOpsProviderDetails>;
  by_event_type: Record<string, FinOpsEventDetails>;
  by_caller_feature: Record<string, FinOpsFeatureDetails>;
  user_segmentation: FinOpsUserSegmentation;
  daily?: FinOpsDailyBucket[];
  monthly?: FinOpsMonthlyBucket[];
  cache: FinOpsCacheMetrics;
  generated_at: string;
}

export interface FinOpsQueryOptions {
  window?: '24h' | 'today' | 'month' | 'custom';
  startDate?: string;
  endDate?: string;
  forceRefresh?: boolean;
  supabaseClient?: any;
}

const KNOWN_RAILWAY_PROVIDERS = new Set(['IRCTC', 'RAILKIT', 'RAILKIT_V2', 'RAILRADAR']);
const KNOWN_AI_PROVIDERS = new Set(['DEEPSEEK', 'GEMINI', 'OPENAI']);
export const supabaseAdmin = supabase;

export class LedgerAggregationService {
  private cache = new Map<string, { data: FinOpsOverview; expiresAt: number }>();
  private readonly CACHE_TTL_MS = 30_000; // 30 seconds cache to protect DB from rapid dashboard polling

  /**
   * Resolve time boundaries using PostgreSQL server-side UTC time semantics.
   */
  public resolveTimeBoundaries(options: FinOpsQueryOptions = {}): { startIso: string; endIso: string; window: '24h' | 'today' | 'month' | 'custom' } {
    const window = options.window || '24h';
    const now = new Date();

    if (window === 'custom') {
      const startIso = options.startDate ? new Date(options.startDate).toISOString() : new Date(now.getTime() - 24 * 60 * 60 * 1000).toISOString();
      const endIso = options.endDate ? new Date(options.endDate).toISOString() : now.toISOString();
      return {
        startIso,
        endIso,
        window: 'custom'
      };
    }

    if (window === 'today') {
      const startOfDay = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), 0, 0, 0, 0));
      return {
        startIso: startOfDay.toISOString(),
        endIso: now.toISOString(),
        window: 'today'
      };
    }

    if (window === 'month') {
      const startOfMonth = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1, 0, 0, 0, 0));
      return {
        startIso: startOfMonth.toISOString(),
        endIso: now.toISOString(),
        window: 'month'
      };
    }

    // Default: '24h' rolling window
    const twentyFourHoursAgo = new Date(now.getTime() - 24 * 60 * 60 * 1000);
    return {
      startIso: twentyFourHoursAgo.toISOString(),
      endIso: now.toISOString(),
      window: '24h'
    };
  }

  /**
   * Generates the complete FinOps Overview by delegating to PostgreSQL RPC get_finops_overview.
   * Strictly respects the Step 2D historical wire boundary:
   *   WHERE latency_ms IS NOT NULL AND caller_feature IS NOT NULL AND event_type != 'split'
   */
  public async getFinOpsOverview(options: FinOpsQueryOptions = {}): Promise<FinOpsOverview> {
    const { startIso, endIso, window } = this.resolveTimeBoundaries(options);
    const cacheKey = `finops_${window}_${startIso}_${endIso}`;

    if (!options.forceRefresh) {
      const cached = this.cache.get(cacheKey);
      if (cached && cached.expiresAt > Date.now()) {
        return cached.data;
      }
    }

    const client = options.supabaseClient || supabaseAdmin;

    // If Supabase is unconfigured, return safe empty zeroed structure with live cache metrics
    if (!isSupabaseConfigured() && !options.supabaseClient) {
      return this.buildZeroedOverview(startIso, endIso, window);
    }

    try {
      // ─── 1. Authoritative PostgreSQL RPC Delegation ─────────────────────────
      // Pure SQL server-side aggregation via public.get_finops_overview(p_start_time, p_end_time, p_window)
      const rpcParams = {
        p_start_time: window === 'custom' ? startIso : null,
        p_end_time: window === 'custom' ? endIso : null,
        p_window: window
      };

      const { data: rpcData, error: rpcError } = await client.rpc('get_finops_overview', rpcParams);

      if (rpcError) {
        winstonLogger.error(`[FINOPS_INTEGRATION_ERROR] get_finops_overview RPC failed: ${rpcError.message}`);
        return this.buildZeroedOverview(startIso, endIso, window);
      }

      if (!rpcData || typeof rpcData !== 'object') {
        winstonLogger.warn(`[FINOPS_INTEGRATION_WARN] get_finops_overview RPC returned invalid or null data`);
        return this.buildZeroedOverview(startIso, endIso, window);
      }

      // ─── 2. Cache Metrics Sourced Authoritatively In-Memory ───────────────────
      // Sourced directly from smartAvailabilityMetrics (zero queries to ledger)
      const cacheSnapshot = smartAvailabilityMetrics.getSnapshot();
      const l1 = cacheSnapshot.l1_hits || 0;
      const l2 = cacheSnapshot.l2_hits || 0;
      const providerCalls = cacheSnapshot.provider_calls || 0;
      const totalLookups = l1 + l2 + providerCalls;
      const cacheHitRatioPct = totalLookups > 0
        ? Number((((l1 + l2) / totalLookups) * 100).toFixed(1))
        : 0;

      const cacheMetrics: FinOpsCacheMetrics = {
        l1_hits: l1,
        l2_hits: l2,
        provider_calls: providerCalls,
        singleflight_hits: cacheSnapshot.singleflight_hits || 0,
        redis_failures: cacheSnapshot.redis_failures || 0,
        cache_latency_avg_ms: cacheSnapshot.cache_latency_avg_ms || 0,
        cache_hit_ratio_pct: cacheHitRatioPct,
        source: 'smartAvailabilityMetrics.getSnapshot()'
      };

      // ─── 3. Assemble Complete FinOps Overview ────────────────────────────────
      const overview: FinOpsOverview = {
        ...(rpcData as FinOpsOverview),
        cache: cacheMetrics
      };

      // Cache result for 30s to prevent rapid dashboard polling DB load
      this.cache.set(cacheKey, { data: overview, expiresAt: Date.now() + this.CACHE_TTL_MS });

      return overview;

    } catch (err: any) {
      winstonLogger.error(`[FINOPS_AGGREGATION_ERROR] Failed to aggregate FinOps telemetry: ${err.message}`);
      return this.buildZeroedOverview(startIso, endIso, window);
    }
  }

  /**
   * Returns empty/zeroed overview structure.
   */
  public buildZeroedOverview(startIso: string, endIso: string, window: '24h' | 'today' | 'month' | 'custom'): FinOpsOverview {
    const cacheSnapshot = smartAvailabilityMetrics.getSnapshot();
    const l1 = cacheSnapshot.l1_hits || 0;
    const l2 = cacheSnapshot.l2_hits || 0;
    const providerCalls = cacheSnapshot.provider_calls || 0;
    const totalLookups = l1 + l2 + providerCalls;
    const cacheHitRatioPct = totalLookups > 0
      ? Number((((l1 + l2) / totalLookups) * 100).toFixed(1))
      : 0;

    return {
      period: { start: startIso, end: endIso, window },
      wire_boundary: WIRE_BOUNDARY_CLAUSE,
      attempts: {
        total_gross_attempts: 0,
        successful_attempts: 0,
        failed_attempts: 0,
        success_rate_pct: 100.0,
        quadrants: { q1_primary_first: 0, q2_fallback_first: 0, q3_primary_retry: 0, q4_fallback_retry: 0 },
        total_retries: 0,
        total_fallbacks: 0,
        retry_rate_pct: 0.0,
        fallback_rate_pct: 0.0
      },
      costs: {
        total_metered_cost_usd: 0.00,
        ai_metered_cost_usd: 0.00,
        railway_metered_cost_usd: 0.00,
        railway_pricing_status: 'UNPRICED / FLAT_SUBSCRIPTION',
        railway_upstream_call_count: 0
      },
      ai: {
        total_ai_attempts: 0,
        successful_ai_attempts: 0,
        failed_ai_attempts: 0,
        total_tokens_in: 0,
        total_tokens_out: 0,
        total_tokens: 0,
        ai_cost_usd: 0.00,
        by_model: {}
      },
      by_provider: {},
      by_event_type: {},
      by_caller_feature: {},
      user_segmentation: {
        safar_pro_paid: { attempts: 0, metered_cost_usd: 0 },
        free_registered: { attempts: 0, metered_cost_usd: 0 },
        beta_users: { attempts: 0, metered_cost_usd: 0 },
        admin_internal: { attempts: 0, metered_cost_usd: 0 },
        background_cron: { attempts: 0, metered_cost_usd: 0 },
        guest_anonymous: { attempts: 0, metered_cost_usd: 0 }
      },
      daily: [],
      monthly: [],
      cache: {
        l1_hits: l1,
        l2_hits: l2,
        provider_calls: providerCalls,
        singleflight_hits: cacheSnapshot.singleflight_hits || 0,
        redis_failures: cacheSnapshot.redis_failures || 0,
        cache_latency_avg_ms: cacheSnapshot.cache_latency_avg_ms || 0,
        cache_hit_ratio_pct: cacheHitRatioPct,
        source: 'smartAvailabilityMetrics.getSnapshot()'
      },
      generated_at: new Date().toISOString()
    };
  }

  public clearCache(): void {
    this.cache.clear();
  }

  /**
   * Returns canonical PostgreSQL query specification for documentation and manual verification.
   */
  public getRawPostgresSqlSpecification(): string {
    return `
SELECT
  COUNT(*) AS total_gross_attempts,
  COUNT(*) FILTER (WHERE success = true) AS successful_attempts,
  COUNT(*) FILTER (WHERE success = false) AS failed_attempts,
  COUNT(*) FILTER (WHERE is_retry = false AND is_fallback = false) AS q1_primary_first,
  COUNT(*) FILTER (WHERE is_retry = false AND is_fallback = true)  AS q2_fallback_first,
  COUNT(*) FILTER (WHERE is_retry = true  AND is_fallback = false) AS q3_primary_retry,
  COUNT(*) FILTER (WHERE is_retry = true  AND is_fallback = true)  AS q4_fallback_retry,
  COUNT(*) FILTER (WHERE is_retry = true)  AS total_retries,
  COUNT(*) FILTER (WHERE is_fallback = true) AS total_fallbacks,
  SUM(COALESCE(tokens_in, 0))  FILTER (WHERE event_type = 'ai') AS total_tokens_in,
  SUM(COALESCE(tokens_out, 0)) FILTER (WHERE event_type = 'ai') AS total_tokens_out,
  SUM(COALESCE(applied_rate, 0)) FILTER (WHERE event_type = 'ai') AS ai_cost_usd
FROM public.api_provider_transaction_ledger
WHERE latency_ms IS NOT NULL
  AND caller_feature IS NOT NULL
  AND event_type != 'split'
  AND timestamp >= $1 AND timestamp <= $2;
`.trim();
  }
}

export const ledgerAggregationService = new LedgerAggregationService();
