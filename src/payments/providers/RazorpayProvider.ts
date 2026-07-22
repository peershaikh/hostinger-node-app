import crypto from 'crypto';
import Razorpay from 'razorpay';
import { winstonLogger } from '../../middleware/logger';
import { IPaymentProvider, OrderResult, WebhookResult } from './IPaymentProvider';

export class RazorpayProvider implements IPaymentProvider {
    public providerName = 'razorpay';
    private razorpayInstance: any;

    constructor() {
        this.razorpayInstance = process.env.RAZORPAY_KEY_ID && process.env.RAZORPAY_KEY_SECRET 
            ? new Razorpay({
                key_id: process.env.RAZORPAY_KEY_ID,
                key_secret: process.env.RAZORPAY_KEY_SECRET,
            }) 
            : null;
    }

    public async createOrder(userId: string, plan: string, amount: number): Promise<OrderResult> {
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
        } catch (error: any) {
            winstonLogger.error(`[RAZORPAY] Order creation failed: ${error.message}`);
            throw new Error("Payment gateway order creation failed");
        }
    }

    public verifyPaymentSignature(orderId: string, paymentId: string, signature: string): boolean {
        if (!process.env.RAZORPAY_KEY_SECRET) {
            throw new Error("Razorpay secret not configured");
        }

        const generatedSignature = crypto
            .createHmac('sha256', process.env.RAZORPAY_KEY_SECRET)
            .update(orderId + "|" + paymentId)
            .digest('hex');
            
        return generatedSignature === signature;
    }

    private safeCompareHex(expected: string, actual: string): boolean {
        if (!expected || !actual || expected.length !== actual.length) {
            return false;
        }
        try {
            return crypto.timingSafeEqual(Buffer.from(expected, 'hex'), Buffer.from(actual, 'hex'));
        } catch {
            return expected === actual;
        }
    }

    public verifyWebhookSignature(payload: string, signature: string, headers?: any): boolean {
        const webhookSecret = process.env.RAZORPAY_WEBHOOK_SECRET;
        if (!webhookSecret || !signature) {
            return false;
        }

        const expectedSignature = crypto
            .createHmac('sha256', webhookSecret)
            .update(payload)
            .digest('hex');

        return this.safeCompareHex(expectedSignature, signature);
    }

    public parseWebhook(payload: any): WebhookResult {
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
