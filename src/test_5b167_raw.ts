import dotenv from 'dotenv';
dotenv.config();

import { irctcService } from './services/irctcService';
import { dbService } from './services/dbService';

async function main() {
  const live = await irctcService.search('BDTS', 'AII', '2026-08-17').catch(() => []);
  console.log(`Live search BDTS->AII: ${live.length} trains`);
  if (live.length > 0) {
    console.log('Live sample train 0:', live[0]);
  }

  const db = await dbService.searchTrains('BDTS', 'AII', '2026-08-17').catch(() => []);
  console.log(`\nDB search BDTS->AII: ${db.length} trains`);
  if (db.length > 0) {
    console.log('DB sample train 0:', db[0]);
  }
}

main().then(() => process.exit(0)).catch(e => { console.error(e); process.exit(1); });
