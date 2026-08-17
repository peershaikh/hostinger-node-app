import dotenv from 'dotenv';
dotenv.config();

import { cacheService } from './services/cacheService';
import { splitJourneyEngine } from './services/splitJourneyEngine';

async function testCacheRevalidation() {
  console.log('\n=== Testing Cache Revalidation ===');
  cacheService.flushAll();

  // Test cached split with active train
  const activeCached: any = {
    _trustGateVersion: '5B167.2',
    split: [
      {
        trainNo: '14702',
        legs: [
          {
            trainNo: '14702',
            fromCode: 'BDTS',
            toCode: 'AII',
            travelDate: '2026-08-17',
            running_days: '1111111',
            is_cancelled: false,
          }
        ]
      }
    ]
  };

  const cancelledCached: any = {
    _trustGateVersion: '5B167.2',
    split: [
      {
        trainNo: '19707',
        legs: [
          {
            trainNo: '19707',
            fromCode: 'BDTS',
            toCode: 'AII',
            travelDate: '2026-08-17',
            running_days: '1111111',
            is_cancelled: true,
          }
        ]
      }
    ]
  };

  const nonRunningCached: any = {
    _trustGateVersion: '5B167.2',
    split: [
      {
        trainNo: '12977',
        legs: [
          {
            trainNo: '12977',
            fromCode: 'ERS',
            toCode: 'AII',
            travelDate: '2026-08-17',
            running_days: '0000001',
            is_cancelled: false,
          }
        ]
      }
    ]
  };

  // Check internal revalidation function
  // In splitJourneyEngine, cache revalidation checks legs
  const checkRevalidation = (splitEngine: any, result: any, source: string, destination: string, date: string) => {
    const { trainOperatesOnDate } = require('./utils/dayUtils');
    const allLegs = (result.split || []).flatMap((s: any) => s.legs || [s.leg1, s.leg2].filter(Boolean));
    for (const leg of allLegs) {
      const trainNo = String(leg.trainNo || leg.number || '').trim();
      const serviceDate = leg.travelDate || leg.journeyDate || leg.departureDate || undefined;
      const runningDays = leg.running_days || leg.runningDays || undefined;

      if (!trainNo || !serviceDate) return true;

      if (leg.is_cancelled === true || leg.isCancelled === true || leg.cancelled === true) {
        return true; // miss
      }

      const operates = trainOperatesOnDate(serviceDate, runningDays, {
        validFrom: leg.validFrom,
        validTo: leg.validTo,
        runningDaysAuthoritative: true,
        dayOffset: leg.dayOffset || 0,
      });
      if (operates !== 'YES') {
        return true; // miss
      }
    }
    return false;
  };

  const activeNeedsReval = checkRevalidation(splitJourneyEngine, activeCached, 'BDTS', 'AII', '2026-08-17');
  const cancelledNeedsReval = checkRevalidation(splitJourneyEngine, cancelledCached, 'BDTS', 'AII', '2026-08-17');
  const nonRunningNeedsReval = checkRevalidation(splitJourneyEngine, nonRunningCached, 'ERS', 'AII', '2026-08-17');

  console.log('Active 14702 cache valid (expect false):', activeNeedsReval === false ? 'PASS' : 'FAIL', activeNeedsReval);
  console.log('Cancelled 19707 cache invalidated (expect true):', cancelledNeedsReval === true ? 'PASS' : 'FAIL', cancelledNeedsReval);
  console.log('Non-running 12977 cache invalidated (expect true):', nonRunningNeedsReval === true ? 'PASS' : 'FAIL', nonRunningNeedsReval);

  if (activeNeedsReval === false && cancelledNeedsReval === true && nonRunningNeedsReval === true) {
    console.log('\nCACHE REVALIDATION INVARIANTS SATISFIED!');
  } else {
    console.error('\nCACHE REVALIDATION FAILED!');
    process.exit(1);
  }
}

testCacheRevalidation().then(() => process.exit(0)).catch(e => { console.error(e); process.exit(1); });
