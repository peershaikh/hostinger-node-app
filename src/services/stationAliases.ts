/**
 * PHASE_4C862 — Shared station alias definitions for schedule matching and IRCTC API mapping.
 * Train-aware resolution lives in trainStationResolver.ts (does NOT blindly map DR→CSMT).
 */

const PAN_INDIA_CLUSTERS: string[][] = [
  ['CSMT', 'CSTM', 'DR', 'DDR', 'BDTS', 'MMCT', 'BCT', 'LTT', 'BVI', 'PNVL', 'KYN', 'TNA'],
  ['NDLS', 'DLI', 'NZM', 'ANVT', 'DEC', 'GZB', 'DEE'],
  ['HWH', 'SDAH', 'KOAA', 'SHM'],
  ['MAS', 'MS', 'PER', 'TBM', 'MMC'],
  ['SBC', 'YPR', 'SMVB', 'BNC', 'KSR'],
  ['SC', 'HYB', 'KCG'],
  ['PUNE', 'CCH', 'LNL'],
  ['ADI', 'SBT', 'SBIB', 'GNC'],
  ['BSB', 'BSBS', 'DDU', 'MUV'],
  ['PRYJ', 'PRRB', 'NYN', 'ALD'],
  ['PNBE', 'PPTA', 'RJPB', 'DNR'],
  ['LKO', 'LJN', 'ASH'],
  ['GHY', 'KYQ'],
  ['ST', 'UDN']
];

export const TERMINAL_ALIASES: Record<string, string[]> = {};

for (const cluster of PAN_INDIA_CLUSTERS) {
  for (const stn of cluster) {
    TERMINAL_ALIASES[stn] = cluster.filter(s => s !== stn);
  }
}

/** IRCTC canonical codes for alias clusters — applied only when train schedule contains the canonical stop. */
export const IRCTC_CANONICAL: Record<string, string> = {
  CSTM: 'CSMT',
  MMC:  'MAS',
  KSR:  'SBC',
  // PHASE_5B037 — ADI cluster: Sabarmati / Gandhinagar Canton → Ahmedabad
  GNC:  'ADI',
  SBT:  'ADI',
  // PHASE_5B037 — Bengaluru: Yeshwantpur → SBC (IRCTC canonical)
  YPR:  'SBC',
};

export function areStationsCompatible(code1: string, code2: string): boolean {
  const c1 = code1.toUpperCase().trim();
  const c2 = code2.toUpperCase().trim();
  if (c1 === c2) return true;
  return (TERMINAL_ALIASES[c1] || []).includes(c2);
}

/**
 * Legacy blind normalization — deprecated for availability; kept for non-train-scoped callers.
 * @deprecated Use trainStationResolver.toIrctcApiCode() with schedule context.
 */
export function normalizeForAPILegacy(code: string): string {
  if (!code) return '';
  const clean = code.toUpperCase().trim();
  if (clean === 'CSTM') return 'CSMT';
  if (clean === 'DR')   return 'CSMT';
  if (clean === 'DDR')  return 'CSMT';
  if (clean === 'MMC') return 'MAS';
  if (clean === 'KSR') return 'SBC';
  return clean;
}