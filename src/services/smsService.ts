import { winstonLogger } from '../middleware/logger';
import * as fs from 'fs';
import * as path from 'path';
import { maskPhoneNumber, normalizeIndianPhoneNumber } from '../utils/phoneNormalizer';

export type FetchClient = typeof fetch;

export class SmsService {
  private logFilePath: string;
  private fetchClient: FetchClient | null = null;
  private mockDeliveryHandler: ((mobileNumber: string, otpCode: string) => Promise<boolean>) | null = null;

  constructor(fetchClient?: FetchClient) {
    this.logFilePath = path.join(__dirname, '../../../logs/sms.log');
    // Ensure logs directory exists
    const dir = path.dirname(this.logFilePath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
    if (fetchClient) {
      this.fetchClient = fetchClient;
    }
  }

  /**
   * Allows injecting a mock fetch client for isolated unit testing.
   * Strictly forbidden in production.
   */
  public setFetchClient(client: FetchClient | null): void {
    if (process.env.NODE_ENV === 'production') {
      throw new Error('Mock fetch client injection is forbidden in production environment');
    }
    this.fetchClient = client;
  }

  /**
   * Allows injecting a deterministic mock delivery handler for testing only.
   * Strictly forbidden in production.
   */
  public setMockDeliveryHandler(handler: ((mobileNumber: string, otpCode: string) => Promise<boolean>) | null): void {
    if (process.env.NODE_ENV === 'production') {
      throw new Error('Mock delivery handler injection is forbidden in production environment');
    }
    this.mockDeliveryHandler = handler;
  }

  /**
   * Dispatches mobile OTP via Renflair WhatsApp Gateway (Non-DLT Route).
   * 
   * Strict contract:
   * - Endpoint: https://whatsapp.renflair.in/V1.php (or RENFLAIR_BASE_URL/V1.php)
   * - Method: GET
   * - Parameters: API, PHONE, OTP, COUNTRY=91
   * - Phone normalized to 10-digit Indian mobile format (stripped of +91/91).
   * - API Key read exclusively from process.env.RENFLAIR_API_KEY.
   * - HTTPS protocol strictly enforced.
   * - 5-second request timeout via AbortController.
   * - Status confirmed via JSON: { status: 'SUCCESS' }.
   * - Plaintext OTP, complete phone number, API key, and query URL are NEVER logged.
   */
  async sendSmsOtp(mobileNumber: string, otpCode?: string): Promise<boolean> {
    const masked = maskPhoneNumber(mobileNumber);
    const isProd = process.env.NODE_ENV === 'production';

    // 1. Phone number format validation and normalization to 10-digit Indian mobile
    const canonical = normalizeIndianPhoneNumber(mobileNumber);
    if (!canonical) {
      winstonLogger.warn(`[SMS_GATEWAY] Invalid Indian mobile number format: ${masked}`);
      return false;
    }
    const phone10 = canonical.slice(-10);
    if (!/^[6-9]\d{9}$/.test(phone10)) {
      winstonLogger.warn(`[SMS_GATEWAY] Invalid 10-digit Indian mobile pattern for ${masked}`);
      return false;
    }

    // 2. Validate OTP code format
    if (!otpCode || typeof otpCode !== 'string' || !/^\d{6}$/.test(otpCode.trim())) {
      winstonLogger.warn(`[SMS_GATEWAY] Invalid OTP code format for ${masked}`);
      return false;
    }
    const cleanOtp = otpCode.trim();

    // 3. Test mock delivery injection hook (Strictly forbidden in production)
    if (this.mockDeliveryHandler && !isProd) {
      winstonLogger.info(`[SMS_GATEWAY] Mock delivery handler invoked for ${masked} (TEST ONLY).`);
      const mockResult = await this.mockDeliveryHandler(canonical, cleanOtp);
      if (mockResult) {
        this.writeAuditLog(masked, 'DISPATCHED');
      }
      return mockResult;
    }

    // 4. API Key Resolution (Exclusively from RENFLAIR_API_KEY)
    const apiKey = process.env.RENFLAIR_API_KEY?.trim();
    if (!apiKey) {
      winstonLogger.error(`[SMS_GATEWAY] Delivery aborted for ${masked}: RENFLAIR_API_KEY is not configured.`);
      return false;
    }

    // 5. Base URL Resolution & HTTPS Enforcement
    const rawBaseUrl = process.env.RENFLAIR_BASE_URL?.trim() || 'https://whatsapp.renflair.in';
    let parsedBase: URL;
    try {
      parsedBase = new URL(rawBaseUrl);
    } catch {
      winstonLogger.error(`[SMS_GATEWAY] Delivery aborted for ${masked}: Invalid RENFLAIR_BASE_URL configuration.`);
      return false;
    }

    if (parsedBase.protocol !== 'https:') {
      winstonLogger.error(`[SMS_GATEWAY] Insecure HTTP protocol rejected for ${masked}. HTTPS is required.`);
      return false;
    }

    // 6. Build target URL with documented query parameters
    const targetUrl = new URL('/V1.php', parsedBase);
    targetUrl.searchParams.set('API', apiKey);
    targetUrl.searchParams.set('PHONE', phone10);
    targetUrl.searchParams.set('OTP', cleanOtp);
    targetUrl.searchParams.set('COUNTRY', '91');

    // 7. Resolve fetch client (injectable in test; global in prod)
    const fetchFn = (!isProd && this.fetchClient)
      ? this.fetchClient
      : (globalThis.fetch ? globalThis.fetch.bind(globalThis) : null);

    if (!fetchFn) {
      winstonLogger.error(`[SMS_GATEWAY] HTTP fetch client unavailable for ${masked}`);
      return false;
    }

    // 8. Strict 5-second request timeout via AbortController
    const controller = new AbortController();
    const timeoutId = setTimeout(() => {
      controller.abort();
    }, 5000);

    try {
      // Execute GET request — NEVER log targetUrl.toString() as it contains API key & OTP!
      const response = await fetchFn(targetUrl.toString(), {
        method: 'GET',
        signal: controller.signal,
        headers: {
          'Accept': 'application/json'
        }
      });

      clearTimeout(timeoutId);

      // Validate HTTP status
      if (!response.ok) {
        winstonLogger.error(`[SMS_GATEWAY] Renflair HTTP ${response.status} (${response.statusText}) for ${masked}`);
        return false;
      }

      // Validate JSON response
      let data: any;
      try {
        data = await response.json();
      } catch {
        winstonLogger.error(`[SMS_GATEWAY] Invalid JSON response from Renflair for ${masked}`);
        return false;
      }

      // Validate documented status field (e.g. status: "SUCCESS")
      if (data && typeof data === 'object' && (data.status === 'SUCCESS' || data.status === 'success')) {
        winstonLogger.info(`[SMS_GATEWAY] Mobile OTP dispatched successfully to ${masked}. Provider: Renflair.`);
        this.writeAuditLog(masked, 'DISPATCHED');
        return true;
      } else {
        const errorReason = (data && typeof data.message === 'string')
          ? data.message
          : 'Provider status FAILED or invalid';
        const safeReason = errorReason.replace(/[\r\n]/g, ' ').substring(0, 100);
        winstonLogger.error(`[SMS_GATEWAY] Renflair rejected dispatch to ${masked}: ${safeReason}`);
        return false;
      }
    } catch (err: any) {
      clearTimeout(timeoutId);

      if (err?.name === 'AbortError' || err?.message?.toLowerCase().includes('aborted') || err?.message?.toLowerCase().includes('timeout')) {
        winstonLogger.error(`[SMS_GATEWAY] Renflair request timed out after 5000ms for ${masked}`);
        return false;
      }

      // Sanitize exception message to prevent secret or OTP leakage
      let safeMsg = err?.message || 'Network exception';
      if (apiKey && safeMsg.includes(apiKey)) {
        safeMsg = safeMsg.split(apiKey).join('[REDACTED_API_KEY]');
      }
      if (cleanOtp && safeMsg.includes(cleanOtp)) {
        safeMsg = safeMsg.split(cleanOtp).join('[REDACTED_OTP]');
      }
      safeMsg = safeMsg.replace(/API=[^&\s]+/gi, 'API=[REDACTED]');
      safeMsg = safeMsg.replace(/OTP=[^&\s]+/gi, 'OTP=[REDACTED]');
      safeMsg = safeMsg.replace(/PHONE=[^&\s]+/gi, 'PHONE=[REDACTED]');

      winstonLogger.error(`[SMS_EXCEPTION] Failed to send OTP to ${masked}: ${safeMsg}`);
      return false;
    }
  }

  private writeAuditLog(maskedPhone: string, status: string): void {
    try {
      const timestamp = new Date().toISOString();
      const logEntry = `[${timestamp}] TO: ${maskedPhone} | STATUS: ${status} | MSG: Mobile verification code dispatched. Valid for 5 minutes.\n`;
      fs.appendFileSync(this.logFilePath, logEntry);
    } catch (logErr: any) {
      winstonLogger.warn(`[SMS_AUDIT] Failed to append to audit log: ${logErr.message}`);
    }
  }
}

export const smsService = new SmsService();


