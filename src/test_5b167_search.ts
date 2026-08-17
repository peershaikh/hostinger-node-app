import dotenv from 'dotenv';
dotenv.config();

import { splitJourneyEngine } from './services/splitJourneyEngine';

async function main() {
  process.env.LOCAL_E2E_NO_WRITE = 'true';
  
  console.log('=== TEST SEARCH: BDTS -> AII on 2026-08-17 ===');
  const res1 = await splitJourneyEngine.findCombinedRoutes('BDTS', 'AII', '2026-08-17', []);
  console.log(`Splits found: ${res1.split?.length || 0}`);
  for (const s of res1.split || []) {
    const l1 = s.legs?.[0];
    const l2 = s.legs?.[1];
    console.log(`Split via ${s.hub}: Leg1=${l1?.trainNo} (${(l1 as any)?.fromCode}->${(l1 as any)?.toCode}, date=${(l1 as any)?.travelDate}) Leg2=${l2?.trainNo} (${(l2 as any)?.fromCode}->${(l2 as any)?.toCode}, date=${(l2 as any)?.travelDate})`);
  }

  console.log('\n=== TEST SEARCH: BDTS -> JP on 2026-08-17 ===');
  const res2 = await splitJourneyEngine.findCombinedRoutes('BDTS', 'JP', '2026-08-17', []);
  console.log(`Splits found: ${res2.split?.length || 0}`);
  for (const s of res2.split || []) {
    const l1 = s.legs?.[0];
    const l2 = s.legs?.[1];
    console.log(`Split via ${s.hub}: Leg1=${l1?.trainNo} (${(l1 as any)?.fromCode}->${(l1 as any)?.toCode}, date=${(l1 as any)?.travelDate}) Leg2=${l2?.trainNo} (${(l2 as any)?.fromCode}->${(l2 as any)?.toCode}, date=${(l2 as any)?.travelDate})`);

  }
}

main().then(() => process.exit(0)).catch(e => { console.error(e); process.exit(1); });
