"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.paymentService = void 0;
const fs_1 = __importDefault(require("fs"));
const logger_1 = require("../middleware/logger");
const path_1 = __importDefault(require("path"));
const crypto_1 = __importDefault(require("crypto"));
const authService_1 = require("./authService");
const referralService_1 = require("./referralService");
const razorpay_1 = __importDefault(require("razorpay"));
const supabase_1 = require("../config/supabase");
const TXN_FILE = path_1.default.join(__dirname, '../../data/transactions.json');
const razorpayInstance = process.env.RAZORPAY_KEY_ID && process.env.RAZORPAY_KEY_SECRET
    ? new razorpay_1.default({
        key_id: process.env.RAZORPAY_KEY_ID,
        key_secret: process.env.RAZORPAY_KEY_SECRET,
    })
    : null;
class PaymentService {
    constructor() {
        this.transactions = [];
        this.loadTransactions();
    }
    loadTransactions() {
        try {
            if (fs_1.default.existsSync(TXN_FILE)) {
                const data = fs_1.default.readFileSync(TXN_FILE, 'utf-8');
                this.transactions = JSON.parse(data);
            }
            else {
                this.transactions = [];
                this.saveTransactions();
            }
        }
        catch (e) {
            logger_1.winstonLogger.error("Error loading transactions:", e);
        }
    }
    saveTransactions() {
        try {
            fs_1.default.writeFileSync(TXN_FILE, JSON.stringify(this.transactions, null, 2));
        }
        catch (e) {
            logger_1.winstonLogger.error("Error saving transactions:", e);
        }
    }
    createOrder(userId, plan, amount) {
        const orderId = `order_${crypto_1.default.randomUUID().replace(/-/g, '').substring(0, 12)}`;
        const txn = {
            id: `txn_${crypto_1.default.randomUUID()}`,
            userId,
            orderId,
            amount,
            plan,
            status: 'PENDING',
            createdAt: new Date().toISOString(),
            gateway: 'cashfree_mock'
        };
        this.transactions.push(txn);
        this.saveTransactions();
        // MOCK API returns a session id
        return {
            success: true,
            orderId: orderId,
            order_id: orderId,
            payment_session_id: `session_${crypto_1.default.randomUUID()}`
        };
    }
    /**
     * Internal lookup — includes user_id for payment-ownership checks (P0-005).
     * Not exposed on public GET /verify/:orderId contract.
     */
    async getOrderRecord(orderId) {
        if ((0, supabase_1.isSupabaseConfigured)()) {
            const { data, error } = await supabase_1.supabase
                .from('payment_transactions')
                .select('status, plan_id, user_id')
                .eq('order_id', orderId)
                .maybeSingle();
            if (!error && data) {
                return {
                    success: true,
                    userId: data.user_id,
                    status: data.status,
                    plan: data.plan_id,
                };
            }
        }
        const txn = this.transactions.find(t => t.orderId === orderId);
        if (!txn) {
            return { success: false, message: 'Order not found' };
        }
        return {
            success: true,
            userId: txn.userId,
            status: txn.status,
            plan: txn.plan,
        };
    }
    /**
     * PHASE_4C837 P0-005: Premium activation requires the order to belong to the caller.
     */
    async assertPaymentOwnership(orderId, userId) {
        const record = await this.getOrderRecord(orderId);
        if (!record.success) {
            return { ok: false, message: 'Transaction not found', httpStatus: 404 };
        }
        if (record.userId !== userId) {
            logger_1.winstonLogger.warn(`[PAYMENT] Ownership mismatch for order ${orderId}: expected ${record.userId}, got ${userId}`);
            return {
                ok: false,
                message: 'Payment does not belong to this account',
                httpStatus: 403,
            };
        }
        return { ok: true, status: record.status, plan: record.plan };
    }
    async verifyPayment(orderId) {
        const record = await this.getOrderRecord(orderId);
        if (!record.success) {
            return { success: false, message: record.message || 'Order not found' };
        }
        return {
            success: true,
            status: record.status,
            plan: record.plan,
            source: (0, supabase_1.isSupabaseConfigured)() ? 'razorpay' : 'mock',
        };
    }
    safeCompareHex(expected, actual) {
        if (!expected || !actual || expected.length !== actual.length) {
            return false;
        }
        try {
            return crypto_1.default.timingSafeEqual(Buffer.from(expected, 'hex'), Buffer.from(actual, 'hex'));
        }
        catch {
            return expected === actual;
        }
    }
    /**
     * Dev/mock webhook HMAC — only used when ALLOW_MOCK_PAYMENT_WEBHOOK=true
     * and PAYMENT_MOCK_WEBHOOK_SECRET is configured.
     */
    verifyMockWebhookSignature(payload, signature) {
        const secret = process.env.PAYMENT_MOCK_WEBHOOK_SECRET;
        if (!secret || !signature) {
            return false;
        }
        const expectedSignature = crypto_1.default
            .createHmac('sha256', secret)
            .update(payload)
            .digest('hex');
        return this.safeCompareHex(expectedSignature, signature);
    }
    processWebhook(payload) {
        const { order_id, payment_status, payment_id } = payload.data || {};
        if (!order_id)
            return { success: false, message: 'Invalid payload' };
        const txn = this.transactions.find(t => t.orderId === order_id);
        if (!txn)
            return { success: false, message: 'Order not found' };
        // Idempotency Check
        if (txn.status === 'SUCCESS') {
            logger_1.winstonLogger.info(`[Webhook] Duplicate webhook for order ${order_id}. Ignoring.`);
            return { success: true, message: 'Already processed' }; // Return 200 to gateway
        }
        txn.status = payment_status;
        if (payment_id)
            txn.paymentId = payment_id;
        this.saveTransactions();
        if (payment_status === 'SUCCESS') {
            // Upgrade user
            const PLAN_DURATION_MAPPING = {
                safar_pro_30m: 30,
                safar_pro: 30 * 24 * 60,
                safar_pro_7d: 7 * 24 * 60,
                safar_pro_30d: 30 * 24 * 60,
                safar_pro_90d: 90 * 24 * 60
            };
            const durationMinutes = PLAN_DURATION_MAPPING[txn.plan] || 30;
            authService_1.authService.upgradeToPro(txn.userId, txn.plan, durationMinutes, 'payment');
            // Referral purchase attribution (non-blocking)
            (0, referralService_1.attributePurchase)(txn.userId, txn.orderId, txn.plan, txn.amount / 100).catch((err) => logger_1.winstonLogger.error(`[WEBHOOK_MOCK] attributePurchase failed: ${err.message}`));
        }
        return { success: true };
    }
    // --- RAZORPAY SERVICE LAYER ---
    async createRazorpayOrder(userId, plan, amount) {
        if (!razorpayInstance) {
            throw new Error("Razorpay is not configured");
        }
        const options = {
            amount: amount, // amount in the smallest currency unit
            currency: "INR",
            receipt: `rcpt_${userId.substring(0, 10)}_${Date.now()}`
        };
        try {
            const order = await razorpayInstance.orders.create(options);
            if ((0, supabase_1.isSupabaseConfigured)()) {
                const { error } = await supabase_1.supabase.from('payment_transactions').insert([{
                        user_id: userId,
                        provider: 'razorpay',
                        order_id: order.id,
                        amount: amount / 100, // store in rupees
                        currency: 'INR',
                        status: 'PENDING',
                        plan_id: plan
                    }]);
                if (error) {
                    logger_1.winstonLogger.error(`[RAZORPAY] Failed to persist order to Supabase: ${error.message}`);
                }
            }
            return {
                success: true,
                orderId: order.id,
                order_id: order.id,
                amount: order.amount,
                currency: order.currency,
                razorpayKey: process.env.RAZORPAY_KEY_ID
            };
        }
        catch (error) {
            logger_1.winstonLogger.error(`[RAZORPAY] Order creation failed: ${error.message}`);
            throw new Error("Payment gateway order creation failed");
        }
    }
    verifyRazorpayPaymentSignature(orderId, paymentId, signature) {
        if (!process.env.RAZORPAY_KEY_SECRET) {
            throw new Error("Razorpay secret not configured");
        }
        const generatedSignature = crypto_1.default
            .createHmac('sha256', process.env.RAZORPAY_KEY_SECRET)
            .update(orderId + "|" + paymentId)
            .digest('hex');
        return generatedSignature === signature;
    }
    verifyRazorpayWebhookSignature(payload, signature) {
        const webhookSecret = process.env.RAZORPAY_WEBHOOK_SECRET;
        if (!webhookSecret || !signature) {
            return false;
        }
        const expectedSignature = crypto_1.default
            .createHmac('sha256', webhookSecret)
            .update(payload)
            .digest('hex');
        return this.safeCompareHex(expectedSignature, signature);
    }
    async processRazorpayWebhook(payloadHash, payload) {
        if (!(0, supabase_1.isSupabaseConfigured)()) {
            return { success: false, message: 'Database not configured' };
        }
        const event = payload.event;
        const paymentEntity = payload.payload?.payment?.entity;
        const orderId = paymentEntity?.order_id;
        if (!event || !orderId) {
            return { success: false, message: 'Invalid payload structure' };
        }
        // 1. Idempotency Check
        const { error: insertError } = await supabase_1.supabase.from('payment_webhooks').insert([{
                provider: 'razorpay',
                event_type: event,
                payload_hash: payloadHash,
                processed: true
            }]);
        if (insertError) {
            if (insertError.code === '23505') {
                logger_1.winstonLogger.info(`[WEBHOOK] Duplicate webhook ignored for hash ${payloadHash}`);
                return { success: true, message: 'Duplicate webhook', duplicate: true }; // Ack to provider
            }
            logger_1.winstonLogger.error(`[WEBHOOK] Failed to persist webhook: ${insertError.message}`);
            return { success: false, message: 'Database error' };
        }
        // 2. Update Transaction
        if (event === 'payment.captured') {
            const { data: txnData, error: fetchError } = await supabase_1.supabase
                .from('payment_transactions')
                .select('user_id, plan_id, status')
                .eq('order_id', orderId)
                .single();
            if (fetchError || !txnData) {
                logger_1.winstonLogger.error(`[WEBHOOK] Failed to fetch transaction ${orderId}: ${fetchError?.message}`);
                return { success: false, message: 'Transaction not found' };
            }
            if (txnData.status !== 'SUCCESS') {
                const { error: updateError } = await supabase_1.supabase
                    .from('payment_transactions')
                    .update({ status: 'SUCCESS', payment_id: paymentEntity.id, updated_at: new Date().toISOString() })
                    .eq('order_id', orderId);
                if (updateError) {
                    logger_1.winstonLogger.error(`[WEBHOOK] Failed to update transaction ${orderId}: ${updateError.message}`);
                    return { success: false, message: 'Failed to update transaction' };
                }
                // 3. Activate Subscription
                const PLAN_MAPPING = {
                    safar_pro_30m: 30,
                    safar_pro: 30 * 24 * 60,
                    safar_pro_7d: 7 * 24 * 60,
                    safar_pro_30d: 30 * 24 * 60,
                    safar_pro_90d: 90 * 24 * 60
                };
                const durationMinutes = PLAN_MAPPING[txnData.plan_id] || 30 * 24 * 60;
                await authService_1.authService.upgradeToPro(txnData.user_id, txnData.plan_id, durationMinutes, 'payment');
                // Referral purchase attribution (non-blocking)
                (0, referralService_1.attributePurchase)(txnData.user_id, orderId, txnData.plan_id, paymentEntity?.amount ? paymentEntity.amount / 100 : 0).catch((err) => logger_1.winstonLogger.error(`[WEBHOOK_RAZORPAY] attributePurchase failed: ${err.message}`));
            }
        }
        return { success: true, message: 'Webhook processed' };
    }
}
exports.paymentService = new PaymentService();
