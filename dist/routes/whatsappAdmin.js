"use strict";
/**
 * STEP 5.9I — WhatsApp Admin CRM Router
 *
 * Mounted under /whatsapp in server/src/routes/admin.ts:
 * Resulting paths:
 *   /api/admin/whatsapp/conversations
 *   /api/admin/whatsapp/conversations/:conversationId
 *   /api/admin/whatsapp/conversations/:conversationId/messages
 *   /api/admin/whatsapp/conversations/:conversationId/assignment
 *   /api/admin/whatsapp/conversations/:conversationId/messages
 *
 * Also preserves /admin mount behavior:
 *   /admin/whatsapp/...
 *
 * Protected by:
 * - requireAuth (verified Bearer JWT)
 * - requireAdmin (verified is_admin === true)
 * - adminLimiter (operational rate limiting)
 */
Object.defineProperty(exports, "__esModule", { value: true });
const express_1 = require("express");
const authMiddleware_1 = require("../middleware/authMiddleware");
const adminAuth_1 = require("../middleware/adminAuth");
const rateLimiter_1 = require("../middleware/rateLimiter");
const whatsappAdminController_1 = require("../controllers/whatsappAdminController");
const errorHandler_1 = require("../middleware/errorHandler");
const router = (0, express_1.Router)();
// Apply auth, admin authorization, and rate limiting to all endpoints in this router
router.use(authMiddleware_1.requireAuth);
router.use(adminAuth_1.requireAdmin);
router.use(rateLimiter_1.adminLimiter);
// 1. Conversation List: supports both / and /conversations
router.get(['/', '/conversations'], (0, errorHandler_1.asyncHandler)(whatsappAdminController_1.whatsappAdminController.listConversations.bind(whatsappAdminController_1.whatsappAdminController)));
// 2. Message History: supports both /:conversationId/messages and /conversations/:conversationId/messages
router.get(['/:conversationId/messages', '/conversations/:conversationId/messages'], (0, errorHandler_1.asyncHandler)(whatsappAdminController_1.whatsappAdminController.getMessageHistory.bind(whatsappAdminController_1.whatsappAdminController)));
// 3. Conversation Detail: supports both /:conversationId and /conversations/:conversationId
router.get(['/:conversationId', '/conversations/:conversationId'], (0, errorHandler_1.asyncHandler)(whatsappAdminController_1.whatsappAdminController.getConversation.bind(whatsappAdminController_1.whatsappAdminController)));
// 4. Assignment: supports both /:conversationId/assignment and /conversations/:conversationId/assignment
router.patch(['/:conversationId/assignment', '/conversations/:conversationId/assignment'], (0, errorHandler_1.asyncHandler)(whatsappAdminController_1.whatsappAdminController.updateAssignment.bind(whatsappAdminController_1.whatsappAdminController)));
// 5. Admin Message Send: supports both /:conversationId/messages and /conversations/:conversationId/messages
router.post(['/:conversationId/messages', '/conversations/:conversationId/messages'], (0, errorHandler_1.asyncHandler)(whatsappAdminController_1.whatsappAdminController.sendAdminMessage.bind(whatsappAdminController_1.whatsappAdminController)));
exports.default = router;
