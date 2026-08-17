"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.emailService = exports.EmailService = void 0;
const resend_1 = require("resend");
const nodemailer_1 = __importDefault(require("nodemailer"));
const logger_1 = require("../middleware/logger");
// Initialize Resend with the provided API key if present
const RESEND_API_KEY = process.env.RESEND_API_KEY;
const resend = RESEND_API_KEY ? new resend_1.Resend(RESEND_API_KEY) : null;
const SENDER_EMAIL = process.env.SENDER_EMAIL || 'support@trayago.in';
// Initialize Nodemailer for Brevo SMTP (Fallback)
const brevoTransporter = nodemailer_1.default.createTransport({
    host: 'smtp-relay.brevo.com',
    port: 587,
    auth: {
        user: process.env.BREVO_SMTP_LOGIN,
        pass: process.env.BREVO_SMTP_PASSWORD,
    },
});
class EmailService {
    async sendOtpEmail(toEmail, otpCode) {
        const subject = 'Your Trayago Verification Code';
        const htmlContent = `
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
    `;
        if (!resend && !process.env.BREVO_SMTP_LOGIN) {
            logger_1.winstonLogger.info(`[DEV_OTP] Verification code for ${toEmail}: ${otpCode}`);
            return true;
        }
        try {
            if (resend) {
                const { error } = await resend.emails.send({
                    from: `Trayago <${SENDER_EMAIL}>`,
                    to: toEmail,
                    subject,
                    html: htmlContent,
                });
                if (error) {
                    throw new Error(error.message);
                }
                logger_1.winstonLogger.info(`[EMAIL_SUCCESS] OTP sent to ${toEmail} via Resend`);
                return true;
            }
            throw new Error('Resend not configured');
        }
        catch (err) {
            logger_1.winstonLogger.warn(`[EMAIL_WARN] Resend failed for ${toEmail}: ${err.message}. Falling back to Brevo SMTP...`);
            try {
                await brevoTransporter.sendMail({
                    from: `"Trayago" <${SENDER_EMAIL}>`,
                    to: toEmail,
                    subject,
                    html: htmlContent,
                });
                logger_1.winstonLogger.info(`[EMAIL_SUCCESS] OTP sent to ${toEmail} via Brevo SMTP (Fallback)`);
                return true;
            }
            catch (brevoErr) {
                logger_1.winstonLogger.error(`[EMAIL_ERROR] Both Resend and Brevo failed to send OTP to ${toEmail}`, brevoErr);
                throw new Error('All email providers failed to send OTP.');
            }
        }
    }
    async sendPasswordResetEmail(toEmail, otpCode) {
        const subject = 'Reset Your Trayago Password';
        const htmlContent = `
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
    `;
        if (!resend && !process.env.BREVO_SMTP_LOGIN) {
            logger_1.winstonLogger.info(`[DEV_PASSWORD_RESET_OTP] Reset code for ${toEmail}: ${otpCode}`);
            return true;
        }
        try {
            if (resend) {
                const { error } = await resend.emails.send({
                    from: `Trayago <${SENDER_EMAIL}>`,
                    to: toEmail,
                    subject,
                    html: htmlContent,
                });
                if (error) {
                    throw new Error(error.message);
                }
                logger_1.winstonLogger.info(`[EMAIL_SUCCESS] Password reset OTP sent to ${toEmail} via Resend`);
                return true;
            }
            throw new Error('Resend not configured');
        }
        catch (err) {
            logger_1.winstonLogger.warn(`[EMAIL_WARN] Resend failed for ${toEmail}: ${err.message}. Falling back to Brevo SMTP...`);
            try {
                await brevoTransporter.sendMail({
                    from: `"Trayago" <${SENDER_EMAIL}>`,
                    to: toEmail,
                    subject,
                    html: htmlContent,
                });
                logger_1.winstonLogger.info(`[EMAIL_SUCCESS] Password reset OTP sent to ${toEmail} via Brevo SMTP (Fallback)`);
                return true;
            }
            catch (brevoErr) {
                logger_1.winstonLogger.error(`[EMAIL_ERROR] Both Resend and Brevo failed to send password reset OTP to ${toEmail}`, brevoErr);
                throw new Error('All email providers failed to send password reset email.');
            }
        }
    }
    async sendAlertEmail(toEmail, alertTitle, alertMessage) {
        if (!resend && !process.env.BREVO_SMTP_LOGIN) {
            logger_1.winstonLogger.info(`[DEV_ALERT] Alert for ${toEmail}: ${alertTitle}`);
            return true;
        }
        try {
            if (resend) {
                const { error } = await resend.emails.send({
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
                    throw new Error(error.message);
                }
                return true;
            }
            return true;
        }
        catch (err) {
            logger_1.winstonLogger.error(`[EMAIL_EXCEPTION] Exception while sending alert to ${toEmail}`, err);
            throw new Error(err.message || 'Failed to send alert email');
        }
    }
    async sendHealthReportEmail(toEmail, subject, htmlContent) {
        if (!resend && !process.env.BREVO_SMTP_LOGIN) {
            logger_1.winstonLogger.info(`[DEV_HEALTH_REPORT] Health report for ${toEmail}: ${subject}`);
            return true;
        }
        try {
            if (resend) {
                const { error } = await resend.emails.send({
                    from: `Trayago Monitor <${SENDER_EMAIL}>`,
                    to: toEmail,
                    subject: subject,
                    html: htmlContent,
                });
                if (error) {
                    throw new Error(error.message);
                }
                return true;
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
