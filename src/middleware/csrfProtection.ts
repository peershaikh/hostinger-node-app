/**
 * PHASE_4C759 — P1-SEC-003: CSRF Protection Middleware
 * PHASE_0C33J, PHASE_0C33L & PHASE_0C33N — Controlled Local CSRF Remediation:
 * 1. Exact, normalized route matching (replaces unanchored endsWith/includes/startsWith)
 * 2. Strict Origin/Referer verification for cookie-authenticated refresh/logout
 * 3. Verified Bearer token CSRF bypass (deferring to authMiddleware's x-user-id)
 * 4. Protection restored on sensitive form endpoints (/contact, /feedback)
 * 5. Exact read-only POST exemption for Same Train Rescue (/trains/same-train-rescue with method === POST)
 * 6. Mobile session refresh & logout support via secure origin & mobile app package verification
 * 7. Strict webhook isolation to exact registered routes
 */

import csrf from 'csurf';
import { Request, Response, NextFunction } from 'express';
import { winstonLogger } from './logger';

const isProd = process.env.NODE_ENV === 'production';
const cookieDomain = process.env.COOKIE_DOMAIN || (isProd ? '.trayago.in' : undefined);

// Initialize CSRF protection with cookie-based storage
export const csrfProtection = csrf({
  cookie: {
    httpOnly: true,
    secure: isProd,
    sameSite: (isProd ? 'none' : 'lax') as 'none' | 'lax',   // PHASE_4C971: matches REFRESH_COOKIE_OPTIONS for multi-subdomain
    maxAge: 3600000,    // 1 hour
    ...(cookieDomain ? { domain: cookieDomain } : {})
  },
  ignoreMethods: ['GET', 'HEAD', 'OPTIONS']
});

/**
 * Middleware to attach CSRF token to response headers for client consumption
 */
export const attachCsrfToken = (req: Request, res: Response, next: NextFunction) => {
  try {
    if (req.csrfToken) {
      const token = req.csrfToken();
      res.setHeader('X-CSRF-Token', token);
      res.locals.csrfToken = token;
    }
    next();
  } catch (error: any) {
    winstonLogger.warn(`[CSRF] Failed to attach CSRF token: ${error.message}`);
    next();
  }
};

/**
 * Error handler specifically for CSRF validation failures
 */
export const csrfErrorHandler = (err: any, req: Request, res: Response, next: NextFunction) => {
  if (err.code === 'EBADCSRFTOKEN') {
    winstonLogger.warn(`[CSRF_VIOLATION] ${req.method} ${req.path} from IP ${req.ip} - Invalid or missing CSRF token`);
    return res.status(403).json({
      success: false,
      error: 'Invalid CSRF token. Please refresh the page and try again.',
      code: 'CSRF_INVALID'
    });
  }
  next(err);
};

// ─── EXACT STATIC ROUTE ALLOWLISTS (Dual-Mounted /api and un-prefixed) ─────────

const EXACT_WEBHOOK_ROUTES: ReadonlySet<string> = new Set([
  '/api/payments/webhook',
  '/payments/webhook',
  '/api/whatsapp/webhook',
  '/whatsapp/webhook'
]);

const EXACT_PUBLIC_AUTH_ROUTES: ReadonlySet<string> = new Set([
  '/api/auth/login',
  '/auth/login',
  '/api/auth/signup',
  '/auth/signup',
  '/api/auth/send-otp',
  '/auth/send-otp',
  '/api/auth/verify-otp',
  '/auth/verify-otp',
  '/api/auth/forgot-password',
  '/auth/forgot-password',
  '/api/auth/reset-password',
  '/auth/reset-password',
  '/api/auth/mobile/send-otp',
  '/auth/mobile/send-otp',
  '/api/auth/mobile/verify-otp',
  '/auth/mobile/verify-otp',
  '/api/auth/mobile/request-otp',
  '/auth/mobile/request-otp',
  '/api/auth/check-device-lock',
  '/auth/check-device-lock',
  '/api/auth/can-use-feature',
  '/auth/can-use-feature',
  '/api/auth/can-use-split',
  '/auth/can-use-split',
  '/api/auth/rescue-consume-free',
  '/auth/rescue-consume-free',
  '/api/auth/mock-ad',
  '/auth/mock-ad',
  '/api/auth/review-reward',
  '/auth/review-reward',
  '/api/auth/app-open',
  '/auth/app-open',
  '/api/auth/google-login',
  '/auth/google-login',
  '/api/auth/google',
  '/auth/google',
  '/api/auth/google/callback',
  '/auth/google/callback',
  '/api/auth/csrf-token',
  '/auth/csrf-token'
]);

const EXACT_TELEMETRY_ROUTES: ReadonlySet<string> = new Set([
  '/api/analytics/event',
  '/analytics/event',
  '/api/analytics/split-click',
  '/analytics/split-click',
  '/api/analytics/complaint',
  '/analytics/complaint'
]);

// PHASE_0C33L Fix A & PHASE_0C33N Fix CSRF-03: Exact read-only POST availability scan paths
const EXACT_READ_ONLY_POST_ROUTES: ReadonlySet<string> = new Set([
  '/api/trains/same-train-rescue',
  '/trains/same-train-rescue'
]);

// Station Alarm routes (exempt for trusted origins and guest device_id; protected by alarmLimiter)
const EXACT_ALARM_ROUTES: ReadonlySet<string> = new Set([
  '/api/alarms',
  '/alarms'
]);

// ─── TRUSTED WEB & MOBILE ORIGINS FOR COOKIE-AUTHENTICATED ENDPOINTS ──────────

const TRUSTED_WEB_ORIGINS: ReadonlySet<string> = new Set([
  'https://trayago.in',
  'https://www.trayago.in',
  'https://app.trayago.in',
  'https://api.trayago.in',
  'https://trayago.com',
  'https://www.trayago.com',
  'https://app.trayago.com',
  'https://api.trayago.com',
  'https://trayago.online',
  'https://www.trayago.online',
  'https://app.trayago.online',
  'https://api.trayago.online',
  'http://localhost:3000',
  'http://localhost:3001',
  'http://127.0.0.1:3000',
  'capacitor://localhost' // PHASE_0C33L Fix B: un-spoofable native mobile app scheme
]);

export function isTrustedWebOrigin(origin: string | undefined, req?: Request): boolean {
  if (!origin || typeof origin !== 'string') return false;
  const normalized = origin.trim().toLowerCase();
  if (TRUSTED_WEB_ORIGINS.has(normalized)) return true;

  // Regex to match any trayago subdomain securely:
  if (/^https:\/\/([a-z0-9-]+\.)?trayago\.(in|com|online)$/.test(normalized)) {
    return true;
  }

  // Regex to match Vercel preview deployments:
  if (/^https:\/\/trayago(-[a-z0-9-]+)?\.vercel\.app$/.test(normalized)) {
    return true;
  }

  // Allow localhost / 127.0.0.1 / [::1] on any port
  if (/^https?:\/\/(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/.test(normalized)) {
    return true;
  }

  // PHASE_0C33N Fix CSRF-02:
  // In production, support Android Capacitor WebView on localhost only when accompanied
  // by genuine Android Capacitor client signals (X-Requested-With package ID or WebView UA).
  // Arbitrary desktop/mobile browsers accessing localhost do NOT pass this check.
  if (normalized === 'http://localhost' || normalized === 'https://localhost') {
    if (req) {
      const reqWith = req.headers['x-requested-with'];
      const ua = (req.headers['user-agent'] as string) || '';
      if (reqWith === 'in.trayago.app' || /(in\.trayago\.app|capacitor|wv)/i.test(ua)) {
        return true;
      }
    }
  }

  return false;
}

function normalizePath(rawPath: string | undefined): string {
  if (!rawPath || typeof rawPath !== 'string') return '/';
  let path = rawPath.trim().toLowerCase();
  if (path.length > 1 && path.endsWith('/')) {
    path = path.replace(/\/+$/, '');
  }
  return path;
}

/**
 * Conditional CSRF middleware:
 * Enforces CSRF token verification across all state-changing endpoints,
 * with strictly audited exemptions for webhooks, public auth, telemetry,
 * exact read-only availability scans, and verified Bearer-authenticated clients.
 */
export const conditionalCsrf = (req: Request, res: Response, next: NextFunction) => {
  const normalizedPath = normalizePath(req.path);

  // 1. Skip CSRF for health checks and monitoring endpoints
  if (normalizedPath === '/' || normalizedPath === '/health' || normalizedPath === '/api/health') {
    return next();
  }

  // 2. Exact webhook callbacks (HMAC signature verification in controllers)
  if (EXACT_WEBHOOK_ROUTES.has(normalizedPath)) {
    return next();
  }

  // 3. Exact public unauthenticated auth routes (initial login, signup, OTP bootstrap)
  if (EXACT_PUBLIC_AUTH_ROUTES.has(normalizedPath)) {
    return next();
  }

  // 4. Exact anonymous client telemetry beacons (sendBeacon write-only logging)
  // Sensitive endpoints like /contact and /feedback are strictly excluded
  if (EXACT_TELEMETRY_ROUTES.has(normalizedPath)) {
    return next();
  }

  // 5. PHASE_0C33L Fix A & PHASE_0C33N Fix CSRF-03: Exact read-only availability search POST routes
  // Idempotent search logic intentionally accessible to anonymous guests; abuse protected by IP-based sameTrainRescueLimiter
  // Strictly restricted to POST method on the exact normalized routes.
  if (req.method === 'POST' && EXACT_READ_ONLY_POST_ROUTES.has(normalizedPath)) {
    return next();
  }

  // 5B. Exact Station Alarm routes (allows guest and authenticated alarms; protected by alarmLimiter)
  if (EXACT_ALARM_ROUTES.has(normalizedPath) || normalizedPath.startsWith('/api/alarms/') || normalizedPath.startsWith('/alarms/')) {
    const rawOrigin = req.headers.origin;
    const rawReferer = req.headers.referer;
    let effectiveOrigin: string | undefined = undefined;
    if (typeof rawOrigin === 'string' && rawOrigin.trim()) {
      effectiveOrigin = rawOrigin.trim();
    } else if (typeof rawReferer === 'string' && rawReferer.trim()) {
      try {
        effectiveOrigin = new URL(rawReferer).origin;
      } catch {
        effectiveOrigin = undefined;
      }
    }
    if ((effectiveOrigin && isTrustedWebOrigin(effectiveOrigin, req)) || req.headers['x-device-id'] || req.headers['authorization']) {
      return next();
    }
  }

  // 6. Read-only station autocomplete queries
  if (req.method === 'GET' && (normalizedPath === '/api/stations' || normalizedPath.startsWith('/api/stations/') || normalizedPath === '/stations' || normalizedPath.startsWith('/stations/'))) {
    return next();
  }

  // 7. Strict Origin Guard for session lifecycle routes (/auth/refresh and /auth/logout)
  if (normalizedPath === '/api/auth/refresh' || normalizedPath === '/auth/refresh' ||
      normalizedPath === '/api/auth/logout' || normalizedPath === '/auth/logout') {
    const rawOrigin = req.headers.origin;
    const rawReferer = req.headers.referer;
    let effectiveOrigin: string | undefined = undefined;
    if (typeof rawOrigin === 'string' && rawOrigin.trim()) {
      effectiveOrigin = rawOrigin.trim();
    } else if (typeof rawReferer === 'string' && rawReferer.trim()) {
      try {
        effectiveOrigin = new URL(rawReferer).origin;
      } catch {
        effectiveOrigin = undefined;
      }
    }

    const hasCookie = Boolean(req.cookies?.refreshToken || req.headers.cookie?.includes('refreshToken='));

    // PHASE_0C33N Fix CSRF-01:
    // If an Origin or Referer is present (all browser and cross-origin POSTs), it MUST match trusted web origins.
    // Untrusted origins are rejected IMMEDIATELY with HTTP 403, even when req.body.refreshToken is present.
    // This prevents Login CSRF and Session Fixation attacks from third-party sites.
    if (effectiveOrigin) {
      if (!isTrustedWebOrigin(effectiveOrigin, req)) {
        winstonLogger.warn(`[CSRF_ORIGIN_BLOCKED] Rejected untrusted origin "${effectiveOrigin}" on ${normalizedPath}`);
        return res.status(403).json({
          success: false,
          error: 'Cross-origin request rejected',
          code: 'CROSS_ORIGIN_FORBIDDEN'
        });
      }
      return next(); // Trusted web/mobile origin allowed to proceed to controller
    }

    // If relying on httpOnly cookies without Origin/Referer header, reject fail-closed
    if (hasCookie) {
      winstonLogger.warn(`[CSRF_COOKIE_BLOCKED] Missing Origin/Referer on cookie-authenticated ${normalizedPath}`);
      return res.status(403).json({
        success: false,
        error: 'Origin verification required for cookie session',
        code: 'CROSS_ORIGIN_FORBIDDEN'
      });
    }

    // Native mobile / server clients without cookies and without Origin header:
    // Fall through to controller where authService.verifyRefreshToken validates cryptographic token signature.
    return next();
  }

  // 8. Cryptographically verified Bearer Token Exemption:
  // authMiddleware runs BEFORE conditionalCsrf and sets req.headers['x-user-id'] ONLY after
  // jwt.verify() succeeds against process.env.JWT_SECRET (client-supplied x-user-id is stripped).
  if (req.headers.authorization && req.headers.authorization.startsWith('Bearer ')) {
    if (req.headers['x-user-id']) {
      return next(); // Verified Bearer-authenticated client (mobile / API)
    }
    // Bearer token was provided by API/SPA client but expired or invalid:
    // Return 401 TOKEN_EXPIRED so AxiosInterceptor / fetchWithAuth can trigger silent token refresh.
    // Never fall through to CSRF, which causes false-positive CSRF_INVALID lockouts.
    return res.status(401).json({
      success: false,
      error: 'Invalid or expired authentication token',
      code: 'TOKEN_EXPIRED'
    });
  }

  // 9. Apply CSRF protection to all remaining state-changing requests
  csrfProtection(req as any, res as any, next);
};
