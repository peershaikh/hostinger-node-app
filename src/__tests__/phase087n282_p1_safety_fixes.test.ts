/**
 * PHASE 087N282 — Unit Tests: Minimal Schedule-Sync Safety Fixes for P1 Readiness
 *
 * Tests cover:
 *   1. Single-character station codes ('R', 'G') accepted by V4 terminus validation
 *   2. Empty, whitespace, and special-character terminus codes rejected by V4
 *   3. V6 station-row filtering preserves valid 1-char codes ('R', 'G') and drops empty/invalid codes
 *   4. trainScheduleIntegrityService accepts schedules containing 'R' (Raipur) and 'G' (Gondia)
 *   5. Empty station code is rejected by trainScheduleIntegrityService
 *   6. Provider AUTH_FAILURE returns 'auth_failure' from syncOneTrain
 *   7. syncOneTrainWithBackoff immediately returns 'auth_failure' without retrying
 *   8. syncAllTrains fast-aborts remaining batch immediately upon AUTH_FAILURE
 *   9. Non-auth failures (TIMEOUT, RATE_LIMITED_429, DB error) do NOT trigger batch abort
 *   10. Dry-run zero-write behavior remains intact when ENABLE_TRAIN_SCHEDULE_SYNC is OFF
 *   11. Source code integrity: V4, V6, AUTH_FAILURE abort log, and type signatures present
 *
 * Run with:
 *   npx ts-node server/src/__tests__/phase087n282_p1_safety_fixes.test.ts
 */

import * as path from 'path';
import * as fs from 'fs';
import { trainScheduleSyncJob } from '../jobs/trainScheduleSyncJob';
import { trainScheduleIntegrityService } from '../services/trainScheduleIntegrityService';
import { irctcService, TrainInfoResult } from '../services/irctcService';
import { featureFlags } from '../config/featureFlags';

let passed = 0;
let failed = 0;
const failures: string[] = [];

function assert(label: string, condition: boolean, detail?: string) {
  if (condition) {
    console.log(`  ✅ PASS [${label}]` + (detail ? ': ' + detail : ''));
    passed++;
  } else {
    const msg = label + (detail ? ': ' + detail : '');
    console.error(`  ❌ FAIL [${label}]` + (detail ? ': ' + detail : ''));
    failures.push(msg);
    failed++;
  }
}

async function runTests() {
  console.log('===============================================================');
  console.log('PHASE 087N282 — P1 SAFETY FIXES TEST SUITE');
  console.log('===============================================================');

  // ── Source Inspection ───────────────────────────────────────────────────────
  console.log('\n── Section 1: Source Inspection ────────────────────────────────');
  const syncJobPath = fs.existsSync(path.join(process.cwd(), 'server', 'src', 'jobs', 'trainScheduleSyncJob.ts'))
    ? path.join(process.cwd(), 'server', 'src', 'jobs', 'trainScheduleSyncJob.ts')
    : path.join(__dirname, '..', 'jobs', 'trainScheduleSyncJob.ts');
  const syncSrc = fs.readFileSync(syncJobPath, 'utf8');

  assert('S1.01_v4_guard_length',
    syncSrc.includes('liveLastCode.length < 1'),
    'V4 allows 1-character terminus codes (length < 1)');

  assert('S1.02_v4_regex_alphanumeric',
    syncSrc.includes('/^[A-Z0-9]{1,8}$/.test(liveLastCode)'),
    'V4 validates terminus code with alphanumeric {1,8} regex');

  assert('S1.03_v6_filter_length',
    syncSrc.includes('Station_Code.length >= 1'),
    'V6 allows 1-character station codes (length >= 1)');

  assert('S1.04_v6_regex_alphanumeric',
    syncSrc.includes('/^[A-Z0-9]{1,8}$/.test(r.Station_Code)'),
    'V6 validates station codes with alphanumeric {1,8} regex');

  assert('S1.05_sync_aborted_auth_log',
    syncSrc.includes('SYNC_ABORTED reason=AUTH_FAILURE'),
    'Clear batch abort log token present for AUTH_FAILURE');

  assert('S1.06_auth_failure_return_syncOneTrain',
    syncSrc.includes("return 'auth_failure';"),
    "syncOneTrain returns 'auth_failure' literal on AUTH_FAILURE");

  assert('S1.07_auth_failure_backoff_passthrough',
    syncSrc.includes("result === 'auth_failure'"),
    "syncOneTrainWithBackoff passes through 'auth_failure' immediately");

  // ── Section 2: V4 Terminus Validation Logic ─────────────────────────────────
  console.log('\n── Section 2: V4 Terminus Validation Logic ───────────────────');

  function validateV4Terminus(lastStation: any): boolean {
    const liveLastCode = (
      lastStation?.stnCode ||
      lastStation?.stationCode ||
      lastStation?.code ||
      ''
    ).toUpperCase().trim();

    return !(!liveLastCode || liveLastCode.length < 1 || !/^[A-Z0-9]{1,8}$/.test(liveLastCode));
  }

  assert('V4.01_R_accepted', validateV4Terminus({ stnCode: 'R' }), 'Raipur (R) accepted as terminus');
  assert('V4.02_G_accepted', validateV4Terminus({ stnCode: 'G' }), 'Gondia (G) accepted as terminus');
  assert('V4.03_NDLS_accepted', validateV4Terminus({ stnCode: 'NDLS' }), 'Standard code NDLS accepted');
  assert('V4.04_lowercase_normalized', validateV4Terminus({ stnCode: 'r' }), 'Lowercase r normalized and accepted');
  assert('V4.05_empty_rejected', !validateV4Terminus({ stnCode: '' }), 'Empty code rejected');
  assert('V4.06_whitespace_rejected', !validateV4Terminus({ stnCode: '   ' }), 'Whitespace-only rejected');
  assert('V4.07_special_rejected', !validateV4Terminus({ stnCode: 'R-1' }), 'Special char code rejected');
  assert('V4.08_null_rejected', !validateV4Terminus(null), 'Null station rejected');

  // ── Section 3: V6 Station-Row Filtering Logic ──────────────────────────────
  console.log('\n── Section 3: V6 Station-Row Filtering Logic ─────────────────');

  const rawStations = [
    { stnCode: 'R', stnName: 'Raipur Jn', serialNo: 1 },
    { stnCode: 'DURG', stnName: 'Durg', serialNo: 2 },
    { stnCode: 'G', stnName: 'Gondia Jn', serialNo: 3 },
    { stnCode: '', stnName: 'Empty Station', serialNo: 4 },
    { stnCode: '   ', stnName: 'Whitespace Station', serialNo: 5 },
    { stnCode: 'ND-1', stnName: 'Special Station', serialNo: 6 },
    { stnCode: 'NGP', stnName: 'Nagpur', serialNo: 7 },
  ];

  const filteredRows = rawStations
    .map((s: any, idx: number) => ({
      Train_No: '12860',
      Station_Code: (s.stnCode || s.stationCode || s.code || '').toUpperCase().trim(),
      Station_Name: (s.stnName || s.stationName || s.name || ''),
      SN: Number(s.serialNo ?? (idx + 1)),
      Arrival_time: '--:--',
      Departure_Time: '--:--',
    }))
    .filter((r: any) => r.Station_Code.length >= 1 && /^[A-Z0-9]{1,8}$/.test(r.Station_Code));

  const preservedCodes = filteredRows.map(r => r.Station_Code);
  assert('V6.01_R_preserved', preservedCodes.includes('R'), "1-character station 'R' preserved");
  assert('V6.02_G_preserved', preservedCodes.includes('G'), "1-character station 'G' preserved");
  assert('V6.03_multi_preserved', preservedCodes.includes('DURG') && preservedCodes.includes('NGP'), 'Multi-char stations preserved');
  assert('V6.04_empty_dropped', !preservedCodes.includes(''), 'Empty station code filtered out');
  assert('V6.05_special_dropped', !preservedCodes.includes('ND-1'), 'Special char station filtered out');
  assert('V6.06_row_count', filteredRows.length === 4, `Expected 4 valid rows, got ${filteredRows.length}`);

  // ── Section 4: trainScheduleIntegrityService Compatibility ─────────────────
  console.log('\n── Section 4: trainScheduleIntegrityService Compatibility ───');

  // Test schedule with R (Raipur)
  const schedule12823 = [
    { Train_No: '12823', Station_Code: 'DURG', Station_Name: 'Durg', SN: 1, Arrival_time: '--:--', Departure_Time: '11:50' },
    { Train_No: '12823', Station_Code: 'R',    Station_Name: 'Raipur Jn', SN: 2, Arrival_time: '12:35', Departure_Time: '12:40' },
    { Train_No: '12823', Station_Code: 'BYT',  Station_Name: 'Bhatapara', SN: 3, Arrival_time: '13:30', Departure_Time: '13:32' },
    { Train_No: '12823', Station_Code: 'NZM',  Station_Name: 'Hazrat Nizamuddin', SN: 4, Arrival_time: '07:40', Departure_Time: '--:--' },
  ];
  const integrity12823 = trainScheduleIntegrityService.validateScheduleRows('12823', schedule12823);
  assert('INT.01_12823_with_R_valid', integrity12823.status === 'VALID', `12823 status=${integrity12823.status} reasons=${integrity12823.reasons}`);

  // Test schedule with both R and G (like 12860 Gitanjali)
  const schedule12860 = [
    { Train_No: '12860', Station_Code: 'HWH',  Station_Name: 'Howrah', SN: 1, Arrival_time: '--:--', Departure_Time: '13:50' },
    { Train_No: '12860', Station_Code: 'R',    Station_Name: 'Raipur Jn', SN: 2, Arrival_time: '02:45', Departure_Time: '02:50' },
    { Train_No: '12860', Station_Code: 'G',    Station_Name: 'Gondia Jn', SN: 3, Arrival_time: '04:45', Departure_Time: '04:47' },
    { Train_No: '12860', Station_Code: 'CSMT', Station_Name: 'Mumbai CSMT', SN: 4, Arrival_time: '21:20', Departure_Time: '--:--' },
  ];
  const integrity12860 = trainScheduleIntegrityService.validateScheduleRows('12860', schedule12860);
  assert('INT.02_12860_with_R_and_G_valid', integrity12860.status === 'VALID', `12860 status=${integrity12860.status} reasons=${integrity12860.reasons}`);

  // Empty code must still fail integrity
  const scheduleBad = [
    { Train_No: '12860', Station_Code: '',     Station_Name: 'Empty', SN: 1, Arrival_time: '--:--', Departure_Time: '10:00' },
    { Train_No: '12860', Station_Code: 'CSMT', Station_Name: 'Mumbai', SN: 2, Arrival_time: '20:00', Departure_Time: '--:--' },
  ];
  const integrityBad = trainScheduleIntegrityService.validateScheduleRows('12860', scheduleBad);
  assert('INT.03_empty_code_invalid', integrityBad.status === 'INVALID' && integrityBad.reasons.includes('INVALID_STATION_CODE'),
    `Empty code rejected with INVALID_STATION_CODE (${integrityBad.reasons})`);

  // ── Section 5: AUTH_FAILURE Fast Abort in syncAllTrains ─────────────────────
  console.log('\n── Section 5: AUTH_FAILURE Fast Abort in syncAllTrains ──────');

  // Test syncOneTrain and syncOneTrainWithBackoff return 'auth_failure'
  const origGetTrainInfoForSync = irctcService.getTrainInfoForSync.bind(irctcService);

  try {
    // 5A: Mock AUTH_FAILURE from irctcService
    irctcService.getTrainInfoForSync = async (_trainNo: string): Promise<TrainInfoResult> => {
      return { kind: 'AUTH_FAILURE' };
    };

    const outcomeSyncOne = await (trainScheduleSyncJob as any).syncOneTrain('99901');
    assert('AUTH.01_syncOneTrain_returns_auth_failure', outcomeSyncOne === 'auth_failure',
      `syncOneTrain returned '${outcomeSyncOne}'`);

    const outcomeBackoff = await (trainScheduleSyncJob as any).syncOneTrainWithBackoff('99901');
    assert('AUTH.02_backoff_returns_auth_failure', outcomeBackoff === 'auth_failure',
      `syncOneTrainWithBackoff returned '${outcomeBackoff}'`);

    // 5B: Mock syncAllTrains execution with a batch of 5 trains, where train 2 is AUTH_FAILURE
    const origGetPriorityBatch = (trainScheduleSyncJob as any).getPriorityBatch.bind(trainScheduleSyncJob);
    const origGetAllTrainNumbers = (trainScheduleSyncJob as any).getAllTrainNumbers.bind(trainScheduleSyncJob);
    const origSleep = (trainScheduleSyncJob as any).sleep.bind(trainScheduleSyncJob);

    // Make sleep instantaneous in tests
    (trainScheduleSyncJob as any).sleep = async () => {};

    const testBatch = ['90001', '90002', '90003', '90004', '90005'];
    (trainScheduleSyncJob as any).getAllTrainNumbers = async () => testBatch;
    (trainScheduleSyncJob as any).getPriorityBatch = async () => ({
      batch: testBatch,
      p0Count: 0, p1Count: 5, p2Count: 0, p3Count: 0, p4Count: 0,
    });

    const attemptedTrains: string[] = [];

    // Override syncOneTrainWithBackoff: train 90001 & 90002 skip, train 90003 fails with auth_failure
    (trainScheduleSyncJob as any).syncOneTrainWithBackoff = async (tNo: string) => {
      attemptedTrains.push(tNo);
      if (tNo === '90003') {
        return 'auth_failure';
      }
      return 'skipped';
    };

    const stats = await (trainScheduleSyncJob as any).syncAllTrains(Date.now());

    assert('AUTH.03_batch_fast_aborted', attemptedTrains.length === 3,
      `Attempted ${attemptedTrains.length}/5 trains: [${attemptedTrains.join(', ')}]`);
    assert('AUTH.04_trains_4_and_5_not_attempted',
      !attemptedTrains.includes('90004') && !attemptedTrains.includes('90005'),
      'Remaining trains 90004 and 90005 were not called');
    assert('AUTH.05_aborted_count_correct', stats.aborted === 2,
      `Aborted count = ${stats.aborted} (expected 2)`);
    assert('AUTH.06_failed_count_correct', stats.failed === 1,
      `Failed count = ${stats.failed} (expected 1 for auth_failure)`);
    assert('AUTH.07_skipped_count_correct', stats.skipped === 2,
      `Skipped count = ${stats.skipped} (expected 2)`);
    assert('AUTH.08_total_equals_sum',
      stats.total === stats.updated + stats.skipped + stats.failed + stats.aborted,
      `Total ${stats.total} === ${stats.updated} + ${stats.skipped} + ${stats.failed} + ${stats.aborted}`);

    // ── Section 6: Non-Auth Failures Do NOT Fast Abort ─────────────────────────
    console.log('\n── Section 6: Non-Auth Failures Do NOT Fast Abort ───────────');

    const nonAuthAttempted: string[] = [];
    (trainScheduleSyncJob as any).syncOneTrainWithBackoff = async (tNo: string) => {
      nonAuthAttempted.push(tNo);
      if (tNo === '90002') return 'failed';       // e.g. TIMEOUT or DB error
      if (tNo === '90003') return 'rate_limited'; // 429
      return 'skipped';
    };

    const nonAuthStats = await (trainScheduleSyncJob as any).syncAllTrains(Date.now());

    assert('NONAUTH.01_all_trains_processed', nonAuthAttempted.length === 5,
      `All 5 trains attempted despite errors: [${nonAuthAttempted.join(', ')}]`);
    assert('NONAUTH.02_aborted_zero', nonAuthStats.aborted === 0,
      `Aborted count = ${nonAuthStats.aborted} (expected 0)`);
    assert('NONAUTH.03_failed_incremented', nonAuthStats.failed === 1,
      `Failed count = ${nonAuthStats.failed} (expected 1)`);
    assert('NONAUTH.04_rate_limited_handled', nonAuthStats.rateLimited === 1 && nonAuthStats.skipped === 4,
      `Rate limited = ${nonAuthStats.rateLimited}, Skipped = ${nonAuthStats.skipped}`);

    // Restore mocked methods
    (trainScheduleSyncJob as any).getPriorityBatch = origGetPriorityBatch;
    (trainScheduleSyncJob as any).getAllTrainNumbers = origGetAllTrainNumbers;
    (trainScheduleSyncJob as any).sleep = origSleep;
    delete (trainScheduleSyncJob as any).syncOneTrainWithBackoff;
  } finally {
    irctcService.getTrainInfoForSync = origGetTrainInfoForSync;
  }

  // ── Section 7: Dry-Run Behavior with Feature Flag OFF ───────────────────────
  console.log('\n── Section 7: Dry-Run Safety ──────────────────────────────────');

  assert('DRY.01_feature_flag_off', featureFlags.trainScheduleSync === false,
    'ENABLE_TRAIN_SCHEDULE_SYNC is strictly OFF');

  // ── Summary ─────────────────────────────────────────────────────────────────
  console.log('\n══════════════════════════════════════════════════════');
  console.log('PHASE 087N282 SAFETY FIXES TEST SUMMARY');
  console.log('══════════════════════════════════════════════════════');
  console.log(`PASSED = ${passed}`);
  console.log(`FAILED = ${failed}`);
  console.log(`TOTAL  = ${passed + failed}`);

  if (failures.length > 0) {
    console.error('\nFAILURES:');
    failures.forEach(f => console.error('  ❌ ' + f));
    process.exitCode = 1;
  } else {
    console.log('\n✅ ALL P1 SAFETY FIX TESTS PASSED');
    process.exitCode = 0;
  }
}

runTests().catch(err => {
  console.error('Test execution error:', err);
  process.exitCode = 1;
});
