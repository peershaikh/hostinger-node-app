import * as admin from 'firebase-admin';
import { winstonLogger } from '../middleware/logger';

/**
 * Initializes the Firebase Admin SDK.
 * Used for sending push notifications securely from the backend.
 * 
 * Requires FIREBASE_SERVICE_ACCOUNT_BASE64 to be set in production.
 */
export const initFirebaseAdmin = () => {
  try {
    const serviceAccountBase64 = process.env.FIREBASE_SERVICE_ACCOUNT_BASE64;
    
    if (!serviceAccountBase64) {
      winstonLogger.warn('[FIREBASE] Missing FIREBASE_SERVICE_ACCOUNT_BASE64. Push notifications disabled.');
      return;
    }

    const serviceAccount = JSON.parse(Buffer.from(serviceAccountBase64, 'base64').toString('utf8'));

    if (!admin.apps.length) {
      admin.initializeApp({
        credential: admin.credential.cert(serviceAccount)
      });
      winstonLogger.info('[FIREBASE] Admin SDK initialized successfully.');
    }
  } catch (error: any) {
    winstonLogger.error(`[FIREBASE] Failed to initialize Admin SDK: ${error.message}`);
  }
};

/**
 * Send a targeted push notification to a specific device token.
 */
export const sendPushNotification = async (token: string, title: string, body: string, data?: Record<string, string>) => {
  try {
    if (!admin.apps.length) {
      winstonLogger.warn('[FIREBASE] Cannot send push — Admin SDK not initialized.');
      return false;
    }

    const message: admin.messaging.Message = {
      token,
      notification: { title, body },
      data: data || {},
      android: {
        priority: 'high',
        notification: { sound: 'default', color: '#a855f7' }
      }
    };

    const response = await admin.messaging().send(message);
    winstonLogger.info(`[FIREBASE] Push sent successfully: ${response}`);
    return true;
  } catch (error: any) {
    winstonLogger.error(`[FIREBASE] Push notification failed: ${error.message}`);
    throw error;
  }
};

/**
 * Broadcast a message to a specific topic (e.g., 'breaking_news', 'delays').
 */
export const broadcastToTopic = async (topic: string, title: string, body: string) => {
  try {
    if (!admin.apps.length) return false;

    const message: admin.messaging.Message = {
      topic,
      notification: { title, body },
      android: {
        priority: 'high'
      }
    };

    const response = await admin.messaging().send(message);
    winstonLogger.info(`[FIREBASE] Broadcast to topic '${topic}' successful: ${response}`);
    return true;
  } catch (error: any) {
    winstonLogger.error(`[FIREBASE] Broadcast to topic failed: ${error.message}`);
    return false;
  }
};
