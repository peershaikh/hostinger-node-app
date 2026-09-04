import cron from 'node-cron';
import { winstonLogger } from '../middleware/logger';
import { railwayNewsService } from '../services/railwayNewsService';
import { newsAutoCuratorService } from '../services/news/newsAutoCuratorService';

/**
 * PHASE_4C750 — News Refresh Job (FIXED) & Phase 087 Autonomous Curator
 *
 * Runs every 6 hours (0:00, 6:00, 12:00, 18:00 UTC).
 * Fetches fresh articles from all RSS providers, deduplicates,
 * distills with AI, and triggers the autonomous SEO-safe auto-curator.
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

    // Daily at 02:30 UTC (08:00 AM IST) — archive stale drafts older than 7 days
    cron.schedule('30 2 * * *', async () => {
      try {
        winstonLogger.info('[NEWS_CLEANUP_CRON] Running daily maintenance archive on stale drafts...');
        await newsAutoCuratorService.archiveStaleDrafts(7);
      } catch (cleanErr: any) {
        winstonLogger.warn(`[NEWS_CLEANUP_CRON_WARN] ${cleanErr.message}`);
      }
    });
  }

  public async trigger(reason: string = 'manual_trigger') {
    return this.refresh(reason);
  }

  private async refresh(reason: string) {
    try {
      winstonLogger.info(`[NEWS_REFRESH] Triggering refresh (${reason})...`);
      const articles = await railwayNewsService.refreshNews();
      winstonLogger.info(`[NEWS_REFRESH] Complete (${reason}): ${articles.length} articles cached`);

      // Run autonomous curation to safely promote top unique passenger news to PUBLISHED
      try {
        await newsAutoCuratorService.curateAndPublishDailyBatch();
      } catch (curatorErr: any) {
        winstonLogger.warn(`[NEWS_AUTOCURATOR_CRON_WARN] ${curatorErr.message}`);
      }

      return articles;
    } catch (err: any) {
      winstonLogger.error(`[NEWS_REFRESH] Failed (${reason}): ${err.message}`);
      return [];
    }
  }
}

export const newsRefreshJob = new NewsRefreshJob();
