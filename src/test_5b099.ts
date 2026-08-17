/**
 * PHASE_5B099 — Regression test: Hub alias physical stop gate
 *
 * Tests:
 *   A) 19031 via ADI  → REJECT (INVALID_BOARDING_STATION)
 *   B) 19411 via ADI  → REJECT (INVALID_BOARDING_STATION)
 *   C) 12989 via ADI  → ACCEPT (ADI is physical stop on 12989)
 *   D) 19031 SBIB→AII → ACCEPT (SBIB is physical stop)
 *   E) 19411 GNC→AII  → ACCEPT (GNC is physical stop)
 *
 * Run: npx ts-node -e "require('./src/test_5b099')"
 */

import { resolveSegmentForAvailability } from './services/trainStationResolver';

const DATE = '2026-08-17';

interface TestCase {
  label: string;
  trainNo: string;
  from: string;
  to: string;
  expectPass: boolean;
  expectReason?: string;
}

const TESTS: TestCase[] = [
  {
    label: 'A) 19031 via ADI → REJECT (hub alias, not physical stop)',
    trainNo: '19031', from: 'ADI', to: 'AII',
    expectPass: false, expectReason: 'INVALID_BOARDING_STATION',
  },
  {
    label: 'B) 19411 via ADI → REJECT (hub alias, not physical stop)',
    trainNo: '19411', from: 'ADI', to: 'AII',
    expectPass: false, expectReason: 'INVALID_BOARDING_STATION',
  },
  {
    label: 'C) 12989 ADI→AII → ACCEPT (ADI is physical stop on 12989)',
    trainNo: '12989', from: 'ADI', to: 'AII',
    expectPass: true,
  },
  {
    label: 'D) 19031 SBIB→AII → ACCEPT (SBIB is physical origin)',
    trainNo: '19031', from: 'SBIB', to: 'AII',
    expectPass: true,
  },
  {
    label: 'E) 19411 GNC→AII → ACCEPT (GNC is physical origin)',
    trainNo: '19411', from: 'GNC', to: 'AII',
    expectPass: true,
  },
];

async function run() {
  let passed = 0;
  let failed = 0;
  console.log('\n=== PHASE_5B099 Physical Stop Gate Regression ===\n');

  for (const tc of TESTS) {
    try {
      const result = await resolveSegmentForAvailability(tc.trainNo, tc.from, tc.to, DATE);
      const gotPass = result.success === true;
      const gotReason = result.success ? null : (result as any).reason;

      const passOk = gotPass === tc.expectPass;
      const reasonOk = !tc.expectReason || gotReason === tc.expectReason;
      const ok = passOk && reasonOk;

      const symbol = ok ? '✅' : '❌';
      const status = ok ? 'PASS' : 'FAIL';
      console.log(`${symbol} [${status}] ${tc.label}`);
      console.log(`      got: success=${gotPass}, reason=${gotReason || '(none)'}`);
      if (!ok) {
        console.log(`      expected: success=${tc.expectPass}, reason=${tc.expectReason || '(any)'}`);
      }
      console.log('');

      if (ok) passed++; else failed++;
    } catch (err: any) {
      console.log(`❌ [ERROR] ${tc.label}`);
      console.log(`      error: ${err.message}`);
      failed++;
    }
  }

  console.log(`=== Results: ${passed} passed, ${failed} failed ===\n`);
  if (failed > 0) process.exit(1);
}

run().catch(e => { console.error(e); process.exit(1); });
