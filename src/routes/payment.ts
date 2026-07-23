import express from 'express';
import { paymentController } from '../controllers/paymentController';
import { requireAuth } from '../middleware/authMiddleware';
import { paymentLimiter } from '../middleware/rateLimiter';
import { validateBody } from '../middleware/validateSchema';
import { createOrderSchema } from '../schemas/appSchemas';

const router = express.Router();

// PHASE_4C837 P0-005: Payment upgrade routes require verified JWT + ownership checks in controller
// PHASE_5B P2: Dedicated per-user payment rate limiter attached to create-order endpoint
// PHASE_5B P3: Strict Zod schema validation attached to reject unknown properties & amount tampering
router.post('/create-order', requireAuth, paymentLimiter, validateBody(createOrderSchema), paymentController.createOrder);
router.post('/webhook', paymentController.webhook);
router.post('/verify-signature', requireAuth, paymentController.verifySignature);
router.get('/verify/:orderId', paymentController.verifyPayment);

export default router;


