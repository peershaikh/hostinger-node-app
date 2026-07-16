import { winstonLogger } from '../middleware/logger';
import * as fs from 'fs';
import * as path from 'path';

export class SmsService {
  private logFilePath: string;

  constructor() {
    this.logFilePath = path.join(__dirname, '../../../logs/sms.log');
    // Ensure logs directory exists
    const dir = path.dirname(this.logFilePath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
  }

  /**
   * Mock send SMS OTP logic
   * Logs to winston and writes to server/logs/sms.log for easy manual testing
   */
  async sendSmsOtp(mobileNumber: string, otpCode: string): Promise<boolean> {
    try {
      const message = `[SMS_GATEWAY] Mobile OTP sent successfully to ${mobileNumber}: Verification code is ${otpCode}`;
      
      // Log to Winston Logger
      winstonLogger.info(message);
      
      // Append to local log file for QA testing
      const timestamp = new Date().toISOString();
      const logEntry = `[${timestamp}] TO: ${mobileNumber} | CODE: ${otpCode} | MSG: Your Trayago mobile verification code is ${otpCode}. Valid for 5 minutes.\n`;
      fs.appendFileSync(this.logFilePath, logEntry);

      return true;
    } catch (err: any) {
      winstonLogger.error(`[SMS_EXCEPTION] Failed to send SMS to ${mobileNumber}: ${err.message}`);
      return false;
    }
  }
}

export const smsService = new SmsService();
