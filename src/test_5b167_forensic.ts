import dotenv from 'dotenv';
dotenv.config();

import { supabase } from './config/supabase';
import { irctcService } from './services/irctcService';
import { resolveSegmentForAvailability } from './services/trainStationResolver';
import { trainOperatesOnDate } from './utils/dayUtils';

async function main() {
  const trainNos = ['12977', '19707', '14702', '09724', '09001', '18421', '19031', '19411', '19407', '19015', '12989'];
  console.log('=== FORENSIC TRAIN DATA ===');
  
  const { data: trains, error } = await supabase.from('trains').select('*').in('number', trainNos);
  if (error) console.error('Supabase trains error:', error);
  console.log(`Found ${trains?.length || 0} trains in DB:`);
  for (const t of trains || []) {
    console.log(`Train ${t.number}: name="${t.name}" running_days="${t.running_days}" status="${t.status || t.train_status || ''}" type="${t.type}"`);
  }

  console.log('\n=== TESTING resolveSegmentForAvailability ON 2026-08-17 ===');
  for (const tNo of trainNos) {
    const res = await resolveSegmentForAvailability(tNo, 'ADI', 'AII', '2026-08-17').catch(e => ({ success: false, reason: e.message }));
    console.log(`Train ${tNo} ADI->AII on 2026-08-17: success=${res.success} reason=${(res as any).reason} message=${(res as any).message}`);
  }
}

main().then(() => process.exit(0)).catch(e => { console.error(e); process.exit(1); });
