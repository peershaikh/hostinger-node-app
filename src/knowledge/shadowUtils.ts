/**
 * PHASE_4C871 — Pure knowledge utilities (no Supabase/logger imports).
 */

export function hubSetsMatch(runtime: string[], catalog: string[]): boolean {
  if (runtime.length === 0 && catalog.length === 0) return true;
  if (runtime.length !== catalog.length) return false;
  const sortedA = [...runtime].sort();
  const sortedB = [...catalog].sort();
  return sortedA.every((h, i) => h === sortedB[i]);
}

export function computeShadowMatchRate(runtime: string[], catalog: string[]): number {
  if (runtime.length === 0 && catalog.length === 0) return 1;
  if (runtime.length === 0) return 0;
  return runtime.filter((h) => catalog.includes(h)).length / runtime.length;
}