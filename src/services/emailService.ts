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

  async sendContactInquiryEmail(options: {
    adminEmails: string | string[];
    userName: string;
    userEmail: string;
    userPhone?: string;
    subject: string;
    message: string;
    category?: string;
  }): Promise<boolean> {
    const { adminEmails, userName, userEmail, userPhone, subject, message, category } = options;
    const catBadge = category ? `[${category.toUpperCase()}] ` : '';
    const emailSubject = `[Trayago Contact] ${catBadge}${subject || 'New Contact Inquiry'}`;
    const safeName = String(userName || 'User').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    const safeEmail = String(userEmail || '').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    const safePhone = userPhone ? String(userPhone).replace(/</g, '&lt;').replace(/>/g, '&gt;') : '';
    const safeCategory = category ? String(category).replace(/</g, '&lt;').replace(/>/g, '&gt;') : '';
    const safeSubject = String(subject || 'Inquiry').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    const safeMessage = String(message || '').replace(/</g, '&lt;').replace(/>/g, '&gt;');

    const html = `
      <div style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; max-width: 600px; margin: 0 auto; padding: 24px; background-color: #f8fafc; border-radius: 12px; color: #1e293b;">
        <div style="background: linear-gradient(135deg, #4f46e5 0%, #7c3aed 100%); padding: 24px; border-radius: 10px 10px 0 0; text-align: center; color: white;">
          <h2 style="margin: 0; font-size: 22px; font-weight: 700; letter-spacing: -0.5px;">Trayago Contact Inquiry</h2>
          <p style="margin: 6px 0 0; font-size: 13px; opacity: 0.9;">New message submitted via www.trayago.in/contact</p>
        </div>
        
        <div style="background-color: #ffffff; padding: 28px; border-radius: 0 0 10px 10px; border: 1px solid #e2e8f0; border-top: none;">
          <div style="margin-bottom: 20px; padding-bottom: 16px; border-bottom: 1px solid #f1f5f9;">
            <table style="width: 100%; border-collapse: collapse;">
              <tr>
                <td style="padding: 6px 0; color: #64748b; font-size: 13px; width: 100px; font-weight: 600;">FROM:</td>
                <td style="padding: 6px 0; color: #0f172a; font-size: 14px; font-weight: 600;">${safeName}</td>
              </tr>
              <tr>
                <td style="padding: 6px 0; color: #64748b; font-size: 13px; font-weight: 600;">EMAIL:</td>
                <td style="padding: 6px 0; color: #2563eb; font-size: 14px;"><a href="mailto:${safeEmail}" style="color: #2563eb; text-decoration: none;">${safeEmail}</a></td>
              </tr>
              ${safePhone ? `
              <tr>
                <td style="padding: 6px 0; color: #64748b; font-size: 13px; font-weight: 600;">PHONE:</td>
                <td style="padding: 6px 0; color: #0f172a; font-size: 14px;">${safePhone}</td>
              </tr>
              ` : ''}
              ${safeCategory ? `
              <tr>
                <td style="padding: 6px 0; color: #64748b; font-size: 13px; font-weight: 600;">CATEGORY:</td>
                <td style="padding: 6px 0; color: #7c3aed; font-size: 13px; font-weight: 600;">${safeCategory.toUpperCase()}</td>
              </tr>
              ` : ''}
            </table>
          </div>

          <div style="margin-bottom: 20px;">
            <p style="margin: 0 0 8px; font-size: 12px; font-weight: 700; color: #64748b; text-transform: uppercase; letter-spacing: 0.5px;">Subject</p>
            <div style="font-size: 15px; font-weight: 600; color: #0f172a; margin-bottom: 16px;">${safeSubject}</div>
            
            <p style="margin: 0 0 8px; font-size: 12px; font-weight: 700; color: #64748b; text-transform: uppercase; letter-spacing: 0.5px;">Message</p>
            <div style="background-color: #f8fafc; padding: 16px; border-radius: 8px; border: 1px solid #e2e8f0; font-size: 14px; line-height: 1.6; color: #334155; white-space: pre-wrap;">${safeMessage}</div>
          </div>

          <div style="text-align: center; margin-top: 24px; padding-top: 16px; border-top: 1px solid #f1f5f9;">
            <a href="mailto:${safeEmail}?subject=Re: ${encodeURIComponent(subject)}" style="display: inline-block; background-color: #4f46e5; color: #ffffff; padding: 10px 20px; border-radius: 6px; font-size: 13px; font-weight: 600; text-decoration: none;">Reply Directly to User</a>
          </div>
        </div>
        
        <div style="text-align: center; margin-top: 16px; font-size: 11px; color: #94a3b8;">
          Sent by Trayago Platform Notification System &bull; IST
        </div>
      </div>
    `;

    return this.sendWithFailover({
      to: adminEmails,
      subject: emailSubject,
      html,
      senderName: 'Trayago Contact',
      tag: 'CONTACT_INQUIRY',
    });
  }
}

export const emailService = new EmailService();

