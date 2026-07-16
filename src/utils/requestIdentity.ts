import { Request } from 'express';

/**
 * PHASE_4C967 — Single identity source for entitlement endpoints.
 * x-user-id is ONLY populated by authMiddleware after JWT verification (P0-001).
 * Never read req.query.userId for authenticated identity.
 */
export function getJwtUserId(req: Request): string | null {
  const raw = req.headers['x-user-id'];
  if (typeof raw !== 'string') return null;
  const trimmed = raw.trim();
  return trimmed.length > 0 ? trimmed : null;
}

export function getBetaCode(req: Request): string | undefined {
  const fromQuery = req.query?.betaCode;
  const fromHeader = req.headers['x-beta-code'];
  const value =
    (typeof fromQuery === 'string' ? fromQuery : undefined) ||
    (typeof fromHeader === 'string' ? fromHeader : undefined);
  return value?.trim() || undefined;
}

export function getDeviceId(req: Request): string | undefined {
  const fromQuery = req.query?.deviceId;
  const fromHeader = req.headers['x-device-id'];
  const value =
    (typeof fromQuery === 'string' ? fromQuery : undefined) ||
    (typeof fromHeader === 'string' ? fromHeader : undefined);
  return value?.trim() || undefined;
}

/** Reject legacy query-param identity when no JWT identity is present. */
export function hasLegacyUserIdQuery(req: Request): boolean {
  const q = req.query?.userId;
  return typeof q === 'string' && q.trim().length > 0;
}