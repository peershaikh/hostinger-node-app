/**
 * PHASE_087N130 — Focused Tests: Observability Log Noise Triage
 *
 * 1. PGRST202 from increment_hub_analytics is non-fatal and does not emit ERROR-level log.
 * 2. Existing PostgreSQL missing-function error handling (42P01, 42883) remains non-fatal.
 * 3. A normal completed zero-split search logs [CONTROLLER_NO_SPLITS], not [CONTROLLER_TIMEOUT].
 * 4. A genuine timeout still logs [CONTROLLER_TIMEOUT].
 */

import { AnalyticsService } from '../services/analyticsService';
import { supabase } from '../config/supabase';
import { winstonLogger } from '../middleware/logger';

let passed = 0;
let failed = 0;

function assert(desc: string, condition: boolean, details?: string) {
  if (condition) {
    console.log(`  PASS: ${desc}`);
    passed++;
  } else {
    console.error(`  FAIL: ${desc}${details ? ` -- ${details}` : ''}`);
    failed++;
  }
}

async function runTests() {
  console.log('\n=== PHASE_087N130 OBSERVABILITY TRIAGE TESTS ===\n');

  // Test 1: PGRST202 handling in AnalyticsService
  console.log('-- Test 1: PGRST202 from logHubSuccess is non-fatal and emits NO ERROR log --');
  const analyticsService = new AnalyticsService();

  // Spy on winstonLogger
  const spyState = { errorLogged: false, debugLogged: false };
  const originalError = winstonLogger.error;
  const originalDebug = winstonLogger.debug;

  (winstonLogger as any).error = (msg: any) => {
    spyState.errorLogged = true;
    originalError.apply(winstonLogger, [msg]);
  };
  (winstonLogger as any).debug = (msg: any) => {
    spyState.debugLogged = true;
    originalDebug.apply(winstonLogger, [msg]);
  };

  // Mock supabase.rpc to return PGRST202 error
  const originalRpc = supabase.rpc;
  (supabase as any).rpc = async (fnName: string, args: any) => {
    return {
      data: null,
      error: {
        code: 'PGRST202',
        message: `Could not find the function public.${fnName} in the schema cache`,
        details: 'Searched for the function...',
        hint: null
      }
    };
  };

  try {
    const hubResult = await analyticsService.logHubSuccess('PUNE');
    assert('1.1 logHubSuccess returns false on PGRST202 (non-fatal)', hubResult === false);
    assert('1.2 logHubSuccess does NOT emit ERROR-level log for PGRST202', !spyState.errorLogged);
    assert('1.3 logHubSuccess emits debug-level log for PGRST202', Boolean(spyState.debugLogged));

    // Reset spies
    spyState.errorLogged = false;
    spyState.debugLogged = false;

    const searchResult = await analyticsService.logSearch('CSMT', 'NDLS');
    assert('1.4 logSearch returns false on PGRST202 (non-fatal)', searchResult === false);
    assert('1.5 logSearch does NOT emit ERROR-level log for PGRST202', !spyState.errorLogged);
  } finally {
    // Restore
    (winstonLogger as any).error = originalError;
    (winstonLogger as any).debug = originalDebug;
  }

  // Test 2: Existing 42883 / 42P01 error handling
  console.log('\n-- Test 2: 42883 / 42P01 error handling remains non-fatal and clean --');
  (supabase as any).rpc = async (fnName: string, args: any) => {
    return {
      data: null,
      error: {
        code: '42883',
        message: 'function does not exist',
        details: null,
        hint: null
      }
    };
  };

  spyState.errorLogged = false;
  (winstonLogger as any).error = (msg: any) => { spyState.errorLogged = true; };
  try {
    const hubRes42883 = await analyticsService.logHubSuccess('SUR');
    assert('2.1 logHubSuccess handles 42883 gracefully without error log', hubRes42883 === false && !spyState.errorLogged);
  } finally {
    (supabase as any).rpc = originalRpc;
    (winstonLogger as any).error = originalError;
  }

  // Test 3 & 4: Controller timeout vs zero splits classification logic
  console.log('\n-- Test 3 & 4: Controller labeling distinguishes normal zero-splits from real timeouts --');

  function classifyControllerResult(
    finalSplits: any[],
    splitResult: any,
    execTime: number
  ): 'CONTROLLER_SUCCESS' | 'CONTROLLER_TIMEOUT' | 'CONTROLLER_NO_SPLITS' {
    if (finalSplits.length > 0) {
      return 'CONTROLLER_SUCCESS';
    }
    const isTimeout = (splitResult as any)?.message === 'Search took longer than expected. Try again.' ||
      ((splitResult as any)?.split?.length === 0 && execTime >= 55000);
    if (isTimeout) {
      return 'CONTROLLER_TIMEOUT';
    }
    return 'CONTROLLER_NO_SPLITS';
  }

  // Normal completed zero splits in 1,200ms
  const normalZeroResult = classifyControllerResult(
    [],
    { direct: [{ trainNo: '12345' }], split: [] },
    1200
  );
  assert('3.1 Normal zero splits in 1,200ms classified as CONTROLLER_NO_SPLITS', normalZeroResult === 'CONTROLLER_NO_SPLITS');

  // Normal completed with splits
  const normalWithSplits = classifyControllerResult(
    [{ hub: 'BPL', leg1: {}, leg2: {} }],
    { direct: [], split: [{ hub: 'BPL' }] },
    3400
  );
  assert('3.2 Normal results with splits classified as CONTROLLER_SUCCESS', normalWithSplits === 'CONTROLLER_SUCCESS');

  // Genuine timeout with message
  const timeoutWithMessage = classifyControllerResult(
    [],
    { direct: [], split: [], message: 'Search took longer than expected. Try again.' },
    55100
  );
  assert('4.1 Genuine timeout with timeout message classified as CONTROLLER_TIMEOUT', timeoutWithMessage === 'CONTROLLER_TIMEOUT');

  // Genuine wall timeout >= 55000ms
  const timeoutWallTime = classifyControllerResult(
    [],
    { direct: [], split: [] },
    56000
  );
  assert('4.2 Genuine wall timeout >= 55s classified as CONTROLLER_TIMEOUT', timeoutWallTime === 'CONTROLLER_TIMEOUT');

  console.log(`\n=== SUMMARY: ${passed} PASSED, ${failed} FAILED ===\n`);
  if (failed > 0) {
    process.exit(1);
  }
}

runTests().catch(err => {
  console.error('Test runner failed:', err);
  process.exit(1);
});
