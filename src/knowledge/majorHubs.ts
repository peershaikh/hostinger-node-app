/**
 * PHASE_4C872A — Authoritative MAJOR_HUBS list for rescue + knowledge shadow parity.
 * segmentAvailabilityEngine and hubCatalogBuilder must import from here only.
 */
import { TERMINAL_ALIASES } from '../services/stationAliases';

export const MAJOR_HUBS: readonly string[] = [
  'NDLS', 'CSMT', 'HWH', 'SBC', 'MAS', 'SC', 'PNBE', 'LKO', 'CNB', 'ADI',
  'BPL', 'JP', 'NGP', 'BBS', 'GHY', 'CDG', 'BSB', 'PRYJ', 'PCOI', 'DDU', 'KGP',
  'VSKP', 'BZA', 'GNT', 'UBL', 'PUNE', 'ST', 'BRC', 'KOTA', 'AGC', 'GWL',
  'JHS', 'GKP', 'BST', 'GD', 'MFP', 'SPJ', 'GAYA', 'BGP', 'MGS', 'ASN',
  'DHN', 'TATA', 'RNC', 'RYP', 'BSP', 'JBP', 'STA', 'MKP', 'KTE', 'ET', 'BSL', 'MMR', 'NK',
  'BVI', 'SUR', 'GR', 'RC', 'GTL', 'RU', 'KPD', 'ED', 'CBE', 'PGT',
  'SRR', 'ERS', 'TVC', 'MDU', 'TPJ', 'VM', 'CGL',
  'RJT', 'BVC', 'MAO', 'RN', 'MAJN', 'KCG', 'SHM', 'MLDT', 'NJP', 'DBRG',
  'BDC', 'BSAE', 'TBAE', 'KJU', 'DMLE', 'KMAE', 'JIT', 'BGAE', 'SOAE', 'BHLA',
  'GPAE', 'ABKA', 'BGRA', 'DTAE', 'SMAE', 'NDAE', 'BFZ', 'PSAE', 'LKX', 'BQY',
  'PTAE', 'AGAE', 'DHAE', 'KLNT', 'BTI', 'VSPR', 'MTFA', 'SRP', 'SHE', 'CGR',
  'CNS', 'SHBA', 'SPRD', 'RGDA', 'STD', 'HNS', 'AUN', 'JKZ', 'BWK', 'BNW',
  'MHU', 'CKD', 'JRL', 'SDRA', 'KSI', 'NLQ', 'JTS', 'KGBS', 'LLH', 'BEQ',
] as const;

const MAJOR_HUB_SET = new Set<string>(MAJOR_HUBS);

export function isMajorHub(code: string): boolean {
  const clean = (code || '').toUpperCase().trim();
  if (MAJOR_HUB_SET.has(clean)) return true;
  const aliases = TERMINAL_ALIASES[clean] || [];
  return aliases.some((alias) => MAJOR_HUB_SET.has(alias));
}

/**
 * PHASE_PAN_INDIA_SPLIT — Authoritative Pan-India National Transfer Junctions Registry.
 * Separately designed to preserve MAJOR_HUBS and existing caller behaviour intact.
 * Every station is forensically verified against full_stations.json coordinates
 * and train_schedule stop records.
 */
export const NATIONAL_TRANSFER_JUNCTIONS: readonly string[] = [
  // Western Railway & West Central Railway (High-capacity transfer junctions)
  'RTM',  // Ratlam Junction (Delhi-Mumbai & Malwa line transfer)
  'NAD',  // Nagda Junction (Bhopal-Ujjain-Ratlam junction)
  'UJN',  // Ujjain Junction (Indore/Bhopal cross-transfer)
  'BINA', // Bina Junction (Jhansi-Bhopal-Katni-Kota quad-junction)
  'GUNA', // Guna Junction (Bina-Kota / Gwalior branch)
  'RTA',  // Ruthiyai Junction (Kota-Bina interchange)
  'MKC',  // Maksi Junction (Ujjain-Bhopal line junction)
  'SWM',  // Sawai Madhopur Junction (Jaipur-Kota interchange)
  'MTJ',  // Mathura Junction (Agra-Delhi-Alwar mega junction)
  'ANND', // Anand Junction (Vadodara-Ahmedabad line junction)
  'BH',   // Bharuch Junction (Vadodara-Surat line junction)
  'BL',   // Valsad (Surat-Mumbai line transfer)
  'VAPI', // Vapi (South Gujarat transfer)
  // Central Railway & South Central Railway
  'AK',   // Akola Junction (Nagpur-Bhusaval & Secunderabad line)
  'WR',   // Wardha Junction (Nagpur-Balharshah & Bhusaval line)
  'BD',   // Badnera Junction (Amravati-Nagpur line)
  'DD',   // Daund Junction (Pune-Solapur-Manmad chord interchange)
  'KWV',  // Kurduvadi Junction (Latur-Miraj line interchange)
  'MRJ',  // Miraj Junction (Pune-Kolhapur-Hubballi interchange)
  'WADI', // Wadi Junction (Solapur-Secunderabad-Guntakal junction)
  'KLBG', // Kalaburagi / Gulbarga (Karnataka-Maharashtra transfer)
  'KRNT', // Kurnool City (Secunderabad-Bengaluru line)
  'VGLJ', // Virangana Lakshmibai Jhansi (North-South arterial junction)
  'JL',   // Jalgaon Junction (Surat-Bhusaval branch junction)
  'KNW',  // Khandwa Junction (Itarsi-Bhusaval cross interchange)
  'IGP',  // Igatpuri (Central Railway ghat operational hub)
  // Northern & North Western Railway
  'UMB',  // Ambala Cantt Junction (Delhi-Amritsar/Chandigarh junction)
  'SRE',  // Saharanpur Junction (Ambala-Moradabad junction)
  'MB',   // Moradabad Junction (Lucknow-Delhi main line)
  'BE',   // Bareilly Junction (Lucknow-Moradabad line)
  'ROK',  // Rohtak Junction (Delhi-Bhiwani/Firozpur line)
  'CPR',  // Chhapra Junction (Varanasi/Gorakhpur-Patna junction)
  'AII',  // Ajmer Junction (Jaipur-Ahmedabad mainline)
  'FL',   // Phulera Junction (Jaipur-Ajmer/Jodhpur junction)
  'MJ',   // Marwar Junction (Jodhpur-Ajmer/Ahmedabad junction)
  'ABR',  // Abu Road (Rajasthan-Gujarat border transfer)
  // Southern & South Western Railway
  'KZJ',  // Kazipet Junction (Secunderabad-Vijayawada-New Delhi arterial)
  'JTJ',  // Jolarpettai Junction (Chennai-Bengaluru/Erode triangular junction)
  'SA',   // Salem Junction (Erode-Bangalore-Coimbatore line)
  'YPR',  // Yesvantpur Junction (Bengaluru north terminal hub)
  'ASK',  // Arsikere Junction (Bengaluru-Hubballi/Mangaluru interchange)
  'DMM',  // Dharmavaram Junction (Bengaluru-Guntakal interchange)
  'NDL',  // Nandyal Junction (Guntur-Guntakal crossline)
  // Eastern, South Eastern & East Coast Railway
  'ROU',  // Rourkela Junction (Howrah-Mumbai mainline)
  'R',    // Raipur Junction (Nagpur-Howrah mainline)
  'KUR',  // Khurda Road Junction (Bhubaneswar-Puri-Visakhapatnam junction)
  'VZM',  // Vizianagaram Junction (Visakhapatnam-Howrah/Raipur junction)
  'LMG',  // Lumding Junction (Guwahati-Silchar/Dibrugarh junction)
  'RNY',  // Rangiya Junction (Guwahati-New Jalpaiguri north bank)
] as const;

const NATIONAL_TRANSFER_SET = new Set<string>(NATIONAL_TRANSFER_JUNCTIONS);

export function isNationalTransferJunction(code: string): boolean {
  const clean = (code || '').toUpperCase().trim();
  if (NATIONAL_TRANSFER_SET.has(clean)) return true;
  const aliases = TERMINAL_ALIASES[clean] || [];
  return aliases.some((alias) => NATIONAL_TRANSFER_SET.has(alias));
}

export function isAnyHubOrJunction(code: string): boolean {
  return isMajorHub(code) || isNationalTransferJunction(code);
}
