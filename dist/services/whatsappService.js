"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.whatsAppService = exports.WhatsAppService = void 0;
exports.toCanonicalE164 = toCanonicalE164;
const logger_1 = require("../middleware/logger");
const supabase_1 = require("../config/supabase");
const phoneNormalizer_1 = require("../utils/phoneNormalizer");
/**
 * Normalizes phone numbers to canonical E.164.
 * Uses Indian mobile normalizer (+91) as primary, with international E.164 fallback.
 */
function toCanonicalE164(phone) {
    if (!phone || typeof phone !== 'string')
        return null;
    const indian = (0, phoneNormalizer_1.normalizeIndianPhoneNumber)(phone);
    if (indian)
        return indian;
    const digits = phone.replace(/\D/g, '');
    if (digits.length >= 7 && digits.length <= 15) {
        return `+${digits}`;
    }
    return null;
}
class WhatsAppService {
    constructor(fetchClient) {
        this.fetchClient = fetchClient || (globalThis.fetch ? globalThis.fetch.bind(globalThis) : null);
    }
    /**
     * Allows injecting a mock fetch function for isolated unit testing.
     */
    setFetchClient(fetchClient) {
        this.fetchClient = fetchClient;
    }
    /**
     * Safe configuration validation without exposing token/secret values.
     */
    getConfig() {
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
    isServiceEnabled() {
        return process.env.ENABLE_WHATSAPP_SERVICE === 'true';
    }
    /**
     * Dispatches a pre-approved Meta WhatsApp Template message.
     */
    async sendTemplateMessage(params, context) {
        if (!this.isServiceEnabled()) {
            logger_1.winstonLogger.info('[WHATSAPP_SERVICE] Send skipped — ENABLE_WHATSAPP_SERVICE is false.');
            return { success: false, reason: 'WHATSAPP_DISABLED' };
        }
        const normalizedPhone = (0, phoneNormalizer_1.normalizeIndianPhoneNumber)(params.to);
        if (!normalizedPhone) {
            logger_1.winstonLogger.warn(`[WHATSAPP_SERVICE] Invalid phone number provided: ${(0, phoneNormalizer_1.maskPhoneNumber)(params.to)}`);
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
    async sendSmartAlertTemplate(to, alertType, templateData, smartAlertId) {
        if (!this.isServiceEnabled()) {
            return { success: false, reason: 'WHATSAPP_DISABLED' };
        }
        if (process.env.ENABLE_WHATSAPP_SMART_ALERTS !== 'true') {
            logger_1.winstonLogger.info('[WHATSAPP_SERVICE] Smart alert skipped — ENABLE_WHATSAPP_SMART_ALERTS is false.');
            return { success: false, reason: 'WHATSAPP_SMART_ALERTS_DISABLED' };
        }
        const templateName = this.resolveSmartAlertTemplateName(alertType);
        const componentResult = this.buildSmartAlertComponents(templateName, templateData);
        if (!componentResult.success) {
            logger_1.winstonLogger.warn(`[WHATSAPP_SERVICE] Smart alert parameter validation failed for template ${templateName}: ${componentResult.reason}`);
            return { success: false, reason: componentResult.reason };
        }
        const components = componentResult.components;
        const bodyText = componentResult.bodyText || this.extractTemplateBodyText(components);
        return this.sendTemplateMessage({
            to,
            templateName,
            languageCode: 'en_US',
            components
        }, {
            source: 'SYSTEM',
            smartAlertId,
            body: bodyText
        });
    }
    /**
     * Dispatches an Authentication OTP message using a pre-approved AUTHENTICATION template.
     */
    async sendAuthOtpTemplate(to, otpCode, context) {
        if (!this.isServiceEnabled()) {
            return { success: false, reason: 'WHATSAPP_DISABLED' };
        }
        if (process.env.ENABLE_WHATSAPP_OTP !== 'true') {
            logger_1.winstonLogger.info('[WHATSAPP_SERVICE] OTP skipped — ENABLE_WHATSAPP_OTP is false.');
            return { success: false, reason: 'WHATSAPP_OTP_DISABLED' };
        }
        const normalizedPhone = (0, phoneNormalizer_1.normalizeIndianPhoneNumber)(to);
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
    async sendSessionTextMessage(to, body, conversationIdOrContext) {
        if (!this.isServiceEnabled()) {
            return { success: false, reason: 'WHATSAPP_DISABLED' };
        }
        const normalizedPhone = (0, phoneNormalizer_1.normalizeIndianPhoneNumber)(to);
        if (!normalizedPhone) {
            return { success: false, reason: 'INVALID_PHONE_NUMBER' };
        }
        let adminSenderId;
        let userId;
        let conversationId;
        let source = 'ADMIN';
        if (typeof conversationIdOrContext === 'string') {
            conversationId = conversationIdOrContext;
        }
        else if (typeof conversationIdOrContext === 'object' && conversationIdOrContext !== null) {
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
    buildTemplatePayload(to, templateName, languageCode = 'en_US', components = []) {
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
    buildOtpPayload(to, otpCode) {
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
    buildSessionTextPayload(to, body) {
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
    normalizeMetaError(metaError) {
        const code = metaError?.code;
        const subcode = metaError?.error_subcode;
        const message = metaError?.message || 'Unknown Meta API error';
        const type = metaError?.type || 'OAuthException';
        const fbtrace_id = metaError?.fbtrace_id;
        let normalizedCode = 'META_API_ERROR';
        if (code === 131026 || code === 131047) {
            normalizedCode = 'CUSTOMER_WINDOW_EXPIRED';
        }
        else if (code === 130429) {
            normalizedCode = 'RATE_LIMIT_EXCEEDED';
        }
        else if (code === 132000) {
            normalizedCode = 'TEMPLATE_PARAM_MISMATCH';
        }
        else if (code === 131051) {
            normalizedCode = 'UNSUPPORTED_PHONE_NUMBER';
        }
        else if (code === 190) {
            normalizedCode = 'INVALID_ACCESS_TOKEN';
        }
        return { normalizedCode, code, subcode, message, type, fbtrace_id };
    }
    isRetryableError(error, statusCode) {
        if (statusCode === 429)
            return true;
        if (statusCode && statusCode >= 500 && statusCode <= 599)
            return true;
        if (statusCode && statusCode >= 400 && statusCode < 500)
            return false;
        // Transient network/socket errors
        const msg = error?.message?.toLowerCase() || '';
        const errCode = error?.code || '';
        if (errCode === 'ECONNRESET' ||
            errCode === 'ETIMEDOUT' ||
            errCode === 'ECONNREFUSED' ||
            errCode === 'EAI_AGAIN' ||
            msg.includes('fetch failed') ||
            msg.includes('network timeout') ||
            msg.includes('socket hang up')) {
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
    async persistOutboundMessage(to, wamid, context) {
        try {
            if (!wamid) {
                logger_1.winstonLogger.warn('[WHATSAPP_SERVICE] Outbound persistence skipped: missing WAMID.');
                return;
            }
            const canonicalPhone = toCanonicalE164(to);
            if (!canonicalPhone) {
                logger_1.winstonLogger.warn(`[WHATSAPP_SERVICE] Outbound persistence skipped: invalid phone (${(0, phoneNormalizer_1.maskPhoneNumber)(to)})`);
                return;
            }
            // 1. Idempotency check: Before inserting, ensure this WAMID does not already exist
            const { data: existingMsg, error: checkMsgErr } = await supabase_1.supabase
                .from('whatsapp_messages')
                .select('id')
                .eq('wamid', wamid)
                .maybeSingle();
            if (!checkMsgErr && existingMsg) {
                logger_1.winstonLogger.info(`[WHATSAPP_SERVICE] Duplicate outbound message ignored for WAMID: ${wamid}`);
                return;
            }
            const sentAt = new Date().toISOString();
            // 2. Resolve user by mobile number if not explicitly provided in caller context
            let resolvedUserId = context?.userId || null;
            if (!resolvedUserId) {
                try {
                    const { data: matchedUser } = await supabase_1.supabase
                        .from('users')
                        .select('id')
                        .eq('mobile_number', canonicalPhone)
                        .maybeSingle();
                    if (matchedUser?.id) {
                        resolvedUserId = matchedUser.id;
                    }
                    else {
                        const digits10 = canonicalPhone.replace(/\D/g, '').slice(-10);
                        const { data: matchedUser10 } = await supabase_1.supabase
                            .from('users')
                            .select('id')
                            .eq('mobile_number', digits10)
                            .maybeSingle();
                        if (matchedUser10?.id) {
                            resolvedUserId = matchedUser10.id;
                        }
                    }
                }
                catch (userErr) {
                    logger_1.winstonLogger.warn(`[WHATSAPP_SERVICE] User lookup non-fatal error: ${userErr?.message}`);
                }
            }
            // 3. Resolve or create whatsapp_conversations record
            let conversationId = context?.conversationId || null;
            if (!conversationId) {
                const { data: existingConv, error: convLookupErr } = await supabase_1.supabase
                    .from('whatsapp_conversations')
                    .select('id, user_id, unread_count')
                    .eq('phone_e164', canonicalPhone)
                    .maybeSingle();
                if (!convLookupErr && existingConv) {
                    conversationId = existingConv.id;
                    const updatePayload = {
                        last_message_at: sentAt,
                        last_outbound_at: sentAt,
                        updated_at: sentAt
                    };
                    // Backfill user_id when conversation exists but user_id is null and user_id is available
                    if (!existingConv.user_id && resolvedUserId) {
                        updatePayload.user_id = resolvedUserId;
                    }
                    const { error: updateConvErr } = await supabase_1.supabase
                        .from('whatsapp_conversations')
                        .update(updatePayload)
                        .eq('id', conversationId);
                    if (updateConvErr) {
                        logger_1.winstonLogger.warn(`[WHATSAPP_SERVICE] Failed to update conversation timestamps: ${updateConvErr.message}`);
                    }
                }
                else {
                    // Create new conversation
                    const insertConvPayload = {
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
                    const { data: createdConv, error: createConvErr } = await supabase_1.supabase
                        .from('whatsapp_conversations')
                        .insert(insertConvPayload)
                        .select('id')
                        .single();
                    if (createConvErr || !createdConv?.id) {
                        // Race condition: another concurrent execution inserted the conversation.
                        // Re-fetch existing conversation.
                        const { data: fallbackConv } = await supabase_1.supabase
                            .from('whatsapp_conversations')
                            .select('id, user_id')
                            .eq('phone_e164', canonicalPhone)
                            .maybeSingle();
                        if (fallbackConv?.id) {
                            conversationId = fallbackConv.id;
                            const updatePayload = {
                                last_message_at: sentAt,
                                last_outbound_at: sentAt,
                                updated_at: sentAt
                            };
                            if (!fallbackConv.user_id && resolvedUserId) {
                                updatePayload.user_id = resolvedUserId;
                            }
                            await supabase_1.supabase
                                .from('whatsapp_conversations')
                                .update(updatePayload)
                                .eq('id', conversationId);
                        }
                        else {
                            logger_1.winstonLogger.error(`[WHATSAPP_SERVICE] Failed to create or resolve conversation for ${(0, phoneNormalizer_1.maskPhoneNumber)(canonicalPhone)}: ${createConvErr?.message}`);
                        }
                    }
                    else {
                        conversationId = createdConv.id;
                    }
                }
            }
            if (!conversationId) {
                logger_1.winstonLogger.error(`[WHATSAPP_SERVICE] Could not resolve conversation container for ${(0, phoneNormalizer_1.maskPhoneNumber)(canonicalPhone)}`);
                return;
            }
            // 4. Insert outbound message row in public.whatsapp_messages
            const source = context?.source || 'SYSTEM';
            const messageType = context?.messageType || 'TEMPLATE';
            const templateName = context?.templateName || null;
            const templateLanguage = context?.templateLanguage || (messageType === 'TEMPLATE' ? 'en_US' : null);
            // Safe body representation: NEVER store plaintext OTP
            let safeBody = context?.body || null;
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
            const { error: insertMsgErr } = await supabase_1.supabase
                .from('whatsapp_messages')
                .insert(insertMsgPayload);
            if (insertMsgErr) {
                if (insertMsgErr.code === '23505' || insertMsgErr.message?.includes('duplicate key')) {
                    logger_1.winstonLogger.info(`[WHATSAPP_SERVICE] Duplicate message insertion ignored for WAMID: ${wamid}`);
                }
                else {
                    logger_1.winstonLogger.error(`[WHATSAPP_SERVICE] Failed to persist outbound message ${wamid}: ${insertMsgErr.message}`);
                }
            }
            else {
                logger_1.winstonLogger.info(`[WHATSAPP_SERVICE] Successfully persisted outbound message WAMID: ${wamid} to ${(0, phoneNormalizer_1.maskPhoneNumber)(canonicalPhone)}`);
            }
        }
        catch (err) {
            logger_1.winstonLogger.error(`[WHATSAPP_SERVICE] Outbound persistence caught exception for ${wamid}: ${err?.message || 'unknown error'}`);
        }
    }
    // ── Internal Request Execution with Retry & Fail-Fast ────────────────────────
    async executeGraphApiRequest(normalizedPhone, payload, context) {
        const { config, error: configError } = this.getConfig();
        if (configError || !config) {
            logger_1.winstonLogger.error(`[WHATSAPP_SERVICE] Configuration error: ${configError}`);
            return { success: false, reason: 'CONFIGURATION_ERROR' };
        }
        const url = `https://graph.facebook.com/${config.graphApiVersion}/${config.phoneNumberId}/messages`;
        const maskedPhone = (0, phoneNormalizer_1.maskPhoneNumber)(normalizedPhone);
        const MAX_ATTEMPTS = 3;
        let attempt = 0;
        let lastError = null;
        let lastStatusCode;
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
                    logger_1.winstonLogger.info(`[WHATSAPP_SERVICE] Message dispatched to ${maskedPhone}. WAMID: ${wamid}. Attempt: ${attempt}`);
                    // STEP 5.9G: Outbound message persistence immediately after Meta returns 200 + valid WAMID
                    try {
                        await this.persistOutboundMessage(normalizedPhone, wamid, context);
                    }
                    catch (persistErr) {
                        // CRITICAL: DB persistence failure must NEVER report Meta delivery failure to caller
                        logger_1.winstonLogger.error(`[WHATSAPP_SERVICE] Non-fatal persistence error for WAMID ${wamid}: ${persistErr?.message || 'unknown'}`);
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
                logger_1.winstonLogger.warn(`[WHATSAPP_SERVICE] Meta API error for ${maskedPhone} (Status: ${response.status}, Code: ${normalized.normalizedCode}): ${normalized.message}`);
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
            }
            catch (networkErr) {
                lastError = networkErr;
                logger_1.winstonLogger.error(`[WHATSAPP_SERVICE] Network exception on attempt ${attempt} for ${maskedPhone}: ${networkErr.message}`);
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
    extractTemplateBodyText(components) {
        if (!components || !Array.isArray(components))
            return undefined;
        const bodyComp = components.find(c => c.type === 'body');
        if (bodyComp && Array.isArray(bodyComp.parameters)) {
            return bodyComp.parameters
                .map(p => p.text || p.payload || '')
                .filter(Boolean)
                .join(' ');
        }
        return undefined;
    }
    resolveSmartAlertTemplateName(alertType) {
        switch (alertType) {
            case 'DELAY':
            case 'trayago_train_delay_alert':
                return 'trayago_train_delay_alert';
            case 'WL_CONFIRM':
            case 'trayago_waitlist_confirmation':
                return 'trayago_waitlist_confirmation';
            case 'CHART_PREPARED':
            case 'trayago_chart_prepared':
                return 'trayago_chart_prepared';
            case 'PLATFORM_CHANGE':
            case 'trayago_platform_change':
                return 'trayago_platform_change';
            default:
                return 'trayago_smart_alert';
        }
    }
    buildSmartAlertComponents(templateName, data) {
        const safeData = data || {};
        if (templateName === 'trayago_train_delay_alert') {
            const title = cleanTemplateValue(safeData.title);
            const message = cleanTemplateValue(safeData.message);
            const trainNo = cleanTemplateValue(safeData.trainNo ?? safeData.train_no ?? safeData.trainNumber ?? safeData.train_number);
            const currentDelayMins = cleanTemplateValue(safeData.currentDelayMins ?? safeData.current_delay_mins ?? safeData.delayMins ?? safeData.delay_mins ?? safeData.delayMinutes ?? safeData.delay_minutes ?? safeData.delay);
            if (!title || !message || !trainNo || !currentDelayMins) {
                return { success: false, reason: 'MISSING_DELAY_PARAMETERS' };
            }
            const parameters = [
                { type: 'text', text: title },
                { type: 'text', text: message },
                { type: 'text', text: trainNo },
                { type: 'text', text: currentDelayMins }
            ];
            return {
                success: true,
                components: [{ type: 'body', parameters }],
                bodyText: `${title}: ${message} (Train ${trainNo}, Delay ${currentDelayMins}m)`
            };
        }
        if (templateName === 'trayago_waitlist_confirmation') {
            const title = cleanTemplateValue(safeData.title);
            const message = cleanTemplateValue(safeData.message);
            const pnr = cleanTemplateValue(safeData.pnr ?? safeData.pnrNumber ?? safeData.pnr_number);
            const oldStatus = cleanTemplateValue(safeData.oldStatus ?? safeData.old_status ?? safeData.previousStatus ?? safeData.previous_status);
            const newStatus = cleanTemplateValue(safeData.newStatus ?? safeData.new_status ?? safeData.currentStatus ?? safeData.current_status ?? safeData.status);
            if (!title || !message || !pnr || !oldStatus || !newStatus) {
                return { success: false, reason: 'MISSING_WAITLIST_PARAMETERS' };
            }
            const parameters = [
                { type: 'text', text: title },
                { type: 'text', text: message },
                { type: 'text', text: pnr },
                { type: 'text', text: oldStatus },
                { type: 'text', text: newStatus }
            ];
            return {
                success: true,
                components: [{ type: 'body', parameters }],
                bodyText: `${title}: ${message} (PNR ${pnr}: ${oldStatus} -> ${newStatus})`
            };
        }
        if (templateName === 'trayago_chart_prepared') {
            const title = cleanTemplateValue(safeData.title);
            const message = cleanTemplateValue(safeData.message);
            const pnr = cleanTemplateValue(safeData.pnr ?? safeData.pnrNumber ?? safeData.pnr_number);
            const chartStatus = cleanTemplateValue(safeData.chartStatus ?? safeData.chart_status ?? safeData.chartingStatus ?? safeData.charting_status ?? safeData.status);
            if (!title || !message || !pnr || !chartStatus) {
                return { success: false, reason: 'MISSING_CHART_PARAMETERS' };
            }
            const parameters = [
                { type: 'text', text: title },
                { type: 'text', text: message },
                { type: 'text', text: pnr },
                { type: 'text', text: chartStatus }
            ];
            return {
                success: true,
                components: [{ type: 'body', parameters }],
                bodyText: `${title}: ${message} (PNR ${pnr}, Chart: ${chartStatus})`
            };
        }
        if (templateName === 'trayago_platform_change') {
            const title = cleanTemplateValue(safeData.title);
            const message = cleanTemplateValue(safeData.message);
            const trainNo = cleanTemplateValue(safeData.trainNo ?? safeData.train_no ?? safeData.trainNumber ?? safeData.train_number);
            const station = cleanTemplateValue(safeData.station ?? safeData.stationCode ?? safeData.station_code ?? safeData.stationName ?? safeData.station_name);
            const oldPlatform = cleanTemplateValue(safeData.oldPlatform ?? safeData.old_platform ?? safeData.previousPlatform ?? safeData.previous_platform);
            const newPlatform = cleanTemplateValue(safeData.newPlatform ?? safeData.new_platform ?? safeData.currentPlatform ?? safeData.current_platform ?? safeData.platform);
            if (!title || !message || !trainNo || !station || !oldPlatform || !newPlatform) {
                return { success: false, reason: 'MISSING_PLATFORM_PARAMETERS' };
            }
            const parameters = [
                { type: 'text', text: title },
                { type: 'text', text: message },
                { type: 'text', text: trainNo },
                { type: 'text', text: station },
                { type: 'text', text: oldPlatform },
                { type: 'text', text: newPlatform }
            ];
            return {
                success: true,
                components: [{ type: 'body', parameters }],
                bodyText: `${title}: ${message} (Train ${trainNo} at ${station}: Platform ${oldPlatform} -> ${newPlatform})`
            };
        }
        // Default: trayago_smart_alert (including WAKEUP_ALARM and fallback alerts)
        // Documented smart-alert fallback allows title to default to 'Trayago Smart Alert'
        const title = cleanTemplateValue(safeData.title) || 'Trayago Smart Alert';
        const message = cleanTemplateValue(safeData.message);
        if (!message) {
            return { success: false, reason: 'MISSING_MESSAGE_PARAMETER' };
        }
        const parameters = [
            { type: 'text', text: title },
            { type: 'text', text: message }
        ];
        return {
            success: true,
            components: [{ type: 'body', parameters }],
            bodyText: `${title}: ${message}`
        };
    }
}
exports.WhatsAppService = WhatsAppService;
function cleanTemplateValue(val) {
    if (val === null || val === undefined)
        return null;
    const str = String(val).trim();
    return str.length > 0 ? str : null;
}
exports.whatsAppService = new WhatsAppService();
