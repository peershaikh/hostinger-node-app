"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.broadcastService = exports.BroadcastService = void 0;
const supabase_1 = require("../config/supabase");
const emailService_1 = require("./emailService");
const whatsappService_1 = require("./whatsappService");
const logger_1 = require("../middleware/logger");
class BroadcastService {
    /**
     * Retrieves accurate live count of registered users, emails, and WhatsApp mobile contacts.
     */
    async getAudienceStats() {
        if (!(0, supabase_1.isSupabaseConfigured)()) {
            return { totalUsers: 0, emailUsers: 0, phoneUsers: 0, verifiedPhoneUsers: 0 };
        }
        const { data: users, error } = await supabase_1.supabase
            .from('users')
            .select('id, email, mobile_number, mobile_verified');
        if (error || !users) {
            logger_1.winstonLogger.error(`[BROADCAST_AUDIENCE_STATS_ERR] ${error?.message}`);
            return { totalUsers: 0, emailUsers: 0, phoneUsers: 0, verifiedPhoneUsers: 0 };
        }
        const totalUsers = users.length;
        const emailUsers = users.filter(u => Boolean(u.email && u.email.includes('@'))).length;
        const phoneUsers = users.filter(u => Boolean(u.mobile_number && u.mobile_number.trim().length >= 10)).length;
        const verifiedPhoneUsers = users.filter(u => u.mobile_verified === true).length;
        return { totalUsers, emailUsers, phoneUsers, verifiedPhoneUsers };
    }
    /**
     * Executes campaign broadcast or single test dispatch to Email, WhatsApp, or both channels.
     */
    async executeBroadcast(payload) {
        const { channel, mode, testEmail = 'peershaikh25@gmail.com', testPhone, title, message, offerPrice, originalPrice, promoCode, actionUrl = 'https://www.trayago.in/pricing', actionLabel = 'Explore Now', bannerUrl } = payload;
        // ── 1. TEST MODE ───────────────────────────────────────────────────────────
        if (mode === 'test') {
            logger_1.winstonLogger.info(`[BROADCAST_TEST] Channel: ${channel}, testEmail: ${testEmail}, testPhone: ${testPhone}`);
            let emailResult = { attempted: false, delivered: false, recipient: testEmail };
            let whatsappResult = { attempted: false, delivered: false, recipient: testPhone };
            // Dispatch Test Email
            if (channel === 'EMAIL' || channel === 'BOTH') {
                if (testEmail) {
                    emailResult.attempted = true;
                    try {
                        const ok = await emailService_1.emailService.sendCustomCampaignEmail({
                            toEmail: testEmail,
                            userName: 'Peer Shaikh',
                            title,
                            message,
                            offerPrice,
                            originalPrice,
                            promoCode,
                            actionUrl,
                            actionLabel,
                            bannerUrl
                        });
                        emailResult.delivered = ok;
                    }
                    catch (err) {
                        logger_1.winstonLogger.error(`[BROADCAST_TEST_EMAIL_ERR] ${err.message}`);
                    }
                }
            }
            // Dispatch Test WhatsApp
            if (channel === 'WHATSAPP' || channel === 'BOTH') {
                if (testPhone) {
                    whatsappResult.attempted = true;
                    try {
                        const res = await whatsappService_1.whatsAppService.sendCampaignMessage(testPhone, {
                            title,
                            message,
                            offerPrice,
                            originalPrice,
                            promoCode,
                            actionUrl,
                            actionLabel,
                            userName: 'Peer Shaikh'
                        });
                        whatsappResult.delivered = res.success;
                    }
                    catch (err) {
                        logger_1.winstonLogger.error(`[BROADCAST_TEST_WA_ERR] ${err.message}`);
                    }
                }
            }
            return {
                success: true,
                mode: 'test',
                channel,
                emailResult,
                whatsappResult,
                message: 'Test campaign dispatch executed.'
            };
        }
        // ── 2. LIVE BROADCAST MODE ─────────────────────────────────────────────────
        logger_1.winstonLogger.info(`[BROADCAST_LIVE_START] Launching broadcast across channel: ${channel}`);
        if (!(0, supabase_1.isSupabaseConfigured)()) {
            throw new Error('Database is not configured for user lookup.');
        }
        const { data: users, error } = await supabase_1.supabase
            .from('users')
            .select('id, email, full_name, mobile_number, mobile_verified');
        if (error || !users) {
            throw new Error(`Failed to query user audience: ${error?.message || 'Unknown error'}`);
        }
        const stats = {
            email: { target: 0, sent: 0, failed: 0 },
            whatsapp: { target: 0, sent: 0, failed: 0 }
        };
        const failures = [];
        // ── EMAIL DISPATCH PIPELINE ────────────────────────────────────────────────
        if (channel === 'EMAIL' || channel === 'BOTH') {
            const emailMap = new Map();
            for (const u of users) {
                const raw = (u.email || '').trim().toLowerCase();
                if (raw && raw.includes('@') && raw.includes('.')) {
                    if (!emailMap.has(raw)) {
                        emailMap.set(raw, { email: raw, name: u.full_name || 'Traveler' });
                    }
                }
            }
            const emailRecipients = Array.from(emailMap.values());
            stats.email.target = emailRecipients.length;
            logger_1.winstonLogger.info(`[BROADCAST_EMAIL] Target count: ${emailRecipients.length}`);
            const BATCH_SIZE = 15;
            for (let i = 0; i < emailRecipients.length; i += BATCH_SIZE) {
                const batch = emailRecipients.slice(i, i + BATCH_SIZE);
                await Promise.all(batch.map(async (r) => {
                    try {
                        const ok = await emailService_1.emailService.sendCustomCampaignEmail({
                            toEmail: r.email,
                            userName: r.name,
                            title,
                            message,
                            offerPrice,
                            originalPrice,
                            promoCode,
                            actionUrl,
                            actionLabel,
                            bannerUrl
                        });
                        if (ok)
                            stats.email.sent++;
                        else {
                            stats.email.failed++;
                            failures.push({ channel: 'EMAIL', recipient: r.email, error: 'Provider returned false' });
                        }
                    }
                    catch (err) {
                        stats.email.failed++;
                        failures.push({ channel: 'EMAIL', recipient: r.email, error: err.message || 'Send failed' });
                    }
                }));
                if (i + BATCH_SIZE < emailRecipients.length) {
                    await new Promise(resolve => setTimeout(resolve, 1000));
                }
            }
        }
        // ── WHATSAPP DISPATCH PIPELINE ─────────────────────────────────────────────
        if (channel === 'WHATSAPP' || channel === 'BOTH') {
            const phoneMap = new Map();
            for (const u of users) {
                const canonical = (0, whatsappService_1.toCanonicalE164)(u.mobile_number);
                if (canonical) {
                    if (!phoneMap.has(canonical)) {
                        phoneMap.set(canonical, { phone: canonical, name: u.full_name || 'Traveler' });
                    }
                }
            }
            const phoneRecipients = Array.from(phoneMap.values());
            stats.whatsapp.target = phoneRecipients.length;
            logger_1.winstonLogger.info(`[BROADCAST_WHATSAPP] Target count: ${phoneRecipients.length}`);
            const BATCH_SIZE = 15;
            for (let i = 0; i < phoneRecipients.length; i += BATCH_SIZE) {
                const batch = phoneRecipients.slice(i, i + BATCH_SIZE);
                await Promise.all(batch.map(async (r) => {
                    try {
                        const res = await whatsappService_1.whatsAppService.sendCampaignMessage(r.phone, {
                            title,
                            message,
                            offerPrice,
                            originalPrice,
                            promoCode,
                            actionUrl,
                            actionLabel,
                            userName: r.name
                        });
                        if (res.success) {
                            stats.whatsapp.sent++;
                        }
                        else {
                            stats.whatsapp.failed++;
                            failures.push({
                                channel: 'WHATSAPP',
                                recipient: r.phone,
                                error: res.reason || res.error?.message || 'Meta API rejected'
                            });
                        }
                    }
                    catch (err) {
                        stats.whatsapp.failed++;
                        failures.push({ channel: 'WHATSAPP', recipient: r.phone, error: err.message || 'Send error' });
                    }
                }));
                if (i + BATCH_SIZE < phoneRecipients.length) {
                    await new Promise(resolve => setTimeout(resolve, 1000));
                }
            }
        }
        logger_1.winstonLogger.info(`[BROADCAST_LIVE_COMPLETE] Email: ${stats.email.sent}/${stats.email.target}, WA: ${stats.whatsapp.sent}/${stats.whatsapp.target}`);
        return {
            success: true,
            mode: 'broadcast',
            channel,
            stats,
            totalDelivered: stats.email.sent + stats.whatsapp.sent,
            failures: failures.slice(0, 15),
            message: `Broadcast completed. Email delivered: ${stats.email.sent}/${stats.email.target}. WhatsApp delivered: ${stats.whatsapp.sent}/${stats.whatsapp.target}.`
        };
    }
}
exports.BroadcastService = BroadcastService;
exports.broadcastService = new BroadcastService();
