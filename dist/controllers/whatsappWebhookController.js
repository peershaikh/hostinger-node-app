"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.whatsappWebhookController = exports.WhatsAppWebhookController = void 0;
exports.toCanonicalE164 = toCanonicalE164;
exports.mapMessageType = mapMessageType;
exports.parseWebhookPayload = parseWebhookPayload;
exports.verifyHubSignature = verifyHubSignature;
const crypto_1 = __importDefault(require("crypto"));
const logger_1 = require("../middleware/logger");
const supabase_1 = require("../config/supabase");
const phoneNormalizer_1 = require("../utils/phoneNormalizer");
/**
 * Normalizes phone numbers to canonical E.164.
 * Uses Indian mobile normalizer (+91) as primary, with safe international E.164 fallback.
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
/**
 * Maps raw Meta message types to the check constraint enum in public.whatsapp_messages:
 * CHECK (message_type IN ('TEMPLATE', 'TEXT', 'MEDIA', 'INTERACTIVE'))
 */
function mapMessageType(type) {
    const lower = (type || '').toLowerCase();
    if (lower === 'text')
        return 'TEXT';
    if (['image', 'document', 'audio', 'video', 'sticker', 'media'].includes(lower))
        return 'MEDIA';
    if (['interactive', 'button', 'list'].includes(lower))
        return 'INTERACTIVE';
    if (lower === 'template')
        return 'TEMPLATE';
    return 'TEXT';
}
/**
 * Pure typed parser for Meta WhatsApp Webhook payloads.
 * Handles malformed payloads gracefully without throwing uncaught exceptions.
 */
function parseWebhookPayload(payload) {
    const result = {
        messages: [],
        statuses: [],
        contacts: []
    };
    if (!payload || typeof payload !== 'object') {
        return result;
    }
    const entries = Array.isArray(payload.entry) ? payload.entry : [];
    for (const entry of entries) {
        const changes = Array.isArray(entry?.changes) ? entry.changes : [];
        for (const change of changes) {
            const value = change?.value;
            if (!value)
                continue;
            result.messagingProduct = value.messaging_product;
            // Extract Contacts
            if (Array.isArray(value.contacts)) {
                for (const contact of value.contacts) {
                    if (contact?.wa_id) {
                        result.contacts.push({
                            wa_id: String(contact.wa_id),
                            name: contact?.profile?.name
                        });
                    }
                }
            }
            // Extract Inbound Messages
            if (Array.isArray(value.messages)) {
                for (const msg of value.messages) {
                    if (msg?.id && msg?.from) {
                        let extractedBody = msg.text?.body;
                        if (!extractedBody) {
                            if (msg[msg.type]?.caption)
                                extractedBody = msg[msg.type].caption;
                            else if (msg.interactive?.button_reply?.title)
                                extractedBody = msg.interactive.button_reply.title;
                            else if (msg.interactive?.list_reply?.title)
                                extractedBody = msg.interactive.list_reply.title;
                            else if (msg.button?.text)
                                extractedBody = msg.button.text;
                        }
                        result.messages.push({
                            id: String(msg.id),
                            from: String(msg.from),
                            timestamp: String(msg.timestamp || Date.now()),
                            type: String(msg.type || 'unknown'),
                            body: extractedBody,
                            raw: msg
                        });
                    }
                }
            }
            // Extract Status Callbacks (sent, delivered, read, failed)
            if (Array.isArray(value.statuses)) {
                for (const st of value.statuses) {
                    if (st?.id && st?.status) {
                        const errorObj = Array.isArray(st.errors) && st.errors.length > 0 ? st.errors[0] : null;
                        result.statuses.push({
                            id: String(st.id),
                            status: String(st.status),
                            timestamp: String(st.timestamp || Date.now()),
                            recipientId: st.recipient_id ? String(st.recipient_id) : undefined,
                            errorCode: errorObj ? String(errorObj.code) : undefined,
                            errorMessage: errorObj ? String(errorObj.message || errorObj.title) : undefined,
                            raw: st
                        });
                    }
                }
            }
        }
    }
    return result;
}
/**
 * Validates X-Hub-Signature-256 header using timingSafeEqual.
 */
function verifyHubSignature(rawBody, signatureHeader, appSecret) {
    if (!signatureHeader || !appSecret || rawBody === undefined || rawBody === null) {
        return false;
    }
    if (!signatureHeader.startsWith('sha256=')) {
        return false;
    }
    try {
        const rawBuffer = typeof rawBody === 'string' ? Buffer.from(rawBody, 'utf8') : rawBufferSafe(rawBody);
        const expectedHash = crypto_1.default.createHmac('sha256', appSecret).update(rawBuffer).digest('hex');
        const expectedHeader = `sha256=${expectedHash}`;
        const sigBuf = Buffer.from(signatureHeader, 'utf8');
        const expBuf = Buffer.from(expectedHeader, 'utf8');
        if (sigBuf.length !== expBuf.length) {
            return false;
        }
        return crypto_1.default.timingSafeEqual(sigBuf, expBuf);
    }
    catch (err) {
        logger_1.winstonLogger.warn(`[WHATSAPP_WEBHOOK] Signature comparison exception: ${err.message}`);
        return false;
    }
}
function rawBufferSafe(rawBody) {
    if (Buffer.isBuffer(rawBody))
        return rawBody;
    return Buffer.from(String(rawBody), 'utf8');
}
class WhatsAppWebhookController {
    constructor() {
        /**
         * GET /webhook — Meta Subscription Challenge Verification
         */
        this.verifyWebhook = (req, res) => {
            const mode = (req.query['hub.mode'] || req.query.hub_mode);
            const token = (req.query['hub.verify_token'] || req.query.hub_verify_token);
            const challenge = (req.query['hub.challenge'] || req.query.hub_challenge);
            const expectedToken = (process.env.META_WHATSAPP_WEBHOOK_VERIFY_TOKEN ||
                process.env.WHATSAPP_WEBHOOK_VERIFY_TOKEN)?.trim();
            if (!mode || !token || !challenge) {
                logger_1.winstonLogger.warn('[WHATSAPP_WEBHOOK] Verification failed: missing required hub query parameters.');
                return res.status(403).send('Forbidden');
            }
            if (mode === 'subscribe' && expectedToken && token === expectedToken) {
                logger_1.winstonLogger.info('[WHATSAPP_WEBHOOK] Webhook challenge verified successfully.');
                return res.status(200).send(challenge);
            }
            logger_1.winstonLogger.warn('[WHATSAPP_WEBHOOK] Verification failed: token mismatch or invalid mode.');
            return res.status(403).send('Forbidden');
        };
        /**
         * POST /webhook — Meta Event Ingestion with Signature Security & Fail-Closed Behavior
         */
        this.handleWebhook = async (req, res) => {
            // 1. Signature Security Verification (Reject missing/invalid signature with 403)
            const signature = (req.headers['x-hub-signature-256'] || req.headers['X-Hub-Signature-256']);
            const appSecret = process.env.META_APP_SECRET?.trim();
            // Use preserved rawBody or fallback to stringified body
            const rawBody = req.rawBody ?? (typeof req.body === 'string' ? req.body : JSON.stringify(req.body || {}));
            const isValidSignature = verifyHubSignature(rawBody, signature, appSecret);
            if (!isValidSignature) {
                logger_1.winstonLogger.warn('[WHATSAPP_WEBHOOK] Webhook event rejected: invalid or missing X-Hub-Signature-256.');
                return res.status(403).json({ error: 'Signature verification failed' });
            }
            // 2. Fail-Closed Check: If WhatsApp service is disabled, acknowledge safely without processing
            if (process.env.ENABLE_WHATSAPP_SERVICE !== 'true') {
                logger_1.winstonLogger.info('[WHATSAPP_WEBHOOK] Webhook event ignored — ENABLE_WHATSAPP_SERVICE is false.');
                return res.status(200).json({ status: 'ignored', reason: 'WHATSAPP_DISABLED' });
            }
            // 3. Fast Acknowledgment
            res.status(200).json({ status: 'received' });
            // 4. Safe Event Persistence Boundary (Zero Meta API calls)
            try {
                const parsedEvents = parseWebhookPayload(req.body);
                logger_1.winstonLogger.info(`[WHATSAPP_WEBHOOK] Webhook event received. Messages: ${parsedEvents.messages.length}, Statuses: ${parsedEvents.statuses.length}`);
                await this.persistWebhookEvents(parsedEvents);
            }
            catch (persistErr) {
                logger_1.winstonLogger.warn(`[WHATSAPP_WEBHOOK] Error during event persistence boundary: ${persistErr.message}`);
            }
            return res;
        };
    }
    /**
     * Safe asynchronous persistence boundary for inbound WhatsApp messages and status callbacks.
     */
    async persistWebhookEvents(parsedEvents) {
        let processedMessages = 0;
        let processedStatuses = 0;
        // ── 1. Process Inbound Messages ───────────────────────────────────────────
        for (const msg of parsedEvents.messages) {
            const canonicalPhone = toCanonicalE164(msg.from);
            if (!canonicalPhone) {
                logger_1.winstonLogger.warn(`[WHATSAPP_WEBHOOK] Inbound message ignored: invalid phone number (${(0, phoneNormalizer_1.maskPhoneNumber)(msg.from)})`);
                continue;
            }
            if (!msg.id) {
                logger_1.winstonLogger.warn('[WHATSAPP_WEBHOOK] Inbound message missing WAMID, skipped.');
                continue;
            }
            // Idempotency check: Do not reprocess an already stored WAMID
            const { data: existingMsg, error: checkMsgErr } = await supabase_1.supabase
                .from('whatsapp_messages')
                .select('id')
                .eq('wamid', msg.id)
                .maybeSingle();
            if (!checkMsgErr && existingMsg) {
                logger_1.winstonLogger.info(`[WHATSAPP_WEBHOOK] Duplicate message event ignored for WAMID: ${msg.id}`);
                continue;
            }
            // Resolve contact display name from contacts payload
            let contactName;
            if (parsedEvents.contacts && parsedEvents.contacts.length > 0) {
                const cleanFrom = msg.from.replace(/\D/g, '');
                const matchedContact = parsedEvents.contacts.find(c => {
                    const cleanWaId = c.wa_id.replace(/\D/g, '');
                    return cleanWaId === cleanFrom || c.wa_id === msg.from;
                });
                if (matchedContact?.name) {
                    contactName = matchedContact.name;
                }
            }
            // Resolve existing user from users table
            let userId = null;
            try {
                const { data: matchedUser } = await supabase_1.supabase
                    .from('users')
                    .select('id')
                    .eq('mobile_number', canonicalPhone)
                    .maybeSingle();
                if (matchedUser?.id) {
                    userId = matchedUser.id;
                }
                else {
                    // Check 10-digit number format
                    const digits10 = canonicalPhone.replace(/\D/g, '').slice(-10);
                    const { data: matchedUser10 } = await supabase_1.supabase
                        .from('users')
                        .select('id')
                        .eq('mobile_number', digits10)
                        .maybeSingle();
                    if (matchedUser10?.id) {
                        userId = matchedUser10.id;
                    }
                }
            }
            catch (userLookupErr) {
                logger_1.winstonLogger.warn(`[WHATSAPP_WEBHOOK] User lookup non-fatal error: ${userLookupErr.message}`);
            }
            // Find or create whatsapp_conversations record
            let conversationId = null;
            const messageTimestamp = msg.timestamp
                ? new Date(parseInt(msg.timestamp, 10) * 1000).toISOString()
                : new Date().toISOString();
            try {
                const { data: existingConv } = await supabase_1.supabase
                    .from('whatsapp_conversations')
                    .select('id, user_id, unread_count, metadata')
                    .eq('phone_e164', canonicalPhone)
                    .maybeSingle();
                if (existingConv) {
                    conversationId = existingConv.id;
                    const currentUnread = typeof existingConv.unread_count === 'number' ? existingConv.unread_count : 0;
                    const updatedMetadata = {
                        ...(existingConv.metadata || {}),
                        ...(contactName ? { contact_name: contactName } : {})
                    };
                    await supabase_1.supabase
                        .from('whatsapp_conversations')
                        .update({
                        last_message_at: messageTimestamp,
                        last_inbound_at: messageTimestamp,
                        unread_count: currentUnread + 1,
                        user_id: existingConv.user_id || userId,
                        metadata: updatedMetadata,
                        updated_at: new Date().toISOString()
                    })
                        .eq('id', conversationId);
                }
                else {
                    const insertConvPayload = {
                        phone_e164: canonicalPhone,
                        user_id: userId,
                        status: 'ACTIVE',
                        last_message_at: messageTimestamp,
                        last_inbound_at: messageTimestamp,
                        unread_count: 1,
                        metadata: contactName ? { contact_name: contactName } : {},
                        created_at: new Date().toISOString(),
                        updated_at: new Date().toISOString()
                    };
                    const { data: createdConv, error: createConvErr } = await supabase_1.supabase
                        .from('whatsapp_conversations')
                        .insert(insertConvPayload)
                        .select('id')
                        .single();
                    if (createConvErr || !createdConv?.id) {
                        // Re-query in case of concurrent insert race condition
                        const { data: fallbackConv } = await supabase_1.supabase
                            .from('whatsapp_conversations')
                            .select('id')
                            .eq('phone_e164', canonicalPhone)
                            .maybeSingle();
                        if (fallbackConv?.id) {
                            conversationId = fallbackConv.id;
                        }
                    }
                    else {
                        conversationId = createdConv.id;
                    }
                }
            }
            catch (convErr) {
                logger_1.winstonLogger.error(`[WHATSAPP_WEBHOOK] Conversation upsert failed for ${(0, phoneNormalizer_1.maskPhoneNumber)(canonicalPhone)}: ${convErr.message}`);
                continue;
            }
            if (!conversationId) {
                logger_1.winstonLogger.warn(`[WHATSAPP_WEBHOOK] Could not establish conversation container for ${(0, phoneNormalizer_1.maskPhoneNumber)(canonicalPhone)}`);
                continue;
            }
            // Insert whatsapp_messages record
            const messageType = mapMessageType(msg.type);
            const insertMessagePayload = {
                conversation_id: conversationId,
                user_id: userId,
                direction: 'INBOUND',
                source: 'USER',
                message_type: messageType,
                body: msg.body || null,
                wamid: msg.id,
                status: 'DELIVERED',
                metadata: msg.raw || {},
                delivered_at: messageTimestamp,
                created_at: new Date().toISOString(),
                updated_at: new Date().toISOString()
            };
            const { error: insertMsgErr } = await supabase_1.supabase
                .from('whatsapp_messages')
                .insert(insertMessagePayload);
            if (insertMsgErr) {
                if (insertMsgErr.code === '23505' || insertMsgErr.message?.includes('duplicate key')) {
                    logger_1.winstonLogger.info(`[WHATSAPP_WEBHOOK] Duplicate message insertion ignored for WAMID: ${msg.id}`);
                }
                else {
                    logger_1.winstonLogger.error(`[WHATSAPP_WEBHOOK] Failed to insert inbound message ${msg.id}: ${insertMsgErr.message}`);
                }
            }
            else {
                processedMessages++;
                logger_1.winstonLogger.info(`[WHATSAPP_WEBHOOK] Persisted inbound message WAMID: ${msg.id} for ${(0, phoneNormalizer_1.maskPhoneNumber)(canonicalPhone)}`);
            }
        }
        // ── 2. Process Delivery Status Updates ────────────────────────────────────
        for (const st of parsedEvents.statuses) {
            if (!st.id)
                continue;
            const { data: existingMsg, error: findMsgErr } = await supabase_1.supabase
                .from('whatsapp_messages')
                .select('id, status, conversation_id')
                .eq('wamid', st.id)
                .maybeSingle();
            if (findMsgErr || !existingMsg) {
                logger_1.winstonLogger.info(`[WHATSAPP_WEBHOOK] Status update skipped for unknown WAMID: ${st.id}`);
                continue;
            }
            const statusUpper = (st.status || '').toUpperCase();
            const statusTimestamp = st.timestamp
                ? new Date(parseInt(st.timestamp, 10) * 1000).toISOString()
                : new Date().toISOString();
            const updatePayload = {
                updated_at: new Date().toISOString()
            };
            if (statusUpper === 'SENT') {
                updatePayload.sent_at = statusTimestamp;
                if (existingMsg.status === 'QUEUED') {
                    updatePayload.status = 'SENT';
                }
            }
            else if (statusUpper === 'DELIVERED') {
                updatePayload.delivered_at = statusTimestamp;
                if (existingMsg.status === 'QUEUED' || existingMsg.status === 'SENT') {
                    updatePayload.status = 'DELIVERED';
                }
            }
            else if (statusUpper === 'READ') {
                updatePayload.read_at = statusTimestamp;
                updatePayload.status = 'READ';
            }
            else if (statusUpper === 'FAILED') {
                updatePayload.failed_at = statusTimestamp;
                updatePayload.status = 'FAILED';
                updatePayload.error_code = st.errorCode || null;
                updatePayload.error_message = st.errorMessage || null;
            }
            const { error: updateMsgErr } = await supabase_1.supabase
                .from('whatsapp_messages')
                .update(updatePayload)
                .eq('id', existingMsg.id);
            if (updateMsgErr) {
                logger_1.winstonLogger.error(`[WHATSAPP_WEBHOOK] Failed to update status for WAMID ${st.id}: ${updateMsgErr.message}`);
            }
            else {
                processedStatuses++;
                logger_1.winstonLogger.info(`[WHATSAPP_WEBHOOK] Updated status to ${statusUpper} for WAMID: ${st.id}`);
                // Update conversation last_outbound_at if outbound delivery was acknowledged
                if ((statusUpper === 'SENT' || statusUpper === 'DELIVERED') && existingMsg.conversation_id) {
                    try {
                        await supabase_1.supabase
                            .from('whatsapp_conversations')
                            .update({
                            last_outbound_at: statusTimestamp,
                            updated_at: new Date().toISOString()
                        })
                            .eq('id', existingMsg.conversation_id);
                    }
                    catch (convUpdateErr) {
                        logger_1.winstonLogger.warn(`[WHATSAPP_WEBHOOK] Non-fatal conversation timestamp update error: ${convUpdateErr.message}`);
                    }
                }
            }
        }
        return { processedMessages, processedStatuses };
    }
}
exports.WhatsAppWebhookController = WhatsAppWebhookController;
exports.whatsappWebhookController = new WhatsAppWebhookController();
