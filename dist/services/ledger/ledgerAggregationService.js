"use strict";
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
Object.defineProperty(exports, "__esModule", { value: true });
exports.ledgerAggregationService = exports.LedgerAggregationService = exports.supabaseAdmin = exports.WIRE_BOUNDARY_CLAUSE = void 0;
const supabase_1 = require("../../config/supabase");
const logger_1 = require("../../middleware/logger");
const smartAvailabilityMetrics_1 = require("../smartAvailabilityMetrics");
exports.WIRE_BOUNDARY_CLAUSE = "latency_ms IS NOT NULL AND caller_feature IS NOT NULL AND event_type != 'split'";
const KNOWN_RAILWAY_PROVIDERS = new Set(['IRCTC', 'RAILKIT', 'RAILKIT_V2', 'RAILRADAR']);
const KNOWN_AI_PROVIDERS = new Set(['DEEPSEEK', 'GEMINI', 'OPENAI']);
exports.supabaseAdmin = supabase_1.supabase;
class LedgerAggregationService {
    constructor() {
        this.cache = new Map();
        this.CACHE_TTL_MS = 30000; // 30 seconds cache to protect DB from rapid dashboard polling
    }
    /**
     * Resolve time boundaries using PostgreSQL server-side UTC time semantics.
     */
    resolveTimeBoundaries(options = {}) {
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
    async getFinOpsOverview(options = {}) {
        const { startIso, endIso, window } = this.resolveTimeBoundaries(options);
        const cacheKey = `finops_${window}_${startIso}_${endIso}`;
        if (!options.forceRefresh) {
            const cached = this.cache.get(cacheKey);
            if (cached && cached.expiresAt > Date.now()) {
                return cached.data;
            }
        }
        const client = options.supabaseClient || exports.supabaseAdmin;
        // If Supabase is unconfigured, return safe empty zeroed structure with live cache metrics
        if (!(0, supabase_1.isSupabaseConfigured)() && !options.supabaseClient) {
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
                logger_1.winstonLogger.error(`[FINOPS_INTEGRATION_ERROR] get_finops_overview RPC failed: ${rpcError.message}`);
                return this.buildZeroedOverview(startIso, endIso, window);
            }
            if (!rpcData || typeof rpcData !== 'object') {
                logger_1.winstonLogger.warn(`[FINOPS_INTEGRATION_WARN] get_finops_overview RPC returned invalid or null data`);
                return this.buildZeroedOverview(startIso, endIso, window);
            }
            // ─── 2. Cache Metrics Sourced Authoritatively In-Memory ───────────────────
            // Sourced directly from smartAvailabilityMetrics (zero queries to ledger)
            const cacheSnapshot = smartAvailabilityMetrics_1.smartAvailabilityMetrics.getSnapshot();
            const l1 = cacheSnapshot.l1_hits || 0;
            const l2 = cacheSnapshot.l2_hits || 0;
            const providerCalls = cacheSnapshot.provider_calls || 0;
            const totalLookups = l1 + l2 + providerCalls;
            const cacheHitRatioPct = totalLookups > 0
                ? Number((((l1 + l2) / totalLookups) * 100).toFixed(1))
                : 0;
            const cacheMetrics = {
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
            const overview = {
                ...rpcData,
                cache: cacheMetrics
            };
            // Cache result for 30s to prevent rapid dashboard polling DB load
            this.cache.set(cacheKey, { data: overview, expiresAt: Date.now() + this.CACHE_TTL_MS });
            return overview;
        }
        catch (err) {
            logger_1.winstonLogger.error(`[FINOPS_AGGREGATION_ERROR] Failed to aggregate FinOps telemetry: ${err.message}`);
            return this.buildZeroedOverview(startIso, endIso, window);
        }
    }
    /**
     * Returns empty/zeroed overview structure.
     */
    buildZeroedOverview(startIso, endIso, window) {
        const cacheSnapshot = smartAvailabilityMetrics_1.smartAvailabilityMetrics.getSnapshot();
        const l1 = cacheSnapshot.l1_hits || 0;
        const l2 = cacheSnapshot.l2_hits || 0;
        const providerCalls = cacheSnapshot.provider_calls || 0;
        const totalLookups = l1 + l2 + providerCalls;
        const cacheHitRatioPct = totalLookups > 0
            ? Number((((l1 + l2) / totalLookups) * 100).toFixed(1))
            : 0;
        return {
            period: { start: startIso, end: endIso, window },
            wire_boundary: exports.WIRE_BOUNDARY_CLAUSE,
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
    clearCache() {
        this.cache.clear();
    }
    /**
     * Returns canonical PostgreSQL query specification for documentation and manual verification.
     */
    getRawPostgresSqlSpecification() {
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
exports.LedgerAggregationService = LedgerAggregationService;
exports.ledgerAggregationService = new LedgerAggregationService();
