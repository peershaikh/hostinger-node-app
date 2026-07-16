import dotenv from 'dotenv';
dotenv.config();

import { availabilityProvider } from './services/availabilityProvider';

async function run() {
  console.log('Testing live IRCTC availability for Train 11139 CSMT → PUNE on 2026-06-25...');
  const res = await availabilityProvider.getAvailability({
    trainNo: '11139',
    from: 'CSMT',
    to: 'PUNE',
    date: '2026-06-25',
    classType: '3A',
    quota: 'GN'
  });

  console.log('Availability Result:', JSON.stringify(res, null, 2));
}

run().catch(console.error);
