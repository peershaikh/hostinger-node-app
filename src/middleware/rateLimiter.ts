import rateLimit from 'express-rate-limit';
import { winstonLogger } from './logger';

/**
 * Rate limiter for regular search endpoints
 */
export const searchLimiter = rateLimit({
    windowMs: 5 * 60 * 1000, // 5 minutes
    max: 200, // limit each IP to 200 requests per windowMs
    message: { success: false, error: 'Too many search requests, please try again later.' },
    standardHeaders: true, legacyHeaders: false,
    handler: (req, res, next) => {
        winstonLogger.warn(`[RATE_LIMIT] Search limit exceeded for IP: ${req.ip}`);
        res.status(429).json({ success: false, error: 'Too many search requests, please try again later.' });
    }
}) as any;

/**
 * Strict Rate limiter for split/advanced search endpoints (30 req / min)
 */
export const advancedSearchLimiter = rateLimit({
    windowMs: 1 * 60 * 1000, // 1 minute
    max: 30, // 30 req/min
    message: { success: false, error: 'Too many split search requests, please wait.' },
    standardHeaders: true, legacyHeaders: false,
    handler: (req, res, next) => {
        winstonLogger.warn(`[RATE_LIMIT] Advanced search limit exceeded for IP: ${req.ip}`);
        res.status(429).json({ success: false, error: 'Too many split search requests, please wait.' });
    }
}) as any;

/**
 * Strict Rate limiter for availability fetch (30 req / min)
 */
export const availabilityLimiter = rateLimit({
    windowMs: 1 * 60 * 1000, // 1 minute
    max: 30, // 30 req/min
    message: { success: false, error: 'Too many availability requests, please wait.' },
    standardHeaders: true, legacyHeaders: false,
    handler: (req, res, next) => {
        winstonLogger.warn(`[RATE_LIMIT] Availability limit exceeded for IP: ${req.ip}`);
        res.status(429).json({ success: false, error: 'Too many availability requests, please wait.' });
    }
}) as any;

/**
 * Rate limiter for user-triggered Same Train Rescue endpoint (10 req / min).
 * Each scan can make up to 8 API calls — keep this strict to protect API budget.
 */
export const sameTrainRescueLimiter = rateLimit({
    windowMs: 1 * 60 * 1000, // 1 minute
    max: 10,
    message: { success: false, error: 'Too many rescue scan requests, please wait.' },
    standardHeaders: true, legacyHeaders: false,
    handler: (req, res, next) => {
        winstonLogger.warn(`[RATE_LIMIT] Same Train Rescue limit exceeded for IP: ${req.ip}`);
        res.status(429).json({ success: false, error: 'Too many rescue scan requests, please wait.' });
    }
}) as any;


/**
 * Rate limiter for PNR endpoints
 */
export const pnrLimiter = rateLimit({
    windowMs: 5 * 60 * 1000, // 5 minutes
    max: 20, // limit each IP to 20 requests per windowMs
    message: {
        success: false,
        error: 'Too many PNR requests, please try again later.'
    },
    standardHeaders: true,
    legacyHeaders: false,
    handler: (req, res, next) => {
        winstonLogger.warn(`[RATE_LIMIT] PNR limit exceeded for IP: ${req.ip}`);
        res.status(429).json({
            success: false,
            error: 'Too many PNR requests, please try again later.'
        });
    }
}) as any;

/**
 * Rate limiter for live train endpoints
 */
export const liveLimiter = rateLimit({
    windowMs: 5 * 60 * 1000, // 5 minutes
    max: 20, // limit each IP to 20 requests per windowMs
    message: {
        success: false,
        error: 'Too many live train requests, please try again later.'
    },
    standardHeaders: true,
    legacyHeaders: false,
    handler: (req, res, next) => {
        winstonLogger.warn(`[RATE_LIMIT] Live train limit exceeded for IP: ${req.ip}`);
        res.status(429).json({
            success: false,
            error: 'Too many live train requests, please try again later.'
        });
    }
}) as any;

/**
 * Rate limiter for complaint endpoints
 */
export const complaintLimiter = rateLimit({
    windowMs: 5 * 60 * 1000, // 5 minutes
    max: 10, // limit each IP to 10 requests per windowMs
    message: {
        success: false,
        error: 'Too many complaint requests, please try again later.'
    },
    standardHeaders: true,
    legacyHeaders: false,
    handler: (req, res, next) => {
        winstonLogger.warn(`[RATE_LIMIT] Complaint limit exceeded for IP: ${req.ip}`);
        res.status(429).json({
            success: false,
            error: 'Too many complaint requests, please try again later.'
        });
    }
}) as any;

/**
 * Strict rate limiter for authentication endpoints
 */
export const authLimiter = rateLimit({
    windowMs: 1 * 60 * 1000, // 1 minute
    max: 10, // limit each IP to 10 requests per windowMs
    message: {
        success: false,
        error: 'Too many authentication attempts, please try again later.'
    },
    standardHeaders: true,
    legacyHeaders: false,
    handler: (req, res, next) => {
        winstonLogger.warn(`[RATE_LIMIT] Auth limit exceeded for IP: ${req.ip}`);
        res.status(429).json({
            success: false,
            error: 'Too many authentication attempts, please try again later.'
        });
    }
}) as any;

/**
 * Rate limiter for referral endpoints
 */
export const referralLimiter = rateLimit({
    windowMs: 5 * 60 * 1000, // 5 minutes
    max: 15, // limit each IP to 15 requests per windowMs
    message: {
        success: false,
        error: 'Too many referral requests, please try again later.'
    },
    standardHeaders: true,
    legacyHeaders: false,
    handler: (req, res, next) => {
        winstonLogger.warn(`[RATE_LIMIT] Referral limit exceeded for IP: ${req.ip}`);
        res.status(429).json({
            success: false,
            error: 'Too many referral requests, please try again later.'
        });
    }
}) as any;

/**
 * Rate limiter for admin endpoints
 */
export const adminLimiter = rateLimit({
    windowMs: 1 * 60 * 1000, // 1 minute
    max: 30,
    message: {
        success: false,
        error: 'Too many admin requests, please try again later.'
    },
    standardHeaders: true,
    legacyHeaders: false,
    handler: (req, res, next) => {
        winstonLogger.warn(`[RATE_LIMIT] Admin limit exceeded for IP: ${req.ip}`);
        res.status(429).json({
            success: false,
            error: 'Too many admin requests, please try again later.'
        });
    }
}) as any;

/**
 * Strict rate limiter for diagnostics endpoints (5 requests per minute)
 */
export const diagnosticsLimiter = rateLimit({
    windowMs: 1 * 60 * 1000, // 1 minute
    max: 5,
    message: { success: false, error: 'Too many diagnostics requests, please wait.' },
    standardHeaders: true,
    legacyHeaders: false,
    handler: (req, res, next) => {
        winstonLogger.warn(`[RATE_LIMIT] Diagnostics limit exceeded for IP: ${req.ip}`);
        res.status(429).json({ success: false, error: 'Too many diagnostics requests, please wait.' });
    }
}) as any;

/**
 * Strict rate limiter for cache clear endpoints (3 requests per minute)
 */
export const cacheClearLimiter = rateLimit({
    windowMs: 1 * 60 * 1000, // 1 minute
    max: 3,
    message: { success: false, error: 'Too many cache clear requests, please wait.' },
    standardHeaders: true,
    legacyHeaders: false,
    handler: (req, res, next) => {
        winstonLogger.warn(`[RATE_LIMIT] Cache clear limit exceeded for IP: ${req.ip}`);
        res.status(429).json({ success: false, error: 'Too many cache clear requests, please wait.' });
    }
}) as any;

/**
 * Throttler for push token registration endpoints (max 5 requests per 10 minutes)
 */
export const notificationRegisterLimiter = rateLimit({
    windowMs: 10 * 60 * 1000, // 10 minutes
    max: 5, // limit each IP to 5 requests per windowMs
    message: { success: false, error: 'Too many token registration requests, please wait.' },
    standardHeaders: true,
    legacyHeaders: false,
    handler: (req, res, next) => {
        winstonLogger.warn({
            message: `[RATE_LIMIT] Push token registration limit exceeded for IP: ${req.ip}`,
            component: 'NOTIFICATION_CONTROLLER',
            event: 'push_throttled'
        });
        res.status(429).json({ success: false, error: 'Too many token registration requests, please wait.' });
    }
}) as any;

/**
 * Throttler for notification privacy settings endpoints (max 10 requests per 10 minutes)
 */
export const notificationPrefsLimiter = rateLimit({
    windowMs: 10 * 60 * 1000, // 10 minutes
    max: 10, // limit each IP to 10 requests per windowMs
    message: { success: false, error: 'Too many preferences requests, please wait.' },
    standardHeaders: true,
    legacyHeaders: false,
    handler: (req, res, next) => {
        winstonLogger.warn({
            message: `[RATE_LIMIT] Push preferences update limit exceeded for IP: ${req.ip}`,
            component: 'NOTIFICATION_CONTROLLER',
            event: 'push_throttled'
        });
        res.status(429).json({ success: false, error: 'Too many preferences requests, please wait.' });
    }
}) as any;

/**
 * Rate limiter for Destination Wake-up Alarm endpoints (max 10 requests per minute)
 */
export const alarmLimiter = rateLimit({
    windowMs: 1 * 60 * 1000, // 1 minute
    max: 10,
    message: { success: false, error: 'Too many alarm configuration requests, please wait.' },
    standardHeaders: true,
    legacyHeaders: false,
    handler: (req, res, next) => {
        winstonLogger.warn(`[RATE_LIMIT] Alarm limit exceeded for IP: ${req.ip}`);
        res.status(429).json({ success: false, error: 'Too many alarm configuration requests, please wait.' });
    }
}) as any;



