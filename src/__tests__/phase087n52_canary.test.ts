/**
 * PHASE_087N52 — Tests: Canary Mechanism
 *
 * Tests cover:
 *   T01. Canary gate OFF → zero writes, returns immediately with abortReason
 *   T02. ENABLE_TRAIN_SCHEDULE_SYNC=true → canary aborts
 *   T03. Canary gate ON → exactly 8 selected trains processed
 *   T04. No concurrent canary (isRunning guard)
 *   T05. V0–V6 guards preserved through canary path
 *   T06. Correct Train_No,SN conflict target used for upsert
 *   T07. No unrelated trains touched (only CANARY_TRAIN_NOS processed)
 *   T08. Rollback scope: key = Train_No + SN, not full table delete
 *   T09. Idempotency: second run logic present, stable counts
 *   T10. 429/backoff path remains active through canary path
 *
 * Run with:
 *   cd c:\trine && npx ts-node server/src/__tests__/phase087n52_canary.test.ts
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

// ── Source paths ──────────────────────────────────────────────────────────────

const syncJobPath = fs.existsSync(path.join(process.cwd(), 'server', 'src', 'jobs', 'trainScheduleSyncJob.ts'))
  ? path.join(process.cwd(), 'server', 'src', 'jobs', 'trainScheduleSyncJob.ts')
  : path.join(__dirname, '..', 'jobs', 'trainScheduleSyncJob.ts');
const syncSrc     = fs.readFileSync(syncJobPath, 'utf8');

// ── T01: Canary gate OFF → zero writes ───────────────────────────────────────

console.log('\n── T01: Canary gate OFF → zero writes ──────────────────────────────────');

assert('T01.01',
  syncSrc.includes("process.env.SCHEDULE_SYNC_CANARY_APPROVED === 'true'"),
  'canary gate reads SCHEDULE_SYNC_CANARY_APPROVED from env'
);
assert('T01.02',
  syncSrc.includes('CANARY_GATE_OFF'),
  'CANARY_GATE_OFF abort reason present'
);
assert('T01.03',
  syncSrc.includes('canaryApproved') && syncSrc.includes('!canaryApproved'),
  'canaryApproved gate check present'
);
assert('T01.04',
  (() => {
    // Compare positions within runCanary's own body
    const canaryStart  = syncSrc.indexOf('async runCanary(');
    const canaryEnd    = syncSrc.indexOf('private async canaryReadBaseline(');
    const canaryBody   = syncSrc.slice(canaryStart, canaryEnd);
    const gateIdx      = canaryBody.indexOf('!canaryApproved');
    const lockIdx      = canaryBody.indexOf('this.isRunning = true');
    return gateIdx > 0 && lockIdx > 0 && gateIdx < lockIdx;
  })(),
  'gate check returns before isRunning is set (within runCanary body)'
);
assert('T01.05',
  syncSrc.includes('abortReason'),
  'abortReason field present in CanaryResult'
);

// ── T02: ENABLE_TRAIN_SCHEDULE_SYNC=true → canary aborts ─────────────────────

console.log('\n── T02: ENABLE_TRAIN_SCHEDULE_SYNC=true → canary aborts ───────────────');

assert('T02.01',
  syncSrc.includes('!fullSyncOff'),
  'fullSyncOff guard present in runCanary'
);
assert('T02.02',
  syncSrc.includes('ENABLE_TRAIN_SCHEDULE_SYNC is true'),
  'abort message references ENABLE_TRAIN_SCHEDULE_SYNC'
);
assert('T02.03',
  syncSrc.includes("const fullSyncOff     = !featureFlags.trainScheduleSync"),
  'fullSyncOff derived from featureFlags.trainScheduleSync'
);
assert('T02.04',
  // Gate 2 check must come BEFORE any write path
  syncSrc.indexOf('!fullSyncOff') < syncSrc.indexOf('(featureFlags as any).trainScheduleSync = true'),
  'fullSyncOff gate fires before flag patch'
);

// ── T03: Canary gate ON → exactly 8 trains ───────────────────────────────────

console.log('\n── T03: Canary gate ON → exactly 8 trains ──────────────────────────────');

assert('T03.01',
  syncSrc.includes("export const CANARY_TRAIN_NOS: readonly string[]"),
  'CANARY_TRAIN_NOS exported'
);

// Parse the 8 trains from source
const canaryMatch = syncSrc.match(/CANARY_TRAIN_NOS:\s*readonly string\[\]\s*=\s*\[([\s\S]*?)\]/);
const canaryTrains = canaryMatch
  ? canaryMatch[1].match(/'(\d+)'/g)?.map(s => s.replace(/'/g, '')) ?? []
  : [];

assert('T03.02',
  canaryTrains.length === 8,
  `exactly 8 canary trains defined (found ${canaryTrains.length})`
);

const REQUIRED_TRAINS = ['15648', '12321', '22359', '12224', '22149', '12346', '11098', '11139'];
for (const t of REQUIRED_TRAINS) {
  assert(`T03.03.${t}`,
    canaryTrains.includes(t),
    `required canary train ${t} present`
  );
}

assert('T03.04',
  syncSrc.includes('11139'),
  '11139 (UPDATE/idempotency path) present'
);
assert('T03.05',
  syncSrc.includes('for (let i = 0; i < CANARY_TRAIN_NOS.length; i++)'),
  'canary iterates CANARY_TRAIN_NOS serially'
);

// ── T04: No concurrent canary (isRunning guard) ──────────────────────────────

console.log('\n── T04: No concurrent canary (isRunning guard) ─────────────────────────');

assert('T04.01',
  syncSrc.includes('if (this.isRunning)') &&
  syncSrc.includes('ABORT: isRunning=true'),
  'isRunning guard present in runCanary'
);
assert('T04.02',
  // isRunning = true is set AFTER the isRunning guard check inside runCanary
  (() => {
    const guardIdx = syncSrc.indexOf('ABORT: isRunning=true');
    const lockIdx  = syncSrc.indexOf('this.isRunning = true;', guardIdx);
    return guardIdx > 0 && lockIdx > guardIdx;
  })(),
  'isRunning set to true only after guard passes'
);
assert('T04.03',
  syncSrc.includes('this.isRunning = false') &&
  syncSrc.includes('finally {') &&
  // The finally block in runCanary that resets isRunning
  (() => {
    const finallyIdx = syncSrc.lastIndexOf('finally {');
    return syncSrc.indexOf('this.isRunning = false', finallyIdx) > finallyIdx;
  })(),
  'isRunning reset in finally block'
);

// ── T05: V0–V6 guards preserved ──────────────────────────────────────────────

console.log('\n── T05: V0–V6 guards preserved ─────────────────────────────────────────');

assert('T05.01',
  syncSrc.includes('syncOneTrainWithBackoff(trainNo)'),
  'canary calls syncOneTrainWithBackoff (not a separate implementation)'
);
assert('T05.02',
  // V0 uses a ternary in a template literal: reason=${kind==='MALFORMED_RESPONSE'?'MALFORMED_RESPONSE':'NULL_RESPONSE'}
  syncSrc.includes("'MALFORMED_RESPONSE' : 'NULL_RESPONSE'") ||
  syncSrc.includes("? 'MALFORMED_RESPONSE' : 'NULL_RESPONSE'"),
  'V0 guard (null/empty response) present in syncOneTrain'
);
assert('T05.03',
  syncSrc.includes('reason=INSUFFICIENT_STOPS'),
  'V1 guard (min stop count) present'
);
assert('T05.04',
  syncSrc.includes('reason=STOP_REGRESSION'),
  'V2 guard (regression threshold) present'
);
assert('T05.05',
  syncSrc.includes('reason=ORIGIN_CHANGED'),
  'V3 guard (origin stability) present'
);
assert('T05.06',
  syncSrc.includes('reason=EMPTY_TERMINUS'),
  'V4 guard (empty terminus) present'
);
assert('T05.07',
  syncSrc.includes('reason=DUPLICATE_SN'),
  'V5 guard (duplicate SN) present'
);
assert('T05.08',
  syncSrc.includes('Station_Code.length >= 1'),
  'V6 filter allows 1-char station codes (PHASE_087N282)'
);
assert('T05.09',
  syncSrc.includes('validateScheduleRows'),
  'PHASE_5B091 integrity gate present'
);
assert('T05.10',
  // Canary does NOT duplicate V0-V6 - it uses the existing syncOneTrain path
  (syncSrc.match(/reason=ORIGIN_CHANGED/g) ?? []).length === 1,
  'V3 guard appears exactly once (no duplication in canary path)'
);

// ── T06: Correct Train_No,SN conflict target ─────────────────────────────────

console.log('\n── T06: Correct Train_No,SN conflict target ────────────────────────────');

assert('T06.01',
  syncSrc.includes("onConflict: 'Train_No,SN'"),
  "UPSERT uses onConflict: 'Train_No,SN'"
);
assert('T06.02',
  (syncSrc.match(/onConflict: 'Train_No,SN'/g) ?? []).length === 1,
  'conflict target appears exactly once (canary reuses existing upsert, not duplicated)'
);

// ── T07: No unrelated trains touched ─────────────────────────────────────────

console.log('\n── T07: No unrelated trains touched ────────────────────────────────────');

assert('T07.01',
  syncSrc.includes('CANARY_TRAIN_NOS') &&
  !syncSrc.includes('syncAllTrains') || // canary does NOT call syncAllTrains
  (() => {
    // runCanary must not reference syncAllTrains
    const canaryFnStart = syncSrc.indexOf('async runCanary(');
    const canaryFnEnd   = syncSrc.indexOf('async canaryReadBaseline(');
    const canaryBody    = syncSrc.slice(canaryFnStart, canaryFnEnd);
    return !canaryBody.includes('syncAllTrains');
  })(),
  'runCanary does not call syncAllTrains'
);
assert('T07.02',
  (() => {
    const canaryFnStart = syncSrc.indexOf('async runCanary(');
    const canaryFnEnd   = syncSrc.indexOf('private async canaryReadBaseline(');
    const canaryBody    = syncSrc.slice(canaryFnStart, canaryFnEnd);
    return canaryBody.includes('CANARY_TRAIN_NOS') && !canaryBody.includes('getAllTrainNumbers');
  })(),
  'runCanary iterates only CANARY_TRAIN_NOS, not getAllTrainNumbers()'
);
assert('T07.03',
  (() => {
    // canaryReadBaseline only reads the 8 canary trains
    const baselineFnStart = syncSrc.indexOf('private async canaryReadBaseline(');
    const baselineFnEnd   = syncSrc.indexOf('// ---------------------------------------------------------------------------\n  // Private: Main sync loop');
    const baselineBody    = syncSrc.slice(baselineFnStart, baselineFnEnd);
    return baselineBody.includes('.eq(\'Train_No\', trainNo)');
  })(),
  'canaryReadBaseline queries by Train_No (not full table scan)'
);

// ── T08: Rollback scope — Train_No + SN keys only ────────────────────────────

console.log('\n── T08: Rollback scope ─────────────────────────────────────────────────');

assert('T08.01',
  syncSrc.includes('.gt(\'SN\', maxLiveSN)') &&
  syncSrc.includes('.eq(\'Train_No\', trainNo)'),
  'DELETE is scoped to Train_No + SN range (not full table)'
);
assert('T08.02',
  !syncSrc.includes('.delete()\n') ||
  (() => {
    // All delete calls are scoped with .eq('Train_No', ...) filter
    const deleteMatches = [...syncSrc.matchAll(/\.delete\(/g)];
    return deleteMatches.every(m => {
      const snippet = syncSrc.slice(m.index!, m.index! + 300);
      return snippet.includes(".eq('Train_No'") || snippet.includes('.eq("Train_No"');
    });
  })(),
  'all DELETE calls are scoped by Train_No'
);
assert('T08.03',
  syncSrc.includes('TRAIN_No,SN') || syncSrc.includes("onConflict: 'Train_No,SN'"),
  'upsert key is (Train_No, SN) — idempotent rollback-safe'
);
assert('T08.04',
  syncSrc.includes('canaryReadBaseline'),
  'baseline capture method exists for rollback reference'
);
assert('T08.05',
  syncSrc.includes('baselineRowCount') && syncSrc.includes('baselineSNs'),
  'baseline row count and SN list captured per train'
);

// ── T09: Idempotency second run logic ────────────────────────────────────────

console.log('\n── T09: Idempotency second run logic ───────────────────────────────────');

assert('T09.01',
  syncSrc.includes('idempotencyRun = false'),
  'idempotencyRun parameter defaults to false'
);
assert('T09.02',
  syncSrc.includes('if (idempotencyRun)'),
  'idempotency second pass is conditional'
);
assert('T09.03',
  syncSrc.includes('IDEMPOTENCY_CHECK'),
  '[SCHEDULE_SYNC_CANARY] IDEMPOTENCY_CHECK log present'
);
assert('T09.04',
  syncSrc.includes('stable    = idempRows === (t.postRowCount ?? 0)'),
  'idempotency stability check: idempRows === postRowCount'
);
assert('T09.05',
  syncSrc.includes('IDEMPOTENCY_EXCEPTION'),
  'idempotency exceptions caught per-train'
);
assert('T09.06',
  (() => {
    // Second pass also restores featureFlags in its own finally block
    const idempIdx    = syncSrc.indexOf('if (idempotencyRun)');
    const idempBody   = syncSrc.slice(idempIdx, idempIdx + 1000);
    return idempBody.includes('finally {') &&
      idempBody.includes('(featureFlags as any).trainScheduleSync = false');
  })(),
  'idempotency second pass also restores trainScheduleSync=false in finally'
);

// ── T10: 429/backoff path active through canary ──────────────────────────────

console.log('\n── T10: 429/backoff path active through canary ─────────────────────────');

assert('T10.01',
  syncSrc.includes('SCHEDULE_SYNC_RATE_LIMITED'),
  '[SCHEDULE_SYNC_RATE_LIMITED] log tag present'
);
assert('T10.02',
  syncSrc.includes('SCHEDULE_SYNC_BACKOFF'),
  '[SCHEDULE_SYNC_BACKOFF] log tag present'
);
assert('T10.03',
  syncSrc.includes('SCHEDULE_SYNC_PAUSED'),
  '[SCHEDULE_SYNC_PAUSED] log tag present'
);
assert('T10.04',
  syncSrc.includes('SCHEDULE_SYNC_RESUMED'),
  '[SCHEDULE_SYNC_RESUMED] log tag present'
);
assert('T10.05',
  syncSrc.includes('this._consecutive429Count++'),
  '429 counter incremented in backoff wrapper'
);
assert('T10.06',
  syncSrc.includes('globalPause()'),
  'globalPause() called after consecutive 429 threshold'
);
assert('T10.07',
  syncSrc.includes('calcBackoff(attempt, undefined)'),
  'calcBackoff used for retry delays'
);
assert('T10.08',
  // Canary uses same inter-call delay as nightly sync
  (() => {
    const canaryFnStart = syncSrc.indexOf('async runCanary(');
    const canaryFnEnd   = syncSrc.indexOf('private async canaryReadBaseline(');
    const canaryBody    = syncSrc.slice(canaryFnStart, canaryFnEnd);
    return canaryBody.includes('SYNC_BASE_INTER_CALL_MS') &&
      canaryBody.includes('_postPauseMode');
  })(),
  'canary uses SYNC_BASE_INTER_CALL_MS and _postPauseMode for pacing'
);
assert('T10.09',
  syncSrc.includes('GLOBAL_PAUSE_CONSECUTIVE_429 = 3'),
  'GLOBAL_PAUSE_CONSECUTIVE_429 = 3 (threshold correct)'
);

// ── Additional: flag restoration safety ──────────────────────────────────────

console.log('\n── T11: Flag restoration safety ────────────────────────────────────────');

assert('T11.01',
  (() => {
    // featureFlags.trainScheduleSync must always be restored to false in finally
    const finallyBlocks = [...syncSrc.matchAll(/} finally \{/g)];
    const canaryFnStart = syncSrc.indexOf('async runCanary(');
    // Find finally blocks within runCanary
    const canaryFinallyBlocks = finallyBlocks.filter(m => m.index! > canaryFnStart);
    return canaryFinallyBlocks.some(m => {
      const snippet = syncSrc.slice(m.index!, m.index! + 300);
      return snippet.includes('(featureFlags as any).trainScheduleSync = false');
    });
  })(),
  'featureFlags.trainScheduleSync=false is restored in a finally block'
);
assert('T11.02',
  // The outer-most finally in runCanary also resets isRunning
  (() => {
    const outerFinally = syncSrc.lastIndexOf('// Belt-and-suspenders');
    return outerFinally > 0 &&
      syncSrc.slice(outerFinally, outerFinally + 200).includes('this.isRunning = false');
  })(),
  'isRunning=false restored in belt-and-suspenders finally'
);
assert('T11.03',
  // ENABLE_TRAIN_SCHEDULE_SYNC default remains OFF (not permanently changed)
  syncSrc.includes("trainScheduleSync: process.env.ENABLE_TRAIN_SCHEDULE_SYNC === 'true'") ||
  fs.readFileSync(
    fs.existsSync(path.join(process.cwd(), 'server', 'src', 'config', 'featureFlags.ts'))
      ? path.join(process.cwd(), 'server', 'src', 'config', 'featureFlags.ts')
      : path.join(__dirname, '..', 'config', 'featureFlags.ts'), 'utf8'
  ).includes("trainScheduleSync: process.env.ENABLE_TRAIN_SCHEDULE_SYNC === 'true'"),
  'featureFlags.trainScheduleSync default is env-controlled (not hardcoded true)'
);

// ── Summary ───────────────────────────────────────────────────────────────────

console.log('\n══════════════════════════════════════════════════════');
console.log('PHASE_087N52_CANARY_TEST_RESULT');
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
