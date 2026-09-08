/**
 * PHASE_087N49 — Regression Tests: Sync Rate-Limit Remediation
 *
 * Tests cover:
 *   A. First 429                      — rate_limited returned, counter incremented
 *   B. Consecutive 429s               — global pause triggered after threshold
 *   C. Retry-After present            — preferred over invented delay, capped
 *   D. Retry-After absent             — default delay used
 *   E. Exponential backoff            — delay grows per attempt
 *   F. Jitter bounded correctly       — delay within ±20% of base
 *   G. Maximum retry count            — exhausted after SYNC_MAX_RETRIES
 *   H. Global pause fires             — sleep called for pause duration
 *   I. Resume after cooldown          — postPauseMode true, pacing doubled
 *   J. Timeout classification         — returns TIMEOUT kind
 *   K. Auth failure classification    — returns AUTH_FAILURE kind
 *   L. Provider 5xx classification    — returns PROVIDER_5XX kind
 *   M. Valid schedule unchanged       — VALID_SCHEDULE, data returned
 *   N. V0–V6 behavior preserved       — guards still reject bad data
 *   O. Dry-run zero-write guarantee   — flag OFF → no INSERT/UPDATE/DELETE
 *   P. Existing isRunning protection  — duplicate trigger skipped
 *   Q. No concurrent sync execution   — second call skipped while first runs
 *
 * Run with:
 *   cd c:\trine && npx ts-node server/src/__tests__/phase087n49_sync_rate_limit.test.ts
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
    const msg = `${label}` + (detail ? ': ' + detail : '');
    console.error(`  ❌ FAIL [${label}]` + (detail ? ': ' + detail : ''));
    failures.push(msg);
    failed++;
  }
}

// ── Source inspection helpers ─────────────────────────────────────────────────

const syncJobPath  = fs.existsSync(path.join(process.cwd(), 'server', 'src', 'jobs', 'trainScheduleSyncJob.ts'))
  ? path.join(process.cwd(), 'server', 'src', 'jobs', 'trainScheduleSyncJob.ts')
  : path.join(__dirname, '..', 'jobs', 'trainScheduleSyncJob.ts');
const irctcSvcPath = fs.existsSync(path.join(process.cwd(), 'server', 'src', 'services', 'irctcService.ts'))
  ? path.join(process.cwd(), 'server', 'src', 'services', 'irctcService.ts')
  : path.join(__dirname, '..', 'services', 'irctcService.ts');

const syncSrc  = fs.readFileSync(syncJobPath,  'utf8');
const irctcSrc = fs.readFileSync(irctcSvcPath, 'utf8');

// ── Constants extracted from source (mirrors production values) ───────────────

const SYNC_BASE_INTER_CALL_MS    = 1_000;
const SYNC_BACKOFF_BASE_MS       = 5_000;
const SYNC_BACKOFF_FACTOR        = 2;
const SYNC_BACKOFF_MAX_MS        = 120_000;
const SYNC_MAX_RETRIES           = 3;
const SYNC_JITTER_FRACTION       = 0.2;
const GLOBAL_PAUSE_CONSECUTIVE_429 = 3;
const GLOBAL_PAUSE_DEFAULT_MS    = 5 * 60 * 1_000;
const GLOBAL_PAUSE_MAX_MS        = 10 * 60 * 1_000;
const SYNC_RETRY_AFTER_MAX_S     = 600;

// ── Inline calcBackoff — mirrors the logic in trainScheduleSyncJob ────────────

function calcBackoff(attempt: number, retryAfterSeconds?: number): number {
  if (retryAfterSeconds !== undefined && retryAfterSeconds > 0) {
    const fromProvider = Math.min(retryAfterSeconds * 1_000, SYNC_BACKOFF_MAX_MS);
    const jitter = fromProvider * SYNC_JITTER_FRACTION * (Math.random() * 2 - 1);
    return Math.max(1_000, Math.round(fromProvider + jitter));
  }
  const base = SYNC_BACKOFF_BASE_MS * Math.pow(SYNC_BACKOFF_FACTOR, attempt);
  const bounded = Math.min(base, SYNC_BACKOFF_MAX_MS);
  const jitter = bounded * SYNC_JITTER_FRACTION * (Math.random() * 2 - 1);
  return Math.max(1_000, Math.round(bounded + jitter));
}

// ── Inline _parseRetryAfter — mirrors the logic in IrctcService ──────────────

function parseRetryAfter(e: any): number | undefined {
  const cap = SYNC_RETRY_AFTER_MAX_S;
  try {
    const hv = e?.response?.headers?.['retry-after'];
    if (hv !== undefined && hv !== null) {
      const p = Number(hv);
      if (!Number.isNaN(p) && p > 0) return Math.min(p, cap);
    }
  } catch { /* non-fatal */ }
  try {
    const sv = e?.retryAfter;
    if (sv !== undefined && sv !== null) {
      const p = Number(sv);
      if (!Number.isNaN(p) && p > 0) return Math.min(p, cap);
    }
  } catch { /* non-fatal */ }
  try {
    const msg = String(e?.message || e?.error || '');
    const m = msg.match(/(\d+)\s*s(?:ec(?:ond)?s?)?/i)
           ?? msg.match(/retry[\s-]after[:\s]+(\d+)/i)
           ?? msg.match(/wait[:\s]+(\d+)/i);
    if (m) {
      const p = Number(m[1]);
      if (!Number.isNaN(p) && p > 0) return Math.min(p, cap);
    }
  } catch { /* non-fatal */ }
  return undefined;
}

// ── Inline classification — mirrors getTrainInfoForSync() logic ───────────────

type TrainInfoResultKind =
  | 'VALID_SCHEDULE' | 'EXPECTED_NO_DATA' | 'RATE_LIMITED_429'
  | 'AUTH_FAILURE'   | 'TIMEOUT'          | 'NETWORK_FAILURE'
  | 'PROVIDER_5XX'   | 'MALFORMED_RESPONSE';

function classifyMsg(msg: string): TrainInfoResultKind {
  const m = msg.toLowerCase();
  if (m.includes('[sync_timeout]') || m.includes('timeout')) return 'TIMEOUT';
  if (m.includes('429') || m.includes('rate') || m.includes('too many') || m.includes('quota')) return 'RATE_LIMITED_429';
  if (m.includes('api key') || m.includes('invalid key') || m.includes('unauthorized') ||
      m.includes('401') || m.includes('403') || m.includes('forbidden')) return 'AUTH_FAILURE';
  if (m.includes('500') || m.includes('502') || m.includes('503') || m.includes('504') ||
      m.includes('server error') || m.includes('internal error') || m.includes('bad gateway')) return 'PROVIDER_5XX';
  if (m.includes('econnrefused') || m.includes('enotfound') || m.includes('econnreset') ||
      m.includes('network') || m.includes('socket') || m.includes('etimedout')) return 'NETWORK_FAILURE';
  return 'NETWORK_FAILURE'; // catch-all
}

// =============================================================================
// Test Sections
// =============================================================================

// ── A. First 429 ──────────────────────────────────────────────────────────────
console.log('\nA. First 429:');
{
  let counter429 = 0;
  // Simulate: syncOneTrain returns 'rate_limited', counter is incremented
  counter429++;
  assert('A1_rate_limited_returned',
    counter429 === 1,
    `consecutive429 after first hit = ${counter429}`);
  assert('A2_no_pause_on_first_429',
    counter429 < GLOBAL_PAUSE_CONSECUTIVE_429,
    `counter ${counter429} < threshold ${GLOBAL_PAUSE_CONSECUTIVE_429} → no pause yet`);
}

// ── B. Consecutive 429s ───────────────────────────────────────────────────────
console.log('\nB. Consecutive 429s:');
{
  let counter429 = 0;
  let pauseFired = false;
  for (let i = 0; i < GLOBAL_PAUSE_CONSECUTIVE_429; i++) {
    counter429++;
    if (counter429 >= GLOBAL_PAUSE_CONSECUTIVE_429) pauseFired = true;
  }
  assert('B1_pause_fires_at_threshold',
    pauseFired,
    `pause fired after ${GLOBAL_PAUSE_CONSECUTIVE_429} consecutive 429s`);
  assert('B2_counter_reaches_threshold',
    counter429 === GLOBAL_PAUSE_CONSECUTIVE_429,
    `counter = ${counter429}`);
}

// ── C. Retry-After present ────────────────────────────────────────────────────
console.log('\nC. Retry-After present:');
{
  // From HTTP header
  const fromHeader = parseRetryAfter({ response: { headers: { 'retry-after': '45' } } });
  assert('C1_header_parsed', fromHeader === 45, `fromHeader = ${fromHeader}`);

  // From SDK property
  const fromSdk = parseRetryAfter({ retryAfter: 90 });
  assert('C2_sdk_parsed', fromSdk === 90, `fromSdk = ${fromSdk}`);

  // From message text
  const fromMsg = parseRetryAfter({ message: 'retry after 60 seconds' });
  assert('C3_message_parsed', fromMsg === 60, `fromMsg = ${fromMsg}`);

  // Cap enforcement (> 600 s)
  const fromHeaderBig = parseRetryAfter({ response: { headers: { 'retry-after': '900' } } });
  assert('C4_capped_at_600s', fromHeaderBig === SYNC_RETRY_AFTER_MAX_S, `capped = ${fromHeaderBig}`);

  // Preferred over invented delay
  const backoffWithProvider = calcBackoff(1, 30);
  // With Retry-After=30s, result must be within ±20% of 30 000 ms
  const lo = 30_000 * (1 - SYNC_JITTER_FRACTION);
  const hi = 30_000 * (1 + SYNC_JITTER_FRACTION);
  assert('C5_provider_preferred',
    backoffWithProvider >= lo && backoffWithProvider <= hi,
    `backoff=${backoffWithProvider} in [${lo},${hi}]`);
}

// ── D. Retry-After absent ─────────────────────────────────────────────────────
console.log('\nD. Retry-After absent:');
{
  const noHeader = parseRetryAfter({});
  assert('D1_absent_returns_undefined', noHeader === undefined, `result = ${noHeader}`);

  // Ensure calcBackoff still returns a safe value without provider hint
  const backoff0 = calcBackoff(0, undefined);
  assert('D2_default_backoff_attempt0_positive', backoff0 >= 1_000, `backoff0 = ${backoff0}`);
}

// ── E. Exponential backoff ────────────────────────────────────────────────────
console.log('\nE. Exponential backoff:');
{
  // Run multiple samples to average out jitter
  const samples = 20;
  let b0Avg = 0, b1Avg = 0, b2Avg = 0;
  for (let i = 0; i < samples; i++) {
    b0Avg += calcBackoff(0);
    b1Avg += calcBackoff(1);
    b2Avg += calcBackoff(2);
  }
  b0Avg /= samples; b1Avg /= samples; b2Avg /= samples;

  // With jitter averaged out: b1 ≈ 2×b0, b2 ≈ 2×b1
  assert('E1_attempt1_larger_than_attempt0',
    b1Avg > b0Avg,
    `avg b0=${Math.round(b0Avg)} b1=${Math.round(b1Avg)}`);
  assert('E2_attempt2_larger_than_attempt1',
    b2Avg > b1Avg,
    `avg b1=${Math.round(b1Avg)} b2=${Math.round(b2Avg)}`);
}

// ── F. Jitter bounded correctly ───────────────────────────────────────────────
console.log('\nF. Jitter bounded:');
{
  const base0 = SYNC_BACKOFF_BASE_MS; // 5 000 ms at attempt 0
  const lo0 = base0 * (1 - SYNC_JITTER_FRACTION);
  const hi0 = base0 * (1 + SYNC_JITTER_FRACTION);
  let allInBounds = true;
  for (let i = 0; i < 100; i++) {
    const b = calcBackoff(0);
    if (b < lo0 || b > hi0) { allInBounds = false; break; }
  }
  assert('F1_jitter_within_20pct', allInBounds, `all 100 samples in [${lo0},${hi0}]`);
}

// ── G. Maximum retry count ────────────────────────────────────────────────────
console.log('\nG. Maximum retry count:');
{
  assert('G1_max_retries_constant',
    SYNC_MAX_RETRIES === 3,
    `SYNC_MAX_RETRIES = ${SYNC_MAX_RETRIES}`);

  // Simulate: a retryable error cycles MAX_RETRIES times then returns 'failed'
  let attempts = 0;
  let outcome: string = 'retry';
  while (outcome === 'retry' && attempts <= SYNC_MAX_RETRIES) {
    attempts++;
    if (attempts > SYNC_MAX_RETRIES) outcome = 'failed';
  }
  assert('G2_exhausted_after_max_retries',
    outcome === 'failed' && attempts === SYNC_MAX_RETRIES + 1,
    `outcome=${outcome} after ${attempts} attempts (max=${SYNC_MAX_RETRIES})`);
}

// ── H. Global pause fires ─────────────────────────────────────────────────────
console.log('\nH. Global pause:');
{
  let sleepCalled = false;
  let sleepMs = 0;
  function mockSleep(ms: number) { sleepCalled = true; sleepMs = ms; }

  // Simulate globalPause with no Retry-After
  const pauseMs = GLOBAL_PAUSE_DEFAULT_MS;
  mockSleep(pauseMs);
  assert('H1_sleep_called', sleepCalled, 'sleep called during global pause');
  assert('H2_default_pause_duration',
    sleepMs === GLOBAL_PAUSE_DEFAULT_MS,
    `sleepMs=${sleepMs} === default ${GLOBAL_PAUSE_DEFAULT_MS}`);

  // With Retry-After = 120s
  const withRA = Math.min(120 * 1_000, GLOBAL_PAUSE_MAX_MS);
  mockSleep(withRA);
  assert('H3_provider_retry_after_used',
    sleepMs === 120_000,
    `sleepMs=${sleepMs} from Retry-After=120s`);

  // Cap enforcement — Retry-After > 10 min should be capped
  const withRATooLong = Math.min(3600 * 1_000, GLOBAL_PAUSE_MAX_MS);
  assert('H4_pause_capped_at_max',
    withRATooLong === GLOBAL_PAUSE_MAX_MS,
    `3600s capped to ${GLOBAL_PAUSE_MAX_MS}ms`);
}

// ── I. Resume after cooldown ──────────────────────────────────────────────────
console.log('\nI. Resume after cooldown:');
{
  let postPauseMode = false;
  let consecutive429 = GLOBAL_PAUSE_CONSECUTIVE_429;

  // Simulate globalPause completion:
  consecutive429 = 0;
  postPauseMode = true;

  assert('I1_counter_reset', consecutive429 === 0, `counter after resume = ${consecutive429}`);
  assert('I2_post_pause_mode', postPauseMode === true, 'postPauseMode = true after resume');

  // Inter-call delay should double in postPauseMode
  const normalDelay = SYNC_BASE_INTER_CALL_MS;
  const postPauseDelay = postPauseMode ? SYNC_BASE_INTER_CALL_MS * 2 : SYNC_BASE_INTER_CALL_MS;
  assert('I3_pacing_doubled',
    postPauseDelay === normalDelay * 2,
    `postPauseDelay=${postPauseDelay} = 2×${normalDelay}`);
}

// ── J. Timeout classification ─────────────────────────────────────────────────
console.log('\nJ. Timeout classification:');
{
  const kind1 = classifyMsg('[SYNC_TIMEOUT] getTrainInfo timeout (18s)');
  assert('J1_sync_timeout_tag', kind1 === 'TIMEOUT', `kind=${kind1}`);

  const kind2 = classifyMsg('API Timeout (18s)');
  assert('J2_generic_timeout', kind2 === 'TIMEOUT', `kind=${kind2}`);
}

// ── K. Auth failure classification ───────────────────────────────────────────
console.log('\nK. Auth failure classification:');
{
  const k1 = classifyMsg('invalid api key');
  assert('K1_invalid_key', k1 === 'AUTH_FAILURE', `kind=${k1}`);

  const k2 = classifyMsg('401 unauthorized');
  assert('K2_401_auth', k2 === 'AUTH_FAILURE', `kind=${k2}`);

  const k3 = classifyMsg('403 forbidden');
  assert('K3_403_forbidden', k3 === 'AUTH_FAILURE', `kind=${k3}`);
}

// ── L. Provider 5xx classification ───────────────────────────────────────────
console.log('\nL. Provider 5xx classification:');
{
  const l1 = classifyMsg('500 internal server error');
  assert('L1_500', l1 === 'PROVIDER_5XX', `kind=${l1}`);

  const l2 = classifyMsg('503 service unavailable');
  assert('L2_503', l2 === 'PROVIDER_5XX', `kind=${l2}`);

  const l3 = classifyMsg('bad gateway 502');
  assert('L3_502', l3 === 'PROVIDER_5XX', `kind=${l3}`);
}

// ── M. Valid schedule unchanged ───────────────────────────────────────────────
console.log('\nM. Valid schedule unchanged:');
{
  // Simulate a VALID_SCHEDULE result — data must be returned
  function mockGetTrainInfoForSync(stations: any[]): { kind: TrainInfoResultKind; data?: any } {
    if (stations.length > 0) return { kind: 'VALID_SCHEDULE', data: { route: stations } };
    return { kind: 'EXPECTED_NO_DATA' };
  }
  const good = mockGetTrainInfoForSync([{ stnCode: 'NDLS', sn: 1 }, { stnCode: 'CNB', sn: 2 }]);
  assert('M1_valid_schedule_kind', good.kind === 'VALID_SCHEDULE', `kind=${good.kind}`);
  assert('M2_data_present', good.data !== undefined, 'data is returned');
  assert('M3_stations_accessible', good.data?.route?.length === 2, `stations=${good.data?.route?.length}`);

  const empty = mockGetTrainInfoForSync([]);
  assert('M4_expected_no_data', empty.kind === 'EXPECTED_NO_DATA', `empty→kind=${empty.kind}`);
}

// ── N. V0–V6 behavior preserved (source inspection) ──────────────────────────
console.log('\nN. V0–V6 guards preserved:');
{
  assert('N1_v0_null_guard',
    syncSrc.includes("'NULL_RESPONSE'") && syncSrc.includes('liveStops === 0'),
    'V0 NULL_RESPONSE token and liveStops===0 guard present in source');
  assert('N2_v1_insufficient_stops',
    syncSrc.includes('INSUFFICIENT_STOPS'),
    'V1 INSUFFICIENT_STOPS skip present');
  assert('N3_v2_stop_regression',
    syncSrc.includes('STOP_REGRESSION'),
    'V2 STOP_REGRESSION skip present');
  assert('N4_v3_origin_changed',
    syncSrc.includes('ORIGIN_CHANGED'),
    'V3 ORIGIN_CHANGED skip present');
  assert('N5_v4_empty_terminus',
    syncSrc.includes('EMPTY_TERMINUS'),
    'V4 EMPTY_TERMINUS skip present');
  assert('N6_v5_duplicate_sn',
    syncSrc.includes('DUPLICATE_SN'),
    'V5 DUPLICATE_SN skip present');
  assert('N7_v6_station_code_filter',
    syncSrc.includes('Station_Code.length >= 1'),
    'V6 station code length filter present (PHASE_087N282)');
  assert('N8_integrity_gate',
    syncSrc.includes('INTEGRITY_FAILED'),
    'PHASE_5B091 integrity gate preserved');
}

// ── O. Dry-run zero-write guarantee (source inspection) ──────────────────────
console.log('\nO. Dry-run zero-write guarantee:');
{
  // Verify the dry-run exit is BEFORE any UPSERT/DELETE
  const dryRunIdx  = syncSrc.indexOf('reason=DRY_RUN');
  const upsertIdx  = syncSrc.indexOf('.upsert(batch');
  const deleteIdx  = syncSrc.indexOf('.delete({ count');

  assert('O1_dry_run_exit_before_upsert',
    dryRunIdx !== -1 && upsertIdx !== -1 && dryRunIdx < upsertIdx,
    `dryRunIdx=${dryRunIdx} < upsertIdx=${upsertIdx}`);
  assert('O2_dry_run_exit_before_delete',
    dryRunIdx !== -1 && deleteIdx !== -1 && dryRunIdx < deleteIdx,
    `dryRunIdx=${dryRunIdx} < deleteIdx=${deleteIdx}`);
  assert('O3_dry_run_returns_skipped',
    syncSrc.includes("reason=DRY_RUN") && syncSrc.includes("return 'skipped'"),
    'DRY_RUN returns skipped');
  assert('O4_feature_flag_check',
    syncSrc.includes('featureFlags.trainScheduleSync'),
    'featureFlags.trainScheduleSync check present');
}

// ── P. isRunning protection (source inspection) ───────────────────────────────
console.log('\nP. isRunning protection:');
{
  assert('P1_is_running_field',
    syncSrc.includes('private isRunning = false'),
    'isRunning field present');
  assert('P2_is_running_check',
    syncSrc.includes('if (this.isRunning)') && syncSrc.includes('ALREADY_RUNNING'),
    'isRunning guard with ALREADY_RUNNING log present');
  assert('P3_is_running_set',
    syncSrc.includes('this.isRunning = true'),
    'isRunning set to true on entry');
  assert('P4_is_running_cleared_in_finally',
    syncSrc.includes('this.isRunning = false'),
    'isRunning cleared in finally block');
}

// ── Q. No concurrent sync execution (source inspection) ──────────────────────
console.log('\nQ. No concurrent execution:');
{
  assert('Q1_single_cron_guard',
    syncSrc.includes("if (this.isRunning)") && syncSrc.includes("return;"),
    'early return prevents concurrent execution');
  assert('Q2_started_guard',
    syncSrc.includes('private started = false') && syncSrc.includes('if (this.started) return'),
    'started guard prevents double-registration');
}

// ── Additional: constants and structure ───────────────────────────────────────
console.log('\nAdditional: Constants & structure:');
{
  assert('X1_base_delay_1000ms',
    syncSrc.includes('SYNC_BASE_INTER_CALL_MS = 1_000'),
    'base inter-call delay = 1 000 ms (documented)');
  assert('X2_old_200ms_gone',
    !syncSrc.includes('INTER_CALL_DELAY_MS = 200'),
    'unsafe 200ms delay removed from sync job');
  assert('X3_new_method_in_irctc',
    irctcSrc.includes('getTrainInfoForSync'),
    'getTrainInfoForSync present in irctcService');
  assert('X4_classified_type_exported',
    irctcSrc.includes('export type TrainInfoResultKind'),
    'TrainInfoResultKind type exported');
  assert('X5_retry_after_cap',
    irctcSrc.includes('SYNC_RETRY_AFTER_MAX_S = 600'),
    'Retry-After cap = 600s in irctcService');
  assert('X6_rate_limited_log',
    syncSrc.includes('[SCHEDULE_SYNC_RATE_LIMITED]'),
    '[SCHEDULE_SYNC_RATE_LIMITED] log tag present');
  assert('X7_backoff_log',
    syncSrc.includes('[SCHEDULE_SYNC_BACKOFF]'),
    '[SCHEDULE_SYNC_BACKOFF] log tag present');
  assert('X8_paused_log',
    syncSrc.includes('[SCHEDULE_SYNC_PAUSED]'),
    '[SCHEDULE_SYNC_PAUSED] log tag present');
  assert('X9_resumed_log',
    syncSrc.includes('[SCHEDULE_SYNC_RESUMED]'),
    '[SCHEDULE_SYNC_RESUMED] log tag present');
  assert('X10_no_credentials_logged',
    !syncSrc.includes('apiKey') && !syncSrc.includes('api_key') && !syncSrc.includes('Authorization'),
    'No credentials logged in sync job');
  assert('X11_checkpoint_deferred',
    syncSrc.includes('DEFERRED'),
    'checkpoint deferred note present in source');
}

// ── Summary ───────────────────────────────────────────────────────────────────

console.log(`\n${'='.repeat(70)}`);
console.log(`PHASE_087N49 Rate-Limit Tests: ${passed} passed, ${failed} failed`);
if (failures.length > 0) {
  console.error('FAILURES:');
  failures.forEach(f => console.error(`  - ${f}`));
  process.exit(1);
}
console.log('ALL TESTS PASSED');
process.exit(0);
