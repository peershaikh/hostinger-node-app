import dotenv from 'dotenv';
dotenv.config();

import { irctcService } from './services/irctcService';

async function main() {
  const trainNos = ['12977', '19707', '14702', '09724', '09001', '18421'];
  for (const t of trainNos) {
    const info = await irctcService.getTrainInfo(t);
    console.log(`\n=== Train ${t} info ===`);
    console.log('trainInfo:', info?.trainInfo || info);
    console.log('running_days:', info?.trainInfo?.running_days || info?.running_days || info?.runningDays);
    console.log('train_status/status:', info?.trainInfo?.train_status || info?.trainInfo?.status || info?.status || info?.train_status);
    console.log('is_cancelled:', info?.trainInfo?.is_cancelled || info?.is_cancelled || info?.isCancelled);
    console.log('validFrom/validTo:', info?.trainInfo?.validFrom || info?.validFrom, info?.trainInfo?.validTo || info?.validTo);
  }
}

main().then(() => process.exit(0)).catch(e => { console.error(e); process.exit(1); });
