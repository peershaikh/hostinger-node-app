/**
 * PHASE_087N145 — Production Safety Fixes & Regression Test Suite
 *
 * Verifies all 8 safety fixes identified in N144 and implemented in N145:
 * 1. test_pune_cluster_does_not_contain_harda: resolveCityStations('PUNE') excludes HD and includes HDP.
 * 2. test_ndls_pune_split_never_terminates_at_hd: A split ending at HD is rejected for NDLS -> PUNE.
 * 3. test_multi_train_buffer_gate_strictly_enforces_45m: Candidates with 27m, 35m, 36m, 41m are rejected.
 * 4. test_inter_station_transfer_lko_ash_requires_60m: LKO -> ASH with 36m is rejected; >= 60m is accepted.
 * 5. test_same_train_rescue_0m_buffer_unaffected: Same-train rescue with 0m remains valid.
 * 6. test_valid_45m_plus_multi_train_splits_pass: Valid multi-train connections >=45m and <=840m remain valid.
 * 7. Legitimate Pune destinations: PUNE / SVJR / KK / HDP remain acceptable.
 *
 * Run with:
 *   cd c:\trine && npx ts-node server/src/__tests__/phase087n145_production_safety_fixes.test.ts
 */

import * as fs from 'fs';
import * as path from 'path';
import {
  PAN_INDIA_CLUSTERS,
  TERMINAL_ALIASES,
  areStationsCompatible,
  isCompatibleWithRequestedDestinations
} from '../services/stationAliases';
import { splitJourneyEngine } from '../services/splitJourneyEngine';

let passed = 0;
let failed = 0;
const failures: string[] = [];

function assert(label: string, condition: boolean, detail?: string) {
  if (condition) {
    console.log('  PASS [' + label + ']' + (detail ? ': ' + detail : ''));
    passed++;
  } else {
    const msg = label + (detail ? ': ' + detail : '');
    console.error('  FAIL [' + label + ']' + (detail ? ': ' + detail : ''));
    failures.push(msg);
    failed++;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// 1. PUNE DESTINATION MAPPING & CLUSTER REGRESSION
// ─────────────────────────────────────────────────────────────────────────────
console.log('\n-- 1. Pune Destination Mapping & Cluster Verification --');

const cityStationsPath = path.join(__dirname, '..', 'data', 'cityStations.json');
const cityStationsRaw = JSON.parse(fs.readFileSync(cityStationsPath, 'utf8'));

// 1.1 test_pune_cluster_does_not_contain_harda
const puneCityList: string[] = cityStationsRaw['PUNE'] || [];
assert('1.01', !puneCityList.includes('HD'), 'cityStations.json PUNE does NOT contain Harda (HD)');
assert('1.02', puneCityList.includes('HDP'), 'cityStations.json PUNE includes Hadapsar (HDP)');
assert('1.03', puneCityList.includes('PUNE'), 'cityStations.json PUNE includes PUNE');
assert('1.04', puneCityList.includes('SVJR') || puneCityList.includes('SHIV'), 'cityStations.json PUNE includes Shivajinagar');
assert('1.05', puneCityList.includes('KK'), 'cityStations.json PUNE includes Khadki (KK)');

// 1.2 stationAliases PAN_INDIA_CLUSTERS check
const puneCluster = PAN_INDIA_CLUSTERS.find(c => c.includes('PUNE')) || [];
assert('1.06', !puneCluster.includes('HD'), 'PAN_INDIA_CLUSTERS Pune does NOT contain HD');
assert('1.07', puneCluster.includes('HDP'), 'PAN_INDIA_CLUSTERS Pune contains HDP');
assert('1.08', puneCluster.includes('SVJR'), 'PAN_INDIA_CLUSTERS Pune contains SVJR');
assert('1.09', puneCluster.includes('KK'), 'PAN_INDIA_CLUSTERS Pune contains KK');
assert('1.10', puneCluster.includes('CCH'), 'PAN_INDIA_CLUSTERS Pune contains CCH (Chinchwad)');
assert('1.11', puneCluster.includes('LNL'), 'PAN_INDIA_CLUSTERS Pune contains LNL (Lonavala)');

assert('1.12', !areStationsCompatible('PUNE', 'HD'), 'areStationsCompatible(PUNE, HD) === false');
assert('1.13', areStationsCompatible('PUNE', 'HDP'), 'areStationsCompatible(PUNE, HDP) === true');
assert('1.14', areStationsCompatible('PUNE', 'SVJR'), 'areStationsCompatible(PUNE, SVJR) === true');
assert('1.15', areStationsCompatible('PUNE', 'KK'), 'areStationsCompatible(PUNE, KK) === true');

// ─────────────────────────────────────────────────────────────────────────────
// 2. DEFENSE-IN-DEPTH DESTINATION CLUSTER COMPATIBILITY GATE
// ─────────────────────────────────────────────────────────────────────────────
console.log('\n-- 2. Destination Cluster Defense-In-Depth (NDLS -> PUNE never ends at HD) --');

const requestedPuneDCodes = ['PUNE', 'SHIV', 'KK', 'HDP'];

// 2.1 test_ndls_pune_split_never_terminates_at_hd
assert(
  '2.01',
  !isCompatibleWithRequestedDestinations('HD', requestedPuneDCodes),
  'isCompatibleWithRequestedDestinations("HD", PUNE) === false'
);

// Even if a corrupted mapping with HD was passed in dCodes:
const corruptedDCodes = ['PUNE', 'SHIV', 'KK', 'HD'];
assert(
  '2.02',
  !isCompatibleWithRequestedDestinations('HD', corruptedDCodes),
  'isCompatibleWithRequestedDestinations("HD", corruptedDCodes) === false (poisoned dCodes cannot leak HD)'
);

// 2.2 Legitimate Pune destinations remain acceptable: PUNE, SVJR, KK, HDP
assert(
  '2.03',
  isCompatibleWithRequestedDestinations('PUNE', requestedPuneDCodes),
  'Legitimate Pune endpoint PUNE is accepted'
);
assert(
  '2.04',
  isCompatibleWithRequestedDestinations('SVJR', requestedPuneDCodes),
  'Legitimate Pune endpoint SVJR is accepted'
);
assert(
  '2.05',
  isCompatibleWithRequestedDestinations('KK', requestedPuneDCodes),
  'Legitimate Pune endpoint KK is accepted'
);
assert(
  '2.06',
  isCompatibleWithRequestedDestinations('HDP', requestedPuneDCodes),
  'Legitimate Pune endpoint HDP is accepted'
);

// 2.3 Other legitimate pan-India clusters are untouched
assert('2.07', isCompatibleWithRequestedDestinations('NZM', ['NDLS']), 'NZM is compatible with NDLS cluster');
assert('2.08', isCompatibleWithRequestedDestinations('ANVT', ['NDLS']), 'ANVT is compatible with NDLS cluster');
assert('2.09', isCompatibleWithRequestedDestinations('LTT', ['CSMT']), 'LTT is compatible with CSMT cluster');
assert('2.10', isCompatibleWithRequestedDestinations('SDAH', ['HWH']), 'SDAH is compatible with HWH cluster');
assert('2.11', isCompatibleWithRequestedDestinations('ET', ['ET']), 'ET is compatible with non-cluster request ET');
// A legitimate passenger booking explicitly to Harda can still book to Harda:
assert('2.12', isCompatibleWithRequestedDestinations('HD', ['HD']), 'Legitimate booking explicitly to HD is accepted');

// ─────────────────────────────────────────────────────────────────────────────
// 3. calculateTransferMeta SAFETY & BUFFER GATES
// ─────────────────────────────────────────────────────────────────────────────
console.log('\n-- 3. calculateTransferMeta Minimums & Bounds --');

const calcTransferMeta = (splitJourneyEngine as any).calculateTransferMeta.bind(splitJourneyEngine);

const leg1_BPL = {
  trainNo: '12156',
  fromCode: 'NDLS',
  toCode: 'BPL',
  departure: '20:40',
  arrival: '05:30',
  durationMins: 530
};

const leg2_BPL_SameStation = {
  trainNo: '12138',
  fromCode: 'BPL',
  toCode: 'PUNE',
  departure: '06:15',
  arrival: '20:00',
  durationMins: 825
};

// 3.1 Same-station multi-train buffer checks:
// Candidates with 27m, 35m, 36m, 41m, 44m must be rejected.
const rejectedSameStationWaits = [27, 35, 36, 41, 44];
for (const wait of rejectedSameStationWaits) {
  const res = calcTransferMeta(leg1_BPL, leg2_BPL_SameStation, wait);
  assert(`3.01-${wait}m`, !res.isValid, `Same-station multi-train with ${wait}m layover is REJECTED`);
}

// 45m authoritative minimum:
const res45 = calcTransferMeta(leg1_BPL, leg2_BPL_SameStation, 45);
assert('3.02-45m', res45.isValid, 'Same-station multi-train with exactly 45m layover is ACCEPTED');
assert('3.03', res45.transferMeta?.minimumRequiredBufferMinutes === 45, 'minimumRequiredBufferMinutes is 45');

// Valid multi-train connections >= 45m and <= 840m remain valid:
const validWaits = [60, 90, 120, 360, 720, 840];
for (const wait of validWaits) {
  const res = calcTransferMeta(leg1_BPL, leg2_BPL_SameStation, wait);
  assert(`3.04-${wait}m`, res.isValid, `Valid multi-train with ${wait}m layover is ACCEPTED`);
}

// Layover > 840m is rejected:
const res841 = calcTransferMeta(leg1_BPL, leg2_BPL_SameStation, 841);
assert('3.05-841m', !res841.isValid, 'Same-station multi-train with 841m layover (> 840m) is REJECTED');

// 3.2 Inter-station transfer checks (e.g. LKO -> ASH):
const leg1_LKO = {
  trainNo: '12353',
  fromCode: 'HWH',
  toCode: 'LKO',
  departure: '08:00',
  arrival: '22:00',
  durationMins: 840
};

const leg2_ASH = {
  trainNo: '15008',
  fromCode: 'ASH',
  toCode: 'NDLS',
  departure: '22:36',
  arrival: '06:00',
  durationMins: 444
};

// 4. test_inter_station_transfer_lko_ash_requires_60m
// LKO -> ASH with 36m is rejected:
const resLkoAsh36 = calcTransferMeta(leg1_LKO, leg2_ASH, 36);
assert('3.06', !resLkoAsh36.isValid, 'Inter-station transfer LKO -> ASH with 36m is REJECTED');

const resLkoAsh59 = calcTransferMeta(leg1_LKO, leg2_ASH, 59);
assert('3.07', !resLkoAsh59.isValid, 'Inter-station transfer LKO -> ASH with 59m is REJECTED');

const resLkoAsh60 = calcTransferMeta(leg1_LKO, leg2_ASH, 60);
assert('3.08', resLkoAsh60.isValid, 'Inter-station transfer LKO -> ASH with 60m is ACCEPTED');
assert('3.09', resLkoAsh60.transferMeta?.minimumRequiredBufferMinutes === 60, 'Inter-station minimumRequiredBufferMinutes is 60');

// ─────────────────────────────────────────────────────────────────────────────
// 4. DEFENSE-IN-DEPTH CANDIDATE TRUST GATE (validateCandidateAgainstSchedule)
// ─────────────────────────────────────────────────────────────────────────────
console.log('\n-- 4. Candidate Trust Gate Full Schedule Validation --');

const validateCandidate = (splitJourneyEngine as any).validateCandidateAgainstSchedule.bind(splitJourneyEngine);

async function runTrustGateTests() {
  const dummyDate = '2026-10-15';
  const scheduleMemo = new Map();
  const providerMemo = new Map();

  // 4.1 test_ndls_pune_split_never_terminates_at_hd
  const splitEndingAtHD = {
    trainNo: '12156',
    isSameTrain: false,
    rescueType: 'HUB_SPLIT',
    bufferMinutes: 90,
    wait_time: 90,
    legs: [
      { trainNo: '12156', fromCode: 'NDLS', toCode: 'BPL', departure: '20:40', arrival: '05:30' },
      { trainNo: '12138', fromCode: 'BPL', toCode: 'HD', departure: '07:00', arrival: '10:00' }
    ]
  };

  const hdOutcome = await validateCandidate(
    splitEndingAtHD,
    ['NDLS'],
    ['PUNE', 'SHIV', 'KK', 'HDP'],
    dummyDate,
    scheduleMemo,
    providerMemo,
    'SL',
    'GN'
  );

  assert('4.01', !hdOutcome.ok, 'Split terminating at HD is rejected for NDLS -> PUNE');
  assert('4.02', (hdOutcome.reason || '').includes('DESTINATION_CLUSTER_INCOMPATIBLE'), 'Rejection reason is DESTINATION_CLUSTER_INCOMPATIBLE');

  // Even if dCodes is corrupted with HD:
  const hdOutcomePoisoned = await validateCandidate(
    splitEndingAtHD,
    ['NDLS'],
    ['PUNE', 'SHIV', 'KK', 'HD'],
    dummyDate,
    scheduleMemo,
    providerMemo,
    'SL',
    'GN'
  );
  assert('4.03', !hdOutcomePoisoned.ok, 'Split terminating at HD is rejected even if dCodes contains HD');

  // 4.2 Multi-train buffer checks: 27m, 35m, 36m, 41m rejected in trust gate
  for (const wait of [27, 35, 36, 41]) {
    const splitShortBuffer = {
      trainNo: '12156',
      isSameTrain: false,
      rescueType: 'HUB_SPLIT',
      bufferMinutes: wait,
      wait_time: wait,
      legs: [
        { trainNo: '12156', fromCode: 'NDLS', toCode: 'BPL', departure: '20:40', arrival: '05:30' },
        { trainNo: '12138', fromCode: 'BPL', toCode: 'PUNE', departure: '06:05', arrival: '20:00' }
      ]
    };
    const outcome = await validateCandidate(
      splitShortBuffer,
      ['NDLS'],
      ['PUNE'],
      dummyDate,
      scheduleMemo,
      providerMemo,
      'SL',
      'GN'
    );
    assert(`4.04-${wait}m`, !outcome.ok, `Multi-train candidate with ${wait}m buffer is rejected by trust gate`);
    assert(`4.05-${wait}m`, (outcome.reason || '').includes('INSUFFICIENT_BUFFER'), `Reason specifies INSUFFICIENT_BUFFER for ${wait}m`);
  }

  // 4.3 Inter-station LKO -> ASH with 36m rejected in trust gate
  const splitInterStationShort = {
    trainNo: '12353',
    isSameTrain: false,
    rescueType: 'HUB_SPLIT',
    bufferMinutes: 36,
    wait_time: 36,
    legs: [
      { trainNo: '12353', fromCode: 'HWH', toCode: 'LKO', departure: '08:00', arrival: '22:00' },
      { trainNo: '15008', fromCode: 'ASH', toCode: 'NDLS', departure: '22:36', arrival: '06:00' }
    ]
  };
  const isOutcome = await validateCandidate(
    splitInterStationShort,
    ['HWH'],
    ['NDLS'],
    dummyDate,
    scheduleMemo,
    providerMemo,
    'SL',
    'GN'
  );
  assert('4.06', !isOutcome.ok, 'Inter-station LKO -> ASH with 36m rejected by trust gate');
  assert('4.07', (isOutcome.reason || '').includes('INSUFFICIENT_INTER_STATION_BUFFER') || (isOutcome.reason || '').includes('INSUFFICIENT_BUFFER'), 'Reason flags insufficient buffer');

  // 4.4 test_same_train_rescue_0m_buffer_unaffected
  // Same-train rescue with 0m buffer must pass buffer check!
  const sameTrainRescue = {
    trainNo: '12627',
    isSameTrain: true,
    rescueType: 'SAME_TRAIN_SEGMENT',
    bufferMinutes: 0,
    wait_time: 0,
    legs: [
      { trainNo: '12627', fromCode: 'SBC', toCode: 'ET', departure: '19:20', arrival: '21:20' },
      { trainNo: '12627', fromCode: 'ET', toCode: 'NDLS', departure: '21:20', arrival: '09:00' }
    ]
  };

  // We test the initial gate check inside validateCandidate
  // Since mock train 12627 schedule may or may not exist in DB during unit test,
  // we check that the buffer validation itself did NOT reject it.
  const sameTrainRes = await validateCandidate(
    sameTrainRescue,
    ['SBC'],
    ['NDLS'],
    dummyDate,
    scheduleMemo,
    providerMemo,
    'SL',
    'GN'
  );
  // It should NOT be rejected for buffer:
  assert('4.08', !sameTrainRes.reason?.includes('INSUFFICIENT_BUFFER'), 'Same-train rescue with 0m buffer is NOT rejected by buffer gate');

  // 4.5 Legitimate Pune destinations: PUNE, SVJR, KK, HDP accepted in trust gate check
  for (const dest of ['PUNE', 'SVJR', 'KK', 'HDP']) {
    const splitValidPune = {
      trainNo: '12156',
      isSameTrain: false,
      rescueType: 'HUB_SPLIT',
      bufferMinutes: 60,
      wait_time: 60,
      legs: [
        { trainNo: '12156', fromCode: 'NDLS', toCode: 'BPL', departure: '20:40', arrival: '05:30' },
        { trainNo: '12138', fromCode: 'BPL', toCode: dest, departure: '06:30', arrival: '20:00' }
      ]
    };
    const res = await validateCandidate(
      splitValidPune,
      ['NDLS'],
      ['PUNE', 'SHIV', 'KK', 'HDP'],
      dummyDate,
      scheduleMemo,
      providerMemo,
      'SL',
      'GN'
    );
    assert(`4.09-${dest}`, !res.reason?.includes('DESTINATION_CLUSTER_INCOMPATIBLE'), `Legitimate Pune destination ${dest} passes destination gate`);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// 5. SOURCE INTEGRITY & INVARIANTS
// ─────────────────────────────────────────────────────────────────────────────
console.log('\n-- 5. Source Invariants & Engine Constants --');

const engineSrc = fs.readFileSync(
  path.join(__dirname, '..', 'services', 'splitJourneyEngine.ts'),
  'utf8'
);

assert('5.01', engineSrc.includes('MIN_BUFFER_MINUTES = 45'), 'MIN_BUFFER_MINUTES = 45 defined');
assert('5.02', engineSrc.includes('MAX_BUFFER_MINUTES = 840'), 'MAX_BUFFER_MINUTES = 840 preserved');
assert('5.03', engineSrc.includes('PHASE_087N145'), 'PHASE_087N145 markers present in splitJourneyEngine');
assert('5.04', !engineSrc.includes('waitMins < 25'), 'Hardcoded waitMins < 25 completely removed');

// Run async tests and print summary
runTrustGateTests().then(() => {
  console.log('\n================================================================');
  console.log(`PHASE_087N145 -- ${passed} passed, ${failed} failed`);
  if (failed > 0) {
    console.error('FAILURES:');
    failures.forEach(f => console.error('  - ' + f));
    process.exit(1);
  } else {
    console.log('ALL PHASE_087N145 TESTS PASSED SUCCESSFULLY');
    process.exit(0);
  }
}).catch(err => {
  console.error('Test runner fatal error:', err);
  process.exit(1);
});
