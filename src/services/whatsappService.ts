import { winstonLogger } from '../middleware/logger';
import { supabase } from '../config/supabase';
import { normalizeIndianPhoneNumber, maskPhoneNumber, isValidIndianPhoneNumber } from '../utils/phoneNormalizer';

/**
 * STEP 5.9A & 5.9G — Meta WhatsApp Cloud API Service & Outbound Persistence
 * 
 * Safe, modular service layer for Meta WhatsApp Cloud API communication.
 * Operates strictly behind the ENABLE_WHATSAPP_SERVICE feature flag.
 * 
 * Fail-Closed: When ENABLE_WHATSAPP_SERVICE is not exactly 'true',
 * no network request is executed and deterministic disabled response is returned.
 * 
 * Step 5.9G: Outbound message persistence into public.whatsapp_conversations
 * and public.whatsapp_messages immediately after Meta returns 200 OK + valid WAMID.
 * Fail-safe boundary: local database persistence failures never convert Meta
 * delivery success into failure and never trigger redelivery.
 */

export interface WhatsAppSendResult {
  success: boolean;
  wamid?: string;
  reason?: string;
  error?: {
    code?: number | string;
    subcode?: number;
    message?: string;
    type?: string;
    normalizedCode?: string;
    fbtrace_id?: string;
  };
  attempts?: number;
}

export interface TemplateComponentParameter {
  type: 'text' | 'currency' | 'date_time' | 'image' | 'document' | 'video' | 'payload';
  text?: string;
  payload?: string;
  [key: string]: any;
}

export interface TemplateComponent {
  type: 'header' | 'body' | 'button';
  sub_type?: 'url' | 'quick_reply';
  index?: string | number;
  parameters: TemplateComponentParameter[];
}

export interface SendTemplateParams {
  to: string;
  templateName: string;
  languageCode?: string;
  components?: TemplateComponent[];
}

export interface OutboundPersistenceContext {
  source?: 'SYSTEM' | 'ADMIN' | 'USER' | 'AUTOMATION';
  messageType?: 'TEMPLATE' | 'TEXT' | 'MEDIA' | 'INTERACTIVE';
  templateName?: string;
  templateLanguage?: string;
  body?: string;
  smartAlertId?: string;
  adminSenderId?: string;
  userId?: string;
  conversationId?: string;
  metadata?: Record<string, any>;
}

export interface WhatsAppConfig {
  phoneNumberId: string;
  token: string;
  wabaId?: string;
  graphApiVersion: string;
}

/**
 * Normalizes phone numbers to canonical E.164.
 * Uses Indian mobile normalizer (+91) as primary, with international E.164 fallback.
 */
export function toCanonicalE164(phone: string | null | undefined): string | null {
  if (!phone || typeof phone !== 'string') return null;
  const indian = normalizeIndianPhoneNumber(phone);
  if (indian) return indian;

  const digits = phone.replace(/\D/g, '');
  if (digits.length >= 7 && digits.length <= 15) {
    return `+${digits}`;
  }
  return null;
}

export class WhatsAppService {
  private fetchClient: typeof fetch;

  constructor(fetchClient?: typeof fetch) {
    this.fetchClient = fetchClient || (globalThis.fetch ? globalThis.fetch.bind(globalThis) : (null as any));
  }

  /**
   * Allows injecting a mock fetch function for isolated unit testing.
   */
  public setFetchClient(fetchClient: typeof fetch): void {
    this.fetchClient = fetchClient;
  }

  /**
   * Safe configuration validation without exposing token/secret values.
   */
  public getConfig(): { config?: WhatsAppConfig; error?: string } {
    const phoneNumberId = process.env.WHATSAPP_PHONE_NUMBER_ID?.trim();
    const token = process.env.WHATSAPP_TOKEN?.trim();
    const wabaId = process.env.WHATSAPP_BUSINESS_ACCOUNT_ID?.trim();
    const graphApiVersion = process.env.WHATSAPP_GRAPH_API_VERSION?.trim() || 'v21.0';

    if (!phoneNumberId) {
      return { error: 'WHATSAPP_PHONE_NUMBER_ID is not configured' };
    }
    if (!token) {
      return { error: 'WHATSAPP_TOKEN is not configured' };
    }

    return {
      config: {
        phoneNumberId,
        token,
        wabaId,
        graphApiVersion
      }
    };
  }

  /**
   * Fail-closed check: Verifies if WhatsApp master service is enabled.
   */
  public isServiceEnabled(): boolean {
    return process.env.ENABLE_WHATSAPP_SERVICE === 'true';
  }

  /**
   * Dispatches a pre-approved Meta WhatsApp Template message.
   */
  public async sendTemplateMessage(
    params: SendTemplateParams,
    context?: OutboundPersistenceContext
  ): Promise<WhatsAppSendResult> {
    if (!this.isServiceEnabled()) {
      winstonLogger.info('[WHATSAPP_SERVICE] Send skipped — ENABLE_WHATSAPP_SERVICE is false.');
      return { success: false, reason: 'WHATSAPP_DISABLED' };
    }

    const normalizedPhone = normalizeIndianPhoneNumber(params.to);
    if (!normalizedPhone) {
      winstonLogger.warn(`[WHATSAPP_SERVICE] Invalid phone number provided: ${maskPhoneNumber(params.to)}`);
      return { success: false, reason: 'INVALID_PHONE_NUMBER' };
    }

    const payload = this.buildTemplatePayload(normalizedPhone, params.templateName, params.languageCode, params.components);
    return this.executeGraphApiRequest(normalizedPhone, payload, {
      source: context?.source || 'SYSTEM',
      messageType: 'TEMPLATE',
      templateName: params.templateName,
      templateLanguage: params.languageCode || 'en_US',
      body: context?.body || this.extractTemplateBodyText(params.components),
      smartAlertId: context?.smartAlertId,
      adminSenderId: context?.adminSenderId,
      userId: context?.userId,
      conversationId: context?.conversationId,
      metadata: context?.metadata
    });
  }

  /**
   * Dispatches a Smart Alert (Delay, Waitlist, Chart, Platform Change) using pre-approved templates.
   */
  public async sendSmartAlertTemplate(
    to: string,
    alertType: string,
    templateData: Record<string, string>,
    smartAlertId?: string
  ): Promise<WhatsAppSendResult> {
    if (!this.isServiceEnabled()) {
      return { success: false, reason: 'WHATSAPP_DISABLED' };
    }

    if (process.env.ENABLE_WHATSAPP_SMART_ALERTS !== 'true') {
      winstonLogger.info('[WHATSAPP_SERVICE] Smart alert skipped — ENABLE_WHATSAPP_SMART_ALERTS is false.');
      return { success: false, reason: 'WHATSAPP_SMART_ALERTS_DISABLED' };
    }

    const templateName = this.resolveSmartAlertTemplateName(alertType);
    const bodyParameters: TemplateComponentParameter[] = Object.values(templateData).map(val => ({
      type: 'text',
      text: String(val)
    }));

    const components: TemplateComponent[] = [
      {
        type: 'body',
        parameters: bodyParameters
      }
    ];

    const bodyText = Object.entries(templateData)
      .map(([k, v]) => `${k}: ${v}`)
      .join(', ');

    return this.sendTemplateMessage(
      {
        to,
        templateName,
        languageCode: 'en_US',
        components
      },
      {
        source: 'SYSTEM',
        smartAlertId,
        body: bodyText
      }
    );
  }

  /**
   * Dispatches an Authentication OTP message using a pre-approved AUTHENTICATION template.
   */
  public async sendAuthOtpTemplate(
    to: string,
    otpCode: string,
    context?: { userId?: string }
  ): Promise<WhatsAppSendResult> {
    if (!this.isServiceEnabled()) {
      return { success: false, reason: 'WHATSAPP_DISABLED' };
    }

    if (process.env.ENABLE_WHATSAPP_OTP !== 'true') {
      winstonLogger.info('[WHATSAPP_SERVICE] OTP skipped — ENABLE_WHATSAPP_OTP is false.');
      return { success: false, reason: 'WHATSAPP_OTP_DISABLED' };
    }

    const normalizedPhone = normalizeIndianPhoneNumber(to);
    if (!normalizedPhone) {
      return { success: false, reason: 'INVALID_PHONE_NUMBER' };
    }

    const payload = this.buildOtpPayload(normalizedPhone, otpCode);
    return this.executeGraphApiRequest(normalizedPhone, payload, {
      source: 'AUTOMATION',
      messageType: 'TEMPLATE',
      templateName: 'trayago_auth_otp',
      templateLanguage: 'en_US',
      body: '[PROTECTED OTP]', // NEVER store plaintext OTP
      userId: context?.userId
    });
  }

  /**
   * Dispatches a free-form session text message (only permitted within the active 24-hour customer window).
   */
  public async sendSessionTextMessage(
    to: string,
    body: string,
    conversationIdOrContext?: string | OutboundPersistenceContext
  ): Promise<WhatsAppSendResult> {
    if (!this.isServiceEnabled()) {
      return { success: false, reason: 'WHATSAPP_DISABLED' };
    }

    const normalizedPhone = normalizeIndianPhoneNumber(to);
    if (!normalizedPhone) {
      return { success: false, reason: 'INVALID_PHONE_NUMBER' };
    }

    let adminSenderId: string | undefined;
    let userId: string | undefined;
    let conversationId: string | undefined;
    let source: 'SYSTEM' | 'ADMIN' | 'AUTOMATION' = 'ADMIN';

    if (typeof conversationIdOrContext === 'string') {
      conversationId = conversationIdOrContext;
    } else if (typeof conversationIdOrContext === 'object' && conversationIdOrContext !== null) {
      conversationId = conversationIdOrContext.conversationId;
      adminSenderId = conversationIdOrContext.adminSenderId;
      userId = conversationIdOrContext.userId;
      if (conversationIdOrContext.source && conversationIdOrContext.source !== 'USER') {
        source = conversationIdOrContext.source;
      }
    }

    const payload = this.buildSessionTextPayload(normalizedPhone, body);
    return this.executeGraphApiRequest(normalizedPhone, payload, {
      source,
      messageType: 'TEXT',
      body,
      conversationId,
      adminSenderId,
      userId
    });
  }

  // ── Payload Builders (Pure functions for deterministic testing) ─────────────

  public buildTemplatePayload(
    to: string,
    templateName: string,
    languageCode = 'en_US',
    components: TemplateComponent[] = []
  ): Record<string, any> {
    return {
      messaging_product: 'whatsapp',
      recipient_type: 'individual',
      to,
      type: 'template',
      template: {
        name: templateName,
        language: {
          code: languageCode
        },
        components
      }
    };
  }

  public buildOtpPayload(to: string, otpCode: string): Record<string, any> {
    return {
      messaging_product: 'whatsapp',
      recipient_type: 'individual',
      to,
      type: 'template',
      template: {
        name: 'trayago_auth_otp',
        language: {
          code: 'en_US'
        },
        components: [
          {
            type: 'body',
            parameters: [
              {
                type: 'text',
                text: otpCode
              }
            ]
          },
          {
            type: 'button',
            sub_type: 'url',
            index: 0,
            parameters: [
              {
                type: 'text',
                text: otpCode
              }
            ]
          }
        ]
      }
    };
  }

  public buildSessionTextPayload(to: string, body: string): Record<string, any> {
    return {
      messaging_product: 'whatsapp',
      recipient_type: 'individual',
      to,
      type: 'text',
      text: {
        preview_url: false,
        body
      }
    };
  }

  // ── Error Normalization & Retry Classification ──────────────────────────────

  public normalizeMetaError(metaError: any): {
    normalizedCode: string;
    code?: number;
    subcode?: number;
    message: string;
    type?: string;
    fbtrace_id?: string;
  } {
    const code = metaError?.code;
    const subcode = metaError?.error_subcode;
    const message = metaError?.message || 'Unknown Meta API error';
    const type = metaError?.type || 'OAuthException';
    const fbtrace_id = metaError?.fbtrace_id;

    let normalizedCode = 'META_API_ERROR';
    if (code === 131026 || code === 131047) {
      normalizedCode = 'CUSTOMER_WINDOW_EXPIRED';
    } else if (code === 130429) {
      normalizedCode = 'RATE_LIMIT_EXCEEDED';
    } else if (code === 132000) {
      normalizedCode = 'TEMPLATE_PARAM_MISMATCH';
    } else if (code === 131051) {
      normalizedCode = 'UNSUPPORTED_PHONE_NUMBER';
    } else if (code === 190) {
      normalizedCode = 'INVALID_ACCESS_TOKEN';
    }

    return { normalizedCode, code, subcode, message, type, fbtrace_id };
  }

  public isRetryableError(error: any, statusCode?: number): boolean {
    if (statusCode === 429) return true;
    if (statusCode && statusCode >= 500 && statusCode <= 599) return true;
    if (statusCode && statusCode >= 400 && statusCode < 500) return false;

    // Transient network/socket errors
    const msg = error?.message?.toLowerCase() || '';
    const errCode = error?.code || '';
    if (
      errCode === 'ECONNRESET' ||
      errCode === 'ETIMEDOUT' ||
      errCode === 'ECONNREFUSED' ||
      errCode === 'EAI_AGAIN' ||
      msg.includes('fetch failed') ||
      msg.includes('network timeout') ||
      msg.includes('socket hang up')
    ) {
      return true;
    }

    return false;
  }

  // ── Outbound Persistence Helper (Step 5.9G) ────────────────────────────────

  /**
   * Internal helper for persisting outbound WhatsApp messages.
   * Runs immediately after Meta returns 200 OK + valid WAMID.
   * Completely decoupled and fail-safe: any database error is caught and logged,
   * never affecting the caller or triggering a Meta retry.
   */
  public async persistOutboundMessage(
    to: string,
    wamid: string,
    context?: OutboundPersistenceContext
  ): Promise<void> {
    try {
      if (!wamid) {
        winstonLogger.warn('[WHATSAPP_SERVICE] Outbound persistence skipped: missing WAMID.');
        return;
      }

      const canonicalPhone = toCanonicalE164(to);
      if (!canonicalPhone) {
        winstonLogger.warn(`[WHATSAPP_SERVICE] Outbound persistence skipped: invalid phone (${maskPhoneNumber(to)})`);
        return;
      }

      // 1. Idempotency check: Before inserting, ensure this WAMID does not already exist
      const { data: existingMsg, error: checkMsgErr } = await supabase
        .from('whatsapp_messages')
        .select('id')
        .eq('wamid', wamid)
        .maybeSingle();

      if (!checkMsgErr && existingMsg) {
        winstonLogger.info(`[WHATSAPP_SERVICE] Duplicate outbound message ignored for WAMID: ${wamid}`);
        return;
      }

      const sentAt = new Date().toISOString();

      // 2. Resolve user by mobile number if not explicitly provided in caller context
      let resolvedUserId: string | null = context?.userId || null;
      if (!resolvedUserId) {
        try {
          const { data: matchedUser } = await supabase
            .from('users')
            .select('id')
            .eq('mobile_number', canonicalPhone)
            .maybeSingle();

          if (matchedUser?.id) {
            resolvedUserId = matchedUser.id;
          } else {
            const digits10 = canonicalPhone.replace(/\D/g, '').slice(-10);
            const { data: matchedUser10 } = await supabase
              .from('users')
              .select('id')
              .eq('mobile_number', digits10)
              .maybeSingle();
            if (matchedUser10?.id) {
              resolvedUserId = matchedUser10.id;
            }
          }
        } catch (userErr: any) {
          winstonLogger.warn(`[WHATSAPP_SERVICE] User lookup non-fatal error: ${userErr?.message}`);
        }
      }

      // 3. Resolve or create whatsapp_conversations record
      let conversationId: string | null = context?.conversationId || null;

      if (!conversationId) {
        const { data: existingConv, error: convLookupErr } = await supabase
          .from('whatsapp_conversations')
          .select('id, user_id, unread_count')
          .eq('phone_e164', canonicalPhone)
          .maybeSingle();

        if (!convLookupErr && existingConv) {
          conversationId = existingConv.id;
          const updatePayload: any = {
            last_message_at: sentAt,
            last_outbound_at: sentAt,
            updated_at: sentAt
          };

          // Backfill user_id when conversation exists but user_id is null and user_id is available
          if (!existingConv.user_id && resolvedUserId) {
            updatePayload.user_id = resolvedUserId;
          }

          const { error: updateConvErr } = await supabase
            .from('whatsapp_conversations')
            .update(updatePayload)
            .eq('id', conversationId);

          if (updateConvErr) {
            winstonLogger.warn(`[WHATSAPP_SERVICE] Failed to update conversation timestamps: ${updateConvErr.message}`);
          }
        } else {
          // Create new conversation
          const insertConvPayload: any = {
            phone_e164: canonicalPhone,
            user_id: resolvedUserId,
            status: 'ACTIVE',
            last_message_at: sentAt,
            last_outbound_at: sentAt,
            unread_count: 0,
            metadata: {},
            created_at: sentAt,
            updated_at: sentAt
          };

          const { data: createdConv, error: createConvErr } = await supabase
            .from('whatsapp_conversations')
            .insert(insertConvPayload)
            .select('id')
            .single();

          if (createConvErr || !createdConv?.id) {
            // Race condition: another concurrent execution inserted the conversation.
            // Re-fetch existing conversation.
            const { data: fallbackConv } = await supabase
              .from('whatsapp_conversations')
              .select('id, user_id')
              .eq('phone_e164', canonicalPhone)
              .maybeSingle();

            if (fallbackConv?.id) {
              conversationId = fallbackConv.id;
              const updatePayload: any = {
                last_message_at: sentAt,
                last_outbound_at: sentAt,
                updated_at: sentAt
              };
              if (!fallbackConv.user_id && resolvedUserId) {
                updatePayload.user_id = resolvedUserId;
              }
              await supabase
                .from('whatsapp_conversations')
                .update(updatePayload)
                .eq('id', conversationId);
            } else {
              winstonLogger.error(`[WHATSAPP_SERVICE] Failed to create or resolve conversation for ${maskPhoneNumber(canonicalPhone)}: ${createConvErr?.message}`);
            }
          } else {
            conversationId = createdConv.id;
          }
        }
      }

      if (!conversationId) {
        winstonLogger.error(`[WHATSAPP_SERVICE] Could not resolve conversation container for ${maskPhoneNumber(canonicalPhone)}`);
        return;
      }

      // 4. Insert outbound message row in public.whatsapp_messages
      const source = context?.source || 'SYSTEM';
      const messageType = context?.messageType || 'TEMPLATE';
      const templateName = context?.templateName || null;
      const templateLanguage = context?.templateLanguage || (messageType === 'TEMPLATE' ? 'en_US' : null);

      // Safe body representation: NEVER store plaintext OTP
      let safeBody: string | null = context?.body || null;
      if (source === 'AUTOMATION' || templateName === 'trayago_auth_otp') {
        safeBody = '[PROTECTED OTP]';
      }

      const insertMsgPayload = {
        conversation_id: conversationId,
        user_id: resolvedUserId,
        direction: 'OUTBOUND',
        source,
        message_type: messageType,
        template_name: templateName,
        template_language: templateLanguage,
        body: safeBody,
        wamid,
        status: 'SENT',
        sent_at: sentAt,
        smart_alert_id: context?.smartAlertId || null,
        admin_sender_id: context?.adminSenderId || null,
        metadata: context?.metadata || {},
        created_at: sentAt,
        updated_at: sentAt
      };

      const { error: insertMsgErr } = await supabase
        .from('whatsapp_messages')
        .insert(insertMsgPayload);

      if (insertMsgErr) {
        if (insertMsgErr.code === '23505' || insertMsgErr.message?.includes('duplicate key')) {
          winstonLogger.info(`[WHATSAPP_SERVICE] Duplicate message insertion ignored for WAMID: ${wamid}`);
        } else {
          winstonLogger.error(`[WHATSAPP_SERVICE] Failed to persist outbound message ${wamid}: ${insertMsgErr.message}`);
        }
      } else {
        winstonLogger.info(`[WHATSAPP_SERVICE] Successfully persisted outbound message WAMID: ${wamid} to ${maskPhoneNumber(canonicalPhone)}`);
      }
    } catch (err: any) {
      winstonLogger.error(`[WHATSAPP_SERVICE] Outbound persistence caught exception for ${wamid}: ${err?.message || 'unknown error'}`);
    }
  }

  // ── Internal Request Execution with Retry & Fail-Fast ────────────────────────

  private async executeGraphApiRequest(
    normalizedPhone: string,
    payload: Record<string, any>,
    context?: OutboundPersistenceContext
  ): Promise<WhatsAppSendResult> {
    const { config, error: configError } = this.getConfig();
    if (configError || !config) {
      winstonLogger.error(`[WHATSAPP_SERVICE] Configuration error: ${configError}`);
      return { success: false, reason: 'CONFIGURATION_ERROR' };
    }

    const url = `https://graph.facebook.com/${config.graphApiVersion}/${config.phoneNumberId}/messages`;
    const maskedPhone = maskPhoneNumber(normalizedPhone);

    const MAX_ATTEMPTS = 3;
    let attempt = 0;
    let lastError: any = null;
    let lastStatusCode: number | undefined;

    while (attempt < MAX_ATTEMPTS) {
      attempt++;

      try {
        if (!this.fetchClient) {
          throw new Error('HTTP fetch client is not available in environment');
        }

        const response = await this.fetchClient(url, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${config.token}`
          },
          body: JSON.stringify(payload)
        });

        lastStatusCode = response.status;
        const responseData = await response.json();

        if (response.ok && responseData?.messages?.[0]?.id) {
          const wamid = responseData.messages[0].id;
          winstonLogger.info(`[WHATSAPP_SERVICE] Message dispatched to ${maskedPhone}. WAMID: ${wamid}. Attempt: ${attempt}`);

          // STEP 5.9G: Outbound message persistence immediately after Meta returns 200 + valid WAMID
          try {
            await this.persistOutboundMessage(normalizedPhone, wamid, context);
          } catch (persistErr: any) {
            // CRITICAL: DB persistence failure must NEVER report Meta delivery failure to caller
            winstonLogger.error(`[WHATSAPP_SERVICE] Non-fatal persistence error for WAMID ${wamid}: ${persistErr?.message || 'unknown'}`);
          }

          return {
            success: true,
            wamid,
            attempts: attempt
          };
        }

        // Handle Meta API error structure
        const metaError = responseData?.error;
        const normalized = this.normalizeMetaError(metaError);

        winstonLogger.warn(
          `[WHATSAPP_SERVICE] Meta API error for ${maskedPhone} (Status: ${response.status}, Code: ${normalized.normalizedCode}): ${normalized.message}`
        );

        const retryable = this.isRetryableError(metaError, response.status);
        if (!retryable || attempt >= MAX_ATTEMPTS) {
          return {
            success: false,
            reason: normalized.normalizedCode,
            error: normalized,
            attempts: attempt
          };
        }

        lastError = normalized;
      } catch (networkErr: any) {
        lastError = networkErr;
        winstonLogger.error(`[WHATSAPP_SERVICE] Network exception on attempt ${attempt} for ${maskedPhone}: ${networkErr.message}`);

        const retryable = this.isRetryableError(networkErr, lastStatusCode);
        if (!retryable || attempt >= MAX_ATTEMPTS) {
          return {
            success: false,
            reason: 'NETWORK_ERROR',
            error: { message: networkErr.message },
            attempts: attempt
          };
        }
      }

      // Exponential backoff with small jitter: 50ms, 100ms, ... (fast backoff for test and prod)
      const delayMs = Math.min(1000, 50 * Math.pow(2, attempt - 1)) + Math.floor(Math.random() * 25);
      await new Promise(resolve => setTimeout(resolve, delayMs));
    }

    return {
      success: false,
      reason: 'MAX_RETRIES_EXCEEDED',
      error: lastError ? { message: lastError.message || String(lastError) } : undefined,
      attempts: attempt
    };
  }

  private extractTemplateBodyText(components?: TemplateComponent[]): string | undefined {
    if (!components || !Array.isArray(components)) return undefined;
    const bodyComp = components.find(c => c.type === 'body');
    if (bodyComp && Array.isArray(bodyComp.parameters)) {
      return bodyComp.parameters
        .map(p => p.text || p.payload || '')
        .filter(Boolean)
        .join(' ');
    }
    return undefined;
  }

  private resolveSmartAlertTemplateName(alertType: string): string {
    switch (alertType) {
      case 'DELAY':
        return 'trayago_train_delay_alert';
      case 'WL_CONFIRM':
        return 'trayago_waitlist_confirmation';
      case 'CHART_PREPARED':
        return 'trayago_chart_prepared';
      case 'PLATFORM_CHANGE':
        return 'trayago_platform_change';
      default:
        return 'trayago_smart_alert';
    }
  }
}

export const whatsAppService = new WhatsAppService();

