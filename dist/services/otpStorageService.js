"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.otpStorageService = exports.OtpStorageService = void 0;
const crypto_1 = __importDefault(require("crypto"));
const supabase_1 = require("../config/supabase");
const logger_1 = require("../middleware/logger");
const phoneNormalizer_1 = require("../utils/phoneNormalizer");
class OtpStorageService {
    constructor() {
        // Test/Development isolated in-memory store (strictly forbidden in production)
        this.testOtps = new Map();
        this.testRateLimits = new Map();
    }
    isProduction() {
        return process.env.NODE_ENV === 'production';
    }
    /**
     * Hashes the OTP using SHA-256 with the server's pepper/secret.
     */
    hashOtp(targetKey, otp) {
        const pepper = process.env.JWT_SECRET || 'trayago_otp_secure_salt';
        return crypto_1.default.createHash('sha256').update(`${targetKey}:${otp.trim()}:${pepper}`).digest('hex');
    }
    /**
     * Generates a secure random 6-digit OTP string.
     */
    generateOtpCode() {
        return crypto_1.default.randomInt(100000, 1000000).toString();
    }
    /**
     * Requests a new mobile OTP with atomic cooldown & rate limit enforcement.
     */
    async requestOtp(params) {
        const normalizedPhone = (0, phoneNormalizer_1.normalizeIndianPhoneNumber)(params.phoneE164);
        if (!normalizedPhone) {
            throw new Error('Invalid Indian mobile number format');
        }
        const isProd = this.isProduction();
        // 1. Production Fail-Closed Safety Check: Never run in-memory in production
        if (isProd && !(0, supabase_1.isSupabaseConfigured)()) {
            logger_1.winstonLogger.error('[OTP_STORAGE] CRITICAL: Supabase is not configured in production. Refusing insecure in-memory fallback.');
            throw new Error('Authentication service temporarily unavailable.');
        }
        const otp = this.generateOtpCode();
        const salt = crypto_1.default.randomBytes(16).toString('hex');
        const hashKey = params.userId || normalizedPhone;
        const otpHash = this.hashOtp(hashKey, otp);
        // 2. Production / Configured Supabase Path via Atomic PostgreSQL RPC
        if ((0, supabase_1.isSupabaseConfigured)()) {
            try {
                const { data, error } = await supabase_1.supabase.rpc('request_mobile_otp', {
                    p_phone_e164: normalizedPhone,
                    p_otp_hash: otpHash,
                    p_salt: salt,
                    p_user_id: params.userId || null,
                    p_channel: params.channel || 'WHATSAPP',
                    p_ip_address: params.ipAddress || null,
                    p_user_agent: params.userAgent || null,
                    p_cooldown_seconds: 60,
                    p_max_hourly: 5,
                    p_expiry_minutes: 5
                });
                if (error) {
                    if (isProd) {
                        logger_1.winstonLogger.error(`[OTP_STORAGE] CRITICAL: Supabase RPC error in production: ${error.message}`);
                        throw new Error('Authentication service temporarily unavailable.');
                    }
                    // In test/local dev without migrated database, fall back to atomic in-memory mock
                    logger_1.winstonLogger.warn(`[OTP_STORAGE] Non-production Supabase RPC unavailable: ${error.message}. Using test fallback.`);
                    return this.requestOtpInMemory(normalizedPhone, otp, otpHash, salt, params);
                }
                if (data && data.success === false) {
                    throw new Error(data.message || 'OTP request rejected.');
                }
                logger_1.winstonLogger.info(`[OTP_STORAGE] Persisted new OTP in Supabase for ${(0, phoneNormalizer_1.maskPhoneNumber)(normalizedPhone)} (channel=${params.channel || 'WHATSAPP'}).`);
                return {
                    otp,
                    otpId: data?.otp_id || crypto_1.default.randomUUID(),
                    cooldownSeconds: data?.cooldown_seconds || 60
                };
            }
            catch (err) {
                if (isProd) {
                    // In production, NEVER fall back to in-memory
                    throw err;
                }
                // In local/test mode, bubble up explicit rate limit / cooldown errors
                if (err.message && (err.message.includes('second(s)') || err.message.includes('Too many OTP requests'))) {
                    throw err;
                }
                return this.requestOtpInMemory(normalizedPhone, otp, otpHash, salt, params);
            }
        }
        // 3. Isolated non-production test fallback
        return this.requestOtpInMemory(normalizedPhone, otp, otpHash, salt, params);
    }
    /**
     * Verifies an OTP atomically. Wrong OTP increments attempts without consuming.
     * Correct OTP is consumed atomically.
     */
    async verifyOtp(params) {
        const normalizedPhone = params.phoneE164 ? (0, phoneNormalizer_1.normalizeIndianPhoneNumber)(params.phoneE164) : undefined;
        if (params.phoneE164 && !normalizedPhone) {
            throw new Error('Invalid Indian mobile number format');
        }
        if (!params.otpCode || !/^\d{6}$/.test(params.otpCode.trim())) {
            throw new Error('Invalid verification code');
        }
        const isProd = this.isProduction();
        // Production Fail-Closed Safety Check
        if (isProd && !(0, supabase_1.isSupabaseConfigured)()) {
            logger_1.winstonLogger.error('[OTP_STORAGE] CRITICAL: Supabase is not configured in production. Refusing insecure in-memory fallback.');
            throw new Error('Authentication service temporarily unavailable.');
        }
        const hashKey = params.userId || normalizedPhone || '';
        const computedHash = this.hashOtp(hashKey, params.otpCode.trim());
        if ((0, supabase_1.isSupabaseConfigured)()) {
            try {
                const { data, error } = await supabase_1.supabase.rpc('verify_mobile_otp', {
                    p_phone_e164: normalizedPhone || null,
                    p_otp_hash: computedHash,
                    p_user_id: params.userId || null
                });
                if (error) {
                    if (isProd) {
                        logger_1.winstonLogger.error(`[OTP_STORAGE] CRITICAL: Supabase verify RPC error in production: ${error.message}`);
                        throw new Error('Authentication service temporarily unavailable.');
                    }
                    logger_1.winstonLogger.warn(`[OTP_STORAGE] Non-production Supabase verify RPC unavailable: ${error.message}. Using test fallback.`);
                    return this.verifyOtpInMemory(normalizedPhone, params.otpCode.trim(), params.userId);
                }
                if (!data || data.success === false) {
                    throw new Error(data?.message || 'Invalid verification code');
                }
                logger_1.winstonLogger.info(`[OTP_STORAGE] Successfully verified OTP in Supabase for ${params.userId || normalizedPhone}.`);
                return {
                    success: true,
                    phoneE164: data.phone_e164 || normalizedPhone || '',
                    channel: data.channel || 'WHATSAPP'
                };
            }
            catch (err) {
                if (isProd) {
                    throw err;
                }
                // Bubble up expected domain error messages
                if (err.message && (err.message.includes('Invalid verification code') ||
                    err.message.includes('expired') ||
                    err.message.includes('Too many failed attempts') ||
                    err.message.includes('No active OTP'))) {
                    throw err;
                }
                return this.verifyOtpInMemory(normalizedPhone, params.otpCode.trim(), params.userId);
            }
        }
        return this.verifyOtpInMemory(normalizedPhone, params.otpCode.trim(), params.userId);
    }
    // ─── Test & Local Non-Production In-Memory Implementation ───────────────────
    requestOtpInMemory(phoneE164, otp, otpHash, salt, params) {
        const now = Date.now();
        const COOLDOWN_MS = 60 * 1000;
        const HOURLY_WINDOW_MS = 60 * 60 * 1000;
        const MAX_HOURLY = 5;
        // Check cooldown for phone
        const existing = this.testOtps.get(phoneE164) || (params.userId ? this.testOtps.get(`user:${params.userId}`) : undefined);
        if (existing && existing.consumedAt === null && (now - existing.lastSentAt) < COOLDOWN_MS) {
            const secondsLeft = Math.ceil((COOLDOWN_MS - (now - existing.lastSentAt)) / 1000);
            throw new Error(`Please wait ${secondsLeft} second(s) before requesting another OTP.`);
        }
        // Check hourly limit for phone
        const phoneLimitKey = `phone:${phoneE164}`;
        let phoneLimit = this.testRateLimits.get(phoneLimitKey);
        if (!phoneLimit || now > phoneLimit.resetAt) {
            phoneLimit = { count: 0, resetAt: now + HOURLY_WINDOW_MS };
            this.testRateLimits.set(phoneLimitKey, phoneLimit);
        }
        if (phoneLimit.count >= MAX_HOURLY) {
            throw new Error('Too many OTP requests. Please try again in an hour.');
        }
        // Check hourly limit for userId if provided
        if (params.userId) {
            const userLimitKey = `user:${params.userId}`;
            let userLimit = this.testRateLimits.get(userLimitKey);
            if (!userLimit || now > userLimit.resetAt) {
                userLimit = { count: 0, resetAt: now + HOURLY_WINDOW_MS };
                this.testRateLimits.set(userLimitKey, userLimit);
            }
            if (userLimit.count >= MAX_HOURLY) {
                throw new Error('Too many OTP requests. Please try again in an hour.');
            }
            userLimit.count++;
        }
        phoneLimit.count++;
        // Invalidate previous unconsumed OTP
        if (existing && existing.consumedAt === null) {
            existing.consumedAt = now;
        }
        const recordId = crypto_1.default.randomUUID();
        const newRecord = {
            id: recordId,
            userId: params.userId,
            phoneE164,
            otpHash,
            salt,
            channel: params.channel || 'WHATSAPP',
            attempts: 0,
            maxAttempts: 5,
            expiresAt: now + 5 * 60 * 1000, // 5 minutes
            lastSentAt: now,
            consumedAt: null,
            createdAt: now
        };
        this.testOtps.set(phoneE164, newRecord);
        if (params.userId) {
            this.testOtps.set(`user:${params.userId}`, newRecord);
        }
        return {
            otp,
            otpId: recordId,
            cooldownSeconds: 60
        };
    }
    verifyOtpInMemory(phoneE164, otpCode, userId) {
        const record = (phoneE164 ? this.testOtps.get(phoneE164) : undefined) ||
            (userId ? this.testOtps.get(`user:${userId}`) : undefined);
        if (!record || record.consumedAt !== null) {
            throw new Error('No active OTP found. Please request a new one.');
        }
        const now = Date.now();
        if (now > record.expiresAt) {
            record.consumedAt = now;
            throw new Error('OTP has expired. Please request a new one.');
        }
        if (record.attempts >= record.maxAttempts) {
            record.consumedAt = now;
            throw new Error('Too many failed attempts. Please request a new OTP.');
        }
        // Check hash
        const hashKey = record.userId || record.phoneE164;
        const computedHash = this.hashOtp(hashKey, (otpCode || '').trim());
        const hashMatches = crypto_1.default.timingSafeEqual(Buffer.from(record.otpHash, 'hex'), Buffer.from(computedHash, 'hex'));
        if (hashMatches) {
            // Sahi OTP: Atomically consume and return
            record.attempts += 1;
            record.consumedAt = now;
            if (record.phoneE164)
                this.testOtps.delete(record.phoneE164);
            if (record.userId)
                this.testOtps.delete(`user:${record.userId}`);
            return {
                success: true,
                phoneE164: record.phoneE164,
                channel: record.channel
            };
        }
        else {
            // Galat OTP: Increment attempt counter, do not consume unless max attempts reached
            record.attempts += 1;
            if (record.attempts > record.maxAttempts) {
                record.consumedAt = now;
                if (record.phoneE164)
                    this.testOtps.delete(record.phoneE164);
                if (record.userId)
                    this.testOtps.delete(`user:${record.userId}`);
                throw new Error('Too many failed attempts. Please request a new OTP.');
            }
            throw new Error('Invalid verification code');
        }
    }
    // ─── Test Helpers ──────────────────────────────────────────────────────────
    getRecordForTest(phoneOrUserId) {
        const rec = this.testOtps.get(phoneOrUserId) || this.testOtps.get(`user:${phoneOrUserId}`);
        if (!rec || rec.consumedAt !== null || rec.attempts >= rec.maxAttempts)
            return undefined;
        rec.mobileNumber = rec.phoneE164;
        return rec;
    }
    setRecordForTest(phoneOrUserId, record) {
        const fullRecord = {
            id: record.id || crypto_1.default.randomUUID(),
            userId: record.userId,
            phoneE164: record.phoneE164 || '+919876543210',
            otpHash: record.otpHash || '',
            salt: record.salt || 'salt',
            channel: record.channel || 'SMS',
            attempts: record.attempts ?? 0,
            maxAttempts: record.maxAttempts ?? 5,
            expiresAt: record.expiresAt ?? (Date.now() + 300000),
            lastSentAt: record.lastSentAt ?? Date.now(),
            consumedAt: record.consumedAt ?? null,
            createdAt: record.createdAt ?? Date.now()
        };
        this.testOtps.set(phoneOrUserId, fullRecord);
        if (record.userId) {
            this.testOtps.set(`user:${record.userId}`, fullRecord);
        }
    }
    clearTestStore() {
        this.testOtps.clear();
        this.testRateLimits.clear();
    }
}
exports.OtpStorageService = OtpStorageService;
exports.otpStorageService = new OtpStorageService();
