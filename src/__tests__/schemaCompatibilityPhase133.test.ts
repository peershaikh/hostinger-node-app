import fs from 'fs';
import path from 'path';
import { selfLearningService } from '../services/selfLearningService';

async function runTests() {
  console.log('\n=== RUNNING PHASE 133 SCHEMA COMPATIBILITY & REGRESSION TESTS ===\n');
  let passed = 0;
  let failed = 0;

  function assert(name: string, condition: boolean, details?: any) {
    if (condition) {
      console.log(`✅ PASS: ${name}`);
      passed++;
    } else {
      console.error(`❌ FAIL: ${name}`, details || '');
      failed++;
    }
  }

  // Allow async constructor sync to settle before running tests
  await new Promise((r) => setTimeout(r, 1200));

  // ───────────────────────────────────────────────────────────────────────────
  // TEST GROUP 1: Static Code Invariant Audit (AST / Function Scope Invariants)
  // ───────────────────────────────────────────────────────────────────────────
  const servicePath = path.join(__dirname, '../services/selfLearningService.ts');
  const sourceCode = fs.readFileSync(servicePath, 'utf8');

  // Extract logMissingStation function body
  const stnFnStart = sourceCode.indexOf('public async logMissingStation');
  const stnFnEnd = sourceCode.indexOf('public async logPnrFailure');
  const logMissingStationBody = sourceCode.slice(stnFnStart, stnFnEnd);

  // Extract logMissingQuery function body
  const queryFnStart = sourceCode.indexOf('public async logMissingQuery');
  const queryFnEnd = sourceCode.indexOf('public async updateGptSuggestion');
  const logMissingQueryBody = sourceCode.slice(queryFnStart, queryFnEnd);

  // Test 1.1: Ensure no queries filter missing_stations on 'status'
  assert(
    'No query in logMissingStation filters on nonexistent status column',
    !logMissingStationBody.includes(".eq('status'"),
    'Found .eq("status") in logMissingStation'
  );

  // Test 1.2: Ensure no queries filter missing_queries on 'status'
  assert(
    'No query in logMissingQuery filters on nonexistent status column',
    !logMissingQueryBody.includes(".eq('status'"),
    'Found .eq("status") in logMissingQuery'
  );

  // Test 1.3: Ensure missing_stations insert does not include status
  const stnInsertBlock = logMissingStationBody.slice(logMissingStationBody.indexOf('.insert('));
  assert(
    'No insert payload for missing_stations includes unsupported status column',
    !stnInsertBlock.includes('status:'),
    'Found status in missing_stations insert payload'
  );

  // Test 1.4: Ensure missing_queries select and insert use only supported columns
  assert(
    'missing_queries select only requests supported id column',
    logMissingQueryBody.includes(".select('id')") && !logMissingQueryBody.includes(".select('id, count')")
  );

  const queryInsertBlock = logMissingQueryBody.slice(logMissingQueryBody.indexOf('.insert('));
  assert(
    'No insert payload for missing_queries includes unsupported status column',
    !queryInsertBlock.includes('status:')
  );
  assert(
    'No insert payload for missing_queries includes unsupported count column',
    !queryInsertBlock.includes('count:')
  );
  assert(
    'No insert payload for missing_queries includes unsupported last_seen column',
    !queryInsertBlock.includes('last_seen:')
  );

  // ───────────────────────────────────────────────────────────────────────────
  // TEST GROUP 2: Functional Execution & Graceful Fallback
  // ───────────────────────────────────────────────────────────────────────────

  // Test 2.1: Empty and invalid input handling
  try {
    await selfLearningService.logMissingStation('', null);
    await selfLearningService.logMissingStation('   ', null);
    await selfLearningService.logMissingQuery('', '', '', null);
    await selfLearningService.logMissingQuery('NDLS', 'NDLS', '2026-11-20', null);
    assert('Empty or invalid query inputs are safely handled as no-ops', true);
  } catch (err: any) {
    assert('Empty or invalid query inputs do not throw', false, err.message);
  }

  // Test 2.2: logMissingStation execution & local persistence
  try {
    const testStation = `TEST_STN_${Date.now()}`;
    await selfLearningService.logMissingStation(testStation, 'test-user-id');

    const localStations = selfLearningService.getLocalDataForTable('missing_stations') as any[];
    const recorded = localStations.find((s) => s.query.toUpperCase() === testStation);
    assert('logMissingStation successfully persists to local in-memory registry', !!recorded);
    if (recorded) {
      assert('local recorded station preserves status in-memory for offline review', recorded.status === 'pending');
      assert('local recorded station tracks count', recorded.count >= 1);
    }
  } catch (err: any) {
    assert('logMissingStation executes without unhandled error', false, err.message);
  }

  // Test 2.3: logMissingStation in-memory TTL deduplication & count increment
  try {
    const dedupeStation = `TEST_DEDUPE_${Date.now()}`;
    await selfLearningService.logMissingStation(dedupeStation, null);
    const s1 = (selfLearningService.getLocalDataForTable('missing_stations') as any[])
      .find((s) => s.query.toUpperCase() === dedupeStation);
    const beforeCount = s1 ? s1.count : 0;

    // Immediate duplicate is suppressed by in-memory dedupCache
    await selfLearningService.logMissingStation(dedupeStation, null);
    const sInter = (selfLearningService.getLocalDataForTable('missing_stations') as any[])
      .find((s) => s.query.toUpperCase() === dedupeStation);
    assert('Immediate duplicate request is rate-limited by dedupCache', sInter?.count === 1);

    // After clearing dedupCache entry, second call increments count
    (selfLearningService as any).dedupCache?.delete(`station:${dedupeStation}`);
    await selfLearningService.logMissingStation(dedupeStation, null);
    const s2 = (selfLearningService.getLocalDataForTable('missing_stations') as any[])
      .find((s) => s.query.toUpperCase() === dedupeStation);
    const afterCount = s2 ? s2.count : 0;

    assert('logMissingStation increments count when dedupe window expires', afterCount === beforeCount + 1, {
      beforeCount,
      afterCount
    });
  } catch (err: any) {
    assert('logMissingStation deduplication executes without error', false, err.message);
  }

  // Test 2.4: logMissingQuery execution & local persistence
  try {
    const testSrc = 'DEL';
    const testDst = `ZZZ_${Date.now()}`;
    await selfLearningService.logMissingQuery(testSrc, testDst, '2026-11-20', 'test-user-id');

    const localQueries = selfLearningService.getLocalDataForTable('missing_queries') as any[];
    const recordedQ = localQueries.find((q) => q.destination.toUpperCase() === testDst.toUpperCase());
    assert('logMissingQuery records entry in local list', !!recordedQ);
    if (recordedQ) {
      assert('local recorded query tracks date', recordedQ.date === '2026-11-20');
      assert('local recorded query preserves status in-memory', recordedQ.status === 'pending');
    }
  } catch (err: any) {
    assert('logMissingQuery executes without unhandled error', false, err.message);
  }

  // Test 2.5: getAnalytics includes missing counts
  try {
    const analytics = await selfLearningService.getAnalytics();
    assert('getAnalytics returns object', typeof analytics === 'object');
    assert('getAnalytics contains missing_queries count', typeof analytics.counts?.missing_queries === 'number');
    assert('getAnalytics contains missing_stations count', typeof analytics.counts?.missing_stations === 'number');
  } catch (err: any) {
    assert('getAnalytics executes without error', false, err.message);
  }

  console.log(`\n==================================================`);
  console.log(`SUMMARY: ${passed} passed, ${failed} failed`);
  console.log(`==================================================\n`);

  process.exit(failed > 0 ? 1 : 0);
}

runTests().catch((err) => {
  console.error('Fatal test error:', err);
  process.exit(1);
});
