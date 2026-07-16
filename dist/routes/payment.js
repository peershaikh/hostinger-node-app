"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const express_1 = __importDefault(require("express"));
const paymentController_1 = require("../controllers/paymentController");
const authMiddleware_1 = require("../middleware/authMiddleware");
const router = express_1.default.Router();
// PHASE_4C837 P0-005: Payment upgrade routes require verified JWT + ownership checks in controller
// LEGACY: Unused in Beta. These were the old Razorpay routes.
router.post('/create-order', authMiddleware_1.requireAuth, paymentController_1.paymentController.createOrder);
router.post('/webhook', paymentController_1.paymentController.webhook);
router.post('/verify-signature', authMiddleware_1.requireAuth, paymentController_1.paymentController.verifySignature);
router.get('/verify/:orderId', paymentController_1.paymentController.verifyPayment);
exports.default = router;
