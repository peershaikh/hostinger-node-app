"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.alarmLimiter = exports.notificationPrefsLimiter = exports.notificationRegisterLimiter = exports.cacheClearLimiter = exports.diagnosticsLimiter = exports.adminLimiter = exports.referralLimiter = exports.authLimiter = exports.complaintLimiter = exports.liveLimiter = exports.pnrLimiter = exports.sameTrainRescueLimiter = exports.availabilityLimiter = exports.advancedSearchLimiter = exports.searchLimiter = void 0;
const express_rate_limit_1 = __importDefault(require("express-rate-limit"));
const logger_1 = require("./logger");
/**
 * Rate limiter for regular search endpoints
 */
exports.searchLimiter = (0, express_rate_limit_1.default)({
    windowMs: 5 * 60 * 1000, // 5 minutes
    max: 200, // limit each IP to 200 requests per windowMs
    message: { success: false, error: 'Too many search requests, please try again later.' },
    standardHeaders: true, legacyHeaders: false,
    handler: (req, res, next) => {
        logger_1.winstonLogger.warn(`[RATE_LIMIT] Search limit exceeded for IP: ${req.ip}`);
        res.status(429).json({ success: false, error: 'Too many search requests, please try again later.' });
    }
});
/**
 * Strict Rate limiter for split/advanced search endpoints (30 req / min)
 */
exports.advancedSearchLimiter = (0, express_rate_limit_1.default)({
    windowMs: 1 * 60 * 1000, // 1 minute
    max: 30, // 30 req/min
    message: { success: false, error: 'Too many split search requests, please wait.' },
    standardHeaders: true, legacyHeaders: false,
    handler: (req, res, next) => {
        logger_1.winstonLogger.warn(`[RATE_LIMIT] Advanced search limit exceeded for IP: ${req.ip}`);
        res.status(429).json({ success: false, error: 'Too many split search requests, please wait.' });
    }
});
/**
 * Strict Rate limiter for availability fetch (30 req / min)
 */
exports.availabilityLimiter = (0, express_rate_limit_1.default)({
    windowMs: 1 * 60 * 1000, // 1 minute
    max: 30, // 30 req/min
    message: { success: false, error: 'Too many availability requests, please wait.' },
    standardHeaders: true, legacyHeaders: false,
    handler: (req, res, next) => {
        logger_1.winstonLogger.warn(`[RATE_LIMIT] Availability limit exceeded for IP: ${req.ip}`);
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
