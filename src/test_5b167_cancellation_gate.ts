import dotenv from 'dotenv';
dotenv.config();

import { splitJourneyEngine } from './services/splitJourneyEngine';

async function main() {
  console.log('\n=== Testing Generic Cancellation & Trust Gate ===');

  // Test candidateTrustGate on normal active train (14702) vs cancelled train (19707)
  const activeSplit: any = {
    trainNo: '14702',
    rescueType: 'SAME_TRAIN_SEGMENT',
    legs: [
      {
        trainNo: '14702',
        fromCode: 'BDTS',
        toCode: 'AII',
        fromName: 'Bandra Terminus',
        toName: 'Ajmer',
        travelDate: '2026-08-17',
        departure: '20:15',
        arrival: '14:55',
        durationMins: 1120,
        running_days: '1111111',
        runningDaysAuthoritative: true,
        is_cancelled: false,
      }
    ]
  };

  const cancelledSplit: any = {
    trainNo: '19707',
    rescueType: 'SAME_TRAIN_SEGMENT',
    legs: [
      {
        trainNo: '19707',
        fromCode: 'BDTS',
        toCode: 'AII',
        fromName: 'Bandra Terminus',
        toName: 'Ajmer',
        travelDate: '2026-08-17',
        departure: '20:55',
        arrival: '15:30',
        durationMins: 1115,
        running_days: '1111111',
        is_cancelled: true,
      }
    ]
  };

  const nonRunningSplit: any = {
    trainNo: '12977',
    rescueType: 'SAME_TRAIN_SEGMENT',
    legs: [
      {
        trainNo: '12977',
        fromCode: 'ERS',
        toCode: 'AII',
        fromName: 'Ernakulam',
        toName: 'Ajmer',
        travelDate: '2026-08-17', // Monday (runs Sun only)
        departure: '18:50',
        arrival: '17:35',
        durationMins: 2805,
        running_days: '0000001',
        runningDaysAuthoritative: true,
      }
    ]
  };

  console.log('Running candidateTrustGate on active 14702, cancelled 19707, and non-running 12977:');
  const gate = await (splitJourneyEngine as any).candidateTrustGate(
    [activeSplit, cancelledSplit, nonRunningSplit],
    ['BDTS', 'ERS'],
    ['AII'],
    '2026-08-17'
  );

  console.log('Trust gate result:');
  console.log(`- in: 3`);
  console.log(`- trusted: ${gate.trusted.length}`);
  console.log(`- forApi: ${gate.forApi.length}`);
  console.log(`- rejected: ${gate.rejected}`);
  console.log(`- corrected: ${gate.corrected}`);

  const trustedTrainNos = gate.trusted.map((s: any) => s.trainNo || s.legs?.[0]?.trainNo);
  console.log('Trusted train numbers:', trustedTrainNos);

  const passedActive = trustedTrainNos.includes('14702');
  const rejectedCancelled = !trustedTrainNos.includes('19707');
  const rejectedNonRunning = !trustedTrainNos.includes('12977');

  console.log('\nResults:');
  console.log('Active 14702 accepted:', passedActive ? 'PASS' : 'FAIL');
  console.log('Cancelled 19707 rejected:', rejectedCancelled ? 'PASS' : 'FAIL');
  console.log('Non-running 12977 rejected:', rejectedNonRunning ? 'PASS' : 'FAIL');

  if (passedActive && rejectedCancelled && rejectedNonRunning) {
    console.log('\nALL TRUST GATE INVARIANTS SATISFIED!');
  } else {
    console.error('\nFAILURES DETECTED IN TRUST GATE!');
    process.exit(1);
  }
}

main().then(() => process.exit(0)).catch(e => { console.error(e); process.exit(1); });
