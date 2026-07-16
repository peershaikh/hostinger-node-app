import express from 'express';
import { paymentController } from '../controllers/paymentController';
import { requireAuth } from '../middleware/authMiddleware';

const router = express.Router();

// PHASE_4C837 P0-005: Payment upgrade routes require verified JWT + ownership checks in controller
// LEGACY: Unused in Beta. These were the old Razorpay routes.
router.post('/create-order', requireAuth, paymentController.createOrder);
router.post('/webhook', paymentController.webhook);
router.post('/verify-signature', requireAuth, paymentController.verifySignature);
router.get('/verify/:orderId', paymentController.verifyPayment);

export default router;
