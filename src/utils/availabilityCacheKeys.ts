/**
 * PHASE_4C868 — Canonical + legacy availability cache key helpers.
 * PHASE_4C871 — Resolver-canonical cache keys (schedule stops + padded train).
 *
 * Canonical: availability:{train}:{from}:{to}:{date}:{quota}:{class}
 * Legacy:    avail_{train}_{from}_{to}_{date}_{class}  (irctcService pre-4C868)
 */

export function normalizeAvailKeyPart(value: string): string {
  return (value || '').toUpperCase().trim();
}

export function normalizeTrainNumber(trainNo: string): string {
  const t = String(trainNo || '').trim();
  if (/^\d+$/.test(t)) return t.padStart(5, '0');
  return t;
}

/** PHASE_4C871 — Pad numeric train numbers to 5 digits (matches trainStationResolver). */
export function padTrainNoForCache(trainNo: string): string {
  return normalizeTrainNumber(trainNo);
}

export interface ResolvedCacheKeyParts {
  trainNo: string;
  from: string;
  to: string;
  /** True when schedule resolution succeeded — safe to cache under canonical key */
  resolverCanonical: boolean;
}

/**
 * PHASE_4C871 P0 — Build cache-key parts from resolver schedule stops.
 * Prevents duplicate L1 entries for station aliases (CSTM/CSMT → same schedule stop).
 */
export async function resolveAvailabilityCacheKeyParts(
  trainNo: string,
  from: string,
  to: string,
  date: string
): Promise<ResolvedCacheKeyParts> {
  const padded = padTrainNoForCache(trainNo);
  const fromNorm = normalizeAvailKeyPart(from);
  const toNorm = normalizeAvailKeyPart(to);

  try {
    const { resolveSegmentForAvailability } = require('../services/trainStationResolver');
    const resolution = await resolveSegmentForAvailability(padded, fromNorm, toNorm, date);

    if (resolution.success) {
      return {
        trainNo: padded,
        from: resolution.scheduleFrom,
        to: resolution.scheduleTo,
        resolverCanonical: true,
      };
    }
  } catch {
    // fall through to user codes
  }

  return {
    trainNo: padded,
    from: fromNorm,
    to: toNorm,
    resolverCanonical: false,
  };
}

export function generateCanonicalAvailabilityKey(
  trainNo: string,
  from: string,
  to: string,
  date: string,
  quota: string,
  classType: string
): string {
  const t = String(trainNo || '').trim();
  const f = normalizeAvailKeyPart(from);
  const d = normalizeAvailKeyPart(to);
  const dt = (date || '').trim();
  const q = normalizeAvailKeyPart(quota || 'GN');
  const c = normalizeAvailKeyPart(classType || '3A');
  return `availability:${t}:${f}:${d}:${dt}:${q}:${c}`;
}

export function generateLegacyAvailabilityKey(
  trainNo: string,
  from: string,
  to: string,
  date: string,
  classType: string
): string {
  const t = String(trainNo || '').trim();
  const f = normalizeAvailKeyPart(from);
  const d = normalizeAvailKeyPart(to);
  const dt = (date || '').trim();
  const c = normalizeAvailKeyPart(classType || '3A');
  return `avail_${t}_${f}_${d}_${dt}_${c}`;
}

/** PHASE_4C870 — Redis L2 key (same field order as canonical L1). */
export function generateRedisAvailabilityKey(
  trainNo: string,
  from: string,
  to: string,
  date: string,
  quota: string,
  classType: string
): string {
  const canonical = generateCanonicalAvailabilityKey(trainNo, from, to, date, quota, classType);
  return canonical.replace(/^availability:/, 'avail:v2:');
}