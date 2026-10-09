import { winstonLogger } from '../middleware/logger';
import * as fs from 'fs';
import * as path from 'path';
import { maskPhoneNumber } from '../utils/phoneNormalizer';

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
   * Operational logging only — NEVER logs plaintext OTP codes to console or disk.
   */
  async sendSmsOtp(mobileNumber: string, _otpCode?: string): Promise<boolean> {
    try {
      const masked = maskPhoneNumber(mobileNumber);
      
      // Log operational event to Winston (NO plaintext OTP)
      winstonLogger.info(`[SMS_GATEWAY] Mobile OTP dispatched successfully to ${masked}. Status: DISPATCHED_MOCK.`);
      
      // Append sanitized operational audit entry to local log file (NO plaintext OTP)
      const timestamp = new Date().toISOString();
      const logEntry = `[${timestamp}] TO: ${masked} | STATUS: DISPATCHED | MSG: Mobile verification code dispatched. Valid for 5 minutes.\n`;
      fs.appendFileSync(this.logFilePath, logEntry);

      return true;
    } catch (err: any) {
      winstonLogger.error(`[SMS_EXCEPTION] Failed to send SMS to ${maskPhoneNumber(mobileNumber)}: ${err.message}`);
      return false;
    }
  }
}

export const smsService = new SmsService();
