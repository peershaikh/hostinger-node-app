import { PAN_INDIA_CLUSTERS, TERMINAL_ALIASES, IRCTC_CANONICAL, isValidStationCode } from '../services/stationAliases';
import { getStations } from '../utils/stationMapper';
import { StationService } from '../services/stationService';
import fs from 'fs';
import path from 'path';

const cityMap = JSON.parse(fs.readFileSync(path.join(__dirname, '../data/cityStations.json'), 'utf8'));
const stationService = new StationService();

console.log('======================================================');
console.log('PAN-INDIA STATION RESOLUTION & CANONICAL AUDIT SUITE');
console.log('======================================================\n');

let passed = 0;
let failed = 0;

function assert(id: string, condition: boolean, message: string) {
  if (condition) {
    console.log(`  PASS [${id}]: ${message}`);
    passed++;
  } else {
    console.error(`  FAIL [${id}]: ${message}`);
    failed++;
  }
}

// 1. Verify PAN_INDIA_CLUSTERS contains ZERO deprecated station codes
console.log('-- 1. PAN_INDIA_CLUSTERS Modern Code Cleanliness --');
const DEPRECATED_CODES = ['CSTM', 'BCT', 'ALD', 'COI', 'MGS', 'MUV', 'JHS', 'HBJ', 'FD', 'MMC', 'KSR'];

for (const code of DEPRECATED_CODES) {
  const presentInClusters = PAN_INDIA_CLUSTERS.some(cluster => cluster.includes(code));
  assert(`1.clean.${code}`, !presentInClusters, `Deprecated code '${code}' is completely purged from PAN_INDIA_CLUSTERS`);
}

// 2. Verify Legacy Station Bridge in TERMINAL_ALIASES
console.log('\n-- 2. Legacy Station Bridge in TERMINAL_ALIASES --');
assert('2.01', Array.isArray(TERMINAL_ALIASES['CSTM']) && TERMINAL_ALIASES['CSTM'].includes('CSMT'), 'TERMINAL_ALIASES[CSTM] bridges to CSMT cluster');
assert('2.02', Array.isArray(TERMINAL_ALIASES['BCT']) && TERMINAL_ALIASES['BCT'].includes('MMCT'), 'TERMINAL_ALIASES[BCT] bridges to MMCT cluster');
assert('2.03', Array.isArray(TERMINAL_ALIASES['ALD']) && TERMINAL_ALIASES['ALD'].includes('PRYJ'), 'TERMINAL_ALIASES[ALD] bridges to PRYJ cluster');
assert('2.04', Array.isArray(TERMINAL_ALIASES['MGS']) && TERMINAL_ALIASES['MGS'].includes('DDU'), 'TERMINAL_ALIASES[MGS] bridges to DDU cluster');
assert('2.05', Array.isArray(TERMINAL_ALIASES['JHS']) && TERMINAL_ALIASES['JHS'].includes('VGLJ'), 'TERMINAL_ALIASES[JHS] bridges to VGLJ cluster');
assert('2.06', Array.isArray(TERMINAL_ALIASES['HBJ']) && TERMINAL_ALIASES['HBJ'].includes('RKMP'), 'TERMINAL_ALIASES[HBJ] bridges to RKMP cluster');
assert('2.07', Array.isArray(TERMINAL_ALIASES['FD']) && TERMINAL_ALIASES['FD'].includes('AYC'), 'TERMINAL_ALIASES[FD] bridges to AYC cluster');
assert('2.08', Array.isArray(TERMINAL_ALIASES['MUV']) && TERMINAL_ALIASES['MUV'].includes('BSBS'), 'TERMINAL_ALIASES[MUV] bridges to BSBS cluster');

// And verify canonical clusters do NOT contain deprecated codes
assert('2.09', !TERMINAL_ALIASES['CSMT'].includes('CSTM'), 'TERMINAL_ALIASES[CSMT] does NOT contain CSTM');
assert('2.10', !TERMINAL_ALIASES['CSMT'].includes('BCT'), 'TERMINAL_ALIASES[CSMT] does NOT contain BCT');
assert('2.11', !TERMINAL_ALIASES['PRYJ'].includes('ALD'), 'TERMINAL_ALIASES[PRYJ] does NOT contain ALD');

// 3. User Freeform Search Normalization across Pan-India
console.log('\n-- 3. User Freeform Search Normalization across Pan-India --');
const userInputs = [
  // Mumbai
  { input: 'CST', expectedCanonical: 'CSMT', cityName: 'Mumbai' },
  { input: 'CSTM', expectedCanonical: 'CSMT', cityName: 'Mumbai' },
  { input: 'VT', expectedCanonical: 'CSMT', cityName: 'Mumbai' },
  { input: 'MUMBAI CST', expectedCanonical: 'CSMT', cityName: 'Mumbai' },
  { input: 'MUMBAI CENTRAL', expectedCanonical: 'MMCT', cityName: 'Mumbai' },
  { input: 'BCT', expectedCanonical: 'MMCT', cityName: 'Mumbai' },
  { input: 'DADAR', expectedCanonical: 'DR', cityName: 'Mumbai' },
  // Delhi
  { input: 'NEW DELHI', expectedCanonical: 'NDLS', cityName: 'Delhi' },
  { input: 'DELHI', expectedCanonical: 'NDLS', cityName: 'Delhi' },
  { input: 'HAZRAT NIZAMUDDIN', expectedCanonical: 'NZM', cityName: 'Delhi' },
  // Prayagraj / Allahabad
  { input: 'ALLAHABAD', expectedCanonical: 'PRYJ', cityName: 'Prayagraj' },
  { input: 'ALD', expectedCanonical: 'PRYJ', cityName: 'Prayagraj' },
  { input: 'PRAYAGRAJ', expectedCanonical: 'PRYJ', cityName: 'Prayagraj' },
  { input: 'CHHEOKI', expectedCanonical: 'PCOI', cityName: 'Prayagraj' },
  { input: 'COI', expectedCanonical: 'PCOI', cityName: 'Prayagraj' },
  // Mughalsarai / DDU
  { input: 'MUGHALSARAI', expectedCanonical: 'DDU', cityName: 'DDU' },
  { input: 'MGS', expectedCanonical: 'DDU', cityName: 'DDU' },
  // Varanasi / Banaras
  { input: 'VARANASI', expectedCanonical: 'BSB', cityName: 'Varanasi' },
  { input: 'BANARAS', expectedCanonical: 'BSBS', cityName: 'Banaras' },
  { input: 'MANDUADIH', expectedCanonical: 'BSBS', cityName: 'Banaras' },
  { input: 'MUV', expectedCanonical: 'BSBS', cityName: 'Banaras' },
  // Jhansi
  { input: 'JHANSI', expectedCanonical: 'VGLJ', cityName: 'Jhansi' },
  { input: 'JHS', expectedCanonical: 'VGLJ', cityName: 'Jhansi' },
  // Bhopal
  { input: 'HABIBGANJ', expectedCanonical: 'RKMP', cityName: 'Bhopal' },
  { input: 'HBJ', expectedCanonical: 'RKMP', cityName: 'Bhopal' },
  { input: 'RANI KAMLAPATI', expectedCanonical: 'RKMP', cityName: 'Bhopal' },
  // Ayodhya
  { input: 'FAIZABAD', expectedCanonical: 'AYC', cityName: 'Ayodhya' },
  { input: 'FD', expectedCanonical: 'AYC', cityName: 'Ayodhya' },
  { input: 'AYODHYA CANTT', expectedCanonical: 'AYC', cityName: 'Ayodhya' },
  { input: 'AYODHYA', expectedCanonical: 'AY', cityName: 'Ayodhya' },
  // Bengaluru
  { input: 'BANGALORE', expectedCanonical: 'SBC', cityName: 'Bengaluru' },
  { input: 'BENGALURU', expectedCanonical: 'SBC', cityName: 'Bengaluru' },
  { input: 'KSR', expectedCanonical: 'SBC', cityName: 'Bengaluru' },
  // Chennai
  { input: 'MADRAS', expectedCanonical: 'MAS', cityName: 'Chennai' },
  { input: 'CHENNAI', expectedCanonical: 'MAS', cityName: 'Chennai' },
  { input: 'MMC', expectedCanonical: 'MAS', cityName: 'Chennai' },
  // Kolkata
  { input: 'CALCUTTA', expectedCanonical: 'HWH', cityName: 'Kolkata' },
  { input: 'KOLKATA', expectedCanonical: 'HWH', cityName: 'Kolkata' },
];

for (let i = 0; i < userInputs.length; i++) {
  const { input, expectedCanonical, cityName } = userInputs[i];
  const normalized = stationService.normalizeInput(input);
  assert(`3.${i + 1}`, normalized === expectedCanonical, `"${input}" normalizes cleanly to canonical "${expectedCanonical}" (${cityName})`);
}

// 4. Layer-A Autocomplete / Mapping Lookup Resolution
console.log('\n-- 4. Layer-A Autocomplete / Mapping Lookup Resolution --');
for (let i = 0; i < userInputs.length; i++) {
  const { input, expectedCanonical } = userInputs[i];
  const resolved = getStations(input, cityMap);
  const primary = resolved[0];
  assert(
    `4.${i + 1}`,
    resolved.length > 0 && (primary === expectedCanonical || resolved.includes(expectedCanonical)),
    `getStations("${input}") resolves to [${resolved.join(', ')}] containing "${expectedCanonical}"`
  );
}

// 5. Canonical RailKit Gate Verification
console.log('\n-- 5. RailKit Outbound Call Protection Gate --');
for (const legacy of Object.keys(IRCTC_CANONICAL)) {
  const canonical = IRCTC_CANONICAL[legacy];
  assert(`5.gate.${legacy}`, canonical !== legacy, `Legacy '${legacy}' transforms to canonical '${canonical}' before external API calls`);
}

console.log('\n======================================================');
console.log(`PAN-INDIA AUDIT RESULTS: ${passed} passed, ${failed} failed`);
if (failed === 0) {
  console.log('ALL PAN-INDIA CANONICAL STATION TESTS PASSED');
  process.exit(0);
} else {
  console.error(`AUDIT FAILED with ${failed} failure(s)`);
  process.exit(1);
}
