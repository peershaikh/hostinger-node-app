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
                    safar_pro_30m: { amount: 900, duration_days: 0.0208 }, // 9 INR in paise, 30 minutes
                    safar_pro: { amount: 14900, duration_days: 30 }, // 149 INR in paise, 30 days
                    safar_pro_7d: { amount: 4900, duration_days: 7 },
                    safar_pro_30d: { amount: 14900, duration_days: 30 },
                    safar_pro_90d: { amount: 39900, duration_days: 90 }
                };
                const planInfo = PLAN_MAPPING[planType];
                if (!planInfo) {
                    return res.status(400).json({ success: false, message: 'Invalid planType' });
                }
                // Check if Razorpay is configured
                const isRazorpayConfigured = !!process.env.RAZORPAY_KEY_ID && !!process.env.RAZORPAY_KEY_SECRET;
                if (isRazorpayConfigured) {
                    try {
                        const result = await paymentService_1.paymentService.createRazorpayOrder(userId, planType, planInfo.amount);
                        return res.json(result);
                    }
                    catch (error) {
                        logger_1.winstonLogger.error(`[PAYMENT] Razorpay order creation failed: ${error.message}`);
                        return res.status(503).json({ success: false, message: 'Payment service unavailable' });
                    }
                }
                if (process.env.NODE_ENV === 'production') {
                    logger_1.winstonLogger.error('[PAYMENT] Razorpay not configured in production');
                    return res.status(503).json({ success: false, message: 'Payment gateway not configured' });
                }
                // Dev-only mock order flow
                logger_1.winstonLogger.info(`[PAYMENT] Using mock payment flow for user ${userId}, plan ${planType}`);
                const result = paymentService_1.paymentService.createOrder(userId, planType, planInfo.amount);
                return res.json(result);
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
        /**
         * POST /api/payments/verify-signature
         * Called by the client after Razorpay checkout completes.
         * Verifies HMAC signature, marks transaction SUCCESS, activates subscription.
         */
        this.verifySignature = async (req, res) => {
            try {
                const userId = req.headers['x-user-id'];
                if (!userId) {
                    return res.status(401).json({ success: false, message: 'Unauthorized' });
                }
                const { razorpay_order_id, razorpay_payment_id, razorpay_signature } = req.body;
                if (!razorpay_order_id || !razorpay_payment_id || !razorpay_signature) {
                    return res.status(400).json({ success: false, message: 'razorpay_order_id, razorpay_payment_id, and razorpay_signature are required' });
                }
                // 1. Verify HMAC signature — premium cannot activate without verified payment
                const isValid = paymentService_1.paymentService.verifyRazorpayPaymentSignature(razorpay_order_id, razorpay_payment_id, razorpay_signature);
                if (!isValid) {
                    logger_1.winstonLogger.warn(`[PAYMENT] Invalid Razorpay signature for order ${razorpay_order_id}, user ${userId}`);
                    return res.status(400).json({ success: false, message: 'Payment signature verification failed' });
                }
                // 2. Verify payment ownership before any upgrade (P0-005)
                const ownership = await paymentService_1.paymentService.assertPaymentOwnership(razorpay_order_id, userId);
                if (!ownership.ok) {
                    return res.status(ownership.httpStatus || 403).json({ success: false, message: ownership.message });
                }
                // 3. Idempotency: already activated (owner only — ownership checked above)
                if (ownership.status === 'SUCCESS') {
                    return res.json({ success: true, message: 'Already activated', alreadyActive: true });
                }
                // 4. Activate subscription via the webhook processor (reuse existing logic)
                const fakeWebhookPayload = {
                    event: 'payment.captured',
                    payload: {
                        payment: {
                            entity: {
                                id: razorpay_payment_id,
                                order_id: razorpay_order_id
                            }
                        }
                    }
                };
                const activationResult = await paymentService_1.paymentService.processRazorpayWebhook(`client_verify_${Date.now()}`, fakeWebhookPayload);
                if (!activationResult.success) {
                    logger_1.winstonLogger.error(`[PAYMENT] Activation failed for order ${razorpay_order_id}, user ${userId}: ${activationResult.message}`);
                    return res.status(500).json({
                        success: false,
                        message: activationResult.message || 'Payment activation failed',
                    });
                }
                logger_1.winstonLogger.info(`[PAYMENT] Signature verified + subscription activated for order ${razorpay_order_id}, user ${userId}`);
                return res.json({ success: true, message: 'Payment verified and plan activated', plan: ownership.plan });
            }
            catch (error) {
                logger_1.winstonLogger.error(`[PAYMENT] verifySignature error: ${error.message}`);
                res.status(500).json({ success: false, message: error.message });
            }
        };
        this.webhook = async (req, res) => {
            try {
                const rawPayload = JSON.stringify(req.body);
                const razorpaySignature = req.headers['x-razorpay-signature'];
                const mockSignature = req.headers['x-payment-signature'];
                // Razorpay production webhook — signature required and verified
                if (razorpaySignature) {
                    if (!paymentService_1.paymentService.verifyRazorpayWebhookSignature(rawPayload, razorpaySignature)) {
                        logger_1.winstonLogger.warn('[PAYMENT] Razorpay webhook rejected: invalid signature');
                        return res.status(401).json({ success: false, message: 'Invalid signature' });
                    }
                    const payloadHash = crypto_1.default.createHash('sha256').update(rawPayload).digest('hex');
                    const result = await paymentService_1.paymentService.processRazorpayWebhook(payloadHash, req.body);
                    if (result.success) {
                        return res.status(200).send('OK');
                    }
                    return res.status(500).json(result);
                }
                // Dev-only signed mock webhook (never enabled in production by default)
                const mockWebhookEnabled = process.env.ALLOW_MOCK_PAYMENT_WEBHOOK === 'true' &&
                    !!process.env.PAYMENT_MOCK_WEBHOOK_SECRET;
                if (mockWebhookEnabled && mockSignature) {
                    if (!paymentService_1.paymentService.verifyMockWebhookSignature(rawPayload, mockSignature)) {
                        logger_1.winstonLogger.warn('[PAYMENT] Mock webhook rejected: invalid signature');
                        return res.status(401).json({ success: false, message: 'Invalid signature' });
                    }
                    const result = paymentService_1.paymentService.processWebhook(req.body);
                    if (result.success) {
                        return res.status(200).send('OK');
                    }
                    return res.status(400).json(result);
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
