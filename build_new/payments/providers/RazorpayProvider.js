"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.RazorpayProvider = void 0;
const crypto_1 = __importDefault(require("crypto"));
const razorpay_1 = __importDefault(require("razorpay"));
const logger_1 = require("../../middleware/logger");
class RazorpayProvider {
    constructor() {
        this.providerName = 'razorpay';
        this.razorpayInstance = process.env.RAZORPAY_KEY_ID && process.env.RAZORPAY_KEY_SECRET
            ? new razorpay_1.default({
                key_id: process.env.RAZORPAY_KEY_ID,
                key_secret: process.env.RAZORPAY_KEY_SECRET,
            })
            : null;
    }
    async createOrder(userId, plan, amount) {
        if (!this.razorpayInstance) {
            throw new Error("Razorpay is not configured");
        }
        const options = {
            amount: amount,
            currency: "INR",
            receipt: `rcpt_${userId.substring(0, 10)}_${Date.now()}`
        };
        try {
            const order = await this.razorpayInstance.orders.create(options);
            return {
                success: true,
                orderId: order.id,
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
    verifyPaymentSignature(orderId, paymentId, signature) {
        if (!process.env.RAZORPAY_KEY_SECRET) {
            throw new Error("Razorpay secret not configured");
        }
        const generatedSignature = crypto_1.default
            .createHmac('sha256', process.env.RAZORPAY_KEY_SECRET)
            .update(orderId + "|" + paymentId)
            .digest('hex');
        return generatedSignature === signature;
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
    verifyWebhookSignature(payload, signature, headers) {
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
    parseWebhook(payload) {
        const event = payload.event;
        const paymentEntity = payload.payload?.payment?.entity;
        const orderId = paymentEntity?.order_id;
        if (!event || !orderId) {
            return { success: false, message: 'Invalid payload structure' };
        }
        return {
            success: true,
            message: 'Parsed successfully',
            event,
            orderId,
            paymentId: paymentEntity.id,
            amount: paymentEntity.amount
        };
    }
}
exports.RazorpayProvider = RazorpayProvider;
