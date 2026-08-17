import dotenv from 'dotenv';
dotenv.config();

import { cacheService } from './services/cacheService';
import { resolveSegmentForAvailability } from './services/trainStationResolver';
import { trainOperatesOnDate, normalizeRunningDays, isDayActiveForBoarding } from './utils/dayUtils';
import { irctcService } from './services/irctcService';

async function main() {
  cacheService.flushAll(); // clear cache to test from clean state
  console.log('Testing 12977 ERS->AII on 2026-08-17:');
  const res = await resolveSegmentForAvailability('12977', 'ERS', 'AII', '2026-08-17');
  console.log('Result:', res);

  const bin = normalizeRunningDays('0000001');
  console.log('bin for 0000001:', bin);
  console.log('isDayActiveForBoarding(bin, 2026-08-17, 0):', isDayActiveForBoarding(bin, '2026-08-17', 0));
  console.log('trainOperatesOnDate(2026-08-17, 0000001):', trainOperatesOnDate('2026-08-17', '0000001', { runningDaysAuthoritative: true, dayOffset: 0 }));
}

main().then(() => process.exit(0)).catch(e => { console.error(e); process.exit(1); });
