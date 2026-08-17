import dotenv from 'dotenv';
dotenv.config();

import { normalizeRunningDays, trainOperatesOnDate } from './utils/dayUtils';
import { resolveSegmentForAvailability } from './services/trainStationResolver';

async function main() {
  console.log('\n=== Testing 12977 Sunday-Only Mask ===');
  const mask = normalizeRunningDays('0000001');
  console.log('12977 mask for 0000001 (Sun only):', mask);
  const sunVerdict = trainOperatesOnDate('2026-08-16', '0000001', { runningDaysAuthoritative: true });
  const monVerdict = trainOperatesOnDate('2026-08-17', '0000001', { runningDaysAuthoritative: true });
  console.log('12977 on 2026-08-16 (Sunday):', sunVerdict);
  console.log('12977 on 2026-08-17 (Monday):', monVerdict);

  console.log('\n=== Testing 19707 Cancellation ===');
  const cancelledLeg = { trainNo: '19707', fromCode: 'BDTS', toCode: 'AII', is_cancelled: true, travelDate: '2026-08-17' };
  const rCancelled = await resolveSegmentForAvailability('19707', 'BDTS', 'AII', '2026-08-17');
  console.log('19707 cancelled resolution:', rCancelled);
}

main().then(() => process.exit(0)).catch(e => { console.error(e); process.exit(1); });
