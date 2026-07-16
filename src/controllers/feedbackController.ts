import crypto from 'crypto';
import { Request, Response } from 'express';
import fs from 'fs';
import path from 'path';
import { supabase, isSupabaseConfigured } from '../config/supabase';
import { winstonLogger } from '../middleware/logger';
import { llmService } from '../services/llmService';

const FEEDBACK_FILE = path.join(__dirname, '../../../data/feedback.json');
const FEEDBACK_CATEGORIES_FILE = path.join(__dirname, '../../../data/feedback_categories.json');

// ─── Async background categorization (non-blocking) ─────────────────────────
async function categorizeFeedbackAsync(feedbackId: string, feedbackText: string, metadata: { feature?: string; severity?: string; device?: string }) {
  try {
    const result = await llmService.categorizeFeedback(feedbackText, metadata);
    if (!result) return; // GPT unavailable or opted out — silently skip

    const category = {
      id: crypto.randomUUID(),
      feedbackId,
      category: result.category,
      confidence: result.confidence,
      priority: result.priority,
      summary: result.summary,
      suggestedAction: result.suggestedAction,
      createdAt: new Date().toISOString()
    };

    // Local JSON persistence
    try {
      let existing: any[] = [];
      if (fs.existsSync(FEEDBACK_CATEGORIES_FILE)) {
        existing = JSON.parse(fs.readFileSync(FEEDBACK_CATEGORIES_FILE, 'utf-8'));
      }
      existing.push(category);
      if (!fs.existsSync(path.dirname(FEEDBACK_CATEGORIES_FILE))) {
        fs.mkdirSync(path.dirname(FEEDBACK_CATEGORIES_FILE), { recursive: true });
      }
      fs.writeFileSync(FEEDBACK_CATEGORIES_FILE, JSON.stringify(existing, null, 2));
    } catch (fileErr: any) {
      winstonLogger.warn(`[FEEDBACK_CATEGORY] Local write failed: ${fileErr.message}`);
    }

    // Supabase dual-write
    if (isSupabaseConfigured()) {
      try {
        await supabase.from('feedback_categories').insert({
          id: category.id,
          feedback_id: category.feedbackId,
          category: category.category,
          confidence: category.confidence,
          priority: category.priority,
          summary: category.summary,
          suggested_action: category.suggestedAction,
          created_at: category.createdAt
        });
      } catch (dbErr: any) {
        winstonLogger.warn(`[FEEDBACK_CATEGORY] Supabase write failed: ${dbErr.message}`);
      }
    }

    winstonLogger.info(`[FEEDBACK_CATEGORY] Classified feedback ${feedbackId} → ${result.category} (${result.priority})`);
  } catch (err: any) {
    winstonLogger.warn(`[FEEDBACK_CATEGORY] Background categorization failed: ${err.message}`);
  }
}

export const feedbackController = {
  submit: async (req: Request, res: Response) => {
    try {
      const { name, email, device, os, feature, bug, screenshot, severity, performance, ui, suggestions, userId, searchId, routeContext } = req.body;
      
      const feedback = {
        id: Math.random().toString(36).substring(2, 9),
        timestamp: new Date().toISOString(),
        name,
        email,
        device,
        os,
        feature,
        bug,
        screenshot,
        severity,
        performance,
        ui,
        suggestions,
        userId: userId || null,
        searchId: searchId || null,
        routeContext: routeContext || null
      };
      
      const pnrVal = (routeContext as any)?.pnr || (routeContext as any)?.pnr_number || null;
      let dbSuccess = false;

      // Primary: Write to Supabase with full schema
      if (isSupabaseConfigured()) {
        try {
          await supabase.from('feedback').insert([{
            id: feedback.id,
            timestamp: feedback.timestamp,
            pnr: pnrVal,
            is_accurate: severity !== 'high',
            comments: `[BETA_FEEDBACK] [OS: ${os || 'N/A'}] [Device: ${device || 'N/A'}] Bug: ${bug || 'N/A'} | Suggestions: ${suggestions || 'N/A'} | Feature: ${feature || 'N/A'} | Severity: ${severity || 'N/A'} | UI: ${ui || 'N/A'} | userId: ${userId || 'N/A'} | searchId: ${searchId || 'N/A'}`,
            name,
            email,
            device,
            os,
            feature,
            bug,
            screenshot,
            severity,
            performance,
            ui,
            suggestions,
            user_id: userId || null,
            search_id: searchId || null,
            route_context: routeContext || null
          }]);
          dbSuccess = true;
        } catch (dbErr: any) {
          winstonLogger.warn(`[FEEDBACK] Supabase primary write failed: ${dbErr.message}, falling back to JSON.`);
        }
      }

      // Secondary: Local JSON Fallback (Always write to keep local log, but especially crucial if DB fails)
      let allFeedback = [];
      if (fs.existsSync(FEEDBACK_FILE)) {
        try {
          allFeedback = JSON.parse(fs.readFileSync(FEEDBACK_FILE, 'utf-8'));
        } catch (e) {
          allFeedback = [];
        }
      }
      
      allFeedback.push(feedback);
      
      if (!fs.existsSync(path.dirname(FEEDBACK_FILE))) {
        fs.mkdirSync(path.dirname(FEEDBACK_FILE), { recursive: true });
      }
      fs.writeFileSync(FEEDBACK_FILE, JSON.stringify(allFeedback, null, 2));

      // ─── Non-blocking GPT categorization ───────────────────────────────────
      // Build the text to classify from the richest available field
      const feedbackText = [bug, suggestions, feature].filter(Boolean).join(' | ') || 'No description provided';
      setImmediate(() => {
        categorizeFeedbackAsync(feedback.id, feedbackText, { feature, severity, device });
      });
      // ───────────────────────────────────────────────────────────────────────

      return res.json({ success: true });
    } catch (err) {
      winstonLogger.error(`[FEEDBACK] submit failed: ${(err as any).message}`);
      return res.status(500).json({ success: false, error: 'Failed to submit feedback' });
    }
  }
};
