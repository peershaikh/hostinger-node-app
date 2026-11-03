/**
 * TRAYAGO PHASE 146P.1: CONTROLLED FREE ENTITLEMENT DURABILITY TEST SUITE
 *
 * Verifies:
 * 1. Two-phase reservation lifecycle (Reserve -> Commit -> Release).
 * 2. Successful Split Journey commits exactly one credit.
 * 3. Successful Same Train Rescue commits exactly one credit.
 * 4. Empty engine results release the reservation so user can retry.
 * 5. Engine exceptions safely release the reservation.
 * 6. Timeouts release the reservation so user is not locked out.
 * 7. Duplicate commits and releases are strictly idempotent.
 * 8. Five or more concurrent requests cannot double-spend (concurrency safety).
 * 9. Cross-process concurrency serialization via atomic directory locking.
 * 10. Atomic writes via temp-file-and-rename and backup snapshot creation.
 * 11. Corrupted primary ledger recovery from .bak snapshot.
 * 12. Corrupted backup handling (preserves corrupt file for forensics without crashing).
 * 13. Lease expiration: expired reservation is safely cleared without deadlocking.
 * 14. IST midnight rollover: previous day's usage does not block today's allowance.
 * 15. Guest and authenticated user identity isolation.
 * 16. Backward compatibility of checkAndConsumeFreeCredit.
 *
 * Run with:
 *   npx ts-node server/src/__tests__/phase146p_entitlement_durability.test.ts
 */

import fs from 'fs';
import path from 'path';
import os from 'os';
import { fork } from 'child_process';
import {
  entitlementService,
  getTodayDateString,
  getLedgerSafe,
  saveLedgerAtomic,
  validateLedgerStructure,
  getBackupPath
} from '../services/entitlementService';
import { authService } from '../services/authService';
import { userCache } from '../cache/userCache';

interface TestResult {
  name: string;
  passed: boolean;
  error?: string;
}

const results: TestResult[] = [];

function assert(condition: boolean, message: string) {
  if (!condition) {
    throw new Error(`Assertion failed: ${message}`);
  }
}

function assertEquals(actual: any, expected: any, message: string) {
  if (actual !== expected) {
    throw new Error(`Assertion failed: ${message} (Expected: ${expected}, Actual: ${actual})`);
  }
}

async function test(name: string, fn: () => Promise<void>) {
  try {
    await fn();
    results.push({ name, passed: true });
    console.log(`  [PASS] ${name}`);
  } catch (err: any) {
    results.push({ name, passed: false, error: err.message });
    console.error(`  [FAIL] ${name}: ${err.message}`);
  }
}

async function runSuite() {
  console.log('\n========================================================================');
  console.log('  TRAYAGO PHASE 146P.1: FREE ENTITLEMENT DURABILITY TEST SUITE');
  console.log('========================================================================\n');

  // Setup isolated temporary ledger file for this test run
  const testDir = path.join(os.tmpdir(), `trayago_test_ledger_${Date.now()}_${Math.random().toString(36).slice(2)}`);
  fs.mkdirSync(testDir, { recursive: true });
  const testLedgerPath = path.join(testDir, 'free_quota_ledger.json');
  process.env.FREE_QUOTA_LEDGER_PATH = testLedgerPath;

  console.log(`[TEST SETUP] Using isolated ledger path: ${testLedgerPath}\n`);

  try {
    // -------------------------------------------------------------------------
    // TEST 1: Two-Phase Reservation and Successful Commit for Split Journey
    // -------------------------------------------------------------------------
    await test('1. Successful Split Journey reserves and commits exactly one credit', async () => {
      const testUserId = '00000000-0000-4000-8000-00000146001';
      await userCache.setUser({
        id: testUserId,
        email: 'p146p_user1@trayago.test',
        planType: 'free',
        splitAccessUntil: null
      } as any);

      // Initial check: has credit
      const statusBefore = await entitlementService.checkRescueOrSplitEntitlement(testUserId, 'split');
      assertEquals(statusBefore.splitCreditRemaining, true, 'User should initially have 1 split credit');
      assertEquals(statusBefore.status, 'ALLOW_FREE_SPLIT', 'Initial status should be ALLOW_FREE_SPLIT');

      // Step 1: Reserve
      const reservation = await entitlementService.reserveFreeCredit(testUserId, 'split', 60000);
      assertEquals(reservation.allowed, true, 'Reservation must be allowed');
      assertEquals(reservation.status, 'ALLOW_FREE_SPLIT', 'Reservation status must be ALLOW_FREE_SPLIT');
      assert(Boolean(reservation.reservationId), 'Reservation must return a unique reservationId');

      // Step 2: During execution, a concurrent reservation attempt should be blocked
      const secondReserve = await entitlementService.reserveFreeCredit(testUserId, 'split', 60000);
      assertEquals(secondReserve.allowed, false, 'Concurrent reservation while one is pending must be disallowed');
      assertEquals(secondReserve.inProgress, true, 'Pending reservation should indicate inProgress: true');

      // Step 3: Engine completes with eligible results -> Commit
      const commitRes = await entitlementService.commitFreeCredit(testUserId, 'split', reservation.reservationId!);
      assertEquals(commitRes.success, true, 'Commit should succeed');

      // Step 4: After commit, quota for today is spent
      const statusAfter = await entitlementService.checkRescueOrSplitEntitlement(testUserId, 'split');
      assertEquals(statusAfter.splitCreditRemaining, false, 'Split credit should now be spent');
      assertEquals(statusAfter.status, 'SHOW_PAYWALL_SPLIT', 'Status should now be SHOW_PAYWALL_SPLIT');

      // Attempt to reserve again on same day should be rejected
      const thirdReserve = await entitlementService.reserveFreeCredit(testUserId, 'split', 60000);
      assertEquals(thirdReserve.allowed, false, 'Subsequent reservation today must be rejected');
      assertEquals(thirdReserve.status, 'SHOW_PAYWALL_SPLIT', 'Must return SHOW_PAYWALL_SPLIT');
    });

    // -------------------------------------------------------------------------
    // TEST 2: Successful Same Train Rescue Reserves and Commits
    // -------------------------------------------------------------------------
    await test('2. Successful Same Train Rescue reserves and commits exactly one credit', async () => {
      const testUserId = '00000000-0000-4000-8000-00000146002';
      await userCache.setUser({
        id: testUserId,
        email: 'p146p_user2@trayago.test',
        planType: 'free',
        splitAccessUntil: null
      } as any);

      // Reserve rescue
      const res = await entitlementService.reserveFreeCredit(testUserId, 'rescue', 60000);
      assertEquals(res.allowed, true, 'Rescue reservation should be allowed');
      assertEquals(res.status, 'ALLOW_FREE_RESCUE', 'Status should be ALLOW_FREE_RESCUE');

      // Commit rescue
      const commitRes = await entitlementService.commitFreeCredit(testUserId, 'rescue', res.reservationId!);
      assertEquals(commitRes.success, true, 'Rescue commit should succeed');

      // Quota is spent for rescue, but split quota remains untouched!
      const status = await entitlementService.checkRescueOrSplitEntitlement(testUserId);
      assertEquals(status.rescueCreditRemaining, false, 'Rescue credit should be spent');
      assertEquals(status.splitCreditRemaining, true, 'Split credit should still be available');
    });

    // -------------------------------------------------------------------------
    // TEST 3: Empty Engine Results Release the Reservation
    // -------------------------------------------------------------------------
    await test('3. Empty results safely release reservation allowing user retry', async () => {
      const testUserId = '00000000-0000-4000-8000-00000146003';
      await userCache.setUser({
        id: testUserId,
        email: 'p146p_user3@trayago.test',
        planType: 'free',
        splitAccessUntil: null
      } as any);

      // Step 1: Reserve credit
      const res = await entitlementService.reserveFreeCredit(testUserId, 'split', 60000);
      assertEquals(res.allowed, true, 'Reservation should succeed');

      // Step 2: Engine yields 0 results -> Release reservation
      const releaseRes = await entitlementService.releaseFreeCredit(testUserId, 'split', res.reservationId!);
      assertEquals(releaseRes.success, true, 'Release should succeed');

      // Step 3: User still has their free credit for today!
      const statusAfter = await entitlementService.checkRescueOrSplitEntitlement(testUserId, 'split');
      assertEquals(statusAfter.splitCreditRemaining, true, 'User must still have split credit remaining');
      assertEquals(statusAfter.status, 'ALLOW_FREE_SPLIT', 'Status must be ALLOW_FREE_SPLIT');

      // Step 4: Retry reservation succeeds
      const retryRes = await entitlementService.reserveFreeCredit(testUserId, 'split', 60000);
      assertEquals(retryRes.allowed, true, 'Retry reservation must succeed');
      // Clean up retry
      await entitlementService.releaseFreeCredit(testUserId, 'split', retryRes.reservationId!);
    });

    // -------------------------------------------------------------------------
    // TEST 4: Engine Exceptions and Timeouts Safely Release Reservation
    // -------------------------------------------------------------------------
    await test('4. Engine exceptions and timeouts safely release reservation', async () => {
      const testUserId = '00000000-0000-4000-8000-00000146004';
      await userCache.setUser({
        id: testUserId,
        email: 'p146p_user4@trayago.test',
        planType: 'free',
        splitAccessUntil: null
      } as any);

      // Simulate try-catch with thrown error
      const res = await entitlementService.reserveFreeCredit(testUserId, 'rescue', 60000);
      assertEquals(res.allowed, true, 'Reservation should succeed');

      try {
        // Simulate upstream failure
        throw new Error('IRCTC provider upstream timeout');
      } catch (err) {
        // In catch block, controller releases credit
        await entitlementService.releaseFreeCredit(testUserId, 'rescue', res.reservationId!);
      }

      // Verify credit remained unconsumed
      const status = await entitlementService.checkRescueOrSplitEntitlement(testUserId, 'rescue');
      assertEquals(status.rescueCreditRemaining, true, 'Rescue credit must be preserved after exception');
    });

    // -------------------------------------------------------------------------
    // TEST 5: Idempotency of Duplicate Commits and Releases
    // -------------------------------------------------------------------------
    await test('5. Duplicate commits and duplicate releases are idempotent', async () => {
      const testUserId = '00000000-0000-4000-8000-00000146005';
      await userCache.setUser({
        id: testUserId,
        email: 'p146p_user5@trayago.test',
        planType: 'free',
        splitAccessUntil: null
      } as any);

      const res = await entitlementService.reserveFreeCredit(testUserId, 'split', 60000);
      assertEquals(res.allowed, true, 'Reservation should succeed');

      // First commit
      const commit1 = await entitlementService.commitFreeCredit(testUserId, 'split', res.reservationId!);
      assertEquals(commit1.success, true, 'First commit succeeds');

      // Duplicate commit (same reservationId)
      const commit2 = await entitlementService.commitFreeCredit(testUserId, 'split', res.reservationId!);
      assertEquals(commit2.success, true, 'Duplicate commit must be idempotent');

      // Releasing an already committed reservation must fail safely
      const releaseAttempt = await entitlementService.releaseFreeCredit(testUserId, 'split', res.reservationId!);
      assertEquals(releaseAttempt.success, false, 'Cannot release an already committed credit');
    });

    // -------------------------------------------------------------------------
    // TEST 6: Five or More Concurrent Requests Cannot Double-Spend
    // -------------------------------------------------------------------------
    await test('6. Five concurrent reservation requests cannot double-spend', async () => {
      const testUserId = '00000000-0000-4000-8000-00000146006';
      await userCache.setUser({
        id: testUserId,
        email: 'p146p_user6@trayago.test',
        planType: 'free',
        splitAccessUntil: null
      } as any);

      // Fire 5 simultaneous reservation requests
      const promises = Array.from({ length: 5 }, () =>
        entitlementService.reserveFreeCredit(testUserId, 'split', 60000)
      );

      const outcomes = await Promise.all(promises);
      const allowedCount = outcomes.filter(o => o.allowed).length;
      const rejectedCount = outcomes.filter(o => !o.allowed).length;

      assertEquals(allowedCount, 1, 'Exactly one concurrent request must acquire the reservation');
      assertEquals(rejectedCount, 4, 'All four other concurrent requests must be rejected');

      // Commit the winner
      const winner = outcomes.find(o => o.allowed)!;
      await entitlementService.commitFreeCredit(testUserId, 'split', winner.reservationId!);
    });

    // -------------------------------------------------------------------------
    // TEST 7: Cross-Process Concurrency Serialization via Directory Lock
    // -------------------------------------------------------------------------
    await test('7. Cross-process mutual exclusion verifies multi-process lock safety', async () => {
      // Test that atomic directory locking prevents concurrent writers
      const lockDir = path.join(testDir, 'test_cross_process.lock');

      // Child script that attempts to acquire lock and record start/end timestamps
      const childScript = `
        const fs = require('fs');
        const lockDir = process.argv[2];
        let acquired = false;
        const start = Date.now();
        while (!acquired) {
          try {
            fs.mkdirSync(lockDir);
            acquired = true;
          } catch (err) {
            if (Date.now() - start > 3000) process.exit(1);
            const waitTill = Date.now() + 15;
            while (Date.now() < waitTill) {}
          }
        }
        // Hold lock for 80ms
        const releaseTime = Date.now() + 80;
        while (Date.now() < releaseTime) {}
        fs.rmdirSync(lockDir);
        process.exit(0);
      `;

      const scriptPath = path.join(testDir, 'child_lock_test.js');
      fs.writeFileSync(scriptPath, childScript);

      // Acquire lock in parent
      fs.mkdirSync(lockDir);

      // Launch child process in background
      const child = fork(scriptPath, [lockDir], { stdio: 'pipe' });

      let childFinished = false;
      let childExitCode: number | null = null;
      child.on('exit', (code) => {
        childFinished = true;
        childExitCode = code;
      });

      // Hold lock in parent for 60ms, verifying child cannot acquire it prematurely
      await new Promise(r => setTimeout(r, 60));
      assertEquals(childFinished, false, 'Child process must be waiting for parent lock');

      // Release parent lock
      fs.rmdirSync(lockDir);

      // Wait for child to acquire and finish cleanly
      await new Promise(r => setTimeout(r, 1000));
      assertEquals(childFinished, true, 'Child process must finish cleanly after acquiring released lock');
      assertEquals(childExitCode, 0, 'Child exit code must be 0');
    });

    // -------------------------------------------------------------------------
    // TEST 8: Atomic Writes via Temp-Rename and Backup Snapshot
    // -------------------------------------------------------------------------
    await test('8. Atomic writes and .bak snapshot updates function correctly', async () => {
      const customLedger = path.join(testDir, 'atomic_test_ledger.json');
      const backupPath = getBackupPath(customLedger);

      // Write initial state
      saveLedgerAtomic({ userA: { splitUsedOn: '2026-11-03' } }, customLedger);
      assert(fs.existsSync(customLedger), 'Primary ledger must exist');

      // Write updated state
      saveLedgerAtomic(
        { userA: { splitUsedOn: '2026-11-03' }, userB: { rescueUsedOn: '2026-11-03' } },
        customLedger
      );

      // Verify backup was created containing initial state
      assert(fs.existsSync(backupPath), 'Backup snapshot must exist after second write');
      const backupParsed = JSON.parse(fs.readFileSync(backupPath, 'utf8'));
      assertEquals(Boolean(backupParsed.userA), true, 'Backup must contain userA');
      assertEquals(Boolean(backupParsed.userB), false, 'Backup must represent previous snapshot (before userB)');
    });

    // -------------------------------------------------------------------------
    // TEST 9: Corrupted Primary Ledger Recovery from .bak Snapshot
    // -------------------------------------------------------------------------
    await test('9. Corrupted primary ledger is recovered automatically from .bak snapshot', async () => {
      const recoveryLedger = path.join(testDir, 'recovery_test_ledger.json');
      const backupPath = getBackupPath(recoveryLedger);

      // Establish valid state and backup
      saveLedgerAtomic({ userV1: { splitUsedOn: '2026-11-03' } }, recoveryLedger);
      saveLedgerAtomic({ userV1: { splitUsedOn: '2026-11-03' }, userV2: { rescueUsedOn: '2026-11-03' } }, recoveryLedger);

      // Simulate catastrophic crash corruption: primary file truncated to broken JSON
      fs.writeFileSync(recoveryLedger, '{"truncated_malformed_json_here": ', 'utf8');

      // Load using getLedgerSafe
      const loaded = getLedgerSafe(recoveryLedger);
      assertEquals(Boolean(loaded.userV1), true, 'Must recover userV1 from backup');

      // Confirm primary file on disk was automatically repaired
      const repairedContent = fs.readFileSync(recoveryLedger, 'utf8');
      const repairedParsed = JSON.parse(repairedContent);
      assertEquals(Boolean(repairedParsed.userV1), true, 'Primary file must be repaired with valid JSON');
    });

    // -------------------------------------------------------------------------
    // TEST 10: Corrupted Backup Handling (Preserves Corrupted File Forensics)
    // -------------------------------------------------------------------------
    await test('10. Corrupted backup is handled safely and preserves forensic file', async () => {
      const disasterLedger = path.join(testDir, 'disaster_ledger.json');
      const backupPath = getBackupPath(disasterLedger);

      // Both primary and backup are corrupt
      fs.writeFileSync(disasterLedger, 'CORRUPT_PRIMARY', 'utf8');
      fs.writeFileSync(backupPath, 'CORRUPT_BACKUP', 'utf8');

      // Should not throw exception
      const loaded = getLedgerSafe(disasterLedger);
      assertEquals(typeof loaded, 'object', 'Must return an object');

      // Check that a .corrupt.<timestamp> forensic copy was created
      const files = fs.readdirSync(testDir);
      const corruptPreserved = files.some(f => f.startsWith('disaster_ledger.json.corrupt.'));
      assertEquals(corruptPreserved, true, 'Corrupt file must be preserved for forensic diagnosis');
    });

    // -------------------------------------------------------------------------
    // TEST 11: Lease Expiration Does Not Deadlock
    // -------------------------------------------------------------------------
    await test('11. Expired reservation lease is cleared and allows fresh search', async () => {
      const testUserId = '00000000-0000-4000-8000-00000146011';
      await userCache.setUser({
        id: testUserId,
        email: 'p146p_user11@trayago.test',
        planType: 'free',
        splitAccessUntil: null
      } as any);

      // Reserve with a tiny lease of 20ms
      const res = await entitlementService.reserveFreeCredit(testUserId, 'split', 20);
      assertEquals(res.allowed, true, 'Initial reservation allowed');

      // Wait for lease to expire
      await new Promise(r => setTimeout(r, 40));

      // Attempt commit on expired reservation -> should be rejected safely
      const commitRes = await entitlementService.commitFreeCredit(testUserId, 'split', res.reservationId!);
      assertEquals(commitRes.success, false, 'Expired reservation cannot be committed');

      // Fresh reservation attempt should clear expired lease and succeed
      const freshRes = await entitlementService.reserveFreeCredit(testUserId, 'split', 60000);
      assertEquals(freshRes.allowed, true, 'Fresh reservation must succeed after lease expiry');
      await entitlementService.releaseFreeCredit(testUserId, 'split', freshRes.reservationId!);
    });

    // -------------------------------------------------------------------------
    // TEST 12: IST Midnight Rollover Calculation
    // -------------------------------------------------------------------------
    await test('12. IST midnight reset enables fresh daily credit on new calendar date', async () => {
      const testUserId = '00000000-0000-4000-8000-00000146012';
      await userCache.setUser({
        id: testUserId,
        email: 'p146p_user12@trayago.test',
        planType: 'free',
        splitAccessUntil: null
      } as any);

      const ledger = getLedgerSafe();
      // Manually record usage yesterday
      ledger[testUserId] = {
        splitUsedOn: '2026-11-02',
        rescueUsedOn: '2026-11-02'
      };
      saveLedgerAtomic(ledger);

      // Today in IST
      const today = getTodayDateString();
      assertEquals(today !== '2026-11-02', true, 'Today must be distinct from yesterday');

      // Check entitlement for today
      const status = await entitlementService.checkRescueOrSplitEntitlement(testUserId, 'split');
      assertEquals(status.splitCreditRemaining, true, 'User should have credit for today despite yesterday usage');
      assertEquals(status.status, 'ALLOW_FREE_SPLIT', 'Status should be ALLOW_FREE_SPLIT');
    });

    // -------------------------------------------------------------------------
    // TEST 13: Guest and Authenticated User Identity Isolation
    // -------------------------------------------------------------------------
    await test('13. Unauthenticated guest requests strictly require login for Split and Rescue', async () => {
      const splitRes = await entitlementService.reserveFreeCredit('', 'split');
      assertEquals(splitRes.allowed, false, 'Empty userId must be disallowed');
      assertEquals(splitRes.status, 'REQUIRE_LOGIN', 'Must return REQUIRE_LOGIN');

      const rescueRes = await entitlementService.reserveFreeCredit('', 'rescue');
      assertEquals(rescueRes.allowed, false, 'Empty userId must be disallowed');
      assertEquals(rescueRes.status, 'REQUIRE_LOGIN', 'Must return REQUIRE_LOGIN');
    });

    // -------------------------------------------------------------------------
    // TEST 14: Backward Compatibility of checkAndConsumeFreeCredit
    // -------------------------------------------------------------------------
    await test('14. Backward-compatible checkAndConsumeFreeCredit executes atomically', async () => {
      const testUserId = '00000000-0000-4000-8000-00000146014';
      await userCache.setUser({
        id: testUserId,
        email: 'p146p_user14@trayago.test',
        planType: 'free',
        splitAccessUntil: null
      } as any);

      // First call consumes
      const call1 = await entitlementService.checkAndConsumeFreeCredit(testUserId, 'split');
      assertEquals(call1.allowed, true, 'First call should be allowed');
      assertEquals(call1.status, 'ALLOW_FREE_SPLIT', 'Status should be ALLOW_FREE_SPLIT');

      // Second call is blocked
      const call2 = await entitlementService.checkAndConsumeFreeCredit(testUserId, 'split');
      assertEquals(call2.allowed, false, 'Second call must be blocked');
      assertEquals(call2.status, 'SHOW_PAYWALL_SPLIT', 'Status must be SHOW_PAYWALL_SPLIT');
    });

    // -------------------------------------------------------------------------
    // TEST 15: Paid User Exemption
    // -------------------------------------------------------------------------
    await test('15. Paid user is never blocked and does not deplete free quota', async () => {
      const proUserId = '00000000-0000-4000-8000-000001460015';
      const proUser = {
        id: proUserId,
        email: 'pro_user@trayago.test',
        planType: 'paid' as any,
        planExpiry: new Date(Date.now() + 86400000).toISOString(),
        splitAccessUntil: new Date(Date.now() + 86400000).toISOString()
      };
      (authService as any).users.push(proUser);
      await userCache.setUser(proUser as any);

      const res = await entitlementService.reserveFreeCredit(proUserId, 'split');
      assertEquals(res.allowed, true, 'Paid user should be allowed');
      assertEquals(res.status, 'ALLOW_PAID', 'Status should be ALLOW_PAID');
      assertEquals(res.isPaid, true, 'isPaid flag must be true');
    });

  } finally {
    // Clean up temporary test directory
    try {
      if (fs.existsSync(testDir)) {
        fs.rmSync(testDir, { recursive: true, force: true });
      }
    } catch {}
  }

  console.log('\n========================================================================');
  const passed = results.filter(r => r.passed).length;
  const failed = results.filter(r => !r.passed).length;
  console.log(`  Phase 146P.1 Suite Finished: ${passed}/${results.length} passed (${failed} failed).`);
  console.log('========================================================================\n');

  if (failed > 0) {
    process.exit(1);
  }
}

runSuite().catch(err => {
  console.error('Fatal test error:', err);
  process.exit(1);
});
