import rateLimit from 'express-rate-limit';
import { winstonLogger } from './logger';

// Helper to safely parse env numeric values with fallback defaults
const parseEnvMs = (envVar: string | undefined, defaultMs: number): number => {
    const parsed = parseInt(envVar || '', 10);
    return !isNaN(parsed) && parsed > 0 ? parsed : defaultMs;
};

const parseEnvMax = (envVar: string | undefined, defaultMax: number): number => {
    const parsed = parseInt(envVar || '', 10);
    return !isNaN(parsed) && parsed > 0 ? parsed : defaultMax;
};

// --- AUTH LIMITER ---
// Default: 20 requests / 15 minutes
export const authLimiter = rateLimit({
    windowMs: parseEnvMs(process.env.RATE_LIMIT_AUTH_WINDOW_MS, 15 * 60 * 1000),
    max: parseEnvMax(process.env.RATE_LIMIT_AUTH_MAX, 20),
    standardHeaders: true, legacyHeaders: false,
    message: { success: false, error: 'Too many authentication attempts, please try again later.' },
    handler: (req: any, res: any) => {
        winstonLogger.warn(`[RATE_LIMIT] Auth limit exceeded for IP: ${req.ip}`);
        res.status(429).json({ success: false, error: 'Too many authentication attempts, please try again later.' });
    }
}) as any;

// --- PAYMENTS LIMITER ---
// Default: 10 requests / 10 minutes (keyed per authenticated user ID or IP fallback)
export const paymentLimiter = rateLimit({
    windowMs: parseEnvMs(process.env.RATE_LIMIT_PAYMENT_WINDOW_MS, 10 * 60 * 1000),
    max: parseEnvMax(process.env.RATE_LIMIT_PAYMENT_MAX, 10),
    standardHeaders: true, legacyHeaders: false,
    validate: false, // PHASE_8.5B: Suppress express-rate-limit v8 validation warnings for custom keyGenerator
    keyGenerator: (req: any) => {
        const userId = req.headers['x-user-id'] || req.user?.id;
        return userId ? `user_${userId}` : req.ip;
    },
    message: { success: false, error: 'Too many payment creation attempts, please wait a few minutes.' },
    handler: (req: any, res: any) => {
        winstonLogger.warn(`[RATE_LIMIT] Payment limit exceeded for user/IP: ${req.headers['x-user-id'] || req.ip}`);
        res.status(429).json({ success: false, error: 'Too many payment creation attempts, please wait a few minutes.' });
    }
}) as any;


// --- SEARCH LIMITERS ---
// Default: 60 requests / 1 minute
export const searchLimiter = rateLimit({
    windowMs: parseEnvMs(process.env.RATE_LIMIT_SEARCH_WINDOW_MS, 1 * 60 * 1000),
    max: parseEnvMax(process.env.RATE_LIMIT_SEARCH_MAX, 60),
    standardHeaders: true, legacyHeaders: false,
    message: { success: false, error: 'Too many search requests, please try again later.' },
    handler: (req: any, res: any) => {
        winstonLogger.warn(`[RATE_LIMIT] Search limit exceeded IP=${req.ip}`);
        res.status(429).json({ success: false, error: 'Too many search requests, please try again later.' });
    }
}) as any;

export const advancedSearchLimiter = rateLimit({
    windowMs: parseEnvMs(process.env.RATE_LIMIT_SEARCH_WINDOW_MS, 1 * 60 * 1000),
    max: parseEnvMax(process.env.RATE_LIMIT_SEARCH_MAX, 60),
    standardHeaders: true, legacyHeaders: false,
    message: { success: false, error: 'Too many split search requests, please wait a moment.' },
    handler: (req: any, res: any) => {
        winstonLogger.warn(`[RATE_LIMIT] Advanced search limit exceeded IP=${req.ip}`);
        res.status(429).json({ success: false, error: 'Too many split search requests, please wait a moment.' });
    }
}) as any;

export const availabilityLimiter = rateLimit({
    windowMs: parseEnvMs(process.env.RATE_LIMIT_SEARCH_WINDOW_MS, 1 * 60 * 1000),
    max: parseEnvMax(process.env.RATE_LIMIT_SEARCH_MAX, 60),
    standardHeaders: true, legacyHeaders: false,
    message: { success: false, error: 'Too many availability requests, please wait.' },
    handler: (req: any, res: any) => {
        winstonLogger.warn(`[RATE_LIMIT] Availability limit exceeded IP=${req.ip}`);
        res.status(429).json({ success: false, error: 'Too many availability requests, please wait.' });
    }
}) as any;

export const sameTrainRescueLimiter = rateLimit({
    windowMs: 1 * 60 * 1000,
    max: 15,
    standardHeaders: true, legacyHeaders: false,
    message: { success: false, error: 'Too many rescue scan requests, please wait.' },
    handler: (req: any, res: any) => {
        winstonLogger.warn(`[RATE_LIMIT] Same Train Rescue limit exceeded for IP: ${req.ip}`);
        res.status(429).json({ success: false, error: 'Too many rescue scan requests, please wait.' });
    }
}) as any;

// --- PNR LIMITER ---
// Default: 30 requests / 15 minutes
export const pnrLimiter = rateLimit({
    windowMs: parseEnvMs(process.env.RATE_LIMIT_PNR_WINDOW_MS, 15 * 60 * 1000),
    max: parseEnvMax(process.env.RATE_LIMIT_PNR_MAX, 30),
    standardHeaders: true, legacyHeaders: false,
    message: { success: false, error: 'Too many PNR requests, please try again later.' },
    handler: (req: any, res: any) => {
        winstonLogger.warn(`[RATE_LIMIT] PNR limit exceeded for IP: ${req.ip}`);
        res.status(429).json({ success: false, error: 'Too many PNR requests, please try again later.' });
    }
}) as any;

// --- LIVE TRAIN LIMITER ---
// Default: 60 requests / 1 minute
export const liveLimiter = rateLimit({
    windowMs: parseEnvMs(process.env.RATE_LIMIT_LIVE_WINDOW_MS, 1 * 60 * 1000),
    max: parseEnvMax(process.env.RATE_LIMIT_LIVE_MAX, 60),
    standardHeaders: true, legacyHeaders: false,
    message: { success: false, error: 'Too many live train requests, please try again later.' },
    handler: (req: any, res: any) => {
        winstonLogger.warn(`[RATE_LIMIT] Live train limit exceeded for IP: ${req.ip}`);
        res.status(429).json({ success: false, error: 'Too many live train requests, please try again later.' });
    }
}) as any;

export const complaintLimiter = rateLimit({
    windowMs: 5 * 60 * 1000,
    max: 10,
    standardHeaders: true, legacyHeaders: false,
    message: { success: false, error: 'Too many complaint requests, please try again later.' },
    handler: (req: any, res: any) => {
        winstonLogger.warn(`[RATE_LIMIT] Complaint limit exceeded for IP: ${req.ip}`);
        res.status(429).json({ success: false, error: 'Too many complaint requests, please try again later.' });
    }
}) as any;

export const referralLimiter = rateLimit({
    windowMs: 5 * 60 * 1000,
    max: 15,
    standardHeaders: true, legacyHeaders: false,
    message: { success: false, error: 'Too many referral requests, please try again later.' },
    handler: (req: any, res: any) => {
        winstonLogger.warn(`[RATE_LIMIT] Referral limit exceeded for IP: ${req.ip}`);
        res.status(429).json({ success: false, error: 'Too many referral requests, please try again later.' });
    }
}) as any;

// --- ADMIN LIMITER ---
// Default: 50 requests / 15 minutes
export const adminLimiter = rateLimit({
    windowMs: parseEnvMs(process.env.RATE_LIMIT_ADMIN_WINDOW_MS, 15 * 60 * 1000),
    max: parseEnvMax(process.env.RATE_LIMIT_ADMIN_MAX, 50),
    standardHeaders: true, legacyHeaders: false,
    message: { success: false, error: 'Too many admin requests, please try again later.' },
    handler: (req: any, res: any) => {
        winstonLogger.warn(`[RATE_LIMIT] Admin limit exceeded for IP: ${req.ip}`);
        res.status(429).json({ success: false, error: 'Too many admin requests, please try again later.' });
    }
}) as any;

export const diagnosticsLimiter = rateLimit({
    windowMs: 1 * 60 * 1000,
    max: 5,
    standardHeaders: true, legacyHeaders: false,
    message: { success: false, error: 'Too many diagnostics requests, please wait.' },
    handler: (req: any, res: any) => {
        winstonLogger.warn(`[RATE_LIMIT] Diagnostics limit exceeded for IP: ${req.ip}`);
        res.status(429).json({ success: false, error: 'Too many diagnostics requests, please wait.' });
    }
}) as any;

export const cacheClearLimiter = rateLimit({
    windowMs: 1 * 60 * 1000,
    max: 3,
    standardHeaders: true, legacyHeaders: false,
    message: { success: false, error: 'Too many cache clear requests, please wait.' },
    handler: (req: any, res: any) => {
        winstonLogger.warn(`[RATE_LIMIT] Cache clear limit exceeded for IP: ${req.ip}`);
        res.status(429).json({ success: false, error: 'Too many cache clear requests, please wait.' });
    }
}) as any;

export const notificationRegisterLimiter = rateLimit({
    windowMs: 10 * 60 * 1000,
    max: 5,
    standardHeaders: true, legacyHeaders: false,
    message: { success: false, error: 'Too many token registration requests, please wait.' },
    handler: (req: any, res: any) => {
        winstonLogger.warn({ message: `[RATE_LIMIT] Push token registration limit exceeded for IP: ${req.ip}`, component: 'NOTIFICATION_CONTROLLER', event: 'push_throttled' });
        res.status(429).json({ success: false, error: 'Too many token registration requests, please wait.' });
    }
}) as any;

export const notificationPrefsLimiter = rateLimit({
    windowMs: 10 * 60 * 1000,
    max: 10,
    standardHeaders: true, legacyHeaders: false,
    message: { success: false, error: 'Too many preferences requests, please wait.' },
    handler: (req: any, res: any) => {
        winstonLogger.warn({ message: `[RATE_LIMIT] Push preferences update limit exceeded for IP: ${req.ip}`, component: 'NOTIFICATION_CONTROLLER', event: 'push_throttled' });
        res.status(429).json({ success: false, error: 'Too many preferences requests, please wait.' });
    }
}) as any;

export const alarmLimiter = rateLimit({
    windowMs: 1 * 60 * 1000,
    max: 10,
    standardHeaders: true, legacyHeaders: false,
    message: { success: false, error: 'Too many alarm configuration requests, please wait.' },
    handler: (req: any, res: any) => {
        winstonLogger.warn(`[RATE_LIMIT] Alarm limit exceeded for IP: ${req.ip}`);
        res.status(429).json({ success: false, error: 'Too many alarm configuration requests, please wait.' });
    }
}) as any;

