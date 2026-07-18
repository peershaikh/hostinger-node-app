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
exports.broadcastToTopic = exports.sendPushNotification = exports.initFirebaseAdmin = void 0;
const admin = __importStar(require("firebase-admin"));
const logger_1 = require("../middleware/logger");
/**
 * Initializes the Firebase Admin SDK.
 * Used for sending push notifications securely from the backend.
 *
 * Requires FIREBASE_SERVICE_ACCOUNT_BASE64 to be set in production.
 */
const initFirebaseAdmin = () => {
    try {
        const serviceAccountBase64 = process.env.FIREBASE_SERVICE_ACCOUNT_BASE64;
        if (!serviceAccountBase64) {
            logger_1.winstonLogger.warn('[FIREBASE] Missing FIREBASE_SERVICE_ACCOUNT_BASE64. Push notifications disabled.');
            return;
        }
        const serviceAccount = JSON.parse(Buffer.from(serviceAccountBase64, 'base64').toString('utf8'));
        if (!admin.apps.length) {
            admin.initializeApp({
                credential: admin.credential.cert(serviceAccount)
            });
            logger_1.winstonLogger.info('[FIREBASE] Admin SDK initialized successfully.');
        }
    }
    catch (error) {
        logger_1.winstonLogger.error(`[FIREBASE] Failed to initialize Admin SDK: ${error.message}`);
    }
};
exports.initFirebaseAdmin = initFirebaseAdmin;
/**
 * Send a targeted push notification to a specific device token.
 */
const sendPushNotification = async (token, title, body, data) => {
    try {
        if (!admin.apps.length) {
            logger_1.winstonLogger.warn('[FIREBASE] Cannot send push — Admin SDK not initialized.');
            return false;
        }
        const message = {
            token,
            notification: { title, body },
            data: data || {},
            android: {
                priority: 'high',
                notification: { sound: 'default', color: '#a855f7' }
            }
        };
        const response = await admin.messaging().send(message);
        logger_1.winstonLogger.info(`[FIREBASE] Push sent successfully: ${response}`);
        return true;
    }
    catch (error) {
        logger_1.winstonLogger.error(`[FIREBASE] Push notification failed: ${error.message}`);
        throw error;
    }
};
exports.sendPushNotification = sendPushNotification;
/**
 * Broadcast a message to a specific topic (e.g., 'breaking_news', 'delays').
 */
const broadcastToTopic = async (topic, title, body) => {
    try {
        if (!admin.apps.length)
            return false;
        const message = {
            topic,
            notification: { title, body },
            android: {
                priority: 'high'
            }
        };
        const response = await admin.messaging().send(message);
        logger_1.winstonLogger.info(`[FIREBASE] Broadcast to topic '${topic}' successful: ${response}`);
        return true;
    }
    catch (error) {
        logger_1.winstonLogger.error(`[FIREBASE] Broadcast to topic failed: ${error.message}`);
        return false;
    }
};
exports.broadcastToTopic = broadcastToTopic;
