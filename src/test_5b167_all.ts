import dotenv from 'dotenv';
dotenv.config();

import { resolveSegmentForAvailability } from './services/trainStationResolver';
import { trainOperatesOnDate } from './utils/dayUtils';
import { irctcService } from './services/irctcService';

async function testAll() {
  console.log('\n=============================================');
  console.log('PHASE 5B167 COMPREHENSIVE VERIFICATION SUITE');
  console.log('=============================================\n');

  const results: Record<string, boolean> = {};

  // 1. Train 09724
  // 17-Aug = Monday (reject)
  // 20-Aug = Thursday (accept)
  // 21-Aug = Friday (reject)
  const r09724_17 = await resolveSegmentForAvailability('09724', 'BDTS', 'JP', '2026-08-17');
  const r09724_20 = await resolveSegmentForAvailability('09724', 'BDTS', 'JP', '2026-08-20');
  const r09724_21 = await resolveSegmentForAvailability('09724', 'BDTS', 'JP', '2026-08-21');

  results['09724_17AUG'] = (r09724_17.success === false && r09724_17.reason === 'TRAIN_NOT_RUNNING');
  results['09724_20AUG'] = (r09724_20.success === true);
  results['09724_21AUG'] = (r09724_21.success === false && r09724_21.reason === 'TRAIN_NOT_RUNNING');
  console.log('09724 17-Aug (expect reject):', r09724_17.success === false ? 'PASS' : 'FAIL', r09724_17);
  console.log('09724 20-Aug (expect accept):', r09724_20.success === true ? 'PASS' : 'FAIL', r09724_20);
  console.log('09724 21-Aug (expect reject):', r09724_21.success === false ? 'PASS' : 'FAIL', r09724_21);

  // 2. Train 09001
  // 17-Aug = Monday (reject, runs Tue/Fri)
  const r09001_17 = await resolveSegmentForAvailability('09001', 'MMCT', 'BNW', '2026-08-17');
  results['09001_17AUG'] = (r09001_17.success === false && r09001_17.reason === 'TRAIN_NOT_RUNNING');
  console.log('09001 17-Aug (expect reject):', r09001_17.success === false ? 'PASS' : 'FAIL', r09001_17);

  // 3. Train 18421
  // 17-Aug = Monday (reject, runs Thu)
  const r18421_17 = await resolveSegmentForAvailability('18421', 'PURI', 'SNPU', '2026-08-17');
  results['18421_17AUG'] = (r18421_17.success === false && r18421_17.reason === 'TRAIN_NOT_RUNNING');
  console.log('18421 17-Aug (expect reject):', r18421_17.success === false ? 'PASS' : 'FAIL', r18421_17);

  // 4. Train 12977
  // 17-Aug = Monday from origin ERS (reject, runs Sun)
  // ADI is also invalid boarding station
  const r12977_17_origin = await resolveSegmentForAvailability('12977', 'ERS', 'AII', '2026-08-17');
  const r12977_17_adi = await resolveSegmentForAvailability('12977', 'ADI', 'AII', '2026-08-17');
  results['12977_17AUG'] = (r12977_17_origin.success === false || r12977_17_adi.success === false);
  console.log('12977 17-Aug ERS->AII (expect reject):', r12977_17_origin.success === false ? 'PASS' : 'FAIL', r12977_17_origin);
  console.log('12977 17-Aug ADI->AII (expect reject):', r12977_17_adi.success === false ? 'PASS' : 'FAIL', r12977_17_adi);

  // 5. Train 19707
  // 17-Aug: 19707 is cancelled/unavailable
  const r19707 = await resolveSegmentForAvailability('19707', 'BDTS', 'AII', '2026-08-17');
  console.log('19707 17-Aug BDTS->AII:', r19707);

  // 6. Train 14702
  // 17-Aug: valid operating date (accept)
  const r14702 = await resolveSegmentForAvailability('14702', 'BDTS', 'AII', '2026-08-17');
  results['14702_VALID_DATE'] = (r14702.success === true);
  console.log('14702 17-Aug BDTS->AII (expect accept):', r14702.success === true ? 'PASS' : 'FAIL', r14702);

  // 7. Regressions
  const r19031_sbib = await resolveSegmentForAvailability('19031', 'SBIB', 'AII', '2026-08-17');
  const r19031_adi = await resolveSegmentForAvailability('19031', 'ADI', 'AII', '2026-08-17');
  results['19031'] = (r19031_sbib.success === true && r19031_adi.success === false);
  console.log('19031: SBIB->AII accept, ADI->AII reject:', results['19031'] ? 'PASS' : 'FAIL');

  const r19411_gnc = await resolveSegmentForAvailability('19411', 'GNC', 'AII', '2026-08-17');
  const r19411_adi = await resolveSegmentForAvailability('19411', 'ADI', 'AII', '2026-08-17');
  results['19411'] = (r19411_gnc.success === true && r19411_adi.success === false);
  console.log('19411: GNC->AII accept, ADI->AII reject:', results['19411'] ? 'PASS' : 'FAIL');

  const r19407_sbib = await resolveSegmentForAvailability('19407', 'SBIB', 'LGH', '2026-08-17');
  const r19407_adi = await resolveSegmentForAvailability('19407', 'ADI', 'LGH', '2026-08-17');
  results['19407'] = (r19407_sbib.success === true && r19407_adi.success === false);
  console.log('19407: SBIB->LGH accept, ADI->LGH reject:', results['19407'] ? 'PASS' : 'FAIL');

  const r19015_adi = await resolveSegmentForAvailability('19015', 'DDR', 'ADI', '2026-08-17');
  const r19015_aii = await resolveSegmentForAvailability('19015', 'DDR', 'AII', '2026-08-17');
  results['19015'] = (r19015_adi.success === true && r19015_aii.success === false);
  console.log('19015: DDR->ADI accept, DDR->AII reject:', results['19015'] ? 'PASS' : 'FAIL');

  const r12989_ddr = await resolveSegmentForAvailability('12989', 'DDR', 'AII', '2026-08-17');
  const r12989_adi = await resolveSegmentForAvailability('12989', 'ADI', 'AII', '2026-08-17');
  results['12989'] = (r12989_ddr.success === true && r12989_adi.success === true);
  console.log('12989: DDR->AII accept, ADI->AII accept:', results['12989'] ? 'PASS' : 'FAIL');

  console.log('\n=== Summary of Results ===');
  console.log(results);
}

testAll().then(() => process.exit(0)).catch(e => { console.error(e); process.exit(1); });
