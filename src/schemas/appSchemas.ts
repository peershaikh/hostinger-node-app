import { z } from 'zod';

// --- PAYMENT SCHEMAS ---
// Enforces strict payload validation: rejects amount, price, currency, discount, provider, status, or any unknown key.
export const createOrderSchema = z.object({
    planType: z.enum(['safar_pro_30m', 'safar_pro_7d', 'safar_pro_30d', 'safar_pro_90d'])
}).strict();

// --- PNR SCHEMAS ---
// Must be exactly 10 numeric digits.
export const pnrParamSchema = z.object({
    pnr: z.string().regex(/^\d{10}$/, 'PNR must be exactly 10 digits')
});

// --- AUTH SCHEMAS ---
export const sendOtpSchema = z.object({
    email: z.string().email().optional(),
    phone: z.string().regex(/^\d{10}$/).optional()
}).strict();

export const verifyOtpSchema = z.object({
    email: z.string().email().optional(),
    phone: z.string().regex(/^\d{10}$/).optional(),
    otp: z.string().min(4).max(6)
}).strict();

export const loginSchema = z.object({
    email: z.string().email(),
    password: z.string().min(6)
}).strict();

export const signupSchema = z.object({
    email: z.string().email(),
    password: z.string().min(6),
    name: z.string().min(2).optional()
}).strict();

export const googleLoginSchema = z.object({
    idToken: z.string().min(10)
}).strict();

// --- REFERRAL SCHEMAS ---
export const referralCodeSchema = z.object({
    referralCode: z.string().min(3).max(30)
}).strict();
