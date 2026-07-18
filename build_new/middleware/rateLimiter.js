"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.alarmLimiter = exports.notificationPrefsLimiter = exports.notificationRegisterLimiter = exports.cacheClearLimiter = exports.diagnosticsLimiter = exports.adminLimiter = exports.referralLimiter = exports.authLimiter = exports.complaintLimiter = exports.liveLimiter = exports.pnrLimiter = exports.sameTrainRescueLimiter = exports.availabilityLimiter = exports.advancedSearchLimiter = exports.searchLimiter = void 0;
const express_rate_limit_1 = __importDefault(require("express-rate-limit"));
const logger_1 = require("./logger");
// PHASE_4C971 FINAL FIX: Removed all custom keyGenerator (smartKey) and skip (skipLoopback)
// functions. These caused express-rate-limit v8 ValidationError on startup because the custom
// keyGenerator accessed req.ip directly. validate: { ip: false } did NOT suppress it.
// Solution: Use default IP-based limiting (no custom keyGenerator = no ValidationError ever).
exports.searchLimiter = (0, express_rate_limit_1.default)({
    windowMs: 5 * 60 * 1000,
    max: 300,
    standardHeaders: true, legacyHeaders: false,
    message: { success: false, error: 'Too many search requests, please try again later.' },
    handler: (req, res) => {
        logger_1.winstonLogger.warn(`[RATE_LIMIT] Search limit exceeded IP=${req.ip}`);
        res.status(429).json({ success: false, error: 'Too many search requests, please try again later.' });
    }
});
exports.advancedSearchLimiter = (0, express_rate_limit_1.default)({
    windowMs: 1 * 60 * 1000,
    max: 60,
    standardHeaders: true, legacyHeaders: false,
    message: { success: false, error: 'Too many split search requests, please wait a moment.' },
    handler: (req, res) => {
        logger_1.winstonLogger.warn(`[RATE_LIMIT] Advanced search limit exceeded IP=${req.ip}`);
        res.status(429).json({ success: false, error: 'Too many split search requests, please wait a moment.' });
    }
});
exports.availabilityLimiter = (0, express_rate_limit_1.default)({
    windowMs: 1 * 60 * 1000,
    max: 60,
    standardHeaders: true, legacyHeaders: false,
    message: { success: false, error: 'Too many availability requests, please wait.' },
    handler: (req, res) => {
        logger_1.winstonLogger.warn(`[RATE_LIMIT] Availability limit exceeded IP=${req.ip}`);
        res.status(429).json({ success: false, error: 'Too many availability requests, please wait.' });
    }
});
exports.sameTrainRescueLimiter = (0, express_rate_limit_1.default)({
    windowMs: 1 * 60 * 1000,
    max: 10,
    standardHeaders: true, legacyHeaders: false,
    message: { success: false, error: 'Too many rescue scan requests, please wait.' },
    handler: (req, res) => {
        logger_1.winstonLogger.warn(`[RATE_LIMIT] Same Train Rescue limit exceeded for IP: ${req.ip}`);
        res.status(429).json({ success: false, error: 'Too many rescue scan requests, please wait.' });
    }
});
exports.pnrLimiter = (0, express_rate_limit_1.default)({
    windowMs: 5 * 60 * 1000,
    max: 20,
    standardHeaders: true, legacyHeaders: false,
    message: { success: false, error: 'Too many PNR requests, please try again later.' },
    handler: (req, res) => {
        logger_1.winstonLogger.warn(`[RATE_LIMIT] PNR limit exceeded for IP: ${req.ip}`);
        res.status(429).json({ success: false, error: 'Too many PNR requests, please try again later.' });
    }
});
exports.liveLimiter = (0, express_rate_limit_1.default)({
    windowMs: 5 * 60 * 1000,
    max: 20,
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
exports.authLimiter = (0, express_rate_limit_1.default)({
    windowMs: 1 * 60 * 1000,
    max: 10,
    standardHeaders: true, legacyHeaders: false,
    message: { success: false, error: 'Too many authentication attempts, please try again later.' },
    handler: (req, res) => {
        logger_1.winstonLogger.warn(`[RATE_LIMIT] Auth limit exceeded for IP: ${req.ip}`);
        res.status(429).json({ success: false, error: 'Too many authentication attempts, please try again later.' });
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
exports.adminLimiter = (0, express_rate_limit_1.default)({
    windowMs: 1 * 60 * 1000,
    max: 30,
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
