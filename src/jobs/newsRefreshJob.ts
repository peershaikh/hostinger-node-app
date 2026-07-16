import cron from 'node-cron';
import { winstonLogger } from '../middleware/logger';
import { railwayNewsService } from '../services/railwayNewsService';

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
export class NewsRefreshJob {
  async start() {
    winstonLogger.info('[NEWS_REFRESH] Scheduler starting — runs every 6 hours.');

    // Warm the cache immediately on boot (BLOCKING with proper error handling)
    try {
      await this.refresh('boot warm-up');
      winstonLogger.info('[NEWS_REFRESH] ✅ Boot warm-up completed');
    } catch (err: any) {
      winstonLogger.warn(`[NEWS_REFRESH] ⚠️ Boot warm-up failed: ${err.message}`);
      // Non-fatal: server continues even if first refresh fails
    }

    // Schedule: every 6 hours at minute 0
    cron.schedule('0 */6 * * *', async () => {
      await this.refresh('scheduled 6h cron');
    });
  }

  private async refresh(reason: string) {
    try {
      winstonLogger.info(`[NEWS_REFRESH] Triggering refresh (${reason})...`);
      const articles = await railwayNewsService.refreshNews();
      winstonLogger.info(`[NEWS_REFRESH] Complete (${reason}): ${articles.length} articles cached`);
    } catch (err: any) {
      winstonLogger.error(`[NEWS_REFRESH] Failed (${reason}): ${err.message}`);
    }
  }
}

export const newsRefreshJob = new NewsRefreshJob();
