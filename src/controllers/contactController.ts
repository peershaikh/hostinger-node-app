import { Request, Response } from 'express';
import crypto from 'crypto';
import { supabase, isSupabaseConfigured, isNoWriteMode } from '../config/supabase';
import { winstonLogger } from '../middleware/logger';
import { emailService } from '../services/emailService';
import {
  enqueueFeedbackRecord,
  StorageCapacityExceededError,
  MAX_FALLBACK_CAPACITY,
} from '../utils/feedbackStorage';

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

      // 3. Save to Supabase `feedback` table for unified Admin Panel review
      let dbSuccess = false;
      if (isSupabaseConfigured()) {
        try {
          const { error } = await supabase.from('feedback').insert([{
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
          if (!error) {
            dbSuccess = true;
          } else {
            winstonLogger.warn(`[CONTACT_DB_WARN] Supabase write failed: ${error.message}`);
          }
        } catch (dbErr: any) {
          winstonLogger.warn(`[CONTACT_DB_WARN] Supabase write fallback: ${dbErr.message}`);
        }
      }

      // 4. Asynchronous Fallback ONLY if database persistence failed or is unconfigured
      // Uses shared serialized queue, FIFO order, bounded capacity, and atomic file write
      let fallbackSuccess = false;
      let capacityExceeded = false;
      if (!dbSuccess && !isNoWriteMode()) {
        try {
          const fallbackRecord = {
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
            comments: `[CONTACT_US] [Subject: ${cleanSubject}] [Category: ${cleanCategory}] [Phone: ${cleanPhone || 'N/A'}] Message: ${cleanMessage}`,
            ui: cleanSubject,
            is_accurate: true,
          };
          await enqueueFeedbackRecord(fallbackRecord);
          fallbackSuccess = true;
        } catch (fbErr: any) {
          if (fbErr instanceof StorageCapacityExceededError) {
            capacityExceeded = true;
            winstonLogger.error(`[CONTACT_FALLBACK_SATURATED] Queue capacity reached (${MAX_FALLBACK_CAPACITY}).`);
          } else {
            winstonLogger.error(`[CONTACT_FALLBACK_FAIL] Fallback persistence failed: ${fbErr.message}`);
          }
        }
      }

      // 5. Evaluate Persistence Durability & Return Response
      // Succeeded via Supabase, simulated via no-write mode (unless capacity exceeded), or persisted via local fallback
      if (dbSuccess || (isNoWriteMode() && !capacityExceeded) || fallbackSuccess) {
        winstonLogger.info(`[CONTACT_INQUIRY_RECEIVED] id=${contactId} category=${cleanCategory}`);
        return res.status(200).json({
          success: true,
          message: 'Your inquiry has been received. Our team will contact you shortly.',
        });
      }

      // Both primary Supabase and local fallback persistence failed (or capacity exceeded)
      winstonLogger.error(`[CONTACT_PERSISTENCE_FAILED] Persistence failed for id=${contactId}`);
      return res.status(503).json({
        success: false,
        error: 'Service temporarily unavailable. Please try again later or email us directly at support@trayago.in.',
      });
    } catch (err: any) {
      winstonLogger.error(`[CONTACT_SUBMIT_ERROR] ${err.message}`);
      return res.status(500).json({
        success: false,
        error: 'Failed to process inquiry. Please try again later.',
      });
    }
  },
};
