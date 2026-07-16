/**
 * PHASE_4C871 — Nightly hub catalog materialization job.
 * Runs only when KNOWLEDGE_HUBS_SHADOW or KNOWLEDGE_STATS is enabled (catalog build for shadow).
 * Default: scheduler registered but no-op on each tick when flags OFF.
 */
import cron from 'node-cron';
import { featureFlags } from '../config/featureFlags';
import { winstonLogger } from '../middleware/logger';
import { knowledgeService } from '../services/knowledgeService';

export class HubCatalogRefreshJob {
  private started = false;

  async start(): Promise<void> {
    if (this.started) return;
    this.started = true;

    winstonLogger.info(
      '[KNOWLEDGE_CATALOG_JOB] Scheduler registered — nightly 02:00 UTC (no-op when flags OFF)'
    );

    // Nightly at 02:00 UTC
    cron.schedule('0 2 * * *', async () => {
      await this.runScheduled('nightly cron');
    });
  }

  private shouldRun(): boolean {
    return featureFlags.knowledgeHubsShadow || featureFlags.knowledgeStats || featureFlags.knowledgeHubs;
  }

  async runScheduled(reason: string): Promise<void> {
    if (!this.shouldRun()) {
      winstonLogger.debug(`[KNOWLEDGE_CATALOG_JOB] Skipped (${reason}) — flags OFF`);
      return;
    }

    try {
      winstonLogger.info(`[KNOWLEDGE_CATALOG_JOB] Starting (${reason})...`);
      const result = await knowledgeService.refreshHubCatalog(200);
      winstonLogger.info(
        `[KNOWLEDGE_CATALOG_JOB] Complete (${reason}): routes=${result.routes} rows=${result.rows}`
      );
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      winstonLogger.warn(`[KNOWLEDGE_CATALOG_JOB] Failed (${reason}): ${msg}`);
    }
  }
}

export const hubCatalogRefreshJob = new HubCatalogRefreshJob();