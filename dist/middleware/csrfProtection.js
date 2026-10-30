"use strict";
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
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.conditionalCsrf = exports.csrfErrorHandler = exports.attachCsrfToken = exports.csrfProtection = void 0;
exports.isTrustedWebOrigin = isTrustedWebOrigin;
const csurf_1 = __importDefault(require("csurf"));
const logger_1 = require("./logger");
// Initialize CSRF protection with cookie-based storage
exports.csrfProtection = (0, csurf_1.default)({
    cookie: {
        httpOnly: true,
        secure: process.env.NODE_ENV === 'production',
        sameSite: 'lax', // PHASE_4C971: 'strict' blocks cross-domain cookies — use 'lax'
        maxAge: 3600000 // 1 hour
    },
    ignoreMethods: ['GET', 'HEAD', 'OPTIONS']
});
/**
 * Middleware to attach CSRF token to response headers for client consumption
 */
const attachCsrfToken = (req, res, next) => {
    try {
        if (req.csrfToken) {
            const token = req.csrfToken();
            res.setHeader('X-CSRF-Token', token);
            res.locals.csrfToken = token;
        }
        next();
    }
    catch (error) {
        logger_1.winstonLogger.warn(`[CSRF] Failed to attach CSRF token: ${error.message}`);
        next();
    }
};
exports.attachCsrfToken = attachCsrfToken;
/**
 * Error handler specifically for CSRF validation failures
 */
const csrfErrorHandler = (err, req, res, next) => {
    if (err.code === 'EBADCSRFTOKEN') {
        logger_1.winstonLogger.warn(`[CSRF_VIOLATION] ${req.method} ${req.path} from IP ${req.ip} - Invalid or missing CSRF token`);
        return res.status(403).json({
            success: false,
            error: 'Invalid CSRF token. Please refresh the page and try again.',
            code: 'CSRF_INVALID'
        });
    }
    next(err);
};
exports.csrfErrorHandler = csrfErrorHandler;
// ─── EXACT STATIC ROUTE ALLOWLISTS (Dual-Mounted /api and un-prefixed) ─────────
const EXACT_WEBHOOK_ROUTES = new Set([
    '/api/payments/webhook',
    '/payments/webhook',
    '/api/whatsapp/webhook',
    '/whatsapp/webhook'
]);
const EXACT_PUBLIC_AUTH_ROUTES = new Set([
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
    '/api/auth/app-open',
    '/auth/app-open',
    '/api/auth/google-login',
    '/auth/google-login',
    '/api/auth/google',
    '/auth/google',
    '/api/auth/google/callback',
    '/auth/google/callback'
]);
const EXACT_TELEMETRY_ROUTES = new Set([
    '/api/analytics/event',
    '/analytics/event',
    '/api/analytics/split-click',
    '/analytics/split-click',
    '/api/analytics/complaint',
    '/analytics/complaint'
]);
// PHASE_0C33L Fix A & PHASE_0C33N Fix CSRF-03: Exact read-only POST availability scan paths
const EXACT_READ_ONLY_POST_ROUTES = new Set([
    '/api/trains/same-train-rescue',
    '/trains/same-train-rescue'
]);
// ─── TRUSTED WEB & MOBILE ORIGINS FOR COOKIE-AUTHENTICATED ENDPOINTS ──────────
const TRUSTED_WEB_ORIGINS = new Set([
    'https://trayago.in',
    'https://www.trayago.in',
    'https://trayago.com',
    'https://www.trayago.com',
    'https://trayago.online',
    'https://www.trayago.online',
    'capacitor://localhost' // PHASE_0C33L Fix B: un-spoofable native mobile app scheme
]);
function isTrustedWebOrigin(origin, req) {
    if (!origin || typeof origin !== 'string')
        return false;
    const normalized = origin.trim().toLowerCase();
    if (TRUSTED_WEB_ORIGINS.has(normalized))
        return true;
    // In non-production, trust all local loopback addresses
    if (process.env.NODE_ENV !== 'production') {
        if (/^https?:\/\/(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/.test(normalized)) {
            return true;
        }
    }
    // PHASE_0C33N Fix CSRF-02:
    // In production, support Android Capacitor WebView on localhost only when accompanied
    // by genuine Android Capacitor client signals (X-Requested-With package ID or WebView UA).
    // Arbitrary desktop/mobile browsers accessing localhost do NOT pass this check.
    if (normalized === 'http://localhost' || normalized === 'https://localhost') {
        if (req) {
            const reqWith = req.headers['x-requested-with'];
            const ua = req.headers['user-agent'] || '';
            if (reqWith === 'in.trayago.app' || /(in\.trayago\.app|capacitor|wv)/i.test(ua)) {
                return true;
            }
        }
    }
    return false;
}
function normalizePath(rawPath) {
    if (!rawPath || typeof rawPath !== 'string')
        return '/';
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
const conditionalCsrf = (req, res, next) => {
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
    // 6. Read-only station autocomplete queries
    if (req.method === 'GET' && (normalizedPath === '/api/stations' || normalizedPath.startsWith('/api/stations/') || normalizedPath === '/stations' || normalizedPath.startsWith('/stations/'))) {
        return next();
    }
    // 7. Strict Origin Guard for session lifecycle routes (/auth/refresh and /auth/logout)
    if (normalizedPath === '/api/auth/refresh' || normalizedPath === '/auth/refresh' ||
        normalizedPath === '/api/auth/logout' || normalizedPath === '/auth/logout') {
        const rawOrigin = req.headers.origin;
        const rawReferer = req.headers.referer;
        let effectiveOrigin = undefined;
        if (typeof rawOrigin === 'string' && rawOrigin.trim()) {
            effectiveOrigin = rawOrigin.trim();
        }
        else if (typeof rawReferer === 'string' && rawReferer.trim()) {
            try {
                effectiveOrigin = new URL(rawReferer).origin;
            }
            catch {
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
                logger_1.winstonLogger.warn(`[CSRF_ORIGIN_BLOCKED] Rejected untrusted origin "${effectiveOrigin}" on ${normalizedPath}`);
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
            logger_1.winstonLogger.warn(`[CSRF_COOKIE_BLOCKED] Missing Origin/Referer on cookie-authenticated ${normalizedPath}`);
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
        // Malformed, tampered, or expired Bearer token: do NOT exempt.
        // Falls through to csrfProtection below and will be blocked if CSRF token is missing.
    }
    // 9. Apply CSRF protection to all remaining state-changing requests
    (0, exports.csrfProtection)(req, res, next);
};
exports.conditionalCsrf = conditionalCsrf;
