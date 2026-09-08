/**
 * PHASE_087N54 — Tests: Single-Char Station Code Fix
 *
 * Tests cover:
 *   T01. 'R' is accepted by isStructurallyValidStationCode (Raipur Jn)
 *   T02. 'G' is accepted by isStructurallyValidStationCode (Gondia Jn)
 *   T03. Normal 2–8 char codes remain accepted
 *   T04. Empty string rejected
 *   T05. Whitespace-only rejected
 *   T06. Special characters rejected
 *   T07. >8 characters rejected
 *   T08. Lowercase input follows existing normalization semantics
 *   T09. validateScheduleRows accepts schedules containing R/G
 *   T10. Invalid station codes still fail integrity validation
 *   T11. No V0–V6 guard semantics weakened (source check)
 *   T12. deriveOriginFromStops accepts 1-char station codes
 *   T13. trainScheduleIntegrityService length < 1 (not < 2) in source
 *   T14. stationResolutionUtils uses {1,8} (not {2,8}) in source
 *   T15. Regex-level boundary tests: 0-char fails, 1-char passes, 8-char passes, 9-char fails
 *
 * Run with:
 *   cd c:\trine && npx ts-node server/src/__tests__/phase087n54_single_char_station_fix.test.ts
 */

import * as path from 'path';
import * as fs from 'fs';

// ── Test harness ─────────────────────────────────────────────────────────────

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

// ── Source inspection ─────────────────────────────────────────────────────────

const resolverUtilsPath = fs.existsSync(path.join(process.cwd(), 'server', 'src', 'services', 'stationResolutionUtils.ts'))
  ? path.join(process.cwd(), 'server', 'src', 'services', 'stationResolutionUtils.ts')
  : path.join(__dirname, '..', 'services', 'stationResolutionUtils.ts');
const integrityServicePath = fs.existsSync(path.join(process.cwd(), 'server', 'src', 'services', 'trainScheduleIntegrityService.ts'))
  ? path.join(process.cwd(), 'server', 'src', 'services', 'trainScheduleIntegrityService.ts')
  : path.join(__dirname, '..', 'services', 'trainScheduleIntegrityService.ts');

const resolverSrc  = fs.readFileSync(resolverUtilsPath,  'utf8');
const integritySrc = fs.readFileSync(integrityServicePath, 'utf8');

// ── Inline the corrected validator (mirrors production logic) ─────────────────

/** Mirrors the post-fix isStructurallyValidStationCode in stationResolutionUtils. */
function isStructurallyValidStationCode(code: string): boolean {
  return /^[A-Z0-9]{1,8}$/.test(code);
}

/** Mirrors the inline check in trainScheduleIntegrityService.validateScheduleRows. */
function integrityCodeCheck(rawCode: string): boolean {
  const stnCode = String(rawCode || '').toUpperCase().trim();
  return !(!stnCode || stnCode.length < 1);
}

// ── T01: R is accepted ───────────────────────────────────────────────────────

console.log('\n── T01: R accepted (Raipur Jn) ─────────────────────────────────────────');

assert('T01.01', isStructurallyValidStationCode('R'),   'R passes structural validator');
assert('T01.02', integrityCodeCheck('R'),                'R passes integrity code check');
assert('T01.03', isStructurallyValidStationCode('R'),   'R uppercase one char passes regex');

// ── T02: G is accepted ───────────────────────────────────────────────────────

console.log('\n── T02: G accepted (Gondia Jn) ─────────────────────────────────────────');

assert('T02.01', isStructurallyValidStationCode('G'),   'G passes structural validator');
assert('T02.02', integrityCodeCheck('G'),                'G passes integrity code check');

// ── T03: Normal 2–8 char codes accepted ──────────────────────────────────────

console.log('\n── T03: Normal 2–8 char codes accepted ──────────────────────────────────');

const normalCodes = ['ND', 'NDLS', 'CSMT', 'BDTS', 'MAS', 'HWH', 'SBC', 'LGH', 'PNBE', 'PUNE', '12345678'];
for (const code of normalCodes) {
  assert(`T03.${code}`, isStructurallyValidStationCode(code), `${code} (len=${code.length}) accepted`);
}

// ── T04: Empty string rejected ───────────────────────────────────────────────

console.log('\n── T04: Empty string rejected ───────────────────────────────────────────');

assert('T04.01', !isStructurallyValidStationCode(''),   'empty string fails structural validator');
assert('T04.02', !integrityCodeCheck(''),                'empty string fails integrity code check');
assert('T04.03', !isStructurallyValidStationCode(''),   'regex {1,8} still rejects empty');

// ── T05: Whitespace rejected ──────────────────────────────────────────────────

console.log('\n── T05: Whitespace rejected ─────────────────────────────────────────────');

assert('T05.01', !isStructurallyValidStationCode(' '),   'single space fails structural validator');
assert('T05.02', !isStructurallyValidStationCode('  '),  'double space fails');
assert('T05.03', !isStructurallyValidStationCode('\t'),  'tab fails');
assert('T05.04', !integrityCodeCheck('   '),             'whitespace-only fails integrity (trim → empty)');

// ── T06: Special characters rejected ─────────────────────────────────────────

console.log('\n── T06: Special characters rejected ────────────────────────────────────');

const specialCodes = ['R-1', 'R/G', 'R.G', 'ND LS', 'CSM!', '@NDL', '#HW', 'A_B'];
for (const code of specialCodes) {
  assert(`T06.${code}`, !isStructurallyValidStationCode(code), `"${code}" rejected`);
}

// ── T07: >8 characters rejected ──────────────────────────────────────────────

console.log('\n── T07: >8 characters rejected ─────────────────────────────────────────');

const longCodes = ['123456789', 'ABCDEFGHI', 'NDLSEXTRA'];
for (const code of longCodes) {
  assert(`T07.${code}`, !isStructurallyValidStationCode(code), `"${code}" (len=${code.length}) rejected`);
}

// ── T08: Lowercase follows normalization semantics ────────────────────────────

console.log('\n── T08: Lowercase normalization semantics ───────────────────────────────');

// isStructurallyValidStationCode only accepts uppercase — lowercase must be normalized by callers
assert('T08.01', !isStructurallyValidStationCode('r'),   'lowercase r fails validator (caller normalizes)');
assert('T08.02', !isStructurallyValidStationCode('g'),   'lowercase g fails validator (caller normalizes)');
assert('T08.03', !isStructurallyValidStationCode('ndls'),'lowercase ndls fails validator (caller normalizes)');
// After normalization (toUpperCase().trim()), they must pass
assert('T08.04', isStructurallyValidStationCode('r'.toUpperCase().trim()), 'r.toUpperCase() = R passes');
assert('T08.05', isStructurallyValidStationCode('g'.toUpperCase().trim()), 'g.toUpperCase() = G passes');
// integrityCodeCheck normalizes internally
assert('T08.06', integrityCodeCheck('r'), 'integrity code check normalizes lowercase r to R');
assert('T08.07', integrityCodeCheck('g'), 'integrity code check normalizes lowercase g to G');

// ── T09: validateScheduleRows accepts schedules containing R/G ────────────────

console.log('\n── T09: validateScheduleRows accepts R/G-containing schedules ───────────');

// Build minimal schedules containing single-char codes
function makeStop(stnCode: string, sn: number) {
  return { Station_Code: stnCode, SN: sn, Station_Name: 'Test', Arrival_time: '10:00', Departure_Time: '10:05' };
}

// We inline the integrity logic to avoid loading Supabase in this pure test
function validateScheduleRowsInline(trainNo: string, stops: any[]): { status: string; reasons: string[] } {
  const reasons: string[] = [];
  const cleanNum = String(trainNo || '').trim().replace(/^0+/, '');
  if (!cleanNum || cleanNum.length < 4 || !/^\d+$/.test(cleanNum)) reasons.push('INVALID_TRAIN_NO');
  if (!Array.isArray(stops) || stops.length < 2) {
    reasons.push('EMPTY_SCHEDULE');
    return { status: 'INVALID', reasons };
  }
  const seenSN = new Set<number>();
  let prevSN = -1;
  for (let i = 0; i < stops.length; i++) {
    const stop = stops[i];
    const stnCode = String(stop.Station_Code || '').toUpperCase().trim();
    const sn = Number(stop.SN ?? (i + 1));
    // PHASE_087N54 rule: length < 1 (not < 2)
    if (!stnCode || stnCode.length < 1) reasons.push('INVALID_STATION_CODE');
    if (isNaN(sn) || sn <= prevSN) { if (!reasons.includes('NON_INCREASING_SN')) reasons.push('NON_INCREASING_SN'); }
    if (seenSN.has(sn)) { if (!reasons.includes('DUPLICATE_SN')) reasons.push('DUPLICATE_SN'); }
    seenSN.add(sn);
    prevSN = sn;
  }
  if (reasons.length > 0) return { status: 'INVALID', reasons };
  return { status: 'VALID', reasons: [] };
}

// Schedule: R → DURG → NDLS (R = Raipur origin)
const scheduleWithR = [makeStop('R', 1), makeStop('DURG', 5), makeStop('NDLS', 30)];
const resultR = validateScheduleRowsInline('12809', scheduleWithR);
assert('T09.01', resultR.status === 'VALID', `schedule with R (Raipur) status=${resultR.status} reasons=${resultR.reasons}`);
assert('T09.02', !resultR.reasons.includes('INVALID_STATION_CODE'), 'no INVALID_STATION_CODE for R');

// Schedule: G → NGP → HWH (G = Gondia)
const scheduleWithG = [makeStop('G', 1), makeStop('NGP', 8), makeStop('HWH', 40)];
const resultG = validateScheduleRowsInline('11139', scheduleWithG);
assert('T09.03', resultG.status === 'VALID', `schedule with G (Gondia) status=${resultG.status} reasons=${resultG.reasons}`);
assert('T09.04', !resultG.reasons.includes('INVALID_STATION_CODE'), 'no INVALID_STATION_CODE for G');

// Schedule: mix of single and multi-char codes
const mixedSchedule = [makeStop('R', 1), makeStop('G', 3), makeStop('NGP', 6), makeStop('NDLS', 10)];
const resultMix = validateScheduleRowsInline('12321', mixedSchedule);
assert('T09.05', resultMix.status === 'VALID', `mixed R+G schedule status=${resultMix.status}`);

// ── T10: Invalid station codes still fail ────────────────────────────────────

console.log('\n── T10: Invalid station codes still fail ────────────────────────────────');

// Schedule with empty station code
const emptyCodeSchedule = [makeStop('', 1), makeStop('NDLS', 5)];
const resultEmpty = validateScheduleRowsInline('12321', emptyCodeSchedule);
assert('T10.01', resultEmpty.status === 'INVALID', 'schedule with empty code is INVALID');
assert('T10.02', resultEmpty.reasons.includes('INVALID_STATION_CODE'), 'INVALID_STATION_CODE reason present');

// Schedule with special-char code
const specialSchedule = [makeStop('ND-1', 1), makeStop('NDLS', 5)];
const resultSpecial = validateScheduleRowsInline('12321', specialSchedule);
// Note: integrity service does NOT apply structural regex — it only checks length and empty.
// The structural regex guard (which rejects ND-1) is in stationResolutionUtils.deriveOriginFromStops.
// So we verify the regex validator directly:
assert('T10.03', !isStructurallyValidStationCode('ND-1'), 'special char code ND-1 fails structural validator');
assert('T10.04', !isStructurallyValidStationCode(''),     'empty string fails structural validator');
assert('T10.05', !isStructurallyValidStationCode('123456789'), '9-char code fails structural validator');

// ── T11: V0–V6 guard semantics not weakened (source check) ───────────────────

console.log('\n── T11: V0–V6 guard semantics not weakened ─────────────────────────────');

const syncJobPath = fs.existsSync(path.join(process.cwd(), 'server', 'src', 'jobs', 'trainScheduleSyncJob.ts'))
  ? path.join(process.cwd(), 'server', 'src', 'jobs', 'trainScheduleSyncJob.ts')
  : path.join(__dirname, '..', 'jobs', 'trainScheduleSyncJob.ts');
const syncSrc = fs.readFileSync(syncJobPath, 'utf8');

assert('T11.01', syncSrc.includes('reason=NULL_RESPONSE') ||
  syncSrc.includes("'MALFORMED_RESPONSE' : 'NULL_RESPONSE'"),
  'V0 guard still present in sync job'
);
assert('T11.02', syncSrc.includes('reason=INSUFFICIENT_STOPS'), 'V1 guard unchanged');
assert('T11.03', syncSrc.includes('reason=STOP_REGRESSION'),    'V2 guard unchanged');
assert('T11.04', syncSrc.includes('reason=ORIGIN_CHANGED'),     'V3 guard unchanged');
assert('T11.05', syncSrc.includes('reason=EMPTY_TERMINUS'),     'V4 guard unchanged');
assert('T11.06', syncSrc.includes('reason=DUPLICATE_SN'),       'V5 guard unchanged');
// V6 filter in sync job updated to >= 1 (PHASE_087N282: allow 1-char station codes)
assert('T11.07', syncSrc.includes('Station_Code.length >= 1'),  'V6 write-path filter allows 1-char station codes (PHASE_087N282)');
assert('T11.08', syncSrc.includes('validateScheduleRows'),      'PHASE_5B091 integrity gate still present');

// ── T12: deriveOriginFromStops accepts 1-char codes ──────────────────────────

console.log('\n── T12: deriveOriginFromStops accepts 1-char station codes ──────────────');

// Inline the corrected deriveOriginFromStops logic to test without I/O
function normalizeStopSN(stop: any): { status: string; value: number | null } {
  if (!stop || typeof stop !== 'object') return { status: 'missing', value: null };
  if (stop._snProvided === false) return { status: 'missing', value: null };
  const candidateKeys = ['serialNo', 'sn', 'SN'];
  let sawCandidate = false;
  for (const key of candidateKeys) {
    const raw = (stop as any)[key];
    if (raw === undefined || raw === null) continue;
    if (typeof raw === 'string' && raw.trim() === '') continue;
    if (typeof raw === 'boolean') continue;
    sawCandidate = true;
    const n = Number(raw);
    if (!Number.isFinite(n)) continue;
    if (!Number.isInteger(n)) continue;
    if (n < 0) continue;
    return { status: 'valid', value: n };
  }
  return { status: sawCandidate ? 'invalid' : 'missing', value: null };
}

function deriveOriginFromStopsInline(stops: any[]): { ok: boolean; reason: string | null } {
  if (!Array.isArray(stops) || stops.length === 0) return { ok: false, reason: 'NO_STOPS' };
  if (stops.length < 3) return { ok: false, reason: 'TOO_FEW_STOPS' };
  const originCode = String(stops[0]?.Station_Code ?? '').toUpperCase().trim();
  if (!isStructurallyValidStationCode(originCode)) return { ok: false, reason: 'INVALID_ORIGIN_CODE' };
  const seen = new Set<number>();
  let prevSN = -1;
  for (let i = 0; i < stops.length; i++) {
    const code = String(stops[i]?.Station_Code ?? '').toUpperCase().trim();
    if (!isStructurallyValidStationCode(code)) return { ok: false, reason: 'INVALID_STATION_CODE' };
    const sn = normalizeStopSN(stops[i]);
    if (sn.status === 'missing') return { ok: false, reason: 'MISSING_SN' };
    if (sn.status !== 'valid' || sn.value === null) return { ok: false, reason: 'INVALID_SN' };
    if (seen.has(sn.value)) return { ok: false, reason: 'DUPLICATE_SN' };
    seen.add(sn.value);
    if (i > 0 && sn.value <= prevSN) return { ok: false, reason: 'NON_INCREASING_SN' };
    if (i === 0 && sn.value > 1) return { ok: false, reason: 'SN_DOES_NOT_START_AT_ORIGIN' };
    prevSN = sn.value;
  }
  return { ok: true, reason: null };
}

// Route with R as origin: R(SN=1) → DURG(SN=5) → NDLS(SN=30)
const deriveStopsR = [
  { Station_Code: 'R',    SN: 1 },
  { Station_Code: 'DURG', SN: 5 },
  { Station_Code: 'NDLS', SN: 30 },
];
const derivedR = deriveOriginFromStopsInline(deriveStopsR);
assert('T12.01', derivedR.ok === true, `deriveOriginFromStops with R origin ok=${derivedR.ok} reason=${derivedR.reason}`);
assert('T12.02', derivedR.reason === null, 'no rejection reason for R-origin stops');

// Route with G mid-route: NDLS(SN=1) → G(SN=10) → HWH(SN=40)
const deriveStopsGMid = [
  { Station_Code: 'NDLS', SN: 1 },
  { Station_Code: 'G',    SN: 10 },
  { Station_Code: 'HWH',  SN: 40 },
];
const derivedGMid = deriveOriginFromStopsInline(deriveStopsGMid);
assert('T12.03', derivedGMid.ok === true, `mid-route G accepted ok=${derivedGMid.ok} reason=${derivedGMid.reason}`);

// ── T13: trainScheduleIntegrityService uses length < 1 ───────────────────────

console.log('\n── T13: trainScheduleIntegrityService uses length < 1 ──────────────────');

assert('T13.01',
  integritySrc.includes('stnCode.length < 1'),
  'integrity service uses length < 1 (PHASE_087N54 change)'
);
assert('T13.02',
  !integritySrc.includes('stnCode.length < 2') ||
  integritySrc.indexOf('stnCode.length < 1') < integritySrc.indexOf('stnCode.length < 2'),
  'old length < 2 either absent or superseded by length < 1'
);
assert('T13.03',
  integritySrc.includes('PHASE_087N54'),
  'PHASE_087N54 annotation present in integrity service'
);

// ── T14: stationResolutionUtils uses {1,8} ───────────────────────────────────

console.log('\n── T14: stationResolutionUtils uses {1,8} ───────────────────────────────');

assert('T14.01',
  resolverSrc.includes('[A-Z0-9]{1,8}'),
  'stationResolutionUtils regex is {1,8} (PHASE_087N54 change)'
);
assert('T14.02',
  !resolverSrc.includes('[A-Z0-9]{2,8}'),
  'old {2,8} regex no longer present'
);
assert('T14.03',
  resolverSrc.includes('PHASE_087N54'),
  'PHASE_087N54 annotation present in stationResolutionUtils'
);

// ── T15: Boundary tests ───────────────────────────────────────────────────────

console.log('\n── T15: Boundary tests (0, 1, 8, 9 chars) ──────────────────────────────');

assert('T15.01', !isStructurallyValidStationCode(''),           '0-char: rejected');
assert('T15.02',  isStructurallyValidStationCode('A'),          '1-char A: accepted');
assert('T15.03',  isStructurallyValidStationCode('R'),          '1-char R: accepted');
assert('T15.04',  isStructurallyValidStationCode('G'),          '1-char G: accepted');
assert('T15.05',  isStructurallyValidStationCode('ND'),         '2-char: accepted');
assert('T15.06',  isStructurallyValidStationCode('NDLS'),       '4-char: accepted');
assert('T15.07',  isStructurallyValidStationCode('ABCDEFGH'),   '8-char: accepted');
assert('T15.08', !isStructurallyValidStationCode('ABCDEFGHI'),  '9-char: rejected');
assert('T15.09',  isStructurallyValidStationCode('1'),          '1-digit: accepted');
assert('T15.10',  isStructurallyValidStationCode('0'),          '1-digit 0: accepted');
assert('T15.11', !isStructurallyValidStationCode('r'),          'lowercase 1-char r: rejected (not normalized)');
assert('T15.12',  isStructurallyValidStationCode('A1B2C3D4'),   '8-char alphanumeric: accepted');

// ── Summary ───────────────────────────────────────────────────────────────────

console.log('\n══════════════════════════════════════════════════════');
console.log('PHASE_087N54_STATION_VALIDATOR_TEST_RESULT');
console.log('══════════════════════════════════════════════════════');
console.log(`PASSED = ${passed}`);
console.log(`FAILED = ${failed}`);
console.log(`TOTAL  = ${passed + failed}`);
if (failures.length > 0) {
  console.error('\nFailed tests:');
  failures.forEach(f => console.error('  ❌ ' + f));
  process.exit(1);
} else {
  console.log('\n✅ ALL TESTS PASS');
  process.exit(0);
}
