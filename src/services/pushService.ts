import * as OneSignal from '@onesignal/node-onesignal';
import { winstonLogger } from '../middleware/logger';

class PushService {
  private client: OneSignal.DefaultApi | null = null;
  private appId: string | null = null;

  constructor() {
    this.appId = process.env.ONESIGNAL_APP_ID || null;
    const apiKey = process.env.ONESIGNAL_REST_API_KEY || null;

    if (!this.appId || !apiKey) {
      winstonLogger.warn('[PUSH] OneSignal configuration missing (ONESIGNAL_APP_ID or ONESIGNAL_REST_API_KEY). Push notifications disabled.');
      return;
    }

    // Configure OneSignal client
    const configuration = OneSignal.createConfiguration({
      restApiKey: apiKey,
    });
    this.client = new OneSignal.DefaultApi(configuration);
    winstonLogger.info('[PUSH] OneSignal push service initialized.');
  }

  /**
   * Send a push notification to specific users by their external_id (Supabase User ID)
   */
  async sendToUsers(userIds: string[], title: string, message: string, url?: string): Promise<boolean> {
    if (!this.client || !this.appId) {
      winstonLogger.debug('[PUSH] Push disabled, skipping sendToUsers.');
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
      winstonLogger.info(`[PUSH] Dispatched push to ${userIds.length} users. Response ID: ${response.id}`);
      return true;
    } catch (error: any) {
      winstonLogger.error(`[PUSH] Failed to send push notification: ${error.message}`);
      return false;
    }
  }

  /**
   * Send a push notification to all subscribers (e.g., global announcements)
   */
  async sendGlobal(title: string, message: string, url?: string): Promise<boolean> {
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
      winstonLogger.info(`[PUSH] Dispatched global push. Response ID: ${response.id}`);
      return true;
    } catch (error: any) {
      winstonLogger.error(`[PUSH] Failed to send global push: ${error.message}`);
      return false;
    }
  }
}

export const pushService = new PushService();
