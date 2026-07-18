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
Object.defineProperty(exports, "__esModule", { value: true });
exports.pushService = void 0;
const OneSignal = __importStar(require("@onesignal/node-onesignal"));
const logger_1 = require("../middleware/logger");
class PushService {
    constructor() {
        this.client = null;
        this.appId = null;
        this.appId = process.env.ONESIGNAL_APP_ID || null;
        const apiKey = process.env.ONESIGNAL_REST_API_KEY || null;
        if (!this.appId || !apiKey) {
            logger_1.winstonLogger.warn('[PUSH] OneSignal configuration missing (ONESIGNAL_APP_ID or ONESIGNAL_REST_API_KEY). Push notifications disabled.');
            return;
        }
        // Configure OneSignal client
        const configuration = OneSignal.createConfiguration({
            restApiKey: apiKey,
        });
        this.client = new OneSignal.DefaultApi(configuration);
        logger_1.winstonLogger.info('[PUSH] OneSignal push service initialized.');
    }
    /**
     * Send a push notification to specific users by their external_id (Supabase User ID)
     */
    async sendToUsers(userIds, title, message, url) {
        if (!this.client || !this.appId) {
            logger_1.winstonLogger.debug('[PUSH] Push disabled, skipping sendToUsers.');
            return false;
        }
        try {
            const notification = new OneSignal.Notification();
            notification.app_id = this.appId;
            notification.include_aliases = { external_id: userIds };
            notification.target_channel = 'push';
            notification.headings = { en: title };
            notification.contents = { en: message };
            if (url) {
                notification.url = url;
            }
            const response = await this.client.createNotification(notification);
            logger_1.winstonLogger.info(`[PUSH] Dispatched push to ${userIds.length} users. Response ID: ${response.id}`);
            return true;
        }
        catch (error) {
            logger_1.winstonLogger.error(`[PUSH] Failed to send push notification: ${error.message}`);
            return false;
        }
    }
    /**
     * Send a push notification to all subscribers (e.g., global announcements)
     */
    async sendGlobal(title, message, url) {
        if (!this.client || !this.appId) {
            return false;
        }
        try {
            const notification = new OneSignal.Notification();
            notification.app_id = this.appId;
            notification.included_segments = ['Subscribed Users'];
            notification.headings = { en: title };
            notification.contents = { en: message };
            if (url) {
                notification.url = url;
            }
            const response = await this.client.createNotification(notification);
            logger_1.winstonLogger.info(`[PUSH] Dispatched global push. Response ID: ${response.id}`);
            return true;
        }
        catch (error) {
            logger_1.winstonLogger.error(`[PUSH] Failed to send global push: ${error.message}`);
            return false;
        }
    }
}
exports.pushService = new PushService();
