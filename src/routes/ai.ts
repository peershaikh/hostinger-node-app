import { Router } from 'express';
import { aiController } from '../controllers/aiController';
import rateLimit from 'express-rate-limit';

const router = Router();

/**
 * Rate limiter: 30 AI requests / minute per IP.
 * Shared between voice-parse and complaint-gen.
 * Keeps LLM API costs bounded without blocking normal usage.
 */
const aiLimiter = rateLimit({
  windowMs: 1 * 60 * 1000, // 1 minute
  max: 30,
  message: { success: false, error: 'Too many AI requests. Please wait a moment.' },
  standardHeaders: true,
  legacyHeaders: false,
}) as any;

// POST /api/ai/voice-parse
// Proxies voice transcript → LLM → { source, dest }
router.post('/voice-parse', aiLimiter, aiController.voiceParse);

// POST /api/ai/complaint-gen
// Proxies complaint prompt → LLM → tweet string
router.post('/complaint-gen', aiLimiter, aiController.complaintGen);

export default router;
