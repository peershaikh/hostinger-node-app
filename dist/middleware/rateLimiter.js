"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.alarmLimiter = exports.notificationPrefsLimiter = exports.notificationRegisterLimiter = exports.cacheClearLimiter = exports.diagnosticsLimiter = exports.adminLimiter = exports.referralLimiter = exports.authLimiter = exports.complaintLimiter = exports.liveLimiter = exports.pnrLimiter = exports.sameTrainRescueLimiter = exports.availabilityLimiter = exports.advancedSearchLimiter = exports.searchLimiter = void 0;
const express_rate_limit_1 = __importDefault(require("express-rate-limit"));
const logger_1 = require("./logger");
// ── Loopback IPs — never rate-limit these (internal health checks, local tests)
const LOOPBACK_IPS = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1', 'localhost']);
/**
 * Smart key generator: use userId (from JWT) if authenticated, else fall back to IP.
 * This prevents different users behind the same NAT/mobile-network IP from sharing limits.
 */
function smartKey(req) {
    if (req.user?.userId)
        return `uid:${req.user.userId}`;
    if (req.user?.id)
        return `uid:${req.user.id}`;
    return req.ip || 'unknown';
}
/**
 * Skip function: exempt loopback / internal IPs from all rate limits.
 */
function skipLoopback(req) {
    return LOOPBACK_IPS.has(req.ip || '');
}
/**
 * Rate limiter for regular search endpoints
 */
exports.searchLimiter = (0, express_rate_limit_1.default)({
    windowMs: 5 * 60 * 1000, // 5 minutes
    max: 300, // 300 req per 5 min per user/IP
    keyGenerator: smartKey,
    skip: skipLoopback,
    message: { success: false, error: 'Too many search requests, please try again later.' },
    standardHeaders: true, legacyHeaders: false,
    handler: (req, res) => {
        logger_1.winstonLogger.warn(`[RATE_LIMIT] Search limit exceeded key=${smartKey(req)}`);
        res.status(429).json({ success: false, error: 'Too many search requests, please try again later.' });
    }
});
/**
 * Rate limiter for split/advanced search (60 req/min per user — was 30/min per IP)
 * Raised because: one split search = 1 user click, 3 route tests = 3 requests, no reason to block.
 */
exports.advancedSearchLimiter = (0, express_rate_limit_1.default)({
    windowMs: 1 * 60 * 1000, // 1 minute
    max: 60, // 60 req/min per user (was 30 per IP)
    keyGenerator: smartKey,
    skip: skipLoopback,
    message: { success: false, error: 'Too many split search requests, please wait a moment.' },
    standardHeaders: true, legacyHeaders: false,
    handler: (req, res) => {
        logger_1.winstonLogger.warn(`[RATE_LIMIT] Advanced search limit exceeded key=${smartKey(req)}`);
        res.status(429).json({ success: false, error: 'Too many split search requests, please wait a moment.' });
    }
});
/**
 * Strict Rate limiter for availability fetch (30 req / min)
 */
exports.availabilityLimiter = (0, express_rate_limit_1.default)({
    windowMs: 1 * 60 * 1000, // 1 minute
    max: 60, // 60 req/min per user
    keyGenerator: smartKey,
    skip: skipLoopback,
    message: { success: false, error: 'Too many availability requests, please wait.' },
    standardHeaders: true, legacyHeaders: false,
    handler: (req, res) => {
        logger_1.winstonLogger.warn(`[RATE_LIMIT] Availability limit exceeded key=${smartKey(req)}`);
        res.status(429).json({ success: false, error: 'Too many availability requests, please wait.' });
    }
});
/**
 * Rate limiter for user-triggered Same Train Rescue endpoint (10 req / min).
 * Each scan can make up to 8 API calls — keep this strict to protect API budget.
 */
exports.sameTrainRescueLimiter = (0, express_rate_limit_1.default)({
    windowMs: 1 * 60 * 1000, // 1 minute
    max: 10,
    message: { success: false, error: 'Too many rescue scan requests, please wait.' },
    standardHeaders: true, legacyHeaders: false,
    handler: (req, res, next) => {
        logger_1.winstonLogger.warn(`[RATE_LIMIT] Same Train Rescue limit exceeded for IP: ${req.ip}`);
        res.status(429).json({ success: false, error: 'Too many rescue scan requests, please wait.' });
    }
});
/**
 * Rate limiter for PNR endpoints
 */
exports.pnrLimiter = (0, express_rate_limit_1.default)({
    windowMs: 5 * 60 * 1000, // 5 minutes
    max: 20, // limit each IP to 20 requests per windowMs
    message: {
        success: false,
        error: 'Too many PNR requests, please try again later.'
    },
    standardHeaders: true,
    legacyHeaders: false,
    handler: (req, res, next) => {
        logger_1.winstonLogger.warn(`[RATE_LIMIT] PNR limit exceeded for IP: ${req.ip}`);
        res.status(429).json({
            success: false,
            error: 'Too many PNR requests, please try again later.'
        });
    }
});
/**
 * Rate limiter for live train endpoints
 */
exports.liveLimiter = (0, express_rate_limit_1.default)({
    windowMs: 5 * 60 * 1000, // 5 minutes
    max: 20, // limit each IP to 20 requests per windowMs
    message: {
        success: false,
        error: 'Too many live train requests, please try again later.'
    },
    standardHeaders: true,
    legacyHeaders: false,
    handler: (req, res, next) => {
        logger_1.winstonLogger.warn(`[RATE_LIMIT] Live train limit exceeded for IP: ${req.ip}`);
        res.status(429).json({
            success: false,
            error: 'Too many live train requests, please try again later.'
        });
    }
});
/**
 * Rate limiter for complaint endpoints
 */
exports.complaintLimiter = (0, express_rate_limit_1.default)({
    windowMs: 5 * 60 * 1000, // 5 minutes
    max: 10, // limit each IP to 10 requests per windowMs
    message: {
        success: false,
        error: 'Too many complaint requests, please try again later.'
    },
    standardHeaders: true,
    legacyHeaders: false,
    handler: (req, res, next) => {
        logger_1.winstonLogger.warn(`[RATE_LIMIT] Complaint limit exceeded for IP: ${req.ip}`);
        res.status(429).json({
            success: false,
            error: 'Too many complaint requests, please try again later.'
        });
    }
});
/**
 * Strict rate limiter for authentication endpoints
 */
exports.authLimiter = (0, express_rate_limit_1.default)({
    windowMs: 1 * 60 * 1000, // 1 minute
    max: 10, // limit each IP to 10 requests per windowMs
    message: {
        success: false,
        error: 'Too many authentication attempts, please try again later.'
    },
    standardHeaders: true,
    legacyHeaders: false,
    handler: (req, res, next) => {
        logger_1.winstonLogger.warn(`[RATE_LIMIT] Auth limit exceeded for IP: ${req.ip}`);
        res.status(429).json({
            success: false,
            error: 'Too many authentication attempts, please try again later.'
        });
    }
});
/**
 * Rate limiter for referral endpoints
 */
exports.referralLimiter = (0, express_rate_limit_1.default)({
    windowMs: 5 * 60 * 1000, // 5 minutes
    max: 15, // limit each IP to 15 requests per windowMs
    message: {
        success: false,
        error: 'Too many referral requests, please try again later.'
    },
    standardHeaders: true,
    legacyHeaders: false,
    handler: (req, res, next) => {
        logger_1.winstonLogger.warn(`[RATE_LIMIT] Referral limit exceeded for IP: ${req.ip}`);
        res.status(429).json({
            success: false,
            error: 'Too many referral requests, please try again later.'
        });
    }
});
/**
 * Rate limiter for admin endpoints
 */
exports.adminLimiter = (0, express_rate_limit_1.default)({
    windowMs: 1 * 60 * 1000, // 1 minute
    max: 30,
    message: {
        success: false,
        error: 'Too many admin requests, please try again later.'
    },
    standardHeaders: true,
    legacyHeaders: false,
    handler: (req, res, next) => {
        logger_1.winstonLogger.warn(`[RATE_LIMIT] Admin limit exceeded for IP: ${req.ip}`);
        res.status(429).json({
            success: false,
            error: 'Too many admin requests, please try again later.'
        });
    }
});
/**
 * Strict rate limiter for diagnostics endpoints (5 requests per minute)
 */
exports.diagnosticsLimiter = (0, express_rate_limit_1.default)({
    windowMs: 1 * 60 * 1000, // 1 minute
    max: 5,
    message: { success: false, error: 'Too many diagnostics requests, please wait.' },
    standardHeaders: true,
    legacyHeaders: false,
    handler: (req, res, next) => {
        logger_1.winstonLogger.warn(`[RATE_LIMIT] Diagnostics limit exceeded for IP: ${req.ip}`);
        res.status(429).json({ success: false, error: 'Too many diagnostics requests, please wait.' });
    }
});
/**
 * Strict rate limiter for cache clear endpoints (3 requests per minute)
 */
exports.cacheClearLimiter = (0, express_rate_limit_1.default)({
    windowMs: 1 * 60 * 1000, // 1 minute
    max: 3,
    message: { success: false, error: 'Too many cache clear requests, please wait.' },
    standardHeaders: true,
    legacyHeaders: false,
    handler: (req, res, next) => {
        logger_1.winstonLogger.warn(`[RATE_LIMIT] Cache clear limit exceeded for IP: ${req.ip}`);
        res.status(429).json({ success: false, error: 'Too many cache clear requests, please wait.' });
    }
});
/**
 * Throttler for push token registration endpoints (max 5 requests per 10 minutes)
 */
exports.notificationRegisterLimiter = (0, express_rate_limit_1.default)({
    windowMs: 10 * 60 * 1000, // 10 minutes
    max: 5, // limit each IP to 5 requests per windowMs
    message: { success: false, error: 'Too many token registration requests, please wait.' },
    standardHeaders: true,
    legacyHeaders: false,
    handler: (req, res, next) => {
        logger_1.winstonLogger.warn({
            message: `[RATE_LIMIT] Push token registration limit exceeded for IP: ${req.ip}`,
            component: 'NOTIFICATION_CONTROLLER',
            event: 'push_throttled'
        });
        res.status(429).json({ success: false, error: 'Too many token registration requests, please wait.' });
    }
});
/**
 * Throttler for notification privacy settings endpoints (max 10 requests per 10 minutes)
 */
exports.notificationPrefsLimiter = (0, express_rate_limit_1.default)({
    windowMs: 10 * 60 * 1000, // 10 minutes
    max: 10, // limit each IP to 10 requests per windowMs
    message: { success: false, error: 'Too many preferences requests, please wait.' },
    standardHeaders: true,
    legacyHeaders: false,
    handler: (req, res, next) => {
        logger_1.winstonLogger.warn({
            message: `[RATE_LIMIT] Push preferences update limit exceeded for IP: ${req.ip}`,
            component: 'NOTIFICATION_CONTROLLER',
            event: 'push_throttled'
        });
        res.status(429).json({ success: false, error: 'Too many preferences requests, please wait.' });
    }
});
/**
 * Rate limiter for Destination Wake-up Alarm endpoints (max 10 requests per minute)
 */
exports.alarmLimiter = (0, express_rate_limit_1.default)({
    windowMs: 1 * 60 * 1000, // 1 minute
    max: 10,
    message: { success: false, error: 'Too many alarm configuration requests, please wait.' },
    standardHeaders: true,
    legacyHeaders: false,
    handler: (req, res, next) => {
        logger_1.winstonLogger.warn(`[RATE_LIMIT] Alarm limit exceeded for IP: ${req.ip}`);
        res.status(429).json({ success: false, error: 'Too many alarm configuration requests, please wait.' });
    }
});
