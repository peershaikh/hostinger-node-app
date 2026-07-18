"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.alertDispatcher = exports.AlertDispatcher = void 0;
const node_cron_1 = __importDefault(require("node-cron"));
const crypto_1 = __importDefault(require("crypto"));
const supabase_1 = require("../config/supabase");
const logger_1 = require("../middleware/logger");
const emailService_1 = require("../services/emailService");
const pushService_1 = require("../services/pushService");
const firebaseService = __importStar(require("../services/firebaseService"));
const notificationController_1 = require("../controllers/notificationController");
class AlertDispatcher {
    constructor() {
        this.isProcessing = false;
    }
    start() {
        logger_1.winstonLogger.info('[ALERT_DISPATCHER] Starting background worker...');
        // Run every minute
        node_cron_1.default.schedule('* * * * *', async () => {
            if (this.isProcessing)
                return;
            this.isProcessing = true;
            try {
                await this.processPendingAlerts();
            }
            catch (err) {
                logger_1.winstonLogger.error(`[ALERT_DISPATCHER] Error: ${err.message}`);
            }
            finally {
                this.isProcessing = false;
            }
        });
    }
    async processPendingAlerts() {
        // 1. Fetch pending alerts
        const { data: alerts, error: fetchErr } = await supabase_1.supabase
            .from('smart_alerts')
            .select(`
        id, 
        user_id, 
        alert_type, 
        metadata
      `)
            .eq('status', 'PENDING')
            .limit(50); // Batch size
        if (fetchErr) {
            throw new Error(`Failed to fetch pending alerts: ${fetchErr.message}`);
        }
        if (!alerts || alerts.length === 0) {
            return; // Nothing to do
        }
        logger_1.winstonLogger.info(`[ALERT_DISPATCHER] Processing ${alerts.length} pending alerts.`);
        for (const alert of alerts) {
            try {
                let userEmail = null;
                if (alert.user_id) {
                    const { data: userData } = await supabase_1.supabase.from('users').select('email').eq('id', alert.user_id).single();
                    if (userData) {
                        userEmail = userData.email;
                    }
                }
                const metadata = alert.metadata || {};
                const title = metadata.title || `Trayago: ${alert.alert_type} Alert`;
                const message = metadata.message || 'You have a new update regarding your train journey.';
                // 2. Validate preferences (skip if disabled)
                let isCategoryEnabled = true;
                if (alert.user_id) {
                    const { data: prefs, error: prefsErr } = await supabase_1.supabase
                        .from('user_notification_preferences')
                        .select('*')
                        .eq('user_id', alert.user_id)
                        .maybeSingle();
                    if (!prefsErr && prefs) {
                        if (alert.alert_type === 'DELAY' && !prefs.delay_alerts_enabled) {
                            isCategoryEnabled = false;
                        }
                        else if ((alert.alert_type === 'WL_CONFIRM' || alert.alert_type === 'CHART_PREPARED') && !prefs.waitlist_alerts_enabled) {
                            isCategoryEnabled = false;
                        }
                        else if (alert.alert_type === 'PLATFORM_CHANGE' && !prefs.platform_alerts_enabled) {
                            isCategoryEnabled = false;
                        }
                    }
                }
                if (!isCategoryEnabled) {
                    logger_1.winstonLogger.info(`[ALERT_DISPATCHER] Skipping alert ${alert.id} of type ${alert.alert_type} due to user preferences.`);
                    await supabase_1.supabase
                        .from('smart_alerts')
                        .update({
                        status: 'DELIVERED',
                        updated_at: new Date().toISOString(),
                        metadata: { ...metadata, dispatch_skipped_reason: 'user_preference_disabled' }
                    })
                        .eq('id', alert.id);
                    continue;
                }
                let delivered = false;
                // 3. Dispatch via Email
                if (userEmail) {
                    const emailSent = await emailService_1.emailService.sendAlertEmail(userEmail, title, message);
                    if (emailSent)
                        delivered = true;
                }
                // 4. Fetch matched push tokens (FCM)
                let tokens = [];
                if (alert.user_id) {
                    const { data: userTokens, error: tokensErr } = await supabase_1.supabase
                        .from('user_push_tokens')
                        .select('id, fcm_token, device_type')
                        .eq('user_id', alert.user_id);
                    if (!tokensErr && userTokens) {
                        tokens = userTokens;
                    }
                }
                else if (metadata.device_id) {
                    const { data: guestTokens, error: tokensErr } = await supabase_1.supabase
                        .from('user_push_tokens')
                        .select('id, fcm_token, device_type')
                        .eq('device_id', metadata.device_id);
                    if (!tokensErr && guestTokens) {
                        tokens = guestTokens;
                    }
                }
                // 5. Dispatch via FCM in parallel
                let fcmDelivered = false;
                if (tokens.length > 0) {
                    const stringifiedData = {};
                    for (const [key, val] of Object.entries(metadata)) {
                        if (val !== null && val !== undefined) {
                            stringifiedData[key] = typeof val === 'object' ? JSON.stringify(val) : String(val);
                        }
                    }
                    stringifiedData.alert_type = alert.alert_type;
                    stringifiedData.alert_id = alert.id;
                    const sendPromises = tokens.map(async (t) => {
                        try {
                            const decryptedToken = (0, notificationController_1.decryptToken)(t.fcm_token);
                            const success = await firebaseService.sendPushNotification(decryptedToken, title, message, stringifiedData);
                            return success;
                        }
                        catch (err) {
                            logger_1.winstonLogger.error(`[ALERT_DISPATCHER] Firebase send failed for token id ${t.id}: ${err.message}`);
                            const isInvalidTokenError = err.code === 'messaging/registration-token-not-registered' ||
                                err.code === 'messaging/invalid-argument' ||
                                (err.message && (err.message.includes('registration-token-not-registered') ||
                                    err.message.includes('not-registered') ||
                                    err.message.includes('invalid-argument')));
                            if (isInvalidTokenError) {
                                logger_1.winstonLogger.info(`[ALERT_DISPATCHER] Pruning invalid token row: ${t.id}`);
                                await supabase_1.supabase.from('user_push_tokens').delete().eq('id', t.id);
                            }
                            return false;
                        }
                    });
                    const results = await Promise.allSettled(sendPromises);
                    fcmDelivered = results.some(r => r.status === 'fulfilled' && r.value === true);
                    if (fcmDelivered)
                        delivered = true;
                }
                // 6. Dispatch via OneSignal (fallback only if FCM not delivered)
                const pushDelivered = fcmDelivered;
                if (!pushDelivered && alert.user_id) {
                    logger_1.winstonLogger.info(`[ALERT_DISPATCHER] FCM delivery unavailable. Falling back to OneSignal for user: ${alert.user_id}`);
                    const pushSent = await pushService_1.pushService.sendToUsers([alert.user_id], title, message);
                    if (pushSent)
                        delivered = true;
                }
                // 6B. Log successful delivery to user notification history
                if (delivered) {
                    try {
                        const { error: histError } = await supabase_1.supabase
                            .from('user_notification_history')
                            .insert({
                            user_id: alert.user_id,
                            device_id: metadata.device_id || null,
                            title,
                            body: message,
                            category: alert.alert_type,
                            metadata: metadata,
                            is_read: false,
                            created_at: new Date().toISOString(),
                            updated_at: new Date().toISOString()
                        });
                        if (histError)
                            throw histError;
                    }
                    catch (histDbErr) {
                        logger_1.winstonLogger.info(`[ALERT_DISPATCHER] Failed to write notification history to DB, writing to memory: ${histDbErr.message}`);
                        const { MEMORY_NOTIFICATION_HISTORY } = require('../controllers/notificationController');
                        MEMORY_NOTIFICATION_HISTORY.push({
                            id: crypto_1.default.randomUUID(),
                            user_id: alert.user_id,
                            device_id: metadata.device_id || null,
                            title,
                            body: message,
                            category: alert.alert_type,
                            metadata: metadata,
                            is_read: false,
                            created_at: new Date(),
                            updated_at: new Date()
                        });
                    }
                }
                // 7. Update status
                const newStatus = delivered ? 'DELIVERED' : 'FAILED';
                await supabase_1.supabase
                    .from('smart_alerts')
                    .update({
                    status: newStatus,
                    updated_at: new Date().toISOString()
                })
                    .eq('id', alert.id);
                logger_1.winstonLogger.debug(`[ALERT_DISPATCHER] Alert ${alert.id} marked as ${newStatus}.`);
            }
            catch (err) {
                logger_1.winstonLogger.error(`[ALERT_DISPATCHER] Failed to process alert ${alert.id}: ${err.message}`);
                await supabase_1.supabase.from('smart_alerts').update({ status: 'FAILED' }).eq('id', alert.id);
            }
        }
    }
}
exports.AlertDispatcher = AlertDispatcher;
exports.alertDispatcher = new AlertDispatcher();
