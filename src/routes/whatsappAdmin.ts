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

import { Router } from 'express';
import { requireAuth } from '../middleware/authMiddleware';
import { requireAdmin } from '../middleware/adminAuth';
import { adminLimiter } from '../middleware/rateLimiter';
import { whatsappAdminController } from '../controllers/whatsappAdminController';
import { asyncHandler } from '../middleware/errorHandler';

const router = Router();

// Apply auth, admin authorization, and rate limiting to all endpoints in this router
router.use(requireAuth);
router.use(requireAdmin as any);
router.use(adminLimiter as any);

// 1. Conversation List: supports both / and /conversations
router.get(
  ['/', '/conversations'],
  asyncHandler(whatsappAdminController.listConversations.bind(whatsappAdminController))
);

// 2. Message History: supports both /:conversationId/messages and /conversations/:conversationId/messages
router.get(
  ['/:conversationId/messages', '/conversations/:conversationId/messages'],
  asyncHandler(whatsappAdminController.getMessageHistory.bind(whatsappAdminController))
);

// 3. Conversation Detail: supports both /:conversationId and /conversations/:conversationId
router.get(
  ['/:conversationId', '/conversations/:conversationId'],
  asyncHandler(whatsappAdminController.getConversation.bind(whatsappAdminController))
);

// 4. Assignment: supports both /:conversationId/assignment and /conversations/:conversationId/assignment
router.patch(
  ['/:conversationId/assignment', '/conversations/:conversationId/assignment'],
  asyncHandler(whatsappAdminController.updateAssignment.bind(whatsappAdminController))
);

// 5. Admin Message Send: supports both /:conversationId/messages and /conversations/:conversationId/messages
router.post(
  ['/:conversationId/messages', '/conversations/:conversationId/messages'],
  asyncHandler(whatsappAdminController.sendAdminMessage.bind(whatsappAdminController))
);

export default router;
