"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.newsRefreshJob = exports.NewsRefreshJob = void 0;
const node_cron_1 = __importDefault(require("node-cron"));
const logger_1 = require("../middleware/logger");
const railwayNewsService_1 = require("../services/railwayNewsService");
/**
 * PHASE_4C750 — News Refresh Job (FIXED)
 *
 * Runs every 6 hours (0:00, 6:00, 12:00, 18:00 UTC).
 * Fetches fresh articles from all RSS providers, deduplicates,
 * and writes to the 30-minute in-process cache.
 *
 * Also performs an immediate warm-up fetch on server boot
 * so the first user request is never a cold cache miss.
 */
class NewsRefreshJob {
    async start() {
        logger_1.winstonLogger.info('[NEWS_REFRESH] Scheduler starting — runs every 6 hours.');
        // Warm the cache immediately on boot (BLOCKING with proper error handling)
        try {
            await this.refresh('boot warm-up');
            logger_1.winstonLogger.info('[NEWS_REFRESH] ✅ Boot warm-up completed');
        }
        catch (err) {
            logger_1.winstonLogger.warn(`[NEWS_REFRESH] ⚠️ Boot warm-up failed: ${err.message}`);
            // Non-fatal: server continues even if first refresh fails
        }
        // Schedule: every 6 hours at minute 0
        node_cron_1.default.schedule('0 */6 * * *', async () => {
            await this.refresh('scheduled 6h cron');
        });
    }
    async refresh(reason) {
        try {
            logger_1.winstonLogger.info(`[NEWS_REFRESH] Triggering refresh (${reason})...`);
            const articles = await railwayNewsService_1.railwayNewsService.refreshNews();
            logger_1.winstonLogger.info(`[NEWS_REFRESH] Complete (${reason}): ${articles.length} articles cached`);
        }
        catch (err) {
            logger_1.winstonLogger.error(`[NEWS_REFRESH] Failed (${reason}): ${err.message}`);
        }
    }
}
exports.NewsRefreshJob = NewsRefreshJob;
exports.newsRefreshJob = new NewsRefreshJob();
