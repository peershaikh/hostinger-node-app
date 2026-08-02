"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.paymentController = exports.PaymentController = void 0;
const paymentService_1 = require("../services/paymentService");
const crypto_1 = __importDefault(require("crypto"));
const logger_1 = require("../middleware/logger");
// LEGACY: Unused in Beta. These were the old Razorpay routes.
class PaymentController {
    constructor() {
        this.createOrder = async (req, res) => {
            try {
                const userId = req.headers['x-user-id'];
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
                const PLAN_MAPPING = {
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
                        const result = await paymentService_1.paymentService.createProviderOrder(userId, planType, planInfo.amount, providerName);
                        return res.json({
                            ...result,
                            provider: providerName,
                            paymentSessionId: result.payment_session_id
                        });
                    }
                    catch (error) {
                        logger_1.winstonLogger.error(`[PAYMENT] Order creation failed: ${error.message}`);
                        return res.status(503).json({ success: false, message: 'Payment service unavailable' });
                    }
                }
                if (process.env.NODE_ENV === 'production') {
                    logger_1.winstonLogger.error('[PAYMENT] Gateway not configured in production');
                    return res.status(503).json({ success: false, message: 'Payment gateway not configured' });
                }
                logger_1.winstonLogger.error('[PAYMENT] Gateway not configured. Mock flow disabled.');
                return res.status(501).json({ success: false, message: 'Payment gateway not configured' });
            }
            catch (error) {
                res.status(500).json({ success: false, message: error.message });
            }
        };
        this.verifyPayment = async (req, res) => {
            try {
                const { orderId } = req.params;
                if (!orderId) {
                    return res.status(400).json({ success: false, message: 'orderId is required' });
                }
                const result = await paymentService_1.paymentService.verifyPayment(orderId);
                res.json(result);
            }
            catch (error) {
                res.status(500).json({ success: false, message: error.message });
            }
        };
        this.verifySignature = async (req, res) => {
            try {
                const userId = req.headers['x-user-id'];
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
                    const isValid = paymentService_1.paymentService.verifyProviderPaymentSignature(orderId, razorpay_payment_id, razorpay_signature, providerName);
                    if (!isValid) {
                        logger_1.winstonLogger.warn(`[PAYMENT] Invalid signature for order ${orderId}, user ${userId}`);
                        return res.status(400).json({ success: false, message: 'Payment signature verification failed' });
                    }
                }
                const ownership = await paymentService_1.paymentService.assertPaymentOwnership(orderId, userId);
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
                    const activationResult = await paymentService_1.paymentService.processProviderWebhook(`client_verify_${Date.now()}`, fakeWebhookPayload, providerName);
                    if (!activationResult.success) {
                        logger_1.winstonLogger.error(`[PAYMENT] Activation failed for order ${orderId}, user ${userId}: ${activationResult.message}`);
                        return res.status(500).json({ success: false, message: activationResult.message || 'Payment activation failed' });
                    }
                }
                logger_1.winstonLogger.info(`[PAYMENT] Client verify success for order ${orderId}, user ${userId}`);
                return res.json({ success: true, message: 'Payment verified and plan activated', plan: ownership.plan });
            }
            catch (error) {
                logger_1.winstonLogger.error(`[PAYMENT] verifySignature error: ${error.message}`);
                res.status(500).json({ success: false, message: error.message });
            }
        };
        this.webhook = async (req, res) => {
            try {
                let rawPayload;
                let jsonBody;
                if (Buffer.isBuffer(req.body)) {
                    rawPayload = req.body.toString('utf8');
                    jsonBody = JSON.parse(rawPayload);
                }
                else {
                    rawPayload = req.rawBody || JSON.stringify(req.body);
                    jsonBody = req.body;
                }
                const razorpaySignature = req.headers['x-razorpay-signature'];
                const cashfreeSignature = req.headers['x-webhook-signature'];
                if (cashfreeSignature) {
                    if (!paymentService_1.paymentService.verifyProviderWebhookSignature(rawPayload, cashfreeSignature, req.headers, 'cashfree')) {
                        logger_1.winstonLogger.warn('[PAYMENT] Cashfree webhook rejected: invalid signature');
                        return res.status(401).json({ success: false, message: 'Invalid signature' });
                    }
                    const payloadHash = crypto_1.default.createHash('sha256').update(rawPayload).digest('hex');
                    const result = await paymentService_1.paymentService.processProviderWebhook(payloadHash, jsonBody, 'cashfree');
                    return result.success ? res.status(200).send('OK') : res.status(500).json(result);
                }
                if (razorpaySignature) {
                    if (!paymentService_1.paymentService.verifyProviderWebhookSignature(rawPayload, razorpaySignature, req.headers, 'razorpay')) {
                        logger_1.winstonLogger.warn('[PAYMENT] Razorpay webhook rejected: invalid signature');
                        return res.status(401).json({ success: false, message: 'Invalid signature' });
                    }
                    const payloadHash = crypto_1.default.createHash('sha256').update(rawPayload).digest('hex');
                    const result = await paymentService_1.paymentService.processProviderWebhook(payloadHash, jsonBody, 'razorpay');
                    return result.success ? res.status(200).send('OK') : res.status(500).json(result);
                }
                logger_1.winstonLogger.warn('[PAYMENT] Webhook rejected: missing or invalid signature');
                return res.status(401).json({ success: false, message: 'Invalid signature' });
            }
            catch (error) {
                res.status(500).json({ success: false, message: error.message });
            }
        };
    }
}
exports.PaymentController = PaymentController;
exports.paymentController = new PaymentController();
