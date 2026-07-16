"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.feedbackController = void 0;
const crypto_1 = __importDefault(require("crypto"));
const fs_1 = __importDefault(require("fs"));
const path_1 = __importDefault(require("path"));
const supabase_1 = require("../config/supabase");
const logger_1 = require("../middleware/logger");
const llmService_1 = require("../services/llmService");
const FEEDBACK_FILE = path_1.default.join(__dirname, '../../../data/feedback.json');
const FEEDBACK_CATEGORIES_FILE = path_1.default.join(__dirname, '../../../data/feedback_categories.json');
// ─── Async background categorization (non-blocking) ─────────────────────────
async function categorizeFeedbackAsync(feedbackId, feedbackText, metadata) {
    try {
        const result = await llmService_1.llmService.categorizeFeedback(feedbackText, metadata);
        if (!result)
            return; // GPT unavailable or opted out — silently skip
        const category = {
            id: crypto_1.default.randomUUID(),
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
            let existing = [];
            if (fs_1.default.existsSync(FEEDBACK_CATEGORIES_FILE)) {
                existing = JSON.parse(fs_1.default.readFileSync(FEEDBACK_CATEGORIES_FILE, 'utf-8'));
            }
            existing.push(category);
            if (!fs_1.default.existsSync(path_1.default.dirname(FEEDBACK_CATEGORIES_FILE))) {
                fs_1.default.mkdirSync(path_1.default.dirname(FEEDBACK_CATEGORIES_FILE), { recursive: true });
            }
            fs_1.default.writeFileSync(FEEDBACK_CATEGORIES_FILE, JSON.stringify(existing, null, 2));
        }
        catch (fileErr) {
            logger_1.winstonLogger.warn(`[FEEDBACK_CATEGORY] Local write failed: ${fileErr.message}`);
        }
        // Supabase dual-write
        if ((0, supabase_1.isSupabaseConfigured)()) {
            try {
                await supabase_1.supabase.from('feedback_categories').insert({
                    id: category.id,
                    feedback_id: category.feedbackId,
                    category: category.category,
                    confidence: category.confidence,
                    priority: category.priority,
                    summary: category.summary,
                    suggested_action: category.suggestedAction,
                    created_at: category.createdAt
                });
            }
            catch (dbErr) {
                logger_1.winstonLogger.warn(`[FEEDBACK_CATEGORY] Supabase write failed: ${dbErr.message}`);
            }
        }
        logger_1.winstonLogger.info(`[FEEDBACK_CATEGORY] Classified feedback ${feedbackId} → ${result.category} (${result.priority})`);
    }
    catch (err) {
        logger_1.winstonLogger.warn(`[FEEDBACK_CATEGORY] Background categorization failed: ${err.message}`);
    }
}
exports.feedbackController = {
    submit: async (req, res) => {
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
            const pnrVal = routeContext?.pnr || routeContext?.pnr_number || null;
            let dbSuccess = false;
            // Primary: Write to Supabase with full schema
            if ((0, supabase_1.isSupabaseConfigured)()) {
                try {
                    await supabase_1.supabase.from('feedback').insert([{
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
                }
                catch (dbErr) {
                    logger_1.winstonLogger.warn(`[FEEDBACK] Supabase primary write failed: ${dbErr.message}, falling back to JSON.`);
                }
            }
            // Secondary: Local JSON Fallback (Always write to keep local log, but especially crucial if DB fails)
            let allFeedback = [];
            if (fs_1.default.existsSync(FEEDBACK_FILE)) {
                try {
                    allFeedback = JSON.parse(fs_1.default.readFileSync(FEEDBACK_FILE, 'utf-8'));
                }
                catch (e) {
                    allFeedback = [];
                }
            }
            allFeedback.push(feedback);
            if (!fs_1.default.existsSync(path_1.default.dirname(FEEDBACK_FILE))) {
                fs_1.default.mkdirSync(path_1.default.dirname(FEEDBACK_FILE), { recursive: true });
            }
            fs_1.default.writeFileSync(FEEDBACK_FILE, JSON.stringify(allFeedback, null, 2));
            // ─── Non-blocking GPT categorization ───────────────────────────────────
            // Build the text to classify from the richest available field
            const feedbackText = [bug, suggestions, feature].filter(Boolean).join(' | ') || 'No description provided';
            setImmediate(() => {
                categorizeFeedbackAsync(feedback.id, feedbackText, { feature, severity, device });
            });
            // ───────────────────────────────────────────────────────────────────────
            return res.json({ success: true });
        }
        catch (err) {
            logger_1.winstonLogger.error(`[FEEDBACK] submit failed: ${err.message}`);
            return res.status(500).json({ success: false, error: 'Failed to submit feedback' });
        }
    }
};
