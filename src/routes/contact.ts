import { Router } from 'express';
import rateLimit from 'express-rate-limit';
import { contactController } from '../controllers/contactController';

const router = Router();

// Anti-spam limiter: maximum 5 messages per 15 minutes per IP
const contactLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 5,
  standardHeaders: true,
  legacyHeaders: false,
  validate: false,
  message: {
    success: false,
    error: 'Too many messages sent from this device. Please wait a few minutes before trying again.',
  },
});

router.post('/', contactLimiter as any, contactController.submit);

export default router;
