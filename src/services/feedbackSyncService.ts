import { supabase, isSupabaseConfigured } from '../config/supabase';
import fs from 'fs';
import path from 'path';
import { winstonLogger } from '../middleware/logger';

export class FeedbackSyncService {
  private isSyncing = false;

  async syncAllFallbacks() {
    if (this.isSyncing) {
      winstonLogger.info('[FEEDBACK_SYNC] Sync is already in progress. Skipping.');
      return;
    }
    if (!isSupabaseConfigured()) {
      winstonLogger.info('[FEEDBACK_SYNC] Supabase is not configured. Skipping sync.');
      return;
    }

    this.isSyncing = true;
    winstonLogger.info('[FEEDBACK_SYNC] Starting offline feedback synchronization...');

    try {
      await this.syncFeedbackFile();
      await this.syncPnrPredictionFeedbackFile();
      await this.syncSocialComplaintsFile();
      winstonLogger.info('[FEEDBACK_SYNC] Offline feedback synchronization completed successfully.');
    } catch (err: any) {
      winstonLogger.error(`[FEEDBACK_SYNC] Sync process encountered errors: ${err.message}`);
    } finally {
      this.isSyncing = false;
    }
  }

  private async syncFeedbackFile() {
    const filePath = path.join(__dirname, '../../../data/feedback.json');
    if (!fs.existsSync(filePath)) return;

    try {
      const content = fs.readFileSync(filePath, 'utf8').trim();
      if (!content || content === '[]') return;

      const items = JSON.parse(content);
      if (!Array.isArray(items) || items.length === 0) return;

      winstonLogger.info(`[FEEDBACK_SYNC] Found ${items.length} items in feedback.json`);

      const remainingItems: any[] = [];

      for (const item of items) {
        try {
          // Check for duplicate in DB using PNR and timestamp
          const { data, error } = await supabase
            .from('feedback')
            .select('id')
            .eq('pnr', item.pnr || '')
            .eq('timestamp', item.timestamp || '');

          if (error) throw error;

          if (data && data.length > 0) {
            winstonLogger.debug(`[FEEDBACK_SYNC] Feedback item for PNR ${item.pnr} at ${item.timestamp} already exists in DB. Skipping.`);
            continue;
          }

          // Safe insert
          const { error: insertError } = await supabase.from('feedback').insert([{
            pnr: item.pnr,
            is_accurate: item.is_accurate,
            comments: item.comments,
            timestamp: item.timestamp,
            name: item.name || null,
            email: item.email || null,
            device: item.device || null,
            os: item.os || null,
            feature: item.feature || null,
            bug: item.bug || null,
            screenshot: item.screenshot || null,
            severity: item.severity || null,
            performance: item.performance || null,
            ui: item.ui || null,
            suggestions: item.suggestions || null,
            user_id: item.user_id || item.userId || null,
            search_id: item.search_id || item.searchId || null,
            route_context: item.route_context || item.routeContext || null
          }]);

          if (insertError) {
            winstonLogger.error(`[FEEDBACK_SYNC] Failed to insert feedback item for PNR ${item.pnr}: ${insertError.message}`);
            remainingItems.push(item);
          }
        } catch (itemErr: any) {
          winstonLogger.error(`[FEEDBACK_SYNC] Error checking/inserting feedback item: ${itemErr.message}`);
          remainingItems.push(item);
        }
      }

      // Rewrite file with remaining items (or clear it)
      if (remainingItems.length > 0) {
        fs.writeFileSync(filePath, JSON.stringify(remainingItems, null, 2), 'utf8');
        winstonLogger.info(`[FEEDBACK_SYNC] Re-wrote feedback.json with ${remainingItems.length} failed items.`);
      } else {
        fs.writeFileSync(filePath, '[]', 'utf8');
        winstonLogger.info('[FEEDBACK_SYNC] feedback.json cleared.');
      }
    } catch (err: any) {
      winstonLogger.error(`[FEEDBACK_SYNC] Error syncing feedback.json: ${err.message}`);
    }
  }

  private async syncPnrPredictionFeedbackFile() {
    const filePath = path.join(__dirname, '../../data/pnr_prediction_feedback_fallback.jsonl');
    if (!fs.existsSync(filePath)) return;

    try {
      const content = fs.readFileSync(filePath, 'utf8').trim();
      if (!content) return;

      const lines = content.split('\n').filter(Boolean);
      winstonLogger.info(`[FEEDBACK_SYNC] Found ${lines.length} lines in pnr_prediction_feedback_fallback.jsonl`);

      const remainingLines: string[] = [];

      for (const line of lines) {
        let item: any;
        try {
          item = JSON.parse(line);
        } catch (parseErr) {
          continue;
        }

        try {
          const timestampToCheck = item.created_at || item.timestamp;
          // Check for duplicate in DB
          const { data, error } = await supabase
            .from('pnr_prediction_feedback')
            .select('id')
            .eq('pnr', item.pnr || '')
            .eq('created_at', timestampToCheck);

          if (error) throw error;

          if (data && data.length > 0) {
            winstonLogger.debug(`[FEEDBACK_SYNC] PNR feedback item for PNR ${item.pnr} at ${timestampToCheck} already exists in DB. Skipping.`);
            continue;
          }

          // Safe insert
          const { error: insertError } = await supabase.from('pnr_prediction_feedback').insert([{
            pnr: item.pnr,
            prediction_percent: item.prediction_percent,
            confidence_label: item.confidence_label,
            current_status: item.current_status,
            user_feedback: item.user_feedback,
            comment: item.comment || null,
            created_at: timestampToCheck
          }]);

          if (insertError) {
            winstonLogger.error(`[FEEDBACK_SYNC] Failed to insert PNR feedback item for PNR ${item.pnr}: ${insertError.message}`);
            remainingLines.push(line);
          }
        } catch (itemErr: any) {
          winstonLogger.error(`[FEEDBACK_SYNC] Error checking/inserting PNR feedback item: ${itemErr.message}`);
          remainingLines.push(line);
        }
      }

      // Rewrite file with remaining items (or delete if all succeeded)
      if (remainingLines.length > 0) {
        fs.writeFileSync(filePath, remainingLines.join('\n') + '\n', 'utf8');
        winstonLogger.info(`[FEEDBACK_SYNC] Re-wrote pnr_prediction_feedback_fallback.jsonl with ${remainingLines.length} failed items.`);
      } else {
        try {
          fs.unlinkSync(filePath);
        } catch (e) {}
        winstonLogger.info('[FEEDBACK_SYNC] pnr_prediction_feedback_fallback.jsonl cleared.');
      }
    } catch (err: any) {
      winstonLogger.error(`[FEEDBACK_SYNC] Error syncing pnr_prediction_feedback_fallback.jsonl: ${err.message}`);
    }
  }

  private async syncSocialComplaintsFile() {
    const filePath = path.join(__dirname, '../../data/social_complaints_fallback.jsonl');
    if (!fs.existsSync(filePath)) return;

    try {
      const content = fs.readFileSync(filePath, 'utf8').trim();
      if (!content) return;

      const lines = content.split('\n').filter(Boolean);
      winstonLogger.info(`[FEEDBACK_SYNC] Found ${lines.length} lines in social_complaints_fallback.jsonl`);

      const remainingLines: string[] = [];

      for (const line of lines) {
        let item: any;
        try {
          item = JSON.parse(line);
        } catch (parseErr) {
          continue;
        }

        try {
          // Check for duplicate in DB
          const { data, error } = await supabase
            .from('social_complaints')
            .select('id')
            .eq('pnr', item.pnr || '')
            .eq('timestamp', item.timestamp || '');

          if (error) throw error;

          if (data && data.length > 0) {
            winstonLogger.debug(`[FEEDBACK_SYNC] Social complaint item for PNR ${item.pnr} at ${item.timestamp} already exists in DB. Skipping.`);
            continue;
          }

          // Safe insert
          const { error: insertError } = await supabase.from('social_complaints').insert([{
            pnr: item.pnr,
            train_no: item.train_no,
            issue_type: item.issue_type,
            tweet_content: item.tweet_content,
            timestamp: item.timestamp
          }]);

          if (insertError) {
            winstonLogger.error(`[FEEDBACK_SYNC] Failed to insert social complaint item for PNR ${item.pnr}: ${insertError.message}`);
            remainingLines.push(line);
          }
        } catch (itemErr: any) {
          winstonLogger.error(`[FEEDBACK_SYNC] Error checking/inserting social complaint item: ${itemErr.message}`);
          remainingLines.push(line);
        }
      }

      // Rewrite file with remaining items (or delete if all succeeded)
      if (remainingLines.length > 0) {
        fs.writeFileSync(filePath, remainingLines.join('\n') + '\n', 'utf8');
        winstonLogger.info(`[FEEDBACK_SYNC] Re-wrote social_complaints_fallback.jsonl with ${remainingLines.length} failed items.`);
      } else {
        try {
          fs.unlinkSync(filePath);
        } catch (e) {}
        winstonLogger.info('[FEEDBACK_SYNC] social_complaints_fallback.jsonl cleared.');
      }
    } catch (err: any) {
      winstonLogger.error(`[FEEDBACK_SYNC] Error syncing social_complaints_fallback.jsonl: ${err.message}`);
    }
  }
}

export const feedbackSyncService = new FeedbackSyncService();
