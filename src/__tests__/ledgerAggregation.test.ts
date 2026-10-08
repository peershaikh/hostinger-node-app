/**
 * STEP 2D — FinOps Ledger Aggregation Service Focused Test Suite
 *
 * Verifies all Phase 2.1 requirements:
 *  A. 24h RPC delegation
 *  B. today RPC delegation
 *  C. month RPC delegation
 *  D. custom RPC delegation
 *  E. correct RPC arguments
 *  F. 30-second cache hit
 *  G. forceRefresh bypass
 *  H. cache snapshot merge
 *  I. cache hit ratio calculation
 *  J. RPC error fallback
 *  K. null RPC result fallback
 *  L. Supabase unconfigured fallback
 *  M. no direct ledger row aggregation remains
 *  N. no RateService fallback cost is used
 *  O. existing zeroed overview contract remains valid
 *  P. Mathematical invariants (Q1-Q4 conservation, zero double counting)
 *
 * Run with:
 *   npx ts-node server/src/__tests__/ledgerAggregation.test.ts
 */

import {
  ledgerAggregationService,
  WIRE_BOUNDARY_CLAUSE,
  FinOpsOverview
} from '../services/ledger/ledgerAggregationService';
import { smartAvailabilityMetrics } from '../services/smartAvailabilityMetrics';

let passed = 0;
let failed = 0;
const failures: string[] = [];

function assert(description: string, condition: boolean, extraInfo?: any): void {
  if (condition) {
    passed++;
    console.log(`  PASS: ${description}`);
  } else {
    failed++;
    const msg = `FAIL: ${description}${extraInfo ? ' — ' + JSON.stringify(extraInfo) : ''}`;
    failures.push(msg);
    console.error(`  ${msg}`);
  }
}

// Canonical mock RPC response matching public.get_finops_overview(timestamptz, timestamptz, text) output
const mockRpcOverviewResponse = {
  period: {
    start: '2026-10-06T16:00:00.000Z',
    end: '2026-10-07T16:00:00.000Z',
    window: '24h'
  },
  wire_boundary: "latency_ms IS NOT NULL AND caller_feature IS NOT NULL AND event_type != 'split'",
  attempts: {
    total_gross_attempts: 9,
    successful_attempts: 7,
    failed_attempts: 2,
    success_rate_pct: 77.78,
    quadrants: {
      q1_primary_first: 6,
      q2_fallback_first: 1,
      q3_primary_retry: 1,
      q4_fallback_retry: 1
    },
    total_retries: 2,
    total_fallbacks: 2,
    retry_rate_pct: 22.22,
    fallback_rate_pct: 22.22
  },
  costs: {
    total_metered_cost_usd: 0.000168,
    ai_metered_cost_usd: 0.000168,
    railway_metered_cost_usd: 0.000000,
    railway_pricing_status: 'UNPRICED / FLAT_SUBSCRIPTION',
    railway_upstream_call_count: 6
  },
  ai: {
    total_ai_attempts: 3,
    successful_ai_attempts: 2,
    failed_ai_attempts: 1,
    total_tokens_in: 800,
    total_tokens_out: 300,
    total_tokens: 1100,
    ai_cost_usd: 0.000168,
    by_model: {
      'deepseek-chat': {
        attempts: 2,
        successful_attempts: 1,
        failed_attempts: 1,
        tokens_in: 300,
        tokens_out: 100,
        cost_usd: 0.000070
      },
      'gemini-2.5-flash': {
        attempts: 1,
        successful_attempts: 1,
        failed_attempts: 0,
        tokens_in: 500,
        tokens_out: 200,
        cost_usd: 0.000098
      }
    }
  },
  by_provider: {
    'IRCTC': {
      provider_name: 'IRCTC',
      total_attempts: 4,
      successful_attempts: 4,
      failed_attempts: 0,
      retry_attempts: 1,
      fallback_attempts: 0,
      avg_latency_ms: 265,
      metered_cost_usd: 0.0,
      pricing_status: 'UNPRICED / FLAT_SUBSCRIPTION'
    },
    'RAILRADAR': {
      provider_name: 'RAILRADAR',
      total_attempts: 2,
      successful_attempts: 1,
      failed_attempts: 1,
      retry_attempts: 1,
      fallback_attempts: 2,
      avg_latency_ms: 875,
      metered_cost_usd: 0.0,
      pricing_status: 'UNPRICED / FLAT_SUBSCRIPTION'
    },
    'DEEPSEEK': {
      provider_name: 'DEEPSEEK',
      total_attempts: 2,
      successful_attempts: 1,
      failed_attempts: 1,
      retry_attempts: 0,
      fallback_attempts: 0,
      avg_latency_ms: 260,
      metered_cost_usd: 0.000070,
      pricing_status: 'METERED_PER_TOKEN'
    },
    'GEMINI': {
      provider_name: 'GEMINI',
      total_attempts: 1,
      successful_attempts: 1,
      failed_attempts: 0,
      retry_attempts: 0,
      fallback_attempts: 0,
      avg_latency_ms: 350,
      metered_cost_usd: 0.000098,
      pricing_status: 'METERED_PER_TOKEN'
    }
  },
  by_event_type: {
    'search': { event_type: 'search', total_attempts: 3, successful_attempts: 3, failed_attempts: 0, metered_cost_usd: 0.0 },
    'pnr': { event_type: 'pnr', total_attempts: 2, successful_attempts: 1, failed_attempts: 1, metered_cost_usd: 0.0 },
    'live': { event_type: 'live', total_attempts: 1, successful_attempts: 1, failed_attempts: 0, metered_cost_usd: 0.0 },
    'ai': { event_type: 'ai', total_attempts: 3, successful_attempts: 2, failed_attempts: 1, metered_cost_usd: 0.000168 }
  },
  by_caller_feature: {
    'trainSearch': { caller_feature: 'trainSearch', total_attempts: 3, successful_attempts: 3, failed_attempts: 0, metered_cost_usd: 0.0 },
    'pnr': { caller_feature: 'pnr', total_attempts: 2, successful_attempts: 1, failed_attempts: 1, metered_cost_usd: 0.0 },
    'background_pnr_poller': { caller_feature: 'background_pnr_poller', total_attempts: 1, successful_attempts: 1, failed_attempts: 0, metered_cost_usd: 0.0 },
    'deepseekAdapter.categorizeFeedback': { caller_feature: 'deepseekAdapter.categorizeFeedback', total_attempts: 2, successful_attempts: 1, failed_attempts: 1, metered_cost_usd: 0.000070 },
    'geminiAdapter.pnrPrediction': { caller_feature: 'geminiAdapter.pnrPrediction', total_attempts: 1, successful_attempts: 1, failed_attempts: 0, metered_cost_usd: 0.000098 }
  },
  user_segmentation: {
    safar_pro_paid: { attempts: 2, metered_cost_usd: 0.0 },
    free_registered: { attempts: 2, metered_cost_usd: 0.0 },
    admin_internal: { attempts: 2, metered_cost_usd: 0.000070 },
    beta_users: { attempts: 1, metered_cost_usd: 0.000098 },
    background_cron: { attempts: 1, metered_cost_usd: 0.0 },
    guest_anonymous: { attempts: 1, metered_cost_usd: 0.0 }
  },
  daily: [
    { date: '2026-10-07', total_attempts: 9, successful_attempts: 7, failed_attempts: 2, retries: 2, fallbacks: 2, metered_cost_usd: 0.000168 }
  ],
  monthly: [
    { month: '2026-10', total_attempts: 9, successful_attempts: 7, failed_attempts: 2, retries: 2, fallbacks: 2, metered_cost_usd: 0.000168 }
  ],
  generated_at: new Date().toISOString()
};

async function runTests(): Promise<void> {
  console.log('\n=== STEP 2D FINOPS LEDGER AGGREGATION TESTS ===\n');

  // ─── Test 1: Wire Boundary Clause Definition ─────────────────────────────
  console.log('-- Test 1: Wire Boundary Clause Definition --');
  assert(
    '1.1 Wire boundary includes latency_ms check',
    WIRE_BOUNDARY_CLAUSE.includes('latency_ms IS NOT NULL')
  );
  assert(
    '1.2 Wire boundary includes caller_feature check',
    WIRE_BOUNDARY_CLAUSE.includes('caller_feature IS NOT NULL')
  );
  assert(
    '1.3 Wire boundary strictly excludes legacy split event type',
    WIRE_BOUNDARY_CLAUSE.includes("event_type != 'split'")
  );

  // ─── Test 2: Canonical SQL Specification ──────────────────────────────────
  console.log('\n-- Test 2: Canonical SQL Specification --');
  const sql = ledgerAggregationService.getRawPostgresSqlSpecification();
  assert('2.1 SQL uses COUNT FILTER for successful attempts', sql.includes('COUNT(*) FILTER (WHERE success = true)'));
  assert('2.2 SQL uses COUNT FILTER for failed attempts', sql.includes('COUNT(*) FILTER (WHERE success = false)'));
  assert('2.3 SQL defines Q1 non-overlapping expression', sql.includes('is_retry = false AND is_fallback = false'));
  assert('2.4 SQL defines Q2 non-overlapping expression', sql.includes('is_retry = false AND is_fallback = true'));
  assert('2.5 SQL defines Q3 non-overlapping expression', sql.includes('is_retry = true  AND is_fallback = false'));
  assert('2.6 SQL defines Q4 non-overlapping expression', sql.includes('is_retry = true  AND is_fallback = true'));
  assert('2.7 SQL uses COALESCE on tokens_in', sql.includes('SUM(COALESCE(tokens_in, 0))'));
  assert('2.8 SQL uses COALESCE on tokens_out', sql.includes('SUM(COALESCE(tokens_out, 0))'));
  assert('2.9 SQL uses COALESCE on applied_rate', sql.includes('SUM(COALESCE(applied_rate, 0))'));

  // ─── Test 3: Time Boundary Resolution ────────────────────────────────────
  console.log('\n-- Test 3: Time Boundary Resolution --');
  const t24h = ledgerAggregationService.resolveTimeBoundaries({ window: '24h' });
  const tToday = ledgerAggregationService.resolveTimeBoundaries({ window: 'today' });
  const tMonth = ledgerAggregationService.resolveTimeBoundaries({ window: 'month' });
  const tCustom = ledgerAggregationService.resolveTimeBoundaries({
    window: 'custom',
    startDate: '2026-10-01T00:00:00.000Z',
    endDate: '2026-10-05T00:00:00.000Z'
  });

  assert('3.1 24h window returns ISO timestamps', Boolean(t24h.startIso && t24h.endIso));
  assert('3.2 24h start is approximately 24h before end', Math.abs(new Date(t24h.endIso).getTime() - new Date(t24h.startIso).getTime() - 86400000) < 5000);
  assert('3.3 today start is UTC midnight', tToday.startIso.endsWith('T00:00:00.000Z'));
  assert('3.4 month start is 1st of month UTC', tMonth.startIso.includes('-01T00:00:00.000Z'));
  assert('3.5 custom start and end are strictly honored', tCustom.startIso === '2026-10-01T00:00:00.000Z' && tCustom.endIso === '2026-10-05T00:00:00.000Z');

  // ─── Mock Fixtures for RPC Delegation Tests ──────────────────────────────
  let rpcCallCount = 0;
  let fromCallCount = 0;
  let lastRpcFn = '';
  let lastRpcArgs: any = null;
  let rpcShouldFail = false;
  let rpcReturnNull = false;

  const mockRpcSupabase = {
    rpc: async (fnName: string, args: any) => {
      rpcCallCount++;
      lastRpcFn = fnName;
      lastRpcArgs = args;

      if (rpcShouldFail) {
        return { data: null, error: { message: 'Database query timeout' } };
      }
      if (rpcReturnNull) {
        return { data: null, error: null };
      }
      return { data: { ...mockRpcOverviewResponse }, error: null };
    },
    from: (_table: string) => {
      fromCallCount++;
      throw new Error('DIRECT_TABLE_ACCESS_PROHIBITED: getFinOpsOverview must not query tables directly!');
    }
  };

  // Set predictable cache counters in smartAvailabilityMetrics
  smartAvailabilityMetrics._resetForTests();
  smartAvailabilityMetrics.recordL1Hit();
  smartAvailabilityMetrics.recordL1Hit();
  smartAvailabilityMetrics.recordL1Hit();
  smartAvailabilityMetrics.recordL2Hit();
  smartAvailabilityMetrics.recordProviderCall();

  // ─── Test 4 (A & E): 24h Window RPC Delegation & Arguments ────────────────
  console.log('\n-- Test 4 (A & E): 24h Window RPC Delegation & Arguments --');
  ledgerAggregationService.clearCache();
  rpcCallCount = 0;
  const overview24h = await ledgerAggregationService.getFinOpsOverview({
    window: '24h',
    forceRefresh: true,
    supabaseClient: mockRpcSupabase
  });

  assert('4.1 Delegates to get_finops_overview RPC', lastRpcFn === 'get_finops_overview');
  assert('4.2 24h passes p_start_time = null', lastRpcArgs.p_start_time === null);
  assert('4.3 24h passes p_end_time = null', lastRpcArgs.p_end_time === null);
  assert('4.4 24h passes p_window = "24h"', lastRpcArgs.p_window === '24h');
  assert('4.5 Exactly one RPC call performed', rpcCallCount === 1);
  assert('4.6 Zero direct table queries performed (PostgREST row bypass)', fromCallCount === 0);

  // ─── Test 5 (B & C): Today & Month RPC Delegation & Arguments ─────────────
  console.log('\n-- Test 5 (B & C): Today & Month RPC Delegation & Arguments --');
  ledgerAggregationService.clearCache();
  await ledgerAggregationService.getFinOpsOverview({
    window: 'today',
    forceRefresh: true,
    supabaseClient: mockRpcSupabase
  });
  assert('5.1 today passes p_start_time = null', lastRpcArgs.p_start_time === null);
  assert('5.2 today passes p_end_time = null', lastRpcArgs.p_end_time === null);
  assert('5.3 today passes p_window = "today"', lastRpcArgs.p_window === 'today');

  ledgerAggregationService.clearCache();
  await ledgerAggregationService.getFinOpsOverview({
    window: 'month',
    forceRefresh: true,
    supabaseClient: mockRpcSupabase
  });
  assert('5.4 month passes p_start_time = null', lastRpcArgs.p_start_time === null);
  assert('5.5 month passes p_end_time = null', lastRpcArgs.p_end_time === null);
  assert('5.6 month passes p_window = "month"', lastRpcArgs.p_window === 'month');

  // ─── Test 6 (D & E): Custom Range RPC Delegation & Arguments ──────────────
  console.log('\n-- Test 6 (D & E): Custom Range RPC Delegation & Arguments --');
  ledgerAggregationService.clearCache();
  await ledgerAggregationService.getFinOpsOverview({
    window: 'custom',
    startDate: '2026-10-01T00:00:00.000Z',
    endDate: '2026-10-05T00:00:00.000Z',
    forceRefresh: true,
    supabaseClient: mockRpcSupabase
  });
  assert('6.1 custom passes p_start_time = startIso', lastRpcArgs.p_start_time === '2026-10-01T00:00:00.000Z');
  assert('6.2 custom passes p_end_time = endIso', lastRpcArgs.p_end_time === '2026-10-05T00:00:00.000Z');
  assert('6.3 custom passes p_window = "custom"', lastRpcArgs.p_window === 'custom');

  // ─── Test 7 (F & G): 30-Second In-Memory Cache & forceRefresh Bypass ──────
  console.log('\n-- Test 7 (F & G): 30-Second In-Memory Cache & forceRefresh Bypass --');
  ledgerAggregationService.clearCache();
  rpcCallCount = 0;

  // First call -> populates cache
  await ledgerAggregationService.getFinOpsOverview({
    window: '24h',
    forceRefresh: false,
    supabaseClient: mockRpcSupabase
  });
  assert('7.1 First call invokes RPC', rpcCallCount === 1);

  // Second call without forceRefresh -> returns from in-memory cache
  await ledgerAggregationService.getFinOpsOverview({
    window: '24h',
    forceRefresh: false,
    supabaseClient: mockRpcSupabase
  });
  assert('7.2 Consecutive call within 30s hits cache (RPC call count remains 1)', rpcCallCount === 1);

  // Third call with forceRefresh: true -> bypasses cache
  await ledgerAggregationService.getFinOpsOverview({
    window: '24h',
    forceRefresh: true,
    supabaseClient: mockRpcSupabase
  });
  assert('7.3 forceRefresh=true bypasses cache (RPC call count increments to 2)', rpcCallCount === 2);

  // ─── Test 8 (H & I): Cache Snapshot Merge & Hit Ratio Calculation ─────────
  console.log('\n-- Test 8 (H & I): Cache Snapshot Merge & Hit Ratio Calculation --');
  const cache = overview24h.cache;
  assert('8.1 Cache metrics merged into overview response', Boolean(cache));
  assert('8.2 Sourced from smartAvailabilityMetrics.getSnapshot()', cache.source === 'smartAvailabilityMetrics.getSnapshot()');
  assert('8.3 L1 hits equals 3', cache.l1_hits === 3);
  assert('8.4 L2 hits equals 1', cache.l2_hits === 1);
  assert('8.5 Provider calls equals 1', cache.provider_calls === 1);
  assert('8.6 Hit ratio: (3+1) / (3+1+1) * 100 = 80.0%', cache.cache_hit_ratio_pct === 80.0);

  // Test zero lookups boundary
  smartAvailabilityMetrics._resetForTests();
  ledgerAggregationService.clearCache();
  const zeroLookupOverview = await ledgerAggregationService.getFinOpsOverview({
    window: '24h',
    forceRefresh: true,
    supabaseClient: mockRpcSupabase
  });
  assert('8.7 Hit ratio is 0.0 when totalLookups = 0', zeroLookupOverview.cache.cache_hit_ratio_pct === 0.0);

  // Restore metrics
  smartAvailabilityMetrics.recordL1Hit();
  smartAvailabilityMetrics.recordL1Hit();
  smartAvailabilityMetrics.recordL1Hit();
  smartAvailabilityMetrics.recordL2Hit();
  smartAvailabilityMetrics.recordProviderCall();

  // ─── Test 9 (J, K, L): Resilience & Fallback Handling ──────────────────────
  console.log('\n-- Test 9 (J, K, L): Resilience & Fallback Handling --');
  ledgerAggregationService.clearCache();

  // J. RPC error fallback
  rpcShouldFail = true;
  const errorOverview = await ledgerAggregationService.getFinOpsOverview({
    window: '24h',
    forceRefresh: true,
    supabaseClient: mockRpcSupabase
  });
  assert('9.1 RPC error falls back gracefully to zeroed overview', errorOverview.attempts.total_gross_attempts === 0);
  assert('9.2 RPC error fallback preserves live cache snapshot', errorOverview.cache.l1_hits === 3);
  rpcShouldFail = false;

  // K. Null RPC result fallback
  ledgerAggregationService.clearCache();
  rpcReturnNull = true;
  const nullOverview = await ledgerAggregationService.getFinOpsOverview({
    window: '24h',
    forceRefresh: true,
    supabaseClient: mockRpcSupabase
  });
  assert('9.3 Null RPC result falls back gracefully to zeroed overview', nullOverview.attempts.total_gross_attempts === 0);
  assert('9.4 Null RPC fallback preserves live cache snapshot', nullOverview.cache.l1_hits === 3);
  rpcReturnNull = false;

  // L. Supabase unconfigured fallback
  ledgerAggregationService.clearCache();
  const unconfiguredOverview = ledgerAggregationService.buildZeroedOverview('2026-10-06T00:00:00.000Z', '2026-10-07T00:00:00.000Z', '24h');
  assert('9.5 buildZeroedOverview returns valid zeroed attempts', unconfiguredOverview.attempts.total_gross_attempts === 0);
  assert('9.6 buildZeroedOverview returns $0.00 metered cost', unconfiguredOverview.costs.total_metered_cost_usd === 0.0);
  assert('9.7 buildZeroedOverview preserves live cache hit ratio', unconfiguredOverview.cache.cache_hit_ratio_pct === 80.0);

  // ─── Test 10 (M, N, O): Metric Integrity & Invariant Preservation ──────────
  console.log('\n-- Test 10 (M, N, O): Metric Integrity & Invariant Preservation --');
  assert('10.1 Zero table reads occurred during all tests (fromCallCount === 0)', fromCallCount === 0);
  assert('10.2 Railway marginal cost strictly 0.00', overview24h.costs.railway_metered_cost_usd === 0.00);
  assert('10.3 Railway pricing status is UNPRICED / FLAT_SUBSCRIPTION', overview24h.costs.railway_pricing_status === 'UNPRICED / FLAT_SUBSCRIPTION');
  assert('10.4 Railway upstream calls separated (6 calls)', overview24h.costs.railway_upstream_call_count === 6);
  assert('10.5 Total metered cost equals AI metered cost (no fake search/split rates)', overview24h.costs.total_metered_cost_usd === overview24h.costs.ai_metered_cost_usd);

  // P. Mathematical Invariants
  const att = overview24h.attempts;
  const q = att.quadrants;
  assert('10.6 Invariant: total_gross_attempts = Q1 + Q2 + Q3 + Q4', att.total_gross_attempts === q.q1_primary_first + q.q2_fallback_first + q.q3_primary_retry + q.q4_fallback_retry);
  assert('10.7 Invariant: total_retries = Q3 + Q4', att.total_retries === q.q3_primary_retry + q.q4_fallback_retry);
  assert('10.8 Invariant: total_fallbacks = Q2 + Q4', att.total_fallbacks === q.q2_fallback_first + q.q4_fallback_retry);
  assert('10.9 Invariant: total_gross_attempts = successful + failed', att.total_gross_attempts === att.successful_attempts + att.failed_attempts);

  // ─── Summary ──────────────────────────────────────────────────────────────
  console.log('\n==================================================');
  console.log(`STEP 2D FINOPS TESTS: ${passed} PASSED, ${failed} FAILED`);
  console.log('==================================================\n');

  if (failed > 0) {
    process.exit(1);
  }
}

runTests().catch(err => {
  console.error('Fatal test error:', err);
  process.exit(1);
});
