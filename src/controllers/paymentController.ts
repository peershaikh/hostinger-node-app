import { Request, Response } from 'express';
import { paymentService } from '../services/paymentService';
import crypto from 'crypto';
import { winstonLogger } from '../middleware/logger';

// LEGACY: Unused in Beta. These were the old Razorpay routes.
export class PaymentController {
    createOrder = async (req: Request, res: Response) => {
        try {
            const userId = req.headers['x-user-id'] as string;
            if (!userId) {
                return res.status(401).json({ success: false, message: 'Unauthorized' });
            }

            const planType = req.body.planType || req.body.plan;
            const { amount, currency, duration, price, gateway } = req.body;
            
            if (amount || currency || duration || price) {
                return res.status(400).json({ success: false, message: 'Client must not provide pricing data' });
            }

            if (!planType) {
                return res.status(400).json({ success: false, message: 'planType is required' });
            }

            const PLAN_MAPPING: Record<string, { amount: number; duration_days: number }> = {
                safar_pro_30m: { amount: 900, duration_days: 0.0208 }, 
                safar_pro: { amount: 14900, duration_days: 30 },       
                safar_pro_7d: { amount: 4900, duration_days: 7 },
                safar_pro_30d: { amount: 14900, duration_days: 30 },
                safar_pro_90d: { amount: 39900, duration_days: 90 }
            };

            const planInfo = PLAN_MAPPING[planType];
            if (!planInfo) {
                return res.status(400).json({ success: false, message: 'Invalid planType' });
            }

            const providerName = process.env.PAYMENT_PROVIDER || 'razorpay';
            const isProviderConfigured = providerName === 'cashfree' 
                ? !!process.env.CASHFREE_CLIENT_ID
                : !!process.env.RAZORPAY_KEY_ID;

            if (isProviderConfigured) {
                try {
                    const result = await paymentService.createProviderOrder(userId, planType, planInfo.amount, providerName);
                    return res.json({
                        ...result,
                        provider: providerName,
                        paymentSessionId: result.payment_session_id 
                    });
                } catch (error: any) {
                    winstonLogger.error(`[PAYMENT] Order creation failed: ${error.message}`);
                    return res.status(503).json({ success: false, message: 'Payment service unavailable' });
                }
            }

            if (process.env.NODE_ENV === 'production') {
                winstonLogger.error('[PAYMENT] Gateway not configured in production');
                return res.status(503).json({ success: false, message: 'Payment gateway not configured' });
            }

            winstonLogger.error('[PAYMENT] Gateway not configured. Mock flow disabled.');
            return res.status(501).json({ success: false, message: 'Payment gateway not configured' });
        } catch (error: any) {
            res.status(500).json({ success: false, message: error.message });
        }
    };

    verifyPayment = async (req: Request, res: Response) => {
        try {
            const { orderId } = req.params;
            if (!orderId) {
                return res.status(400).json({ success: false, message: 'orderId is required' });
            }

            const result = await paymentService.verifyPayment(orderId);
            res.json(result);
        } catch (error: any) {
            res.status(500).json({ success: false, message: error.message });
        }
    };

    verifySignature = async (req: Request, res: Response) => {
        try {
            const userId = req.headers['x-user-id'] as string;
            if (!userId) {
                return res.status(401).json({ success: false, message: 'Unauthorized' });
            }

            const { razorpay_order_id, razorpay_payment_id, razorpay_signature, cf_order_id } = req.body;
            const orderId = razorpay_order_id || cf_order_id;

            if (!orderId) {
                return res.status(400).json({ success: false, message: 'order_id is required' });
            }

            const providerName = razorpay_order_id ? 'razorpay' : 'cashfree';

            if (providerName === 'razorpay') {
                const isValid = paymentService.verifyProviderPaymentSignature(orderId, razorpay_payment_id, razorpay_signature, providerName);
                if (!isValid) {
                    winstonLogger.warn(`[PAYMENT] Invalid signature for order ${orderId}, user ${userId}`);
                    return res.status(400).json({ success: false, message: 'Payment signature verification failed' });
                }
            }

            const ownership = await paymentService.assertPaymentOwnership(orderId, userId);
            if (!ownership.ok) {
                return res.status(ownership.httpStatus || 403).json({ success: false, message: ownership.message });
            }

            if (ownership.status === 'SUCCESS') {
                return res.json({ success: true, message: 'Already activated', alreadyActive: true });
            }

            if (providerName === 'razorpay') {
                const fakeWebhookPayload = {
                    event: 'payment.captured',
                    payload: { payment: { entity: { id: razorpay_payment_id, order_id: orderId } } }
                };
                const activationResult = await paymentService.processProviderWebhook(
                    `client_verify_${Date.now()}`,
                    fakeWebhookPayload,
                    providerName
                );

                if (!activationResult.success) {
                    winstonLogger.error(`[PAYMENT] Activation failed for order ${orderId}, user ${userId}: ${activationResult.message}`);
                    return res.status(500).json({ success: false, message: activationResult.message || 'Payment activation failed' });
                }
            }

            winstonLogger.info(`[PAYMENT] Client verify success for order ${orderId}, user ${userId}`);
            return res.json({ success: true, message: 'Payment verified and plan activated', plan: ownership.plan });
        } catch (error: any) {
            winstonLogger.error(`[PAYMENT] verifySignature error: ${error.message}`);
            res.status(500).json({ success: false, message: error.message });
        }
    };

    webhook = async (req: Request, res: Response) => {
        try {
            let rawPayload: string;
            let jsonBody: any;

            if (Buffer.isBuffer(req.body)) {
                rawPayload = req.body.toString('utf8');
                jsonBody = JSON.parse(rawPayload);
            } else {
                rawPayload = (req as any).rawBody || JSON.stringify(req.body);
                jsonBody = req.body;
            }
            
            const razorpaySignature = req.headers['x-razorpay-signature'] as string | undefined;
            const cashfreeSignature = req.headers['x-webhook-signature'] as string | undefined;

            if (cashfreeSignature) {
                if (!paymentService.verifyProviderWebhookSignature(rawPayload, cashfreeSignature, req.headers, 'cashfree')) {
                    winstonLogger.warn('[PAYMENT] Cashfree webhook rejected: invalid signature');
                    return res.status(401).json({ success: false, message: 'Invalid signature' });
                }
                const payloadHash = crypto.createHash('sha256').update(rawPayload).digest('hex');
                const result = await paymentService.processProviderWebhook(payloadHash, jsonBody, 'cashfree');
                return result.success ? res.status(200).send('OK') : res.status(500).json(result);
            }

            if (razorpaySignature) {
                if (!paymentService.verifyProviderWebhookSignature(rawPayload, razorpaySignature, req.headers, 'razorpay')) {
                    winstonLogger.warn('[PAYMENT] Razorpay webhook rejected: invalid signature');
                    return res.status(401).json({ success: false, message: 'Invalid signature' });
                }
                const payloadHash = crypto.createHash('sha256').update(rawPayload).digest('hex');
                const result = await paymentService.processProviderWebhook(payloadHash, jsonBody, 'razorpay');
                return result.success ? res.status(200).send('OK') : res.status(500).json(result);
            }

            winstonLogger.warn('[PAYMENT] Webhook rejected: missing or invalid signature');
            return res.status(401).json({ success: false, message: 'Invalid signature' });
        } catch (error: any) {
            res.status(500).json({ success: false, message: error.message });
        }
    };
}

export const paymentController = new PaymentController();
