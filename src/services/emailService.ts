import { Resend } from 'resend';
import nodemailer from 'nodemailer';
import { winstonLogger } from '../middleware/logger';

// Helper to parse multiple Resend API keys from RESEND_API_KEYS or RESEND_API_KEY
function getResendClients(): { client: Resend; keyHint: string }[] {
  const rawKeys = process.env.RESEND_API_KEYS || process.env.RESEND_API_KEY || '';
  const keys = rawKeys
    .split(',')
    .map(k => k.trim())
    .filter(k => k.length > 0);

  return keys.map(k => ({
    client: new Resend(k),
    keyHint: k.length > 12 ? `${k.substring(0, 8)}...${k.substring(k.length - 4)}` : 'key_hidden',
  }));
}

// Helper to parse comma-separated sender emails (e.g. "noreply@trayago.in,noreply@trayago.com")
function getSenderEmails(): { defaultSender: string; comSender: string; inSender: string } {
  const raw = process.env.SENDER_EMAIL || 'noreply@trayago.com,support@trayago.in';
  const parts = raw
    .split(',')
    .map(s => s.trim())
    .filter(s => s.length > 0);

  const comSender = parts.find(s => s.toLowerCase().endsWith('@trayago.com')) || 'noreply@trayago.com';
  const inSender = parts.find(s => s.toLowerCase().endsWith('@trayago.in')) || 'support@trayago.in';
  const defaultSender = parts[0] || comSender;

  return { defaultSender, comSender, inSender };
}

// Nodemailer transporter for Brevo SMTP (Emergency Fallback)
function getBrevoTransporter() {
  const login = process.env.BREVO_SMTP_LOGIN;
  const pass = process.env.BREVO_SMTP_PASSWORD;
  if (!login || !pass) return null;

  return nodemailer.createTransport({
    host: 'smtp-relay.brevo.com',
    port: 587,
    auth: {
      user: login,
      pass: pass,
    },
  });
}

interface SendEmailOptions {
  to: string | string[];
  subject: string;
  html: string;
  senderName?: string;
  tag?: string;
}

export class EmailService {
  /**
   * Smart multi-key failover pipeline:
   * 1. Try each Resend API key in order (Key 1: 50k quota -> Key 2: 3k quota)
   * 2. If all Resend keys fail (or coupon expired/401/403/account closed), silently failover to Brevo SMTP
   * 3. If running in local dev without keys, log to winston and succeed
   */
  private async sendWithFailover(options: SendEmailOptions): Promise<boolean> {
    const clients = getResendClients();
    const brevoTransporter = getBrevoTransporter();
    const { defaultSender, comSender, inSender } = getSenderEmails();
    const tag = options.tag || 'EMAIL';
    const senderName = options.senderName || 'Trayago';

    // Local dev mode when no email providers are configured
    if (clients.length === 0 && !brevoTransporter) {
      winstonLogger.info(`[DEV_${tag}] Email to ${JSON.stringify(options.to)}: ${options.subject}`);
      return true;
    }

    let lastError: any = null;

    // 1. Try Resend keys in order
    for (let i = 0; i < clients.length; i++) {
      const { client, keyHint } = clients[i];
      // For Resend, use comSender (verified trayago.com domain), falling back to default
      const resendSender = comSender || defaultSender;

      try {
        const { error } = await client.emails.send({
          from: `${senderName} <${resendSender}>`,
          to: options.to,
          subject: options.subject,
          html: options.html,
          replyTo: inSender,
        });

        if (error) {
          throw new Error(error.message || JSON.stringify(error));
        }

        winstonLogger.info(`[EMAIL_SUCCESS] ${tag} sent to ${JSON.stringify(options.to)} via Resend (Key #${i + 1}: ${keyHint})`);
        return true;
      } catch (err: any) {
        lastError = err;
        winstonLogger.warn(`[EMAIL_WARN] Resend Key #${i + 1} (${keyHint}) failed for ${JSON.stringify(options.to)}: ${err.message}. Trying next provider...`);
      }
    }

    // 2. Emergency fallback to Brevo SMTP
    if (brevoTransporter) {
      try {
        const brevoSender = inSender || defaultSender;
        await brevoTransporter.sendMail({
          from: `"${senderName}" <${brevoSender}>`,
          to: options.to,
          subject: options.subject,
          html: options.html,
          replyTo: inSender,
        });

        winstonLogger.info(`[EMAIL_SUCCESS] ${tag} sent to ${JSON.stringify(options.to)} via Brevo SMTP (Fallback)`);
        return true;
      } catch (brevoErr: any) {
        winstonLogger.error(`[EMAIL_ERROR] Both Resend (all keys) and Brevo SMTP failed for ${JSON.stringify(options.to)}`, brevoErr);
        throw new Error(`All email providers failed to send ${tag}: ${brevoErr.message}`);
      }
    }

    // If Resend failed and no Brevo configured
    winstonLogger.error(`[EMAIL_ERROR] All Resend keys failed and Brevo is not configured for ${JSON.stringify(options.to)}`, lastError);
    throw new Error(`All email providers failed to send ${tag}: ${lastError?.message || 'Unknown error'}`);
  }

  async sendOtpEmail(toEmail: string, otpCode: string): Promise<boolean> {
    const subject = 'Your Trayago Verification Code';
    const html = `
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

    return this.sendWithFailover({
      to: toEmail,
      subject,
      html,
      senderName: 'Trayago',
      tag: 'OTP',
    });
  }

  async sendPasswordResetEmail(toEmail: string, otpCode: string): Promise<boolean> {
    const subject = 'Reset Your Trayago Password';
    const html = `
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

    return this.sendWithFailover({
      to: toEmail,
      subject,
      html,
      senderName: 'Trayago',
      tag: 'PASSWORD_RESET',
    });
  }

  async sendAlertEmail(toEmail: string, alertTitle: string, alertMessage: string): Promise<boolean> {
    const html = `
      <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto; padding: 20px; background-color: #f9f9f9; border-radius: 10px;">
        <div style="background-color: #ffffff; padding: 30px; border-radius: 8px; box-shadow: 0 4px 6px rgba(0,0,0,0.05);">
          <h2 style="color: #ef4444; margin-top: 0;">${alertTitle}</h2>
          <p style="color: #555; font-size: 16px; line-height: 1.5;">
            ${alertMessage}
          </p>
        </div>
      </div>
    `;

    return this.sendWithFailover({
      to: toEmail,
      subject: alertTitle,
      html,
      senderName: 'Trayago Alerts',
      tag: 'ALERT',
    });
  }

  async sendHealthReportEmail(toEmail: string | string[], subject: string, htmlContent: string): Promise<boolean> {
    return this.sendWithFailover({
      to: toEmail,
      subject,
      html: htmlContent,
      senderName: 'Trayago Monitor',
      tag: 'HEALTH_REPORT',
    });
  }
}

export const emailService = new EmailService();

