"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const express_1 = __importDefault(require("express"));
const paymentController_1 = require("../controllers/paymentController");
const authMiddleware_1 = require("../middleware/authMiddleware");
const rateLimiter_1 = require("../middleware/rateLimiter");
const validateSchema_1 = require("../middleware/validateSchema");
const appSchemas_1 = require("../schemas/appSchemas");
const router = express_1.default.Router();
// PHASE_4C837 P0-005: Payment upgrade routes require verified JWT + ownership checks in controller
// PHASE_5B P2: Dedicated per-user payment rate limiter attached to create-order endpoint
// PHASE_5B P3: Strict Zod schema validation attached to reject unknown properties & amount tampering
router.post('/create-order', authMiddleware_1.requireAuth, rateLimiter_1.paymentLimiter, (0, validateSchema_1.validateBody)(appSchemas_1.createOrderSchema), paymentController_1.paymentController.createOrder);
router.post('/webhook', paymentController_1.paymentController.webhook);
router.post('/verify-signature', authMiddleware_1.requireAuth, paymentController_1.paymentController.verifyPayment);
router.get('/verify/:orderId', paymentController_1.paymentController.verifyPayment);
exports.default = router;
