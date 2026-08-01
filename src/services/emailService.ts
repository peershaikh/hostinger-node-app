import { Resend } from 'resend';
import nodemailer from 'nodemailer';
import { winstonLogger } from '../middleware/logger';

// Initialize Resend with the provided API key
const RESEND_API_KEY = process.env.RESEND_API_KEY;
if (!RESEND_API_KEY) {
  throw new Error('RESEND_API_KEY is not defined in environment variables.');
}
const resend = new Resend(RESEND_API_KEY);

const SENDER_EMAIL = process.env.SENDER_EMAIL;
const EMAIL_REGEX = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

if (!SENDER_EMAIL || !EMAIL_REGEX.test(SENDER_EMAIL)) {
  throw new Error('SENDER_EMAIL is missing or invalid in environment variables.');
}

// Initialize Nodemailer for Brevo SMTP (Fallback)
const brevoTransporter = nodemailer.createTransport({
  host: 'smtp-relay.brevo.com',
  port: 587,
  auth: {
    user: process.env.BREVO_SMTP_LOGIN,
    pass: process.env.BREVO_SMTP_PASSWORD,
  },
});

export class EmailService {
  async sendOtpEmail(toEmail: string, otpCode: string): Promise<boolean> {
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

    try {
      const { error } = await resend.emails.send({
        from: `Trayago <${SENDER_EMAIL}>`,
        to: toEmail,
        subject,
        html: htmlContent,
      });

      if (error) {
        throw new Error(error.message);
      }

      winstonLogger.info(`[EMAIL_SUCCESS] OTP sent to ${toEmail} via Resend`);
      return true;
    } catch (err: any) {
      winstonLogger.warn(`[EMAIL_WARN] Resend failed for ${toEmail}: ${err.message}. Falling back to Brevo SMTP...`);
      
      try {
        await brevoTransporter.sendMail({
          from: `"Trayago" <${SENDER_EMAIL}>`,
          to: toEmail,
          subject,
          html: htmlContent,
        });
        winstonLogger.info(`[EMAIL_SUCCESS] OTP sent to ${toEmail} via Brevo SMTP (Fallback)`);
        return true;
      } catch (brevoErr: any) {
        winstonLogger.error(`[EMAIL_ERROR] Both Resend and Brevo failed to send OTP to ${toEmail}`, brevoErr);
        throw new Error('All email providers failed to send OTP.');
      }
    }
  }

  async sendPasswordResetEmail(toEmail: string, otpCode: string): Promise<boolean> {
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

    try {
      const { error } = await resend.emails.send({
        from: `Trayago <${SENDER_EMAIL}>`,
        to: toEmail,
        subject,
        html: htmlContent,
      });

      if (error) {
        throw new Error(error.message);
      }

      winstonLogger.info(`[EMAIL_SUCCESS] Password reset OTP sent to ${toEmail} via Resend`);
      return true;
    } catch (err: any) {
      winstonLogger.warn(`[EMAIL_WARN] Resend failed for ${toEmail}: ${err.message}. Falling back to Brevo SMTP...`);
      
      try {
        await brevoTransporter.sendMail({
          from: `"Trayago" <${SENDER_EMAIL}>`,
          to: toEmail,
          subject,
          html: htmlContent,
        });
        winstonLogger.info(`[EMAIL_SUCCESS] Password reset OTP sent to ${toEmail} via Brevo SMTP (Fallback)`);
        return true;
      } catch (brevoErr: any) {
        winstonLogger.error(`[EMAIL_ERROR] Both Resend and Brevo failed to send password reset OTP to ${toEmail}`, brevoErr);
        throw new Error('All email providers failed to send password reset email.');
      }
    }
  }

  async sendAlertEmail(toEmail: string, alertTitle: string, alertMessage: string): Promise<boolean> {
    try {
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
    } catch (err: any) {
      winstonLogger.error(`[EMAIL_EXCEPTION] Exception while sending alert to ${toEmail}`, err);
      throw new Error(err.message || 'Failed to send alert email');
    }
  }

  async sendHealthReportEmail(toEmail: string, subject: string, htmlContent: string): Promise<boolean> {
    try {
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
    } catch (err: any) {
      winstonLogger.error(`[EMAIL_EXCEPTION] Exception while sending health report to ${toEmail}`, err);
      throw new Error(err.message || 'Failed to send health report email');
    }
  }
}

export const emailService = new EmailService();
