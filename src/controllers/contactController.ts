import { Request, Response } from 'express';
import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import { supabase, isSupabaseConfigured } from '../config/supabase';
import { winstonLogger } from '../middleware/logger';
import { emailService } from '../services/emailService';

const CONTACT_MESSAGES_FILE = path.join(__dirname, '../../../data/contact_messages.json');
const FEEDBACK_FILE = path.join(__dirname, '../../../data/feedback.json');

export const contactController = {
  submit: async (req: Request, res: Response) => {
    try {
      const { name, email, phone, subject, message, category } = req.body;

      if (!name || typeof name !== 'string' || !name.trim()) {
        return res.status(400).json({ success: false, error: 'Please provide your name.' });
      }

      const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
      if (!email || typeof email !== 'string' || !emailRegex.test(email.trim())) {
        return res.status(400).json({ success: false, error: 'Please provide a valid email address.' });
      }

      if (!message || typeof message !== 'string' || message.trim().length < 5) {
        return res.status(400).json({ success: false, error: 'Please enter a message of at least 5 characters.' });
      }

      const cleanName = name.trim().slice(0, 100);
      const cleanEmail = email.trim().toLowerCase().slice(0, 150);
      const cleanPhone = phone ? String(phone).trim().slice(0, 30) : null;
      const cleanSubject = subject ? String(subject).trim().slice(0, 200) : 'General Inquiry';
      const cleanCategory = category ? String(category).trim().toLowerCase().slice(0, 50) : 'general';
      const cleanMessage = message.trim().slice(0, 5000);

      const contactId = crypto.randomUUID();
      const timestamp = new Date().toISOString();

      const record = {
        id: contactId,
        timestamp,
        name: cleanName,
        email: cleanEmail,
        phone: cleanPhone,
        subject: cleanSubject,
        category: cleanCategory,
        message: cleanMessage,
        ip: req.ip || req.socket.remoteAddress || 'unknown',
        userAgent: req.headers['user-agent'] || 'unknown',
      };

      // 1. Resolve Admin Emails
      const rawEmails = process.env.ADMIN_EMAILS || process.env.ADMIN_EMAIL || '';
      const envEmails = rawEmails.split(',').map((e: string) => e.trim()).filter(Boolean);
      const DEV_ADMIN_EMAIL = 'peershaikh25@gmail.com';
      const recipientEmails = envEmails.includes(DEV_ADMIN_EMAIL)
        ? (envEmails.length ? envEmails : [DEV_ADMIN_EMAIL])
        : [...envEmails, DEV_ADMIN_EMAIL];

      // 2. Dispatch Email to Admin (non-blocking)
      setImmediate(() => {
        emailService.sendContactInquiryEmail({
          adminEmails: recipientEmails,
          userName: cleanName,
          userEmail: cleanEmail,
          userPhone: cleanPhone || undefined,
          subject: cleanSubject,
          message: cleanMessage,
          category: cleanCategory,
        }).catch((err: any) => {
          winstonLogger.error(`[CONTACT_EMAIL_FAIL] Error notifying admin: ${err.message}`);
        });
      });

      // 3. Local JSON Storage (contact_messages.json)
      try {
        let messages: any[] = [];
        if (fs.existsSync(CONTACT_MESSAGES_FILE)) {
          messages = JSON.parse(fs.readFileSync(CONTACT_MESSAGES_FILE, 'utf-8'));
        }
        messages.unshift(record);
        if (!fs.existsSync(path.dirname(CONTACT_MESSAGES_FILE))) {
          fs.mkdirSync(path.dirname(CONTACT_MESSAGES_FILE), { recursive: true });
        }
        fs.writeFileSync(CONTACT_MESSAGES_FILE, JSON.stringify(messages.slice(0, 500), null, 2));
      } catch (fileErr: any) {
        winstonLogger.warn(`[CONTACT_FILE_FAIL] Local write failed: ${fileErr.message}`);
      }

      // 4. Save to Supabase `feedback` table for unified Admin Panel review
      if (isSupabaseConfigured()) {
        try {
          await supabase.from('feedback').insert([{
            id: contactId,
            timestamp,
            comments: `[CONTACT_US] [Subject: ${cleanSubject}] [Category: ${cleanCategory}] [Phone: ${cleanPhone || 'N/A'}] Message: ${cleanMessage}`,
            name: cleanName,
            email: cleanEmail,
            feature: 'CONTACT_US',
            severity: 'medium',
            suggestions: cleanMessage,
            ui: cleanSubject,
            is_accurate: true,
          }]);
        } catch (dbErr: any) {
          winstonLogger.warn(`[CONTACT_DB_WARN] Supabase write fallback: ${dbErr.message}`);
        }
      }

      // Also append to feedback.json so existing Admin FeedbackReviewPanel shows it immediately
      try {
        let allFeedback: any[] = [];
        if (fs.existsSync(FEEDBACK_FILE)) {
          allFeedback = JSON.parse(fs.readFileSync(FEEDBACK_FILE, 'utf-8'));
        }
        allFeedback.unshift({
          id: contactId,
          timestamp,
          name: cleanName,
          email: cleanEmail,
          device: cleanPhone ? `Phone: ${cleanPhone}` : 'Web Contact',
          os: cleanCategory,
          feature: 'CONTACT_US',
          bug: cleanSubject,
          suggestions: cleanMessage,
          severity: 'medium',
        });
        fs.writeFileSync(FEEDBACK_FILE, JSON.stringify(allFeedback.slice(0, 1000), null, 2));
      } catch (fbErr: any) {
        winstonLogger.warn(`[CONTACT_FEEDBACK_SYNC] Feedback sync failed: ${fbErr.message}`);
      }

      winstonLogger.info(`[CONTACT_INQUIRY_RECEIVED] From: ${cleanEmail} (${cleanName}) | Subject: ${cleanSubject}`);
      return res.status(200).json({
        success: true,
        message: 'Your inquiry has been received. Our team will contact you shortly.',
      });
    } catch (err: any) {
      winstonLogger.error(`[CONTACT_SUBMIT_ERROR] ${err.message}`);
      return res.status(500).json({
        success: false,
        error: 'Failed to send message. Please try again or email us directly at support@trayago.in.',
      });
    }
  },
};
