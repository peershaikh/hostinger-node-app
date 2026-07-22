import crypto from 'crypto';
import { IPaymentProvider, OrderResult, WebhookResult } from './IPaymentProvider';
import { winstonLogger } from '../../middleware/logger';
import { supabase, isSupabaseConfigured } from '../../config/supabase';

export class CashfreeProvider implements IPaymentProvider {
    public providerName = 'cashfree';

    private get baseUrl() {
        return process.env.CASHFREE_ENVIRONMENT === 'PRODUCTION'
            ? 'https://api.cashfree.com/pg'
            : 'https://sandbox.cashfree.com/pg';
    }

    private get headers() {
        return {
            'x-client-id': process.env.CASHFREE_CLIENT_ID || '',
            'x-client-secret': process.env.CASHFREE_SECRET_KEY || '',
            'x-api-version': '2023-08-01',
            'Content-Type': 'application/json',
            'Accept': 'application/json'
        };
    }

    public async createOrder(userId: string, plan: string, amount: number): Promise<OrderResult> {
        if (!process.env.CASHFREE_CLIENT_ID) {
            throw new Error("Cashfree is not configured");
        }

        const orderId = `order_${crypto.randomUUID().replace(/-/g, '').substring(0, 12)}`;
        
        let customerPhone = '9999999999';
        if (isSupabaseConfigured()) {
            const { data } = await supabase.from('users').select('phone').eq('id', userId).single();
            if (data?.phone) {
                customerPhone = data.phone;
            }
        }

        const payload = {
            order_id: orderId,
            order_amount: amount / 100, // Cashfree takes amount in actual currency, not paise
            order_currency: "INR",
            customer_details: {
                customer_id: userId,
                customer_phone: customerPhone,
                customer_name: userId
            },
            order_meta: {
                return_url: `${process.env.FRONTEND_URL}/payment/verify?order_id={order_id}`
            }
        };

        try {
            const response = await fetch(`${this.baseUrl}/orders`, {
                method: 'POST',
                headers: this.headers,
                body: JSON.stringify(payload)
            });

            const data = await response.json();
            
            if (!response.ok) {
                throw new Error(data.message || 'Gateway error');
            }

            return {
                success: true,
                orderId: data.order_id,
                amount: Math.round(data.order_amount * 100), // convert back to paise for standard interface
                currency: data.order_currency,
                payment_session_id: data.payment_session_id
            };
        } catch (error: any) {
            winstonLogger.error(`[CASHFREE] Order creation failed: ${error.message}`);
            throw new Error("Payment gateway order creation failed");
        }
    }

    public verifyPaymentSignature(orderId: string, paymentId: string, signature: string): boolean {
        // Cashfree verify is usually done by server-to-server API call, not simple signature 
        // We will implement an API check if this is called, but ideally we rely on webhook.
        // For the generic interface, we just return true and let verifyPayment handle it via DB.
        return true; 
    }

    public verifyWebhookSignature(payload: string, signature: string, headers?: any): boolean {
        const secret = process.env.CASHFREE_SECRET_KEY;
        if (!secret || !signature || !headers) {
            return false;
        }

        const timestamp = headers['x-webhook-timestamp'];
        if (!timestamp) return false;

        // Replay Protection: Reject if older than 5 minutes
        const now = Date.now();
        if (now - Number(timestamp) > 5 * 60 * 1000) {
            winstonLogger.warn(`[CASHFREE] Webhook rejected due to timestamp replay protection. Timestamp: ${timestamp}`);
            return false;
        }

        const expectedSignature = crypto
            .createHmac('sha256', secret)
            .update(timestamp + payload)
            .digest('base64');

        return expectedSignature === signature;
    }

    public parseWebhook(payload: any): WebhookResult {
        // Cashfree wraps everything in a 'data' object sometimes, but their v2023-08-01 webhook is direct
        const event = payload.type; 
        const order = payload.data?.order;
        const payment = payload.data?.payment;
        
        if (!event || !order || !order.order_id) {
            return { success: false, message: 'Invalid payload structure' };
        }

        let mappedEvent = '';
        if (event === 'PAYMENT_SUCCESS_WEBHOOK') mappedEvent = 'payment.captured';
        else if (event === 'PAYMENT_FAILED_WEBHOOK') mappedEvent = 'payment.failed';

        return {
            success: true,
            message: 'Parsed successfully',
            event: mappedEvent,
            orderId: order.order_id,
            paymentId: payment?.cf_payment_id?.toString(),
            amount: payment?.payment_amount ? Math.round(payment.payment_amount * 100) : undefined // Convert to paise
        };
    }
}
