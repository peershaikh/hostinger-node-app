"use strict";
/**
 * PHASE_4C759 — P1-SEC-003: CSRF Protection Middleware
 *
 * Protects state-changing routes (POST/PUT/DELETE/PATCH) from CSRF attacks.
 * Uses csurf package with cookie-based token storage.
 *
 * Flow:
 * 1. Client makes GET request to any route
 * 2. Server generates CSRF token and sends it in response header + cookie
 * 3. Client stores token and includes it in subsequent state-changing requests
 * 4. Server validates token before processing request
 */
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.conditionalCsrf = exports.csrfErrorHandler = exports.attachCsrfToken = exports.csrfProtection = void 0;
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
        // Generate CSRF token (only if csrfProtection middleware has run)
        if (req.csrfToken) {
            const token = req.csrfToken();
            // Attach token to response header for client to read
            res.setHeader('X-CSRF-Token', token);
            // Also expose it in response locals for views/templates if needed
            res.locals.csrfToken = token;
        }
        next();
    }
    catch (error) {
        logger_1.winstonLogger.warn(`[CSRF] Failed to attach CSRF token: ${error.message}`);
        next(); // Don't block request if token attachment fails
    }
};
exports.attachCsrfToken = attachCsrfToken;
/**
 * Error handler specifically for CSRF validation failures
 */
const csrfErrorHandler = (err, req, res, next) => {
    if (err.code === 'EBADCSRFTOKEN') {
        // Log the CSRF violation for security monitoring
        logger_1.winstonLogger.warn(`[CSRF_VIOLATION] ${req.method} ${req.path} from IP ${req.ip} - Invalid or missing CSRF token`);
        return res.status(403).json({
            success: false,
            error: 'Invalid CSRF token. Please refresh the page and try again.',
            code: 'CSRF_INVALID'
        });
    }
    // Pass other errors to the next error handler
    next(err);
};
exports.csrfErrorHandler = csrfErrorHandler;
/**
 * Conditional CSRF middleware - only applies to authenticated routes
 * Public routes (guest access) can bypass CSRF for ease of integration
 */
const conditionalCsrf = (req, res, next) => {
    // Skip CSRF for health checks and monitoring endpoints
    if (req.path === '/api/health' || req.path === '/' || req.path === '/health') {
        return next();
    }
    // PHASE_4C971 FIX: Next.js proxy strips '/api/' prefix before forwarding to backend.
    // So backend receives '/auth/login' NOT '/api/auth/login'.
    // Use endsWith matching to handle BOTH '/api/auth/login' and '/auth/login'.
    const authSuffixes = [
        '/auth/login',
        '/auth/signup',
        '/auth/refresh',
        '/auth/logout',
        '/auth/send-otp',
        '/auth/verify-otp',
        '/auth/forgot-password',
        '/auth/reset-password',
        '/auth/mobile/send-otp',
        '/auth/mobile/verify-otp',
        '/auth/app-open',
        '/auth/google',
        '/auth/google/callback',
    ];
    if (authSuffixes.some(suffix => req.path === suffix || req.path.endsWith(suffix))) {
        return next();
    }
    // Skip CSRF for webhook callbacks (e.g., payment gateways)
    if (req.path.startsWith('/api/webhooks/') || req.path.startsWith('/api/payments/webhook')
        || req.path.startsWith('/webhooks/') || req.path.startsWith('/payments/webhook')) {
        return next();
    }
    // same-train-rescue is a read-only availability scan (no state-changing writes).
    if (req.path.endsWith('/trains/same-train-rescue')) {
        return next();
    }
    // PHASE_4C839 NF-006: Mobile/API clients use Bearer JWT without CSRF cookies.
    const authHeader = req.headers.authorization;
    if (authHeader && authHeader.startsWith('Bearer ')) {
        return next();
    }
    // Apply CSRF protection
    (0, exports.csrfProtection)(req, res, next);
};
exports.conditionalCsrf = conditionalCsrf;
