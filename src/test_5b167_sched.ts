import dotenv from 'dotenv';
dotenv.config();

import { supabase } from './config/supabase';

async function main() {
  for (const t of ['12977', '19707', '14702']) {
    const { data, error } = await supabase.from('train_schedule').select('Station_Code, SN, Station_Name, Arrival_time, Departure_Time').eq('Train_No', t).order('SN', { ascending: true });
    console.log(`\nTrain ${t} in train_schedule: ${data?.length || 0} stops`);
    if (data && data.length > 0) {
      console.log(`First stop: ${data[0].Station_Code} (${data[0].Station_Name}), Last stop: ${data[data.length - 1].Station_Code} (${data[data.length - 1].Station_Name})`);
      const sample = data.map(s => s.Station_Code).slice(0, 10).join(' -> ');
      console.log(`Sample stops: ${sample} ...`);
    }
  }
}

main().then(() => process.exit(0)).catch(e => { console.error(e); process.exit(1); });
