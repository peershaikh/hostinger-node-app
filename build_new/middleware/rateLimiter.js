"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.alarmLimiter = exports.notificationPrefsLimiter = exports.notificationRegisterLimiter = exports.cacheClearLimiter = exports.diagnosticsLimiter = exports.adminLimiter = exports.referralLimiter = exports.complaintLimiter = exports.liveLimiter = exports.pnrLimiter = exports.sameTrainRescueLimiter = exports.availabilityLimiter = exports.advancedSearchLimiter = exports.searchLimiter = exports.paymentLimiter = exports.authLimiter = void 0;
const express_rate_limit_1 = __importDefault(require("express-rate-limit"));
const logger_1 = require("./logger");
// Helper to safely parse env numeric values with fallback defaults
const parseEnvMs = (envVar, defaultMs) => {
    const parsed = parseInt(envVar || '', 10);
    return !isNaN(parsed) && parsed > 0 ? parsed : defaultMs;
};
const parseEnvMax = (envVar, defaultMax) => {
    const parsed = parseInt(envVar || '', 10);
    return !isNaN(parsed) && parsed > 0 ? parsed : defaultMax;
};
// --- AUTH LIMITER ---
// Default: 20 requests / 15 minutes
exports.authLimiter = (0, express_rate_limit_1.default)({
    windowMs: parseEnvMs(process.env.RATE_LIMIT_AUTH_WINDOW_MS, 15 * 60 * 1000),
    max: parseEnvMax(process.env.RATE_LIMIT_AUTH_MAX, 20),
    standardHeaders: true, legacyHeaders: false,
    message: { success: false, error: 'Too many authentication attempts, please try again later.' },
    handler: (req, res) => {
        logger_1.winstonLogger.warn(`[RATE_LIMIT] Auth limit exceeded for IP: ${req.ip}`);
        res.status(429).json({ success: false, error: 'Too many authentication attempts, please try again later.' });
    }
});
// --- PAYMENTS LIMITER ---
// Default: 10 requests / 10 minutes (keyed per authenticated user ID or IP fallback)
exports.paymentLimiter = (0, express_rate_limit_1.default)({
    windowMs: parseEnvMs(process.env.RATE_LIMIT_PAYMENT_WINDOW_MS, 10 * 60 * 1000),
    max: parseEnvMax(process.env.RATE_LIMIT_PAYMENT_MAX, 10),
    standardHeaders: true, legacyHeaders: false,
    validate: false, // PHASE_8.5B: Suppress express-rate-limit v8 validation warnings for custom keyGenerator
    keyGenerator: (req) => {
        const userId = req.headers['x-user-id'] || req.user?.id;
        return userId ? `user_${userId}` : req.ip;
    },
    message: { success: false, error: 'Too many payment creation attempts, please wait a few minutes.' },
    handler: (req, res) => {
        logger_1.winstonLogger.warn(`[RATE_LIMIT] Payment limit exceeded for user/IP: ${req.headers['x-user-id'] || req.ip}`);
        res.status(429).json({ success: false, error: 'Too many payment creation attempts, please wait a few minutes.' });
    }
});
// --- SEARCH LIMITERS ---
// Default: 60 requests / 1 minute
exports.searchLimiter = (0, express_rate_limit_1.default)({
    windowMs: parseEnvMs(process.env.RATE_LIMIT_SEARCH_WINDOW_MS, 1 * 60 * 1000),
    max: parseEnvMax(process.env.RATE_LIMIT_SEARCH_MAX, 60),
    standardHeaders: true, legacyHeaders: false,
    message: { success: false, error: 'Too many search requests, please try again later.' },
    handler: (req, res) => {
        logger_1.winstonLogger.warn(`[RATE_LIMIT] Search limit exceeded IP=${req.ip}`);
        res.status(429).json({ success: false, error: 'Too many search requests, please try again later.' });
    }
});
exports.advancedSearchLimiter = (0, express_rate_limit_1.default)({
    windowMs: parseEnvMs(process.env.RATE_LIMIT_SEARCH_WINDOW_MS, 1 * 60 * 1000),
    max: parseEnvMax(process.env.RATE_LIMIT_SEARCH_MAX, 60),
    standardHeaders: true, legacyHeaders: false,
    message: { success: false, error: 'Too many split search requests, please wait a moment.' },
    handler: (req, res) => {
        logger_1.winstonLogger.warn(`[RATE_LIMIT] Advanced search limit exceeded IP=${req.ip}`);
        res.status(429).json({ success: false, error: 'Too many split search requests, please wait a moment.' });
    }
});
exports.availabilityLimiter = (0, express_rate_limit_1.default)({
    windowMs: parseEnvMs(process.env.RATE_LIMIT_SEARCH_WINDOW_MS, 1 * 60 * 1000),
    max: parseEnvMax(process.env.RATE_LIMIT_SEARCH_MAX, 60),
    standardHeaders: true, legacyHeaders: false,
    message: { success: false, error: 'Too many availability requests, please wait.' },
    handler: (req, res) => {
        logger_1.winstonLogger.warn(`[RATE_LIMIT] Availability limit exceeded IP=${req.ip}`);
        res.status(429).json({ success: false, error: 'Too many availability requests, please wait.' });
    }
});
exports.sameTrainRescueLimiter = (0, express_rate_limit_1.default)({
    windowMs: 1 * 60 * 1000,
    max: 15,
    standardHeaders: true, legacyHeaders: false,
    message: { success: false, error: 'Too many rescue scan requests, please wait.' },
    handler: (req, res) => {
        logger_1.winstonLogger.warn(`[RATE_LIMIT] Same Train Rescue limit exceeded for IP: ${req.ip}`);
        res.status(429).json({ success: false, error: 'Too many rescue scan requests, please wait.' });
    }
});
// --- PNR LIMITER ---
// Default: 30 requests / 15 minutes
exports.pnrLimiter = (0, express_rate_limit_1.default)({
    windowMs: parseEnvMs(process.env.RATE_LIMIT_PNR_WINDOW_MS, 15 * 60 * 1000),
    max: parseEnvMax(process.env.RATE_LIMIT_PNR_MAX, 30),
    standardHeaders: true, legacyHeaders: false,
    message: { success: false, error: 'Too many PNR requests, please try again later.' },
    handler: (req, res) => {
        logger_1.winstonLogger.warn(`[RATE_LIMIT] PNR limit exceeded for IP: ${req.ip}`);
        res.status(429).json({ success: false, error: 'Too many PNR requests, please try again later.' });
    }
});
// --- LIVE TRAIN LIMITER ---
// Default: 60 requests / 1 minute
exports.liveLimiter = (0, express_rate_limit_1.default)({
    windowMs: parseEnvMs(process.env.RATE_LIMIT_LIVE_WINDOW_MS, 1 * 60 * 1000),
    max: parseEnvMax(process.env.RATE_LIMIT_LIVE_MAX, 60),
    standardHeaders: true, legacyHeaders: false,
    message: { success: false, error: 'Too many live train requests, please try again later.' },
    handler: (req, res) => {
        logger_1.winstonLogger.warn(`[RATE_LIMIT] Live train limit exceeded for IP: ${req.ip}`);
        res.status(429).json({ success: false, error: 'Too many live train requests, please try again later.' });
    }
});
exports.complaintLimiter = (0, express_rate_limit_1.default)({
    windowMs: 5 * 60 * 1000,
    max: 10,
    standardHeaders: true, legacyHeaders: false,
    message: { success: false, error: 'Too many complaint requests, please try again later.' },
    handler: (req, res) => {
        logger_1.winstonLogger.warn(`[RATE_LIMIT] Complaint limit exceeded for IP: ${req.ip}`);
        res.status(429).json({ success: false, error: 'Too many complaint requests, please try again later.' });
    }
});
exports.referralLimiter = (0, express_rate_limit_1.default)({
    windowMs: 5 * 60 * 1000,
    max: 15,
    standardHeaders: true, legacyHeaders: false,
    message: { success: false, error: 'Too many referral requests, please try again later.' },
    handler: (req, res) => {
        logger_1.winstonLogger.warn(`[RATE_LIMIT] Referral limit exceeded for IP: ${req.ip}`);
        res.status(429).json({ success: false, error: 'Too many referral requests, please try again later.' });
    }
});
// --- ADMIN LIMITER ---
// Default: 50 requests / 15 minutes
exports.adminLimiter = (0, express_rate_limit_1.default)({
    windowMs: parseEnvMs(process.env.RATE_LIMIT_ADMIN_WINDOW_MS, 15 * 60 * 1000),
    max: parseEnvMax(process.env.RATE_LIMIT_ADMIN_MAX, 50),
    standardHeaders: true, legacyHeaders: false,
    message: { success: false, error: 'Too many admin requests, please try again later.' },
    handler: (req, res) => {
        logger_1.winstonLogger.warn(`[RATE_LIMIT] Admin limit exceeded for IP: ${req.ip}`);
        res.status(429).json({ success: false, error: 'Too many admin requests, please try again later.' });
    }
});
exports.diagnosticsLimiter = (0, express_rate_limit_1.default)({
    windowMs: 1 * 60 * 1000,
    max: 5,
    standardHeaders: true, legacyHeaders: false,
    message: { success: false, error: 'Too many diagnostics requests, please wait.' },
    handler: (req, res) => {
        logger_1.winstonLogger.warn(`[RATE_LIMIT] Diagnostics limit exceeded for IP: ${req.ip}`);
        res.status(429).json({ success: false, error: 'Too many diagnostics requests, please wait.' });
    }
});
exports.cacheClearLimiter = (0, express_rate_limit_1.default)({
    windowMs: 1 * 60 * 1000,
    max: 3,
    standardHeaders: true, legacyHeaders: false,
    message: { success: false, error: 'Too many cache clear requests, please wait.' },
    handler: (req, res) => {
        logger_1.winstonLogger.warn(`[RATE_LIMIT] Cache clear limit exceeded for IP: ${req.ip}`);
        res.status(429).json({ success: false, error: 'Too many cache clear requests, please wait.' });
    }
});
exports.notificationRegisterLimiter = (0, express_rate_limit_1.default)({
    windowMs: 10 * 60 * 1000,
    max: 5,
    standardHeaders: true, legacyHeaders: false,
    message: { success: false, error: 'Too many token registration requests, please wait.' },
    handler: (req, res) => {
        logger_1.winstonLogger.warn({ message: `[RATE_LIMIT] Push token registration limit exceeded for IP: ${req.ip}`, component: 'NOTIFICATION_CONTROLLER', event: 'push_throttled' });
        res.status(429).json({ success: false, error: 'Too many token registration requests, please wait.' });
    }
});
exports.notificationPrefsLimiter = (0, express_rate_limit_1.default)({
    windowMs: 10 * 60 * 1000,
    max: 10,
    standardHeaders: true, legacyHeaders: false,
    message: { success: false, error: 'Too many preferences requests, please wait.' },
    handler: (req, res) => {
        logger_1.winstonLogger.warn({ message: `[RATE_LIMIT] Push preferences update limit exceeded for IP: ${req.ip}`, component: 'NOTIFICATION_CONTROLLER', event: 'push_throttled' });
        res.status(429).json({ success: false, error: 'Too many preferences requests, please wait.' });
    }
});
exports.alarmLimiter = (0, express_rate_limit_1.default)({
    windowMs: 1 * 60 * 1000,
    max: 10,
    standardHeaders: true, legacyHeaders: false,
    message: { success: false, error: 'Too many alarm configuration requests, please wait.' },
    handler: (req, res) => {
        logger_1.winstonLogger.warn(`[RATE_LIMIT] Alarm limit exceeded for IP: ${req.ip}`);
        res.status(429).json({ success: false, error: 'Too many alarm configuration requests, please wait.' });
    }
});
