/**
 * PHASE_4C849 — Strict CORS origin whitelist validator.
 * PHASE_4C970 — Multi-domain: trayago.in + trayago.com + trayago.online
 *
 * Replaces the static-string origin from PHASE_4C843 P0-URL-02.
 * express/cors and Socket.IO accept a function (origin, callback) for dynamic validation.
 * When a function is used, only origins that pass the check receive an
 * Access-Control-Allow-Origin header; all others get no header at all.
 *
 * Allowed:
 *   - https://trayago.in + https://www.trayago.in
 *   - https://trayago.com + https://www.trayago.com
 *   - https://trayago.online + https://www.trayago.online
 *   - localhost origins (http/https, any port) — development only
 *
 * Requests with no Origin header (same-origin, curl, server-to-server)
 * are also allowed so health checks and server-side calls are not broken.
 */

const PRODUCTION_ORIGINS: ReadonlySet<string> = new Set([
  // Primary .in domain
  'https://trayago.in',
  'https://www.trayago.in',
  // Secondary .com domain
  'https://trayago.com',
  'https://www.trayago.com',
  // Secondary .online domain
  'https://trayago.online',
  'https://www.trayago.online',
]);

/**
 * Returns true when the origin is on the production whitelist.
 * In development, also allows localhost (any port, http or https).
 */
export function isOriginAllowed(origin: string | undefined): boolean {
  if (!origin) return true; // no Origin header → allow (same-origin / non-browser)

  if (PRODUCTION_ORIGINS.has(origin)) return true;

  if (process.env.NODE_ENV !== 'production') {
    // localhost / 127.0.0.1 / [::1] on any port — dev only
    if (/^https?:\/\/(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/.test(origin)) {
      return true;
    }
  }

  return false;
}

/**
 * cors-compatible origin callback for express/cors and Socket.IO.
 * Pass this directly as the `origin` option.
 */
export function corsOriginValidator(
  origin: string | undefined,
  callback: (err: Error | null, allow?: boolean) => void
): void {
  if (isOriginAllowed(origin)) {
    callback(null, true);
  } else {
    callback(null, false);
  }
}

/**
 * @deprecated Use corsOriginValidator (function) for strict per-request validation.
 * Retained for any code that still expects a string; returns the primary production origin.
 */
export function getCorsOrigin(): string {
  if (process.env.NODE_ENV !== 'production') return '*';
  return 'https://www.trayago.in';
}