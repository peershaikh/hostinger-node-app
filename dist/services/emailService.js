"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.emailService = exports.EmailService = void 0;
const resend_1 = require("resend");
const logger_1 = require("../middleware/logger");
// Initialize Resend with the provided API key
const RESEND_API_KEY = process.env.RESEND_API_KEY;
if (!RESEND_API_KEY) {
    throw new Error('RESEND_API_KEY is not defined in environment variables.');
}
const resend = new resend_1.Resend(RESEND_API_KEY);
const SENDER_EMAIL = process.env.SENDER_EMAIL;
const EMAIL_REGEX = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
if (!SENDER_EMAIL || !EMAIL_REGEX.test(SENDER_EMAIL)) {
    throw new Error('SENDER_EMAIL is missing or invalid in environment variables.');
}
class EmailService {
    async sendOtpEmail(toEmail, otpCode) {
        try {
            const { data, error } = await resend.emails.send({
                from: `Trayago <${SENDER_EMAIL}>`,
                to: toEmail,
                subject: 'Your Trayago Verification Code',
                html: `
          <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto; padding: 20px; background-color: #f9f9f9; border-radius: 10px;">
            <div style="text-align: center; margin-bottom: 20px;">
              <h1 style="color: #6b21a8; margin: 0;">Trayago</h1>
              <p style="color: #666; margin-top: 5px;">Intelligent Pan-India Travel</p>
            </div>
            
            <div style="background-color: #ffffff; padding: 30px; border-radius: 8px; box-shadow: 0 4px 6px rgba(0,0,0,0.05); text-align: center;">
              <h2 style="color: #333; margin-top: 0;">Verify Your Email</h2>
              <p style="color: #555; font-size: 16px; line-height: 1.5;">
                Thank you for signing up with Trayago! Please use the following 6-digit code to verify your email address and activate your account.
              </p>
              
              <div style="margin: 30px 0;">
                <span style="font-size: 32px; font-weight: bold; letter-spacing: 5px; color: #10b981; background-color: #ecfdf5; padding: 15px 25px; border-radius: 8px; border: 2px dashed #10b981;">
                  ${otpCode}
                </span>
              </div>
              
              <p style="color: #777; font-size: 14px;">
                This code will expire in 15 minutes. If you did not request this, please ignore this email.
              </p>
            </div>
            
            <div style="text-align: center; margin-top: 20px; color: #888; font-size: 12px;">
              <p>&copy; ${new Date().getFullYear()} Trayago. All rights reserved.</p>
            </div>
          </div>
        `,
            });
            if (error) {
                logger_1.winstonLogger.error(`[EMAIL_ERROR] Failed to send OTP to ${toEmail}`, error);
                throw new Error(error.message);
            }
            logger_1.winstonLogger.info(`[EMAIL_SUCCESS] OTP sent to ${toEmail}`);
            return true;
        }
        catch (err) {
            logger_1.winstonLogger.error(`[EMAIL_EXCEPTION] Exception while sending OTP to ${toEmail}`, err);
            throw new Error(err.message || 'Failed to send OTP email');
        }
    }
    async sendPasswordResetEmail(toEmail, otpCode) {
        try {
            const { data, error } = await resend.emails.send({
                from: `Trayago <${SENDER_EMAIL}>`,
                to: toEmail,
                subject: 'Reset Your Trayago Password',
                html: `
          <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto; padding: 20px; background-color: #f9f9f9; border-radius: 10px;">
            <div style="text-align: center; margin-bottom: 20px;">
              <h1 style="color: #6b21a8; margin: 0;">Trayago</h1>
              <p style="color: #666; margin-top: 5px;">Intelligent Pan-India Travel</p>
            </div>
            
            <div style="background-color: #ffffff; padding: 30px; border-radius: 8px; box-shadow: 0 4px 6px rgba(0,0,0,0.05); text-align: center;">
              <h2 style="color: #333; margin-top: 0;">Password Reset Request</h2>
              <p style="color: #555; font-size: 16px; line-height: 1.5;">
                We received a request to reset your Trayago account password. Use the code below to proceed. This code expires in <strong>10 minutes</strong>.
              </p>
              
              <div style="margin: 30px 0;">
                <span style="font-size: 32px; font-weight: bold; letter-spacing: 5px; color: #f97316; background-color: #fff7ed; padding: 15px 25px; border-radius: 8px; border: 2px dashed #f97316;">
                  ${otpCode}
                </span>
              </div>
              
              <p style="color: #777; font-size: 14px;">
                If you did not request a password reset, please ignore this email. Your account is safe.
              </p>
            </div>
            
            <div style="text-align: center; margin-top: 20px; color: #888; font-size: 12px;">
              <p>&copy; ${new Date().getFullYear()} Trayago. All rights reserved.</p>
            </div>
          </div>
        `,
            });
            if (error) {
                logger_1.winstonLogger.error(`[EMAIL_ERROR] Failed to send password reset OTP to ${toEmail}`, error);
                throw new Error(error.message);
            }
            logger_1.winstonLogger.info(`[EMAIL_SUCCESS] Password reset OTP sent to ${toEmail}`);
            return true;
        }
        catch (err) {
            logger_1.winstonLogger.error(`[EMAIL_EXCEPTION] Exception while sending password reset OTP to ${toEmail}`, err);
            throw new Error(err.message || 'Failed to send password reset email');
        }
    }
    async sendAlertEmail(toEmail, alertTitle, alertMessage) {
        try {
            const { data, error } = await resend.emails.send({
                from: `Trayago Alerts <${SENDER_EMAIL}>`,
                to: toEmail,
                subject: alertTitle,
                html: `
          <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto; padding: 20px; background-color: #f9f9f9; border-radius: 10px;">
            <div style="background-color: #ffffff; padding: 30px; border-radius: 8px; box-shadow: 0 4px 6px rgba(0,0,0,0.05);">
              <h2 style="color: #ef4444; margin-top: 0;">${alertTitle}</h2>
              <p style="color: #555; font-size: 16px; line-height: 1.5;">
                ${alertMessage}
              </p>
            </div>
          </div>
        `,
            });
            if (error) {
                logger_1.winstonLogger.error(`[EMAIL_ERROR] Failed to send alert to ${toEmail}`, error);
                throw new Error(error.message);
            }
            return true;
        }
        catch (err) {
            logger_1.winstonLogger.error(`[EMAIL_EXCEPTION] Exception while sending alert to ${toEmail}`, err);
            throw new Error(err.message || 'Failed to send alert email');
        }
    }
    async sendHealthReportEmail(toEmail, subject, htmlContent) {
        try {
            const { data, error } = await resend.emails.send({
                from: `Trayago Monitor <${SENDER_EMAIL}>`,
                to: toEmail,
                subject: subject,
                html: htmlContent,
            });
            if (error) {
                logger_1.winstonLogger.error(`[EMAIL_ERROR] Failed to send health report to ${toEmail}`, error);
                throw new Error(error.message);
            }
            return true;
        }
        catch (err) {
            logger_1.winstonLogger.error(`[EMAIL_EXCEPTION] Exception while sending health report to ${toEmail}`, err);
            throw new Error(err.message || 'Failed to send health report email');
        }
    }
}
exports.EmailService = EmailService;
exports.emailService = new EmailService();
