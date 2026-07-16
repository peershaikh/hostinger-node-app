/**
 * PHASE_4C862 — Shared station alias definitions for schedule matching and IRCTC API mapping.
 * Train-aware resolution lives in trainStationResolver.ts (does NOT blindly map DR→CSMT).
 */

export const TERMINAL_ALIASES: Record<string, string[]> = {
  'CSMT': ['CSTM', 'DR', 'DDR'],
  'CSTM': ['CSMT', 'DR', 'DDR'],
  'DR':   ['CSMT', 'CSTM', 'DDR'],
  'DDR':  ['CSMT', 'CSTM', 'DR'],
  'MAS': ['MMC'],
  'MMC': ['MAS'],
  'SBC': ['KSR'],
  'KSR': ['SBC'],
};

/** IRCTC canonical codes for alias clusters — applied only when train schedule contains the canonical stop. */
export const IRCTC_CANONICAL: Record<string, string> = {
  CSTM: 'CSMT',
  MMC: 'MAS',
  KSR: 'SBC',
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