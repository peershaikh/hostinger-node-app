"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.feedbackSyncService = exports.FeedbackSyncService = void 0;
const supabase_1 = require("../config/supabase");
const fs_1 = __importDefault(require("fs"));
const path_1 = __importDefault(require("path"));
const logger_1 = require("../middleware/logger");
class FeedbackSyncService {
    constructor() {
        this.isSyncing = false;
    }
    async syncAllFallbacks() {
        if (this.isSyncing) {
            logger_1.winstonLogger.info('[FEEDBACK_SYNC] Sync is already in progress. Skipping.');
            return;
        }
        if (!(0, supabase_1.isSupabaseConfigured)()) {
            logger_1.winstonLogger.info('[FEEDBACK_SYNC] Supabase is not configured. Skipping sync.');
            return;
        }
        this.isSyncing = true;
        logger_1.winstonLogger.info('[FEEDBACK_SYNC] Starting offline feedback synchronization...');
        try {
            await this.syncFeedbackFile();
            await this.syncPnrPredictionFeedbackFile();
            await this.syncSocialComplaintsFile();
            logger_1.winstonLogger.info('[FEEDBACK_SYNC] Offline feedback synchronization completed successfully.');
        }
        catch (err) {
            logger_1.winstonLogger.error(`[FEEDBACK_SYNC] Sync process encountered errors: ${err.message}`);
        }
        finally {
            this.isSyncing = false;
        }
    }
    async syncFeedbackFile() {
        const filePath = path_1.default.join(__dirname, '../../../data/feedback.json');
        if (!fs_1.default.existsSync(filePath))
            return;
        try {
            const content = fs_1.default.readFileSync(filePath, 'utf8').trim();
            if (!content || content === '[]')
                return;
            const items = JSON.parse(content);
            if (!Array.isArray(items) || items.length === 0)
                return;
            logger_1.winstonLogger.info(`[FEEDBACK_SYNC] Found ${items.length} items in feedback.json`);
            const remainingItems = [];
            for (const item of items) {
                try {
                    // Check for duplicate in DB using PNR and timestamp
                    const { data, error } = await supabase_1.supabase
                        .from('feedback')
                        .select('id')
                        .eq('pnr', item.pnr || '')
                        .eq('timestamp', item.timestamp || '');
                    if (error)
                        throw error;
                    if (data && data.length > 0) {
                        logger_1.winstonLogger.debug(`[FEEDBACK_SYNC] Feedback item for PNR ${item.pnr} at ${item.timestamp} already exists in DB. Skipping.`);
                        continue;
                    }
                    // Safe insert
                    const { error: insertError } = await supabase_1.supabase.from('feedback').insert([{
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
                        logger_1.winstonLogger.error(`[FEEDBACK_SYNC] Failed to insert feedback item for PNR ${item.pnr}: ${insertError.message}`);
                        remainingItems.push(item);
                    }
                }
                catch (itemErr) {
                    logger_1.winstonLogger.error(`[FEEDBACK_SYNC] Error checking/inserting feedback item: ${itemErr.message}`);
                    remainingItems.push(item);
                }
            }
            // Rewrite file with remaining items (or clear it)
            if (remainingItems.length > 0) {
                fs_1.default.writeFileSync(filePath, JSON.stringify(remainingItems, null, 2), 'utf8');
                logger_1.winstonLogger.info(`[FEEDBACK_SYNC] Re-wrote feedback.json with ${remainingItems.length} failed items.`);
            }
            else {
                fs_1.default.writeFileSync(filePath, '[]', 'utf8');
                logger_1.winstonLogger.info('[FEEDBACK_SYNC] feedback.json cleared.');
            }
        }
        catch (err) {
            logger_1.winstonLogger.error(`[FEEDBACK_SYNC] Error syncing feedback.json: ${err.message}`);
        }
    }
    async syncPnrPredictionFeedbackFile() {
        const filePath = path_1.default.join(__dirname, '../../data/pnr_prediction_feedback_fallback.jsonl');
        if (!fs_1.default.existsSync(filePath))
            return;
        try {
            const content = fs_1.default.readFileSync(filePath, 'utf8').trim();
            if (!content)
                return;
            const lines = content.split('\n').filter(Boolean);
            logger_1.winstonLogger.info(`[FEEDBACK_SYNC] Found ${lines.length} lines in pnr_prediction_feedback_fallback.jsonl`);
            const remainingLines = [];
            for (const line of lines) {
                let item;
                try {
                    item = JSON.parse(line);
                }
                catch (parseErr) {
                    continue;
                }
                try {
                    const timestampToCheck = item.created_at || item.timestamp;
                    // Check for duplicate in DB
                    const { data, error } = await supabase_1.supabase
                        .from('pnr_prediction_feedback')
                        .select('id')
                        .eq('pnr', item.pnr || '')
                        .eq('created_at', timestampToCheck);
                    if (error)
                        throw error;
                    if (data && data.length > 0) {
                        logger_1.winstonLogger.debug(`[FEEDBACK_SYNC] PNR feedback item for PNR ${item.pnr} at ${timestampToCheck} already exists in DB. Skipping.`);
                        continue;
                    }
                    // Safe insert
                    const { error: insertError } = await supabase_1.supabase.from('pnr_prediction_feedback').insert([{
                            pnr: item.pnr,
                            prediction_percent: item.prediction_percent,
                            confidence_label: item.confidence_label,
                            current_status: item.current_status,
                            user_feedback: item.user_feedback,
                            comment: item.comment || null,
                            created_at: timestampToCheck
                        }]);
                    if (insertError) {
                        logger_1.winstonLogger.error(`[FEEDBACK_SYNC] Failed to insert PNR feedback item for PNR ${item.pnr}: ${insertError.message}`);
                        remainingLines.push(line);
                    }
                }
                catch (itemErr) {
                    logger_1.winstonLogger.error(`[FEEDBACK_SYNC] Error checking/inserting PNR feedback item: ${itemErr.message}`);
                    remainingLines.push(line);
                }
            }
            // Rewrite file with remaining items (or delete if all succeeded)
            if (remainingLines.length > 0) {
                fs_1.default.writeFileSync(filePath, remainingLines.join('\n') + '\n', 'utf8');
                logger_1.winstonLogger.info(`[FEEDBACK_SYNC] Re-wrote pnr_prediction_feedback_fallback.jsonl with ${remainingLines.length} failed items.`);
            }
            else {
                try {
                    fs_1.default.unlinkSync(filePath);
                }
                catch (e) { }
                logger_1.winstonLogger.info('[FEEDBACK_SYNC] pnr_prediction_feedback_fallback.jsonl cleared.');
            }
        }
        catch (err) {
            logger_1.winstonLogger.error(`[FEEDBACK_SYNC] Error syncing pnr_prediction_feedback_fallback.jsonl: ${err.message}`);
        }
    }
    async syncSocialComplaintsFile() {
        const filePath = path_1.default.join(__dirname, '../../data/social_complaints_fallback.jsonl');
        if (!fs_1.default.existsSync(filePath))
            return;
        try {
            const content = fs_1.default.readFileSync(filePath, 'utf8').trim();
            if (!content)
                return;
            const lines = content.split('\n').filter(Boolean);
            logger_1.winstonLogger.info(`[FEEDBACK_SYNC] Found ${lines.length} lines in social_complaints_fallback.jsonl`);
            const remainingLines = [];
            for (const line of lines) {
                let item;
                try {
                    item = JSON.parse(line);
                }
                catch (parseErr) {
                    continue;
                }
                try {
                    // Check for duplicate in DB
                    const { data, error } = await supabase_1.supabase
                        .from('social_complaints')
                        .select('id')
                        .eq('pnr', item.pnr || '')
                        .eq('timestamp', item.timestamp || '');
                    if (error)
                        throw error;
                    if (data && data.length > 0) {
                        logger_1.winstonLogger.debug(`[FEEDBACK_SYNC] Social complaint item for PNR ${item.pnr} at ${item.timestamp} already exists in DB. Skipping.`);
                        continue;
                    }
                    // Safe insert
                    const { error: insertError } = await supabase_1.supabase.from('social_complaints').insert([{
                            pnr: item.pnr,
                            train_no: item.train_no,
                            issue_type: item.issue_type,
                            tweet_content: item.tweet_content,
                            timestamp: item.timestamp
                        }]);
                    if (insertError) {
                        logger_1.winstonLogger.error(`[FEEDBACK_SYNC] Failed to insert social complaint item for PNR ${item.pnr}: ${insertError.message}`);
                        remainingLines.push(line);
                    }
                }
                catch (itemErr) {
                    logger_1.winstonLogger.error(`[FEEDBACK_SYNC] Error checking/inserting social complaint item: ${itemErr.message}`);
                    remainingLines.push(line);
                }
            }
            // Rewrite file with remaining items (or delete if all succeeded)
            if (remainingLines.length > 0) {
                fs_1.default.writeFileSync(filePath, remainingLines.join('\n') + '\n', 'utf8');
                logger_1.winstonLogger.info(`[FEEDBACK_SYNC] Re-wrote social_complaints_fallback.jsonl with ${remainingLines.length} failed items.`);
            }
            else {
                try {
                    fs_1.default.unlinkSync(filePath);
                }
                catch (e) { }
                logger_1.winstonLogger.info('[FEEDBACK_SYNC] social_complaints_fallback.jsonl cleared.');
            }
        }
        catch (err) {
            logger_1.winstonLogger.error(`[FEEDBACK_SYNC] Error syncing social_complaints_fallback.jsonl: ${err.message}`);
        }
    }
}
exports.FeedbackSyncService = FeedbackSyncService;
exports.feedbackSyncService = new FeedbackSyncService();
