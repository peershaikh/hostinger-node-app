/**
 * STEP 2D-PHASE 2.2 — Admin FinOps API Controller & Route Verification Test Suite
 *
 * Verifies all Phase 2.2 requirements:
 *  A. GET /api/admin/finops/summary defaults to 24h
 *  B. window=24h passes window='24h' to service
 *  C. window=today passes window='today' to service
 *  D. window=month passes window='month' to service
 *  E. window=custom with valid start/end passes ISO strings to service
 *  F. invalid window => 400
 *  G. custom missing start => 400
 *  H. custom missing end => 400
 *  I. invalid start format => 400
 *  J. invalid end format => 400
 *  K. start >= end => 400
 *  L. forceRefresh=true passes through to service
 *  M. requireAuth middleware remains enforced
 *  N. requireAdmin middleware remains enforced
 *  O. adminLimiter remains applied
 *  P. controller does not directly query ledger table
 *  Q. controller does not use RateService fallback rates
 *  R. existing admin routes remain unaffected
 *
 * Run with:
 *   npx ts-node server/src/__tests__/adminFinOpsApi.test.ts
 */

import { adminController } from '../controllers/adminController';
import adminRouter from '../routes/admin';
import { ledgerAggregationService } from '../services/ledger/ledgerAggregationService';
import { adminLimiter } from '../middleware/rateLimiter';
import fs from 'fs';
import path from 'path';

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

// Mock helper to create mock Express Request & Response
function createMockContext(query: Record<string, any> = {}) {
  let statusCode = 200;
  let jsonBody: any = null;

  const req: any = { query };
  const res: any = {
    status: (code: number) => {
      statusCode = code;
      return res;
    },
    json: (body: any) => {
      jsonBody = body;
      return res;
    }
  };

  return {
    req,
    res,
    getStatus: () => statusCode,
    getBody: () => jsonBody
  };
}

async function runTests(): Promise<void> {
  console.log('\n=== STEP 2D-PHASE 2.2 ADMIN FINOPS CONTROLLER & ROUTE TESTS ===\n');

  // Spy on ledgerAggregationService.getFinOpsOverview
  let lastServiceOptions: any = null;
  const originalGetFinOpsOverview = ledgerAggregationService.getFinOpsOverview.bind(ledgerAggregationService);

  (ledgerAggregationService as any).getFinOpsOverview = async (options: any) => {
    lastServiceOptions = options;
    return {
      period: { start: '2026-10-06T00:00:00.000Z', end: '2026-10-07T00:00:00.000Z', window: options.window },
      wire_boundary: "latency_ms IS NOT NULL",
      attempts: { total_gross_attempts: 10, successful_attempts: 9, failed_attempts: 1 },
      costs: { total_metered_cost_usd: 0.001, ai_metered_cost_usd: 0.001, railway_metered_cost_usd: 0.0, railway_pricing_status: 'UNPRICED / FLAT_SUBSCRIPTION' }
    } as any;
  };

  try {
    // ─── Test A: Default Window = 24h ──────────────────────────────────────────
    console.log('-- Test A: Default Window = 24h --');
    const ctxA = createMockContext({});
    await adminController.getFinOpsSummary(ctxA.req, ctxA.res);
    assert('A.1 HTTP status is 200', ctxA.getStatus() === 200);
    assert('A.2 Response success is true', ctxA.getBody()?.success === true);
    assert('A.3 Service receives default window="24h"', lastServiceOptions?.window === '24h');
    assert('A.4 Service receives forceRefresh=false', lastServiceOptions?.forceRefresh === false);

    // ─── Test B: window = 24h ──────────────────────────────────────────────────
    console.log('\n-- Test B: Explicit window = 24h --');
    const ctxB = createMockContext({ window: '24h' });
    await adminController.getFinOpsSummary(ctxB.req, ctxB.res);
    assert('B.1 HTTP status is 200', ctxB.getStatus() === 200);
    assert('B.2 Service receives window="24h"', lastServiceOptions?.window === '24h');

    // ─── Test C: window = today ────────────────────────────────────────────────
    console.log('\n-- Test C: window = today --');
    const ctxC = createMockContext({ window: 'today' });
    await adminController.getFinOpsSummary(ctxC.req, ctxC.res);
    assert('C.1 HTTP status is 200', ctxC.getStatus() === 200);
    assert('C.2 Service receives window="today"', lastServiceOptions?.window === 'today');

    // ─── Test D: window = month ────────────────────────────────────────────────
    console.log('\n-- Test D: window = month --');
    const ctxD = createMockContext({ window: 'month' });
    await adminController.getFinOpsSummary(ctxD.req, ctxD.res);
    assert('D.1 HTTP status is 200', ctxD.getStatus() === 200);
    assert('D.2 Service receives window="month"', lastServiceOptions?.window === 'month');

    // ─── Test E: window = custom with Valid start / end ────────────────────────
    console.log('\n-- Test E: window = custom with Valid start / end --');
    const startValid = '2026-10-01T00:00:00.000Z';
    const endValid = '2026-10-05T00:00:00.000Z';
    const ctxE = createMockContext({ window: 'custom', start: startValid, end: endValid });
    await adminController.getFinOpsSummary(ctxE.req, ctxE.res);
    assert('E.1 HTTP status is 200', ctxE.getStatus() === 200);
    assert('E.2 Service receives window="custom"', lastServiceOptions?.window === 'custom');
    assert('E.3 Service receives parsed startDate ISO', lastServiceOptions?.startDate === startValid);
    assert('E.4 Service receives parsed endDate ISO', lastServiceOptions?.endDate === endValid);

    // ─── Test F: Invalid Window => 400 ─────────────────────────────────────────
    console.log('\n-- Test F: Invalid Window => 400 --');
    const ctxF1 = createMockContext({ window: 'year' });
    await adminController.getFinOpsSummary(ctxF1.req, ctxF1.res);
    assert('F.1 window="year" returns HTTP 400', ctxF1.getStatus() === 400);
    assert('F.2 Error message mentions allowed values', ctxF1.getBody()?.error?.includes('Allowed values'));

    const ctxF2 = createMockContext({ window: 'arbitrary_text' });
    await adminController.getFinOpsSummary(ctxF2.req, ctxF2.res);
    assert('F.3 window="arbitrary_text" returns HTTP 400', ctxF2.getStatus() === 400);

    // ─── Test G: Custom Missing start => 400 ───────────────────────────────────
    console.log('\n-- Test G: Custom Missing start => 400 --');
    const ctxG = createMockContext({ window: 'custom', end: endValid });
    await adminController.getFinOpsSummary(ctxG.req, ctxG.res);
    assert('G.1 Missing start returns HTTP 400', ctxG.getStatus() === 400);
    assert('G.2 Error specifies start is required', ctxG.getBody()?.error?.includes("'start' is required"));

    // ─── Test H: Custom Missing end => 400 ─────────────────────────────────────
    console.log('\n-- Test H: Custom Missing end => 400 --');
    const ctxH = createMockContext({ window: 'custom', start: startValid });
    await adminController.getFinOpsSummary(ctxH.req, ctxH.res);
    assert('H.1 Missing end returns HTTP 400', ctxH.getStatus() === 400);
    assert('H.2 Error specifies end is required', ctxH.getBody()?.error?.includes("'end' is required"));

    // ─── Test I: Invalid start Date Format => 400 ──────────────────────────────
    console.log('\n-- Test I: Invalid start Date Format => 400 --');
    const ctxI = createMockContext({ window: 'custom', start: 'not-a-valid-date', end: endValid });
    await adminController.getFinOpsSummary(ctxI.req, ctxI.res);
    assert('I.1 Invalid start returns HTTP 400', ctxI.getStatus() === 400);
    assert('I.2 Error mentions invalid start date format', ctxI.getBody()?.error?.includes("Invalid 'start' date"));

    // ─── Test J: Invalid end Date Format => 400 ────────────────────────────────
    console.log('\n-- Test J: Invalid end Date Format => 400 --');
    const ctxJ = createMockContext({ window: 'custom', start: startValid, end: 'not-a-valid-date' });
    await adminController.getFinOpsSummary(ctxJ.req, ctxJ.res);
    assert('J.1 Invalid end returns HTTP 400', ctxJ.getStatus() === 400);
    assert('J.2 Error mentions invalid end date format', ctxJ.getBody()?.error?.includes("Invalid 'end' date"));

    // ─── Test K: start >= end => 400 ───────────────────────────────────────────
    console.log('\n-- Test K: start >= end => 400 --');
    const ctxK1 = createMockContext({ window: 'custom', start: '2026-10-10T00:00:00.000Z', end: '2026-10-05T00:00:00.000Z' });
    await adminController.getFinOpsSummary(ctxK1.req, ctxK1.res);
    assert('K.1 start > end returns HTTP 400', ctxK1.getStatus() === 400);
    assert('K.2 Error message specifies start must be before end', ctxK1.getBody()?.error?.includes("strictly before"));

    const ctxK2 = createMockContext({ window: 'custom', start: '2026-10-05T00:00:00.000Z', end: '2026-10-05T00:00:00.000Z' });
    await adminController.getFinOpsSummary(ctxK2.req, ctxK2.res);
    assert('K.3 start === end returns HTTP 400', ctxK2.getStatus() === 400);

    // ─── Test L: forceRefresh Parameter Passthrough ───────────────────────────
    console.log('\n-- Test L: forceRefresh Parameter Passthrough --');
    const ctxL1 = createMockContext({ window: '24h', forceRefresh: 'true' });
    await adminController.getFinOpsSummary(ctxL1.req, ctxL1.res);
    assert('L.1 forceRefresh="true" string passes true boolean to service', lastServiceOptions?.forceRefresh === true);

    const ctxL2 = createMockContext({ window: '24h', forceRefresh: true });
    await adminController.getFinOpsSummary(ctxL2.req, ctxL2.res);
    assert('L.2 forceRefresh=true boolean passes true boolean to service', lastServiceOptions?.forceRefresh === true);

    const ctxL3 = createMockContext({ window: '24h', forceRefresh: 'false' });
    await adminController.getFinOpsSummary(ctxL3.req, ctxL3.res);
    assert('L.3 forceRefresh="false" passes false boolean to service', lastServiceOptions?.forceRefresh === false);

    // ─── Test M, N, O: Router Registration & Middleware Stack ──────────────────
    console.log('\n-- Test M, N, O: Router Registration & Middleware Stack --');
    // Inspect Express router stack
    const stack = (adminRouter as any).stack || [];

    // Find /finops/summary route layer
    const finopsRouteLayer = stack.find((l: any) => l.route && l.route.path === '/finops/summary');
    assert('M/N/O.1 Route /finops/summary is registered in adminRouter', Boolean(finopsRouteLayer));
    assert('M/N/O.2 Route method is GET', finopsRouteLayer?.route?.methods?.get === true);

    const routeHandlers = finopsRouteLayer?.route?.stack?.map((s: any) => s.handle) || [];
    assert('M/N/O.3 Route stack contains multiple middleware handlers', routeHandlers.length >= 3);

    // Verify requireAuth is mounted at the router root
    const hasRequireAuthGuard = stack.some((l: any) => {
      const fnStr = String(l.handle || '');
      return fnStr.includes('requireAuth') || l.name === 'requireAuth' || l.handle?.name === 'requireAuth';
    });
    assert('M.1 Global requireAuth guard is active on adminRouter', hasRequireAuthGuard);

    // Verify requireAdmin middleware in route stack
    const hasRequireAdmin = routeHandlers.some((h: any) => {
      const fnStr = String(h || '');
      return fnStr.includes('requireAdmin') || h.name === 'requireAdmin';
    });
    assert('N.1 requireAdmin middleware is in route stack', hasRequireAdmin);

    // Verify rate limiter in route stack
    const hasAdminLimiter = routeHandlers.some((h: any) => {
      return h === adminLimiter || (h && (h.name === 'rateLimit' || h.name === 'middleware' || String(h).includes('rateLimit') || String(h).includes('limiter')));
    });
    assert('O.1 adminLimiter rate limiting middleware is in route stack', hasAdminLimiter);

    // ─── Test P, Q: Architectural Boundary Verification ───────────────────────
    console.log('\n-- Test P, Q: Architectural Boundary Verification --');
    const controllerSource = fs.readFileSync(path.join(__dirname, '../controllers/adminController.ts'), 'utf-8');

    // Extract getFinOpsSummary method body from controller source
    const methodStartIndex = controllerSource.indexOf('getFinOpsSummary(req: Request, res: Response)');
    const methodSub = controllerSource.slice(methodStartIndex, methodStartIndex + 2500);

    assert(
      'P.1 getFinOpsSummary does not query api_provider_transaction_ledger directly',
      !methodSub.includes('api_provider_transaction_ledger') && !methodSub.includes("from('api_provider_transaction_ledger')")
    );
    assert(
      'Q.1 getFinOpsSummary does not reference RateService.FALLBACK_RATES',
      !methodSub.includes('FALLBACK_RATES')
    );
    assert(
      'Q.2 getFinOpsSummary does not invoke rateService.getRate',
      !methodSub.includes('rateService.getRate')
    );
    assert(
      'Q.3 getFinOpsSummary does not synthesize hardcoded railway costs',
      !methodSub.includes('0.005') && !methodSub.includes('0.01')
    );

    // ─── Test R: Existing Admin Routes Remain Unaffected ──────────────────────
    console.log('\n-- Test R: Existing Admin Routes Remain Unaffected --');
    const expectedExistingRoutes = [
      '/analytics',
      '/live-pulse',
      '/analytics/history',
      '/analytics/export',
      '/daily-operations',
      '/incidents',
      '/engineering-tasks',
      '/intelligence-v2',
      '/production-incidents',
      '/last-digest',
      '/revenue'
    ];

    const registeredPaths = stack
      .filter((l: any) => l.route && l.route.path)
      .map((l: any) => l.route.path);

    for (const p of expectedExistingRoutes) {
      assert(`R. Route ${p} remains registered in adminRouter`, registeredPaths.includes(p));
    }

  } finally {
    // Restore original method
    (ledgerAggregationService as any).getFinOpsOverview = originalGetFinOpsOverview;
  }

  // ─── Summary ──────────────────────────────────────────────────────────────
  console.log('\n==================================================');
  console.log(`STEP 2D-PHASE 2.2 TESTS: ${passed} PASSED, ${failed} FAILED`);
  console.log('==================================================\n');

  if (failed > 0) {
    process.exit(1);
  }
  process.exit(0);
}

runTests().catch(err => {
  console.error('Fatal test error:', err);
  process.exit(1);
});
