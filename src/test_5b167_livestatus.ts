import dotenv from 'dotenv';
dotenv.config();

import { irctcService } from './services/irctcService';

async function main() {
  for (const t of ['19707', '14702']) {
    console.log(`\n=== Live status for ${t} ===`);
    const status = await irctcService.getLiveStatus(t, '2026-08-17').catch(e => e.message);
    console.log('Live status:', JSON.stringify(status, null, 2)?.slice(0, 500));
  }
}

main().then(() => process.exit(0)).catch(e => { console.error(e); process.exit(1); });
