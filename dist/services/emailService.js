"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.emailService = exports.EmailService = void 0;
const nodemailer_1 = __importDefault(require("nodemailer"));
const resend_1 = require("resend");
const logger_1 = require("../middleware/logger");
// Helper to parse multiple Resend API keys from RESEND_API_KEYS or RESEND_API_KEY
function getResendClients() {
    const rawKeys = process.env.RESEND_API_KEYS || process.env.RESEND_API_KEY || '';
    const keys = rawKeys
        .split(',')
        .map(k => k.trim())
        .filter(k => k.length > 0);
    return keys.map(k => ({
        client: new resend_1.Resend(k),
        keyHint: k.length > 12 ? `${k.substring(0, 8)}...${k.substring(k.length - 4)}` : 'key_hidden',
    }));
}
// Helper to parse comma-separated sender emails (e.g. "noreply@trayago.in,noreply@trayago.com")
function getSenderEmails() {
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
    if (!login || !pass)
        return null;
    return nodemailer_1.default.createTransport({
        host: 'smtp-relay.brevo.com',
        port: 587,
        auth: {
            user: login,
            pass: pass,
        },
    });
}
class EmailService {
    /**
     * Smart multi-key failover pipeline:
     * 1. Try each Resend API key in order (Key 1: 50k quota -> Key 2: 3k quota)
     * 2. If all Resend keys fail (or coupon expired/401/403/account closed), silently failover to Brevo SMTP
     * 3. If running in local dev without keys, log to winston and succeed
     */
    async sendWithFailover(options) {
        const clients = getResendClients();
        const brevoTransporter = getBrevoTransporter();
        const { defaultSender, comSender, inSender } = getSenderEmails();
        const tag = options.tag || 'EMAIL';
        const senderName = options.senderName || 'Trayago';
        // Local dev mode when no email providers are configured
        if (clients.length === 0 && !brevoTransporter) {
            logger_1.winstonLogger.info(`[DEV_${tag}] Email to ${JSON.stringify(options.to)}: ${options.subject}`);
            return true;
        }
        let lastError = null;
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
                logger_1.winstonLogger.info(`[EMAIL_SUCCESS] ${tag} sent to ${JSON.stringify(options.to)} via Resend (Key #${i + 1}: ${keyHint})`);
                return true;
            }
            catch (err) {
                lastError = err;
                const errMsg = String(err?.message || '');
                // If Resend hit rate-limit (429), back off 1200ms and retry once
                if (errMsg.includes('429') || errMsg.toLowerCase().includes('rate limit') || errMsg.toLowerCase().includes('too many requests')) {
                    logger_1.winstonLogger.warn(`[EMAIL_RATE_LIMIT] Resend 429 for ${JSON.stringify(options.to)}, backing off 1200ms and retrying...`);
                    await new Promise(r => setTimeout(r, 1200));
                    try {
                        const retryRes = await client.emails.send({
                            from: `${senderName} <${resendSender}>`,
                            to: options.to,
                            subject: options.subject,
                            html: options.html,
                            replyTo: inSender,
                        });
                        if (!retryRes.error) {
                            logger_1.winstonLogger.info(`[EMAIL_SUCCESS] ${tag} sent to ${JSON.stringify(options.to)} via Resend after backoff`);
                            return true;
                        }
                    }
                    catch (retryErr) {
                        lastError = retryErr;
                    }
                }
                logger_1.winstonLogger.warn(`[EMAIL_WARN] Resend Key #${i + 1} (${keyHint}) failed for ${JSON.stringify(options.to)}: ${err.message}. Trying next provider...`);
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
                logger_1.winstonLogger.info(`[EMAIL_SUCCESS] ${tag} sent to ${JSON.stringify(options.to)} via Brevo SMTP (Fallback)`);
                return true;
            }
            catch (brevoErr) {
                logger_1.winstonLogger.error(`[EMAIL_ERROR] Both Resend (all keys) and Brevo SMTP failed for ${JSON.stringify(options.to)}`, brevoErr);
                throw new Error(`All email providers failed to send ${tag}: ${brevoErr.message}`);
            }
        }
        // If Resend failed and no Brevo configured
        logger_1.winstonLogger.error(`[EMAIL_ERROR] All Resend keys failed and Brevo is not configured for ${JSON.stringify(options.to)}`, lastError);
        throw new Error(`All email providers failed to send ${tag}: ${lastError?.message || 'Unknown error'}`);
    }
    async sendOtpEmail(toEmail, otpCode) {
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
    async sendPasswordResetEmail(toEmail, otpCode) {
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
    async sendAlertEmail(toEmail, alertTitle, alertMessage, metadata, alertType) {
        const pnr = metadata?.pnr || '';
        const trainNo = metadata?.trainNo || metadata?.train_no || '';
        const trainName = metadata?.trainName || metadata?.train_name || '';
        const journeyDate = metadata?.journeyDate || metadata?.journey_date || '';
        const fromStation = metadata?.from || metadata?.fromStation || '';
        const toStation = metadata?.to || metadata?.toStation || '';
        const passengers = Array.isArray(metadata?.passengers) ? metadata.passengers : [];
        let passengerRowsHtml = '';
        if (passengers.length > 0) {
            passengerRowsHtml = `
        <div style="margin: 22px 0;">
          <h4 style="font-size: 12px; text-transform: uppercase; letter-spacing: 0.5px; color: #64748b; margin-bottom: 8px;">Passenger Allocation Details</h4>
          <table style="width: 100%; border-collapse: collapse; font-size: 13px; background-color: #f8fafc; border-radius: 8px; overflow: hidden; border: 1px solid #e2e8f0;">
            <thead>
              <tr style="background-color: #f1f5f9; text-align: left; color: #475569;">
                <th style="padding: 10px 14px; font-weight: bold; border-bottom: 1px solid #e2e8f0;">Passenger</th>
                <th style="padding: 10px 14px; font-weight: bold; border-bottom: 1px solid #e2e8f0;">Booking Status</th>
                <th style="padding: 10px 14px; font-weight: bold; border-bottom: 1px solid #e2e8f0;">Final / Current Status</th>
              </tr>
            </thead>
            <tbody>
              ${passengers.map((p, idx) => {
                const cur = p.current_status || p.currentStatus || 'N/A';
                const isCnf = cur.toUpperCase().includes('CNF') || cur.toUpperCase().includes('CONFIRM');
                const isRac = cur.toUpperCase().includes('RAC');
                const statusColor = isCnf ? '#16a34a' : isRac ? '#2563eb' : '#d97706';
                return `
                <tr style="border-bottom: 1px solid #f1f5f9;">
                  <td style="padding: 10px 14px; font-weight: bold; color: #334155;">Passenger ${idx + 1}</td>
                  <td style="padding: 10px 14px; color: #64748b;">${p.booking_status || p.bookingStatus || 'N/A'}</td>
                  <td style="padding: 10px 14px; font-weight: 800; color: ${statusColor};">${cur}</td>
                </tr>
              `;
            }).join('')}
            </tbody>
          </table>
        </div>
      `;
        }
        const html = `
<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${alertTitle}</title>
</head>
<body style="margin: 0; padding: 0; background-color: #0f172a; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif;">
  <table width="100%" border="0" cellspacing="0" cellpadding="0" style="background-color: #0f172a; padding: 30px 10px;">
    <tr>
      <td align="center">
        <table width="100%" border="0" cellspacing="0" cellpadding="0" style="max-width: 600px; background-color: #ffffff; border-radius: 16px; overflow: hidden; box-shadow: 0 10px 25px rgba(0,0,0,0.3);">
          
          <!-- Header Banner with Logo -->
          <tr>
            <td style="background: linear-gradient(135deg, #1e293b 0%, #0f172a 100%); padding: 22px 28px; text-align: left; border-bottom: 3px solid #3b82f6;">
              <table width="100%" border="0" cellspacing="0" cellpadding="0">
                <tr>
                  <td style="vertical-align: middle;">
                    <img src="https://www.trayago.in/branding/trayago-logo-512x512.png" alt="Trayago" width="44" height="44" style="border-radius: 10px; display: inline-block; vertical-align: middle; margin-right: 12px; box-shadow: 0 2px 8px rgba(0,0,0,0.2);" />
                    <span style="font-size: 24px; font-weight: 900; color: #ffffff; letter-spacing: -0.5px; vertical-align: middle;">Trayago</span>
                  </td>
                  <td align="right" style="vertical-align: middle;">
                    <span style="display: inline-block; padding: 6px 12px; border-radius: 20px; font-size: 11px; font-weight: 800; text-transform: uppercase; letter-spacing: 0.5px; background-color: rgba(59, 130, 246, 0.2); color: #60a5fa; border: 1px solid rgba(96, 165, 250, 0.3);">
                      ${alertType === 'CHART_PREPARED' ? 'Chart Finalized' : 'Smart Alert'}
                    </span>
                  </td>
                </tr>
              </table>
            </td>
          </tr>

          <!-- Main Body -->
          <tr>
            <td style="padding: 28px;">
              <!-- Headline Title -->
              <h2 style="margin: 0 0 12px 0; font-size: 20px; font-weight: 800; color: #0f172a; line-height: 1.3;">
                ${alertTitle}
              </h2>

              <!-- Status Alert Box -->
              <div style="background-color: #f0fdf4; border: 1px solid #bbf7d0; border-left: 4px solid #16a34a; border-radius: 8px; padding: 14px 16px; margin-bottom: 22px;">
                <p style="margin: 0; font-size: 15px; font-weight: 600; color: #166534; line-height: 1.5;">
                  ${alertMessage}
                </p>
              </div>

              <!-- Journey Card -->
              <div style="background-color: #f8fafc; border: 1px solid #e2e8f0; border-radius: 12px; padding: 18px; margin-bottom: 18px;">
                <table width="100%" border="0" cellspacing="0" cellpadding="0">
                  <tr>
                    <td style="padding-bottom: 10px;">
                      <span style="font-size: 11px; font-weight: 800; text-transform: uppercase; color: #64748b; letter-spacing: 0.5px;">PNR Number</span>
                      <div style="font-size: 20px; font-weight: 900; font-family: monospace; color: #1e293b; letter-spacing: 2px;">
                        ${pnr || 'N/A'}
                      </div>
                    </td>
                    ${trainNo ? `
                    <td align="right" style="padding-bottom: 10px;">
                      <span style="font-size: 11px; font-weight: 800; text-transform: uppercase; color: #64748b; letter-spacing: 0.5px;">Train</span>
                      <div style="font-size: 15px; font-weight: 800; color: #2563eb;">
                        ${trainNo} ${trainName ? `&middot; ${trainName}` : ''}
                      </div>
                    </td>
                    ` : ''}
                  </tr>
                  ${(fromStation || toStation || journeyDate) ? `
                  <tr>
                    <td colspan="2" style="border-top: 1px solid #e2e8f0; padding-top: 10px;">
                      <table width="100%" border="0" cellspacing="0" cellpadding="0">
                        <tr>
                          ${(fromStation && toStation) ? `
                          <td>
                            <span style="font-size: 11px; font-weight: 700; text-transform: uppercase; color: #64748b;">Route</span>
                            <div style="font-size: 13px; font-weight: 700; color: #334155;">
                              ${fromStation} &rarr; ${toStation}
                            </div>
                          </td>
                          ` : ''}
                          ${journeyDate ? `
                          <td align="right">
                            <span style="font-size: 11px; font-weight: 700; text-transform: uppercase; color: #64748b;">Journey Date</span>
                            <div style="font-size: 13px; font-weight: 700; color: #334155;">
                              ${journeyDate}
                            </div>
                          </td>
                          ` : ''}
                        </tr>
                      </table>
                    </td>
                  </tr>
                  ` : ''}
                </table>
              </div>

              <!-- Passenger Breakdown -->
              ${passengerRowsHtml}

              <!-- CTAs -->
              <div style="margin: 28px 0 10px 0; text-align: center;">
                <table width="100%" border="0" cellspacing="0" cellpadding="0">
                  <tr>
                    <td align="center">
                      <a href="https://www.trayago.in/pnr" target="_blank" style="display: inline-block; padding: 13px 24px; background-color: #2563eb; color: #ffffff; text-decoration: none; border-radius: 10px; font-size: 13px; font-weight: 800; letter-spacing: 0.5px; box-shadow: 0 4px 12px rgba(37, 99, 235, 0.3); margin-bottom: 8px;">
                        View Live PNR Status &rarr;
                      </a>
                      ${trainNo ? `
                      <a href="https://www.trayago.in/live?train=${trainNo}&mode=inside" target="_blank" style="display: inline-block; margin-left: 8px; padding: 13px 22px; background-color: #0f172a; color: #ffffff; text-decoration: none; border-radius: 10px; font-size: 13px; font-weight: 800; letter-spacing: 0.5px; border: 1px solid #334155; margin-bottom: 8px;">
                        Track Live Speed & GPS &rarr;
                      </a>
                      ` : ''}
                    </td>
                  </tr>
                </table>
              </div>

              <p style="margin-top: 20px; font-size: 12px; color: #94a3b8; text-align: center; line-height: 1.5;">
                Travelling inside the train? Open Trayago Live Tracking and tap "Inside Train" to monitor live GPS speed and upcoming stops in real time.
              </p>
            </td>
          </tr>

          <!-- Footer -->
          <tr>
            <td style="background-color: #f8fafc; border-top: 1px solid #e2e8f0; padding: 18px 28px; text-align: center;">
              <p style="margin: 0 0 4px 0; font-size: 12px; font-weight: 600; color: #64748b;">
                Trayago &middot; Pan-India Railway Travel Companion
              </p>
              <p style="margin: 0; font-size: 11px; color: #94a3b8;">
                Need help? Contact <a href="mailto:support@trayago.in" style="color: #2563eb; text-decoration: none;">support@trayago.in</a> &middot; <a href="https://www.trayago.in" style="color: #2563eb; text-decoration: none;">www.trayago.in</a>
              </p>
            </td>
          </tr>

        </table>
      </td>
    </tr>
  </table>
</body>
</html>
    `;
        return this.sendWithFailover({
            to: toEmail,
            subject: alertTitle,
            html,
            senderName: 'Trayago Alerts',
            tag: 'ALERT',
        });
    }
    async sendHealthReportEmail(toEmail, subject, htmlContent) {
        return this.sendWithFailover({
            to: toEmail,
            subject,
            html: htmlContent,
            senderName: 'Trayago Monitor',
            tag: 'HEALTH_REPORT',
        });
    }
    async sendContactInquiryEmail(options) {
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
    async sendSubscriptionRenewalEmail(options) {
        const { toEmail, userName, stage, expiryDateFormatted, offerPlanName = 'Safar Pro Loyalty Renewal', offerPrice = '₹39', originalPrice = '₹49', bonusDaysText = '+ 7 Days Free Bonus (37 Days Total)', renewalUrl, promoCode = 'RENEW39' } = options;
        const safeName = String(userName || 'Traveler').replace(/</g, '&lt;').replace(/>/g, '&gt;');
        let badgeText = '⏳ 3 DAYS LEFT • EXPIRES SOON';
        let badgeBg = '#fef3c7';
        let badgeColor = '#92400e';
        let headline = 'Your Safar Pro Plan Expires in 3 Days';
        let subheadline = 'Renew today with your exclusive Loyalty Bonus: 37 days of unlimited AI train features for just ₹39!';
        let subject = `[Trayago] Your Safar Pro expires in 3 days — Claim 7 Days Free Bonus!`;
        if (stage === 'EXPIRING_TOMORROW') {
            badgeText = '⚠️ LAST 24 HOURS • ACTION NEEDED';
            badgeBg = '#fee2e2';
            badgeColor = '#991b1b';
            headline = 'Final Notice: Safar Pro Expires Tomorrow';
            subheadline = 'Don\'t lose your unlimited AI split routes, berth confirmation alerts & ad-free experience.';
            subject = `[Urgent] Your Safar Pro expires tomorrow — Keep unlimited routes active`;
        }
        else if (stage === 'EXPIRED_GRACE') {
            badgeText = '🔄 SPECIAL WINBACK LOYALTY OFFER';
            badgeBg = '#ede9fe';
            badgeColor = '#5b21b6';
            headline = 'Your Safar Pro Has Expired';
            subheadline = 'We miss you! Re-activate your Pro benefits today with an exclusive 7-day bonus pass for ₹39.';
            subject = `[Exclusive Offer] Your Safar Pro has expired — Reactivate with 7 Bonus Days`;
        }
        const html = `
      <div style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif; max-width: 600px; margin: 0 auto; padding: 20px; background-color: #f1f5f9; color: #1e293b;">
        <!-- Header -->
        <div style="background: linear-gradient(135deg, #4338ca 0%, #6366f1 50%, #8b5cf6 100%); padding: 32px 24px; border-radius: 16px 16px 0 0; text-align: center; color: white;">
          <h1 style="margin: 0; font-size: 28px; font-weight: 800; letter-spacing: -0.5px;">Trayago</h1>
          <p style="margin: 6px 0 0; font-size: 14px; opacity: 0.9; font-weight: 500;">Intelligent Pan-India Train Assistant</p>
          <div style="display: inline-block; margin-top: 18px; padding: 6px 14px; background-color: ${badgeBg}; color: ${badgeColor}; border-radius: 9999px; font-size: 11px; font-weight: 800; letter-spacing: 0.5px; text-transform: uppercase;">
            ${badgeText}
          </div>
        </div>

        <!-- Main Card -->
        <div style="background-color: #ffffff; padding: 32px 28px; border-radius: 0 0 16px 16px; border: 1px solid #e2e8f0; border-top: none; box-shadow: 0 10px 25px -5px rgba(0, 0, 0, 0.05);">
          <p style="margin: 0 0 14px; font-size: 17px; font-weight: 600; color: #0f172a;">
            Namaste ${safeName},
          </p>
          <h2 style="margin: 0 0 12px; font-size: 22px; font-weight: 700; color: #1e1b4b; line-height: 1.3;">
            ${headline}
          </h2>
          <p style="margin: 0 0 24px; font-size: 15px; line-height: 1.6; color: #475569;">
            ${subheadline}
          </p>

          <!-- Plan Status Pill -->
          <div style="background-color: #f8fafc; border: 1px solid #e2e8f0; border-radius: 10px; padding: 14px 18px; margin-bottom: 24px; display: flex; justify-content: space-between; align-items: center;">
            <span style="font-size: 13px; color: #64748b; font-weight: 500;">Expiry Date:</span>
            <span style="font-size: 14px; color: #0f172a; font-weight: 700;">${expiryDateFormatted}</span>
          </div>

          <!-- Special Renewal Offer Highlight Box -->
          <div style="background: linear-gradient(145deg, #faf5ff 0%, #f3e8ff 100%); border: 2px dashed #a855f7; border-radius: 14px; padding: 24px 20px; text-align: center; margin-bottom: 28px;">
            <span style="background-color: #7e22ce; color: #ffffff; padding: 4px 12px; border-radius: 9999px; font-size: 11px; font-weight: 700; text-transform: uppercase; letter-spacing: 0.5px;">
              ⭐ LOYALTY RENEWAL PASS
            </span>
            <h3 style="margin: 12px 0 6px; font-size: 20px; font-weight: 800; color: #3b0764;">
              ${offerPlanName}
            </h3>
            <p style="margin: 0 0 16px; font-size: 14px; font-weight: 600; color: #7e22ce;">
              ${bonusDaysText}
            </p>

            <div style="margin: 16px 0;">
              <span style="font-size: 16px; color: #94a3b8; text-decoration: line-through; margin-right: 8px;">${originalPrice}</span>
              <span style="font-size: 38px; font-weight: 900; color: #6b21a8; vertical-align: middle;">${offerPrice}</span>
              <span style="font-size: 14px; color: #6b21a8; font-weight: 600;">/ 37 Days</span>
            </div>

            <div style="background-color: #ffffff; border: 1px solid #d8b4fe; border-radius: 8px; padding: 8px 14px; display: inline-block; margin-bottom: 18px;">
              <span style="font-size: 12px; color: #6b21a8; font-weight: 600;">PROMO CODE: </span>
              <span style="font-size: 13px; font-family: monospace; font-weight: 800; color: #581c87; letter-spacing: 1px;">${promoCode}</span>
            </div>

            <div>
              <a href="${renewalUrl}" style="display: inline-block; width: 85%; max-width: 340px; background: linear-gradient(135deg, #6366f1 0%, #8b5cf6 100%); color: #ffffff; text-decoration: none; padding: 14px 28px; border-radius: 10px; font-size: 16px; font-weight: 700; box-shadow: 0 4px 14px rgba(124, 58, 237, 0.35);">
                Renew Safar Pro for ${offerPrice} Now &rarr;
              </a>
            </div>
          </div>

          <!-- Feature Checklist -->
          <div style="margin-bottom: 24px;">
            <p style="margin: 0 0 12px; font-size: 13px; font-weight: 700; color: #64748b; text-transform: uppercase; letter-spacing: 0.5px;">
              What stays unlocked with Safar Pro:
            </p>
            <ul style="margin: 0; padding: 0; list-style: none;">
              <li style="padding: 8px 0; font-size: 14px; color: #334155; display: flex; align-items: center;">
                <span style="color: #10b981; font-weight: bold; margin-right: 10px; font-size: 16px;">✓</span>
                <span><strong>Unlimited AI Split Journey Engine</strong> &bull; Find confirmed seats when direct is waitlisted</span>
              </li>
              <li style="padding: 8px 0; font-size: 14px; color: #334155; display: flex; align-items: center;">
                <span style="color: #10b981; font-weight: bold; margin-right: 10px; font-size: 16px;">✓</span>
                <span><strong>Instant PNR & Charting Alerts</strong> &bull; Multi-ticket tracking with high-speed updates</span>
              </li>
              <li style="padding: 8px 0; font-size: 14px; color: #334155; display: flex; align-items: center;">
                <span style="color: #10b981; font-weight: bold; margin-right: 10px; font-size: 16px;">✓</span>
                <span><strong>Priority Station Wake-Up Alarm</strong> &bull; Never miss your stop at night</span>
              </li>
              <li style="padding: 8px 0; font-size: 14px; color: #334155; display: flex; align-items: center;">
                <span style="color: #10b981; font-weight: bold; margin-right: 10px; font-size: 16px;">✓</span>
                <span><strong>100% Ad-Free Travel Experience</strong> &bull; Lightning fast search with zero interruptions</span>
              </li>
            </ul>
          </div>

          <p style="margin: 0; font-size: 12px; color: #94a3b8; text-align: center; line-height: 1.5;">
            Secured via Razorpay &bull; Instant activation on all devices &bull; UPI, Cards, Netbanking supported
          </p>
        </div>

        <!-- Footer -->
        <div style="text-align: center; margin-top: 20px; font-size: 12px; color: #64748b;">
          <p style="margin: 0 0 6px;">Questions or need help? Contact us at <a href="mailto:support@trayago.in" style="color: #4f46e5; text-decoration: none;">support@trayago.in</a></p>
          <p style="margin: 0;">&copy; ${new Date().getFullYear()} Trayago. All rights reserved.</p>
        </div>
      </div>
    `;
        return this.sendWithFailover({
            to: toEmail,
            subject,
            html,
            senderName: 'Trayago Safar Pro',
            tag: 'SUBSCRIPTION_RENEWAL',
        });
    }
    async sendDiwaliPromoEmail(options) {
        const { toEmail, userName, claimUrl = 'https://www.trayago.in/pricing?code=OFFER35', promoCode = 'OFFER35', offerPrice = '₹35', originalPrice = '₹49' } = options;
        const safeName = String(userName || 'Traveler').replace(/</g, '&lt;').replace(/>/g, '&gt;');
        const subject = '🪔 Diwali Special: Get Trayago Pro for just ₹35! Unlimited AI Split Journeys & Confirmed Seats';
        const html = `
<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Trayago Diwali Special Offer</title>
</head>
<body style="margin: 0; padding: 0; background-color: #0b0f19; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif; color: #1e293b;">
  <table width="100%" border="0" cellspacing="0" cellpadding="0" style="background-color: #0b0f19; padding: 30px 10px;">
    <tr>
      <td align="center">
        <table width="100%" border="0" cellspacing="0" cellpadding="0" style="max-width: 600px; background-color: #ffffff; border-radius: 18px; overflow: hidden; box-shadow: 0 16px 36px rgba(0,0,0,0.35); border: 1px solid rgba(245, 158, 11, 0.25);">
          
          <!-- Header Bar with Logo -->
          <tr>
            <td style="background: linear-gradient(135deg, #0f172a 0%, #1e1b4b 100%); padding: 20px 28px; text-align: left; border-bottom: 2px solid #f59e0b;">
              <table width="100%" border="0" cellspacing="0" cellpadding="0">
                <tr>
                  <td style="vertical-align: middle;">
                    <img src="https://www.trayago.in/branding/trayago-logo-512x512.png" alt="Trayago" width="42" height="42" style="border-radius: 10px; display: inline-block; vertical-align: middle; margin-right: 12px; box-shadow: 0 2px 8px rgba(0,0,0,0.3);" />
                    <span style="font-size: 24px; font-weight: 900; color: #ffffff; letter-spacing: -0.5px; vertical-align: middle;">Trayago</span>
                  </td>
                  <td align="right" style="vertical-align: middle;">
                    <span style="display: inline-block; padding: 6px 14px; border-radius: 20px; font-size: 11px; font-weight: 800; text-transform: uppercase; letter-spacing: 0.5px; background: linear-gradient(135deg, #f59e0b 0%, #d97706 100%); color: #ffffff; box-shadow: 0 2px 8px rgba(245, 158, 11, 0.35);">
                      ✨ Diwali Special ✨
                    </span>
                  </td>
                </tr>
              </table>
            </td>
          </tr>

          <!-- Festive Diwali Banner -->
          <tr>
            <td style="background-color: #0f172a; line-height: 0;">
              <a href="${claimUrl}" target="_blank" style="text-decoration: none; display: block;">
                <img src="https://www.trayago.in/branding/trayago-diwali-2026.jpg" alt="Trayago Diwali Special Offer - ₹35 for 30 Days" width="600" style="width: 100%; max-width: 600px; height: auto; display: block; border: 0;" />
              </a>
            </td>
          </tr>

          <!-- Main Body Content -->
          <tr>
            <td style="padding: 30px 28px 24px 28px; background-color: #ffffff;">
              <p style="margin: 0 0 14px 0; font-size: 17px; font-weight: 700; color: #0f172a;">
                Namaste ${safeName},
              </p>

              <p style="margin: 0 0 16px 0; font-size: 15px; line-height: 1.6; color: #334155;">
                Festive season planning is in full swing, and we know how stressful it can be when direct train tickets show long waitlists.
              </p>

              <p style="margin: 0 0 24px 0; font-size: 15px; line-height: 1.6; color: #334155;">
                This Diwali, we want to make sure you reach your destination smoothly. That is why we are giving you full access to <strong>Trayago Pro for just ${offerPrice}</strong> (originally ${originalPrice}) for the next 30 days!
              </p>

              <!-- Special Offer Price Badge Card -->
              <div style="background: linear-gradient(145deg, #fffbeb 0%, #fef3c7 100%); border: 2px dashed #f59e0b; border-radius: 14px; padding: 22px 20px; text-align: center; margin-bottom: 28px;">
                <span style="background-color: #b45309; color: #ffffff; padding: 5px 14px; border-radius: 9999px; font-size: 11px; font-weight: 800; text-transform: uppercase; letter-spacing: 0.8px;">
                  🪔 30% OFF FESTIVE PASS
                </span>
                <h3 style="margin: 12px 0 6px 0; font-size: 22px; font-weight: 900; color: #78350f;">
                  Trayago Pro Monthly Access
                </h3>

                <div style="margin: 14px 0;">
                  <span style="font-size: 18px; color: #94a3b8; text-decoration: line-through; margin-right: 8px; font-weight: 700;">${originalPrice}</span>
                  <span style="font-size: 42px; font-weight: 900; color: #b45309; vertical-align: middle;">${offerPrice}</span>
                  <span style="font-size: 15px; color: #92400e; font-weight: 700;">/ 30 Days</span>
                </div>

                <div style="background-color: #ffffff; border: 1px solid #fcd34d; border-radius: 8px; padding: 8px 16px; display: inline-block; margin-bottom: 18px;">
                  <span style="font-size: 12px; color: #92400e; font-weight: 700;">PROMO CODE: </span>
                  <span style="font-size: 15px; font-family: monospace; font-weight: 900; color: #b45309; letter-spacing: 1.5px;">${promoCode}</span>
                </div>

                <div>
                  <a href="${claimUrl}" target="_blank" style="display: inline-block; width: 85%; max-width: 360px; background: linear-gradient(135deg, #f59e0b 0%, #d97706 100%); color: #ffffff; text-decoration: none; padding: 14px 28px; border-radius: 10px; font-size: 16px; font-weight: 800; letter-spacing: 0.5px; box-shadow: 0 4px 14px rgba(245, 158, 11, 0.4);">
                    Claim 1 Month Pro for ${offerPrice} &rarr;
                  </a>
                </div>
              </div>

              <!-- Unlocked Features Section -->
              <div style="margin-bottom: 26px;">
                <h4 style="margin: 0 0 14px 0; font-size: 16px; font-weight: 800; color: #0f172a;">
                  🪔 Here is what you unlock with Trayago Pro:
                </h4>

                <table width="100%" border="0" cellspacing="0" cellpadding="0" style="border-collapse: collapse;">
                  <!-- Feature 1 -->
                  <tr>
                    <td style="padding: 10px 0; vertical-align: top; width: 28px;">
                      <span style="font-size: 18px; line-height: 1;">⚡</span>
                    </td>
                    <td style="padding: 10px 0 10px 8px; vertical-align: top;">
                      <div style="font-size: 14px; font-weight: 800; color: #0f172a; margin-bottom: 2px;">
                        Unlimited AI Hidden Split Journeys
                      </div>
                      <div style="font-size: 13px; color: #475569; line-height: 1.5;">
                        Our advanced engine scans millions of node combinations to find you confirmed seats across connecting legs when direct booking is full.
                      </div>
                    </td>
                  </tr>

                  <!-- Feature 2 -->
                  <tr>
                    <td style="padding: 10px 0; vertical-align: top; width: 28px; border-top: 1px solid #f1f5f9;">
                      <span style="font-size: 18px; line-height: 1;">🛰️</span>
                    </td>
                    <td style="padding: 10px 0 10px 8px; vertical-align: top; border-top: 1px solid #f1f5f9;">
                      <div style="font-size: 14px; font-weight: 800; color: #0f172a; margin-bottom: 2px;">
                        Live Train GPS Alerts & Real-time Speedometer
                      </div>
                      <div style="font-size: 13px; color: #475569; line-height: 1.5;">
                        Track your train in real-time with precise station coordinates, accurate platform indicators, live speedometer HUD, and delay forecasts.
                      </div>
                    </td>
                  </tr>

                  <!-- Feature 3 -->
                  <tr>
                    <td style="padding: 10px 0; vertical-align: top; width: 28px; border-top: 1px solid #f1f5f9;">
                      <span style="font-size: 18px; line-height: 1;">📊</span>
                    </td>
                    <td style="padding: 10px 0 10px 8px; vertical-align: top; border-top: 1px solid #f1f5f9;">
                      <div style="font-size: 14px; font-weight: 800; color: #0f172a; margin-bottom: 2px;">
                        Smart PNR Confirmation Probabilities
                      </div>
                      <div style="font-size: 13px; color: #475569; line-height: 1.5;">
                        Analyze historical confirmation trends and forecast the exact percentage chance of your waitlisted ticket getting confirmed with 92%+ accuracy.
                      </div>
                    </td>
                  </tr>

                  <!-- Feature 4 -->
                  <tr>
                    <td style="padding: 10px 0; vertical-align: top; width: 28px; border-top: 1px solid #f1f5f9;">
                      <span style="font-size: 18px; line-height: 1;">🚀</span>
                    </td>
                    <td style="padding: 10px 0 10px 8px; vertical-align: top; border-top: 1px solid #f1f5f9;">
                      <div style="font-size: 14px; font-weight: 800; color: #0f172a; margin-bottom: 2px;">
                        High Priority Support & Auto-Refresh
                      </div>
                      <div style="font-size: 13px; color: #475569; line-height: 1.5;">
                        Get your routes processed faster with dedicated server priority.
                      </div>
                    </td>
                  </tr>
                </table>
              </div>

              <!-- How to claim box -->
              <div style="background-color: #f8fafc; border: 1px solid #e2e8f0; border-radius: 12px; padding: 18px 20px; margin-bottom: 24px;">
                <h4 style="margin: 0 0 10px 0; font-size: 14px; font-weight: 800; color: #0f172a; text-transform: uppercase; letter-spacing: 0.5px;">
                  How to claim your offer:
                </h4>
                <ol style="margin: 0; padding-left: 20px; font-size: 14px; color: #334155; line-height: 1.7;">
                  <li>Log into your account at <a href="https://www.trayago.in" target="_blank" style="color: #2563eb; text-decoration: none; font-weight: 700;">trayago.in</a>.</li>
                  <li>Click on the Diwali Special Offer banner or the claim button below.</li>
                  <li>Your discount code <strong>${promoCode}</strong> will be automatically applied at checkout.</li>
                </ol>
              </div>

              <p style="margin: 0 0 20px 0; font-size: 14px; line-height: 1.6; color: #475569; font-style: italic; text-align: center;">
                Don't let a waitlisted ticket keep you away from family celebrations this festive season. Upgrade today and travel smarter.
              </p>

              <!-- Final CTA Button -->
              <div style="text-align: center; margin-bottom: 26px;">
                <a href="${claimUrl}" target="_blank" style="display: inline-block; background-color: #0f172a; color: #ffffff; text-decoration: none; padding: 14px 32px; border-radius: 10px; font-size: 15px; font-weight: 800; letter-spacing: 0.5px; border: 1px solid #334155; box-shadow: 0 4px 12px rgba(15, 23, 42, 0.25);">
                  Claim 1 Month Pro for ${offerPrice} &rarr;
                </a>
              </div>

              <!-- Sign-off -->
              <div style="border-top: 1px solid #f1f5f9; padding-top: 20px;">
                <p style="margin: 0 0 4px 0; font-size: 15px; font-weight: 700; color: #0f172a;">
                  Wishing you a safe, happy, and prosperous Diwali!
                </p>
                <p style="margin: 0 0 2px 0; font-size: 14px; color: #64748b;">
                  Best regards,
                </p>
                <p style="margin: 0 0 2px 0; font-size: 14px; font-weight: 700; color: #0f172a;">
                  The Trayago Team
                </p>
                <p style="margin: 0; font-size: 13px; color: #2563eb;">
                  <a href="mailto:support@trayago.in" style="color: #2563eb; text-decoration: none;">support@trayago.in</a>
                </p>
              </div>
            </td>
          </tr>

          <!-- Footer -->
          <tr>
            <td style="background-color: #f8fafc; border-top: 1px solid #e2e8f0; padding: 18px 28px; text-align: center;">
              <p style="margin: 0 0 4px 0; font-size: 12px; font-weight: 600; color: #64748b;">
                Trayago &middot; Pan-India Smart Railway Travel Companion
              </p>
              <p style="margin: 0 0 4px 0; font-size: 11px; color: #94a3b8;">
                You are receiving this special festive update because you are a registered member of Trayago.
              </p>
              <p style="margin: 0; font-size: 11px; color: #94a3b8;">
                <a href="https://www.trayago.in" style="color: #64748b; text-decoration: none;">Visit Website</a> &middot; 
                <a href="https://www.trayago.in/profile" style="color: #64748b; text-decoration: none;">Manage Preferences</a> &middot; 
                <a href="mailto:support@trayago.in" style="color: #64748b; text-decoration: none;">Contact Support</a>
              </p>
            </td>
          </tr>

        </table>
      </td>
    </tr>
  </table>
</body>
</html>
    `;
        return this.sendWithFailover({
            to: toEmail,
            subject,
            html,
            senderName: 'Trayago Diwali Special',
            tag: 'DIWALI_PROMO',
        });
    }
    async sendCustomCampaignEmail(options) {
        const { toEmail, userName, title, message, offerPrice, originalPrice, promoCode, actionUrl = 'https://www.trayago.in/pricing', actionLabel = 'Explore Now', bannerUrl } = options;
        const safeName = String(userName || 'Traveler').replace(/</g, '&lt;').replace(/>/g, '&gt;');
        const safeTitle = String(title || 'Special Update from Trayago').replace(/</g, '&lt;').replace(/>/g, '&gt;');
        const paragraphs = message
            .split('\n')
            .map(line => line.trim())
            .filter(line => line.length > 0)
            .map(line => `<p style="margin: 0 0 14px 0; font-size: 15px; line-height: 1.6; color: #334155;">${line.replace(/</g, '&lt;').replace(/>/g, '&gt;')}</p>`)
            .join('');
        const bannerHtml = bannerUrl ? `
      <tr>
        <td style="background-color: #0f172a; line-height: 0;">
          <a href="${actionUrl}" target="_blank" style="text-decoration: none; display: block;">
            <img src="${bannerUrl}" alt="${safeTitle}" width="600" style="width: 100%; max-width: 600px; height: auto; display: block; border: 0;" />
          </a>
        </td>
      </tr>
    ` : '';
        const offerCardHtml = offerPrice ? `
      <div style="background: linear-gradient(145deg, #fffbeb 0%, #fef3c7 100%); border: 2px dashed #f59e0b; border-radius: 14px; padding: 22px 20px; text-align: center; margin: 24px 0;">
        <span style="background-color: #b45309; color: #ffffff; padding: 5px 14px; border-radius: 9999px; font-size: 11px; font-weight: 800; text-transform: uppercase; letter-spacing: 0.8px;">
          ⭐ SPECIAL PROMOTIONAL OFFER
        </span>
        <div style="margin: 14px 0;">
          ${originalPrice ? `<span style="font-size: 18px; color: #94a3b8; text-decoration: line-through; margin-right: 8px; font-weight: 700;">${originalPrice}</span>` : ''}
          <span style="font-size: 40px; font-weight: 900; color: #b45309; vertical-align: middle;">${offerPrice}</span>
        </div>
        ${promoCode ? `
        <div style="background-color: #ffffff; border: 1px solid #fcd34d; border-radius: 8px; padding: 8px 16px; display: inline-block; margin-bottom: 18px;">
          <span style="font-size: 12px; color: #92400e; font-weight: 700;">PROMO CODE: </span>
          <span style="font-size: 15px; font-family: monospace; font-weight: 900; color: #b45309; letter-spacing: 1.5px;">${promoCode}</span>
        </div>
        ` : ''}
        <div>
          <a href="${actionUrl}" target="_blank" style="display: inline-block; width: 85%; max-width: 360px; background: linear-gradient(135deg, #f59e0b 0%, #d97706 100%); color: #ffffff; text-decoration: none; padding: 14px 28px; border-radius: 10px; font-size: 16px; font-weight: 800; letter-spacing: 0.5px; box-shadow: 0 4px 14px rgba(245, 158, 11, 0.4);">
            ${actionLabel} &rarr;
          </a>
        </div>
      </div>
    ` : `
      <div style="text-align: center; margin: 28px 0;">
        <a href="${actionUrl}" target="_blank" style="display: inline-block; background-color: #2563eb; color: #ffffff; text-decoration: none; padding: 14px 32px; border-radius: 10px; font-size: 15px; font-weight: 800; letter-spacing: 0.5px; box-shadow: 0 4px 14px rgba(37, 99, 235, 0.35);">
          ${actionLabel} &rarr;
        </a>
      </div>
    `;
        const html = `
<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${safeTitle}</title>
</head>
<body style="margin: 0; padding: 0; background-color: #0b0f19; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif; color: #1e293b;">
  <table width="100%" border="0" cellspacing="0" cellpadding="0" style="background-color: #0b0f19; padding: 30px 10px;">
    <tr>
      <td align="center">
        <table width="100%" border="0" cellspacing="0" cellpadding="0" style="max-width: 600px; background-color: #ffffff; border-radius: 18px; overflow: hidden; box-shadow: 0 16px 36px rgba(0,0,0,0.35); border: 1px solid #e2e8f0;">
          
          <!-- Header Bar with Logo -->
          <tr>
            <td style="background: linear-gradient(135deg, #0f172a 0%, #1e293b 100%); padding: 20px 28px; text-align: left; border-bottom: 2px solid #2563eb;">
              <table width="100%" border="0" cellspacing="0" cellpadding="0">
                <tr>
                  <td style="vertical-align: middle;">
                    <img src="https://www.trayago.in/branding/trayago-logo-512x512.png" alt="Trayago" width="42" height="42" style="border-radius: 10px; display: inline-block; vertical-align: middle; margin-right: 12px; box-shadow: 0 2px 8px rgba(0,0,0,0.3);" />
                    <span style="font-size: 24px; font-weight: 900; color: #ffffff; letter-spacing: -0.5px; vertical-align: middle;">Trayago</span>
                  </td>
                  <td align="right" style="vertical-align: middle;">
                    <span style="display: inline-block; padding: 6px 14px; border-radius: 20px; font-size: 11px; font-weight: 800; text-transform: uppercase; letter-spacing: 0.5px; background: rgba(37, 99, 235, 0.2); color: #60a5fa; border: 1px solid rgba(96, 165, 250, 0.3);">
                      Official Announcement
                    </span>
                  </td>
                </tr>
              </table>
            </td>
          </tr>

          ${bannerHtml}

          <!-- Main Body Content -->
          <tr>
            <td style="padding: 30px 28px 24px 28px; background-color: #ffffff;">
              <p style="margin: 0 0 16px 0; font-size: 17px; font-weight: 700; color: #0f172a;">
                Namaste ${safeName},
              </p>

              <h2 style="margin: 0 0 18px 0; font-size: 22px; font-weight: 800; color: #0f172a; line-height: 1.3;">
                ${safeTitle}
              </h2>

              <div style="margin-bottom: 20px;">
                ${paragraphs}
              </div>

              ${offerCardHtml}

              <!-- Sign-off -->
              <div style="border-top: 1px solid #f1f5f9; padding-top: 20px; margin-top: 24px;">
                <p style="margin: 0 0 2px 0; font-size: 14px; color: #64748b;">
                  Best regards,
                </p>
                <p style="margin: 0 0 2px 0; font-size: 14px; font-weight: 700; color: #0f172a;">
                  The Trayago Team
                </p>
                <p style="margin: 0; font-size: 13px; color: #2563eb;">
                  <a href="mailto:support@trayago.in" style="color: #2563eb; text-decoration: none;">support@trayago.in</a> &middot; <a href="https://www.trayago.in" style="color: #2563eb; text-decoration: none;">www.trayago.in</a>
                </p>
              </div>
            </td>
          </tr>

          <!-- Footer -->
          <tr>
            <td style="background-color: #f8fafc; border-top: 1px solid #e2e8f0; padding: 18px 28px; text-align: center;">
              <p style="margin: 0 0 4px 0; font-size: 12px; font-weight: 600; color: #64748b;">
                Trayago &middot; Pan-India Smart Railway Travel Companion
              </p>
              <p style="margin: 0 0 4px 0; font-size: 11px; color: #94a3b8;">
                You are receiving this update because you are a registered user of Trayago.
              </p>
              <p style="margin: 0; font-size: 11px; color: #94a3b8;">
                <a href="https://www.trayago.in" style="color: #64748b; text-decoration: none;">Website</a> &middot; 
                <a href="https://www.trayago.in/profile" style="color: #64748b; text-decoration: none;">Preferences</a> &middot; 
                <a href="mailto:support@trayago.in" style="color: #64748b; text-decoration: none;">Support</a>
              </p>
            </td>
          </tr>

        </table>
      </td>
    </tr>
  </table>
</body>
</html>
    `;
        return this.sendWithFailover({
            to: toEmail,
            subject: safeTitle,
            html,
            senderName: 'Trayago Updates',
            tag: 'CAMPAIGN_BROADCAST',
        });
    }
}
exports.EmailService = EmailService;
exports.emailService = new EmailService();
