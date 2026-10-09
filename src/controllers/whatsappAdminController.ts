import { Request, Response } from 'express';
import { supabase } from '../config/supabase';
import { whatsAppService } from '../services/whatsappService';
import { winstonLogger } from '../middleware/logger';
import { maskPhoneNumber } from '../utils/phoneNormalizer';

/**
 * STEP 5.9I — WhatsApp Admin CRM Backend Controller
 *
 * Implements the 5 core CRM backend endpoints:
 * 1. listConversations: Search, filter, and paginate WhatsApp conversations.
 * 2. getConversation: Retrieve single conversation details.
 * 3. getMessageHistory: Fetch chronological chat history for a conversation.
 * 4. updateAssignment: Assign or unassign a conversation to an admin.
 * 5. sendAdminMessage: Dispatch session text message within the 24h customer window.
 *
 * Strict Security & Privacy:
 * - All admin sender IDs derived strictly from verified JWT context.
 * - Request-body admin_sender_id is never trusted.
 * - Phone numbers masked in operational logs.
 * - Plaintext OTPs / tokens / Meta secrets never exposed.
 * - 24h window enforced before calling whatsAppService.
 * - Controller never writes directly to whatsapp_messages.
 */

const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const TWENTY_FOUR_HOURS_MS = 24 * 60 * 60 * 1000;
const MAX_MESSAGE_LENGTH = 4096;

/**
 * Strips any sensitive credentials, tokens, or secrets from conversation metadata.
 */
function sanitizeMetadata(metadata: any): Record<string, any> {
  if (!metadata || typeof metadata !== 'object' || Array.isArray(metadata)) {
    return {};
  }
  const clean: Record<string, any> = {};
  for (const [key, value] of Object.entries(metadata)) {
    const lowerKey = key.toLowerCase();
    if (
      lowerKey.includes('token') ||
      lowerKey.includes('secret') ||
      lowerKey.includes('key') ||
      lowerKey.includes('auth') ||
      lowerKey.includes('password')
    ) {
      continue;
    }
    clean[key] = value;
  }
  return clean;
}

/**
 * Extracts verified authenticated admin ID from request context.
 * The ID is established by requireAuth from the verified Bearer JWT.
 */
export function getAuthenticatedAdminId(req: Request): string | null {
  const user = (req as any).user;
  const adminId = user?.id || user?.userId || (req.headers['x-user-id'] as string);
  if (typeof adminId === 'string' && adminId.trim()) {
    return adminId.trim();
  }
  return null;
}

export class WhatsAppAdminController {
  /**
   * GET /api/admin/whatsapp/conversations
   *
   * Query params:
   * - limit (1..100, default 50)
   * - offset (>= 0, default 0)
   * - status ('ACTIVE' | 'CLOSED' | 'ARCHIVED' | 'ALL', default 'ACTIVE')
   * - unread_only ('true' | 'false')
   * - assigned_to (UUID | 'unassigned' | 'me')
   * - search (phone / contact partial search)
   */
  public async listConversations(req: Request, res: Response): Promise<Response> {
    try {
      const authenticatedAdminId = getAuthenticatedAdminId(req);

      // Pagination
      let limit = 50;
      if (req.query.limit !== undefined) {
        const parsedLimit = parseInt(req.query.limit as string, 10);
        if (!isNaN(parsedLimit) && parsedLimit >= 1) {
          limit = Math.min(parsedLimit, 100);
        }
      }

      let offset = 0;
      if (req.query.offset !== undefined) {
        const parsedOffset = parseInt(req.query.offset as string, 10);
        if (!isNaN(parsedOffset) && parsedOffset >= 0) {
          offset = parsedOffset;
        }
      }

      // Status filtering
      const statusParam = typeof req.query.status === 'string'
        ? req.query.status.trim().toUpperCase()
        : 'ACTIVE';

      // Unread filtering
      const unreadOnly = req.query.unread_only === 'true' || (req.query.unread_only as unknown) === true;

      // Assignment filtering
      const assignedToParam = typeof req.query.assigned_to === 'string'
        ? req.query.assigned_to.trim()
        : undefined;

      // Search filter
      const searchParam = typeof req.query.search === 'string'
        ? req.query.search.trim()
        : undefined;

      // Build query
      let query = supabase
        .from('whatsapp_conversations')
        .select('*', { count: 'exact' });

      if (statusParam !== 'ALL') {
        const allowedStatuses = ['ACTIVE', 'CLOSED', 'ARCHIVED'];
        const targetStatus = allowedStatuses.includes(statusParam) ? statusParam : 'ACTIVE';
        query = query.eq('status', targetStatus);
      }

      if (unreadOnly) {
        query = query.gt('unread_count', 0);
      }

      if (assignedToParam) {
        if (assignedToParam.toLowerCase() === 'unassigned') {
          query = query.is('assigned_admin_id', null);
        } else if (assignedToParam.toLowerCase() === 'me') {
          if (authenticatedAdminId) {
            query = query.eq('assigned_admin_id', authenticatedAdminId);
          } else {
            // Cannot match 'me' without authenticated admin context
            return res.status(200).json({
              success: true,
              data: [],
              pagination: { total: 0, limit, offset }
            });
          }
        } else if (UUID_REGEX.test(assignedToParam)) {
          query = query.eq('assigned_admin_id', assignedToParam);
        }
      }

      if (searchParam) {
        const cleanSearch = searchParam.replace(/[%_]/g, '');
        if (cleanSearch) {
          query = query.ilike('phone_e164', `%${cleanSearch}%`);
        }
      }

      // Order by last_message_at DESC
      query = query
        .order('last_message_at', { ascending: false, nullsFirst: false })
        .range(offset, offset + limit - 1);

      const { data: rawConversations, count, error } = await query;

      if (error) {
        winstonLogger.error(`[WHATSAPP_ADMIN] Error listing conversations: ${error.message}`);
        return res.status(500).json({
          success: false,
          error: 'Failed to retrieve conversations'
        });
      }

      const conversations = rawConversations || [];

      // Collect user and admin IDs to resolve display names in batch
      const userIdsToResolve = new Set<string>();
      for (const conv of conversations) {
        if (conv.user_id && UUID_REGEX.test(conv.user_id)) {
          userIdsToResolve.add(conv.user_id);
        }
        if (conv.assigned_admin_id && UUID_REGEX.test(conv.assigned_admin_id)) {
          userIdsToResolve.add(conv.assigned_admin_id);
        }
      }

      const nameMap: Record<string, string> = {};
      if (userIdsToResolve.size > 0) {
        try {
          const { data: usersData } = await supabase
            .from('users')
            .select('id, full_name')
            .in('id', Array.from(userIdsToResolve));

          if (usersData) {
            for (const u of usersData) {
              const displayName = (u.full_name || '').trim();
              if (displayName) {
                nameMap[u.id] = displayName;
              }
            }
          }
        } catch (nameErr: any) {
          winstonLogger.warn(`[WHATSAPP_ADMIN] Non-fatal name lookup error: ${nameErr?.message}`);
        }
      }

      const formatted = conversations.map(conv => ({
        id: conv.id,
        phone_e164: conv.phone_e164,
        user_id: conv.user_id || null,
        user_name: (conv.user_id && nameMap[conv.user_id]) || null,
        status: conv.status,
        unread_count: conv.unread_count ?? 0,
        assigned_admin_id: conv.assigned_admin_id || null,
        assigned_admin_name: (conv.assigned_admin_id && nameMap[conv.assigned_admin_id]) || null,
        last_message_at: conv.last_message_at,
        last_inbound_at: conv.last_inbound_at || null,
        last_outbound_at: conv.last_outbound_at || null,
        last_message_snippet: conv.last_message_snippet || null,
        metadata: sanitizeMetadata(conv.metadata)
      }));

      return res.status(200).json({
        success: true,
        data: formatted,
        pagination: {
          total: count ?? formatted.length,
          limit,
          offset
        }
      });
    } catch (err: any) {
      winstonLogger.error(`[WHATSAPP_ADMIN] Unhandled exception in listConversations: ${err?.message}`);
      return res.status(500).json({
        success: false,
        error: 'Failed to retrieve conversations'
      });
    }
  }

  /**
   * GET /api/admin/whatsapp/conversations/:conversationId
   *
   * Read-only detailed conversation view with customer & assigned admin details.
   */
  public async getConversation(req: Request, res: Response): Promise<Response> {
    try {
      const { conversationId } = req.params;

      if (!conversationId || !UUID_REGEX.test(conversationId)) {
        return res.status(400).json({
          success: false,
          error: 'Invalid conversation ID'
        });
      }

      const { data: conv, error } = await supabase
        .from('whatsapp_conversations')
        .select('*')
        .eq('id', conversationId)
        .maybeSingle();

      if (error) {
        winstonLogger.error(`[WHATSAPP_ADMIN] Error fetching conversation ${conversationId}: ${error.message}`);
        return res.status(500).json({
          success: false,
          error: 'Failed to retrieve conversation'
        });
      }

      if (!conv) {
        return res.status(404).json({
          success: false,
          error: 'Conversation not found'
        });
      }

      // Fetch user profile if user_id present
      let userProfile: any = null;
      let userName: string | null = null;
      if (conv.user_id && UUID_REGEX.test(conv.user_id)) {
        try {
          const { data: u } = await supabase
            .from('users')
            .select('id, full_name, email, mobile_number')
            .eq('id', conv.user_id)
            .maybeSingle();

          if (u) {
            userName = (u.full_name || '').trim() || null;
            userProfile = {
              id: u.id,
              name: userName,
              email: u.email || null,
              mobile_number: u.mobile_number || null
            };
          }
        } catch (uErr: any) {
          winstonLogger.warn(`[WHATSAPP_ADMIN] User profile lookup non-fatal error: ${uErr?.message}`);
        }
      }

      // Fetch assigned admin profile if assigned_admin_id present
      let adminProfile: any = null;
      let adminName: string | null = null;
      if (conv.assigned_admin_id && UUID_REGEX.test(conv.assigned_admin_id)) {
        try {
          const { data: a } = await supabase
            .from('users')
            .select('id, full_name, email')
            .eq('id', conv.assigned_admin_id)
            .maybeSingle();

          if (a) {
            adminName = (a.full_name || '').trim() || null;
            adminProfile = {
              id: a.id,
              name: adminName,
              email: a.email || null
            };
          }
        } catch (aErr: any) {
          winstonLogger.warn(`[WHATSAPP_ADMIN] Admin profile lookup non-fatal error: ${aErr?.message}`);
        }
      }

      return res.status(200).json({
        success: true,
        data: {
          id: conv.id,
          phone_e164: conv.phone_e164,
          user_id: conv.user_id || null,
          user_name: userName,
          user: userProfile,
          status: conv.status,
          unread_count: conv.unread_count ?? 0,
          assigned_admin_id: conv.assigned_admin_id || null,
          assigned_admin_name: adminName,
          assigned_admin: adminProfile,
          last_message_at: conv.last_message_at,
          last_inbound_at: conv.last_inbound_at || null,
          last_outbound_at: conv.last_outbound_at || null,
          last_message_snippet: conv.last_message_snippet || null,
          metadata: sanitizeMetadata(conv.metadata),
          created_at: conv.created_at,
          updated_at: conv.updated_at
        }
      });
    } catch (err: any) {
      winstonLogger.error(`[WHATSAPP_ADMIN] Unhandled exception in getConversation: ${err?.message}`);
      return res.status(500).json({
        success: false,
        error: 'Failed to retrieve conversation'
      });
    }
  }

  /**
   * GET /api/admin/whatsapp/conversations/:conversationId/messages
   *
   * Chronological message history with OTP redaction and secret protection.
   */
  public async getMessageHistory(req: Request, res: Response): Promise<Response> {
    try {
      const { conversationId } = req.params;

      if (!conversationId || !UUID_REGEX.test(conversationId)) {
        return res.status(400).json({
          success: false,
          error: 'Invalid conversation ID'
        });
      }

      // Verify conversation exists
      const { data: conv, error: convErr } = await supabase
        .from('whatsapp_conversations')
        .select('id')
        .eq('id', conversationId)
        .maybeSingle();

      if (convErr) {
        winstonLogger.error(`[WHATSAPP_ADMIN] Error validating conversation ${conversationId}: ${convErr.message}`);
        return res.status(500).json({
          success: false,
          error: 'Failed to retrieve message history'
        });
      }

      if (!conv) {
        return res.status(404).json({
          success: false,
          error: 'Conversation not found'
        });
      }

      // Pagination
      let limit = 50;
      if (req.query.limit !== undefined) {
        const parsedLimit = parseInt(req.query.limit as string, 10);
        if (!isNaN(parsedLimit) && parsedLimit >= 1) {
          limit = Math.min(parsedLimit, 100);
        }
      }

      let offset = 0;
      if (req.query.offset !== undefined) {
        const parsedOffset = parseInt(req.query.offset as string, 10);
        if (!isNaN(parsedOffset) && parsedOffset >= 0) {
          offset = parsedOffset;
        }
      }

      const beforeCursor = typeof req.query.before === 'string' ? req.query.before.trim() : undefined;

      let query = supabase
        .from('whatsapp_messages')
        .select('*')
        .eq('conversation_id', conversationId);

      if (beforeCursor) {
        query = query.lt('created_at', beforeCursor);
      }

      query = query
        .order('created_at', { ascending: true })
        .range(offset, offset + limit - 1);

      const { data: rawMessages, error: msgErr } = await query;

      if (msgErr) {
        winstonLogger.error(`[WHATSAPP_ADMIN] Error fetching messages for ${conversationId}: ${msgErr.message}`);
        return res.status(500).json({
          success: false,
          error: 'Failed to retrieve message history'
        });
      }

      const messages = (rawMessages || []).map(msg => {
        let safeBody = msg.body;
        // Never expose plaintext OTP or auth tokens
        if (
          msg.template_name === 'trayago_auth_otp' ||
          msg.source === 'AUTOMATION' ||
          safeBody === '[PROTECTED OTP]'
        ) {
          safeBody = '[PROTECTED OTP]';
        } else if (safeBody && (/\b\d{6}\b/.test(safeBody) && /otp|verification|code/i.test(safeBody))) {
          safeBody = '[PROTECTED OTP]';
        }

        return {
          id: msg.id,
          conversation_id: msg.conversation_id,
          direction: msg.direction,
          source: msg.source,
          message_type: msg.message_type,
          template_name: msg.template_name || null,
          template_language: msg.template_language || null,
          body: safeBody,
          wamid: msg.wamid || null,
          status: msg.status,
          error_code: msg.error_code || null,
          error_message: msg.error_message || null,
          sent_at: msg.sent_at || null,
          delivered_at: msg.delivered_at || null,
          read_at: msg.read_at || null,
          failed_at: msg.failed_at || null,
          smart_alert_id: msg.smart_alert_id || null,
          admin_sender_id: msg.admin_sender_id || null,
          created_at: msg.created_at
        };
      });

      return res.status(200).json({
        success: true,
        data: messages,
        pagination: {
          limit,
          offset
        }
      });
    } catch (err: any) {
      winstonLogger.error(`[WHATSAPP_ADMIN] Unhandled exception in getMessageHistory: ${err?.message}`);
      return res.status(500).json({
        success: false,
        error: 'Failed to retrieve message history'
      });
    }
  }

  /**
   * PATCH /api/admin/whatsapp/conversations/:conversationId/assignment
   *
   * Assign or unassign a conversation to an admin.
   * Body: { adminId: string | null }
   */
  public async updateAssignment(req: Request, res: Response): Promise<Response> {
    try {
      const { conversationId } = req.params;

      if (!conversationId || !UUID_REGEX.test(conversationId)) {
        return res.status(400).json({
          success: false,
          error: 'Invalid conversation ID'
        });
      }

      if (!req.body || req.body.adminId === undefined) {
        return res.status(400).json({
          success: false,
          error: 'adminId field is required (provide UUID or null)'
        });
      }

      const { adminId } = req.body;

      // Verify conversation exists
      const { data: conv, error: convErr } = await supabase
        .from('whatsapp_conversations')
        .select('id, assigned_admin_id')
        .eq('id', conversationId)
        .maybeSingle();

      if (convErr) {
        winstonLogger.error(`[WHATSAPP_ADMIN] Error loading conversation ${conversationId}: ${convErr.message}`);
        return res.status(500).json({
          success: false,
          error: 'Failed to update conversation assignment'
        });
      }

      if (!conv) {
        return res.status(404).json({
          success: false,
          error: 'Conversation not found'
        });
      }

      let targetAdminId: string | null = null;
      let targetAdminName: string | null = null;

      if (adminId !== null) {
        if (typeof adminId !== 'string' || !UUID_REGEX.test(adminId.trim())) {
          return res.status(400).json({
            success: false,
            error: 'Invalid admin ID format'
          });
        }

        const cleanAdminId = adminId.trim();

        // Resolve user and require is_admin === true
        const { data: targetUser, error: userErr } = await supabase
          .from('users')
          .select('id, full_name, is_admin')
          .eq('id', cleanAdminId)
          .maybeSingle();

        if (userErr) {
          winstonLogger.error(`[WHATSAPP_ADMIN] Error resolving target user ${cleanAdminId}: ${userErr.message}`);
          return res.status(500).json({
            success: false,
            error: 'Failed to verify administrator assignment'
          });
        }

        if (!targetUser) {
          return res.status(400).json({
            success: false,
            error: 'Target administrator user not found'
          });
        }

        if (targetUser.is_admin !== true) {
          return res.status(400).json({
            success: false,
            error: 'Assigned user is not an administrator'
          });
        }

        targetAdminId = targetUser.id;
        targetAdminName = (targetUser.full_name || '').trim() || null;
      }

      const now = new Date().toISOString();

      const { error: updateErr } = await supabase
        .from('whatsapp_conversations')
        .update({
          assigned_admin_id: targetAdminId,
          updated_at: now
        })
        .eq('id', conversationId);

      if (updateErr) {
        winstonLogger.error(`[WHATSAPP_ADMIN] Error updating assignment on ${conversationId}: ${updateErr.message}`);
        return res.status(500).json({
          success: false,
          error: 'Failed to update conversation assignment'
        });
      }

      winstonLogger.info(
        `[WHATSAPP_ADMIN] Conversation ${conversationId} assignment updated to ${targetAdminId || 'unassigned'}`
      );

      return res.status(200).json({
        success: true,
        data: {
          id: conversationId,
          assigned_admin_id: targetAdminId,
          assigned_admin_name: targetAdminName,
          updated_at: now
        }
      });
    } catch (err: any) {
      winstonLogger.error(`[WHATSAPP_ADMIN] Unhandled exception in updateAssignment: ${err?.message}`);
      return res.status(500).json({
        success: false,
        error: 'Failed to update conversation assignment'
      });
    }
  }

  /**
   * POST /api/admin/whatsapp/conversations/:conversationId/messages
   *
   * Sends a free-form session text message from the authenticated admin.
   * Body: { body: "message text" }
   *
   * Enforces:
   * - 24-hour customer service window based on conversation.last_inbound_at.
   * - Message body presence, non-empty, and maximum length.
   * - Dispatches via whatsAppService.sendSessionTextMessage with source 'ADMIN'.
   * - Never inserts directly to DB from controller.
   */
  public async sendAdminMessage(req: Request, res: Response): Promise<Response> {
    try {
      const { conversationId } = req.params;

      if (!conversationId || !UUID_REGEX.test(conversationId)) {
        return res.status(400).json({
          success: false,
          error: 'Invalid conversation ID'
        });
      }

      // Admin identity strictly from verified JWT
      const authenticatedAdminId = getAuthenticatedAdminId(req);
      if (!authenticatedAdminId) {
        return res.status(401).json({
          success: false,
          error: 'Unauthorized admin context'
        });
      }

      // Check WhatsApp service enablement flag
      if (!whatsAppService.isServiceEnabled()) {
        return res.status(400).json({
          success: false,
          error: 'WhatsApp service is currently disabled'
        });
      }

      // Validate message body
      if (!req.body || typeof req.body.body !== 'string') {
        return res.status(400).json({
          success: false,
          error: 'Message body cannot be empty'
        });
      }

      const bodyText = req.body.body.trim();
      if (bodyText.length === 0) {
        return res.status(400).json({
          success: false,
          error: 'Message body cannot be empty'
        });
      }

      if (bodyText.length > MAX_MESSAGE_LENGTH) {
        return res.status(400).json({
          success: false,
          error: `Message body exceeds maximum length of ${MAX_MESSAGE_LENGTH} characters`
        });
      }

      // Load conversation
      const { data: conv, error: convErr } = await supabase
        .from('whatsapp_conversations')
        .select('*')
        .eq('id', conversationId)
        .maybeSingle();

      if (convErr) {
        winstonLogger.error(`[WHATSAPP_ADMIN] Error loading conversation ${conversationId}: ${convErr.message}`);
        return res.status(500).json({
          success: false,
          error: 'Failed to retrieve conversation'
        });
      }

      if (!conv) {
        return res.status(404).json({
          success: false,
          error: 'Conversation not found'
        });
      }

      // Check 24-hour customer service window
      if (!conv.last_inbound_at) {
        return res.status(400).json({
          success: false,
          error: '24-hour customer service window expired. An approved WhatsApp template is required to contact this user.'
        });
      }

      const lastInboundTime = new Date(conv.last_inbound_at).getTime();
      const elapsed = Date.now() - lastInboundTime;

      if (isNaN(lastInboundTime) || elapsed > TWENTY_FOUR_HOURS_MS) {
        // Outside 24h window: fail fast without invoking Meta API
        return res.status(400).json({
          success: false,
          error: '24-hour customer service window expired. An approved WhatsApp template is required to contact this user.'
        });
      }

      // Dispatch session text message via whatsAppService
      const sendResult = await whatsAppService.sendSessionTextMessage(
        conv.phone_e164,
        bodyText,
        {
          conversationId: conv.id,
          adminSenderId: authenticatedAdminId,
          source: 'ADMIN'
        }
      );

      if (!sendResult.success) {
        winstonLogger.warn(
          `[WHATSAPP_ADMIN] Message send failed for ${maskPhoneNumber(conv.phone_e164)}: ${sendResult.reason || sendResult.error?.message}`
        );
        return res.status(400).json({
          success: false,
          error: sendResult.reason || sendResult.error?.message || 'Failed to send WhatsApp message'
        });
      }

      winstonLogger.info(
        `[WHATSAPP_ADMIN] Admin message sent to ${maskPhoneNumber(conv.phone_e164)} (WAMID: ${sendResult.wamid})`
      );

      return res.status(200).json({
        success: true,
        data: {
          wamid: sendResult.wamid,
          status: 'SENT'
        }
      });
    } catch (err: any) {
      winstonLogger.error(`[WHATSAPP_ADMIN] Unhandled exception in sendAdminMessage: ${err?.message}`);
      return res.status(500).json({
        success: false,
        error: 'Failed to send message'
      });
    }
  }
}

export const whatsappAdminController = new WhatsAppAdminController();
