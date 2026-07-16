"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.hubCatalogRefreshJob = exports.HubCatalogRefreshJob = void 0;
/**
 * PHASE_4C871 — Nightly hub catalog materialization job.
 * Runs only when KNOWLEDGE_HUBS_SHADOW or KNOWLEDGE_STATS is enabled (catalog build for shadow).
 * Default: scheduler registered but no-op on each tick when flags OFF.
 */
const node_cron_1 = __importDefault(require("node-cron"));
const featureFlags_1 = require("../config/featureFlags");
const logger_1 = require("../middleware/logger");
const knowledgeService_1 = require("../services/knowledgeService");
class HubCatalogRefreshJob {
    constructor() {
        this.started = false;
    }
    async start() {
        if (this.started)
            return;
        this.started = true;
        logger_1.winstonLogger.info('[KNOWLEDGE_CATALOG_JOB] Scheduler registered — nightly 02:00 UTC (no-op when flags OFF)');
        // Nightly at 02:00 UTC
        node_cron_1.default.schedule('0 2 * * *', async () => {
            await this.runScheduled('nightly cron');
        });
    }
    shouldRun() {
        return featureFlags_1.featureFlags.knowledgeHubsShadow || featureFlags_1.featureFlags.knowledgeStats || featureFlags_1.featureFlags.knowledgeHubs;
    }
    async runScheduled(reason) {
        if (!this.shouldRun()) {
            logger_1.winstonLogger.debug(`[KNOWLEDGE_CATALOG_JOB] Skipped (${reason}) — flags OFF`);
            return;
        }
        try {
            logger_1.winstonLogger.info(`[KNOWLEDGE_CATALOG_JOB] Starting (${reason})...`);
            const result = await knowledgeService_1.knowledgeService.refreshHubCatalog(200);
            logger_1.winstonLogger.info(`[KNOWLEDGE_CATALOG_JOB] Complete (${reason}): routes=${result.routes} rows=${result.rows}`);
        }
        catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            logger_1.winstonLogger.warn(`[KNOWLEDGE_CATALOG_JOB] Failed (${reason}): ${msg}`);
        }
    }
}
exports.HubCatalogRefreshJob = HubCatalogRefreshJob;
exports.hubCatalogRefreshJob = new HubCatalogRefreshJob();
