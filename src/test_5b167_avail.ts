import dotenv from 'dotenv';
dotenv.config();

import { irctcService } from './services/irctcService';

async function main() {
  const search1 = await irctcService.search('BDTS', 'AII', '2026-08-17');
  console.log('Trains in live search BDTS->AII on 2026-08-17:');
  for (const t of search1) {
    console.log(`- ${t.train_no || t.trainNo}: ${t.train_name || t.trainName} (running_days: ${t.running_days || t.runningDays})`);
  }

  console.log('\nChecking availability for 19707 on 2026-08-17 BDTS->AII:');
  const avail19707 = await irctcService.getAvailability('19707', '2026-08-17', 'BDTS', 'AII', 'SL', 'GN').catch(e => e.message);
  console.log('19707 avail:', avail19707);

  console.log('\nChecking availability for 14702 on 2026-08-17 BDTS->AII:');
  const avail14702 = await irctcService.getAvailability('14702', '2026-08-17', 'BDTS', 'AII', 'SL', 'GN').catch(e => e.message);
  console.log('14702 avail:', avail14702);

  console.log('\nChecking availability for 12977 on 2026-08-17 BRC->AII:');
  const avail12977 = await irctcService.getAvailability('12977', '2026-08-17', 'BRC', 'AII', 'SL', 'GN').catch(e => e.message);
  console.log('12977 avail:', avail12977);
}

main().then(() => process.exit(0)).catch(e => { console.error(e); process.exit(1); });
