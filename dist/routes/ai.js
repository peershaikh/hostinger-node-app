"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const express_1 = require("express");
const aiController_1 = require("../controllers/aiController");
const express_rate_limit_1 = __importDefault(require("express-rate-limit"));
const router = (0, express_1.Router)();
/**
 * Rate limiter: 30 AI requests / minute per IP.
 * Shared between voice-parse and complaint-gen.
 * Keeps LLM API costs bounded without blocking normal usage.
 */
const aiLimiter = (0, express_rate_limit_1.default)({
    windowMs: 1 * 60 * 1000, // 1 minute
    max: 30,
    message: { success: false, error: 'Too many AI requests. Please wait a moment.' },
    standardHeaders: true,
    legacyHeaders: false,
    validate: false, // PHASE_8.8: Suppress express-rate-limit v8 validation warnings
});
// POST /api/ai/voice-parse
// Proxies voice transcript → LLM → { source, dest }
router.post('/voice-parse', aiLimiter, aiController_1.aiController.voiceParse);
// POST /api/ai/complaint-gen
// Proxies complaint prompt → LLM → tweet string
router.post('/complaint-gen', aiLimiter, aiController_1.aiController.complaintGen);
exports.default = router;
