"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.referralCodeSchema = exports.googleLoginSchema = exports.signupSchema = exports.loginSchema = exports.verifyOtpSchema = exports.sendOtpSchema = exports.pnrParamSchema = exports.createOrderSchema = void 0;
const zod_1 = require("zod");
// --- PAYMENT SCHEMAS ---
// Enforces strict payload validation: rejects amount, price, currency, discount, provider, status, or any unknown key.
exports.createOrderSchema = zod_1.z.object({
    planType: zod_1.z.enum(['safar_pro_30m', 'safar_pro_7d', 'safar_pro_30d', 'safar_pro_90d'])
}).strict();
// --- PNR SCHEMAS ---
// Must be exactly 10 numeric digits.
exports.pnrParamSchema = zod_1.z.object({
    pnr: zod_1.z.string().regex(/^\d{10}$/, 'PNR must be exactly 10 digits')
});
// --- AUTH SCHEMAS ---
exports.sendOtpSchema = zod_1.z.object({
    email: zod_1.z.string().email().optional(),
    phone: zod_1.z.string().regex(/^\d{10}$/).optional()
}).strict();
exports.verifyOtpSchema = zod_1.z.object({
    email: zod_1.z.string().email().optional(),
    phone: zod_1.z.string().regex(/^\d{10}$/).optional(),
    otp: zod_1.z.string().min(4).max(6)
}).strict();
exports.loginSchema = zod_1.z.object({
    email: zod_1.z.string().email(),
    password: zod_1.z.string().min(6)
}).strict();
exports.signupSchema = zod_1.z.object({
    email: zod_1.z.string().email(),
    password: zod_1.z.string().min(6),
    name: zod_1.z.string().min(2).optional()
}).strict();
exports.googleLoginSchema = zod_1.z.object({
    idToken: zod_1.z.string().min(10)
}).strict();
// --- REFERRAL SCHEMAS ---
exports.referralCodeSchema = zod_1.z.object({
    referralCode: zod_1.z.string().min(3).max(30)
}).strict();
