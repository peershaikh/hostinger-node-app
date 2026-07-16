/**
 * PHASE_4C872A — Authoritative MAJOR_HUBS list for rescue + knowledge shadow parity.
 * segmentAvailabilityEngine and hubCatalogBuilder must import from here only.
 */
import { TERMINAL_ALIASES } from '../services/stationAliases';

export const MAJOR_HUBS: readonly string[] = [
  'NDLS', 'CSMT', 'HWH', 'SBC', 'MAS', 'SC', 'PNBE', 'LKO', 'CNB', 'ADI',
  'BPL', 'JP', 'NGP', 'BBS', 'GHY', 'CDG', 'BSB', 'PRYJ', 'DDU', 'KGP',
  'VSKP', 'BZA', 'GNT', 'UBL', 'PUNE', 'ST', 'BRC', 'KOTA', 'AGC', 'GWL',
  'JHS', 'GKP', 'BST', 'GD', 'MFP', 'SPJ', 'GAYA', 'BGP', 'MGS', 'ASN',
  'DHN', 'TATA', 'RNC', 'RYP', 'BSP', 'JBP', 'ET', 'BSL', 'MMR', 'NK',
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