"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.analyticsService = exports.AnalyticsService = void 0;
const supabase_1 = require("../config/supabase");
const logger_1 = require("../middleware/logger");
class AnalyticsService {
    constructor() {
        this.SEARCH_RPC = 'increment_search_popularity';
        this.HUB_RPC = 'increment_hub_analytics';
        this.EVENTS_TABLE = 'analytics_events';
    }
    /**
     * Logs a search query to identify popular routes
     * Uses atomic RPC increment (no race conditions)
     */
    async logSearch(source, destination) {
        if (global.SYSTEM_MODE === 'MODE_A')
            return false;
        try {
            const s = source.toUpperCase();
            const d = destination.toUpperCase();
            const { error } = await supabase_1.supabase.rpc(this.SEARCH_RPC, {
                p_source: s,
                p_destination: d
            });
            if (error) {
                if (error.code === '42P01' || error.code === '42883') {
                    logger_1.winstonLogger.warn(`[ANALYTICS] RPC ${this.SEARCH_RPC} or table missing. Skipping.`);
                    return false;
                }
                throw error;
            }
            logger_1.winstonLogger.debug(`[ANALYTICS] Search logged: ${s} → ${d}`);
            return true;
        }
        catch (err) {
            logger_1.winstonLogger.error(`[ANALYTICS] logSearch failed (${source}→${destination}): ${err.message}`);
            return false;
        }
    }
    /**
     * Logs successful split-journey hub usage for intelligence layer feedback
     */
    async logHubSuccess(hubName) {
        if (global.SYSTEM_MODE === 'MODE_A')
            return false;
        try {
            const hub = hubName.toUpperCase();
            const { error } = await supabase_1.supabase.rpc(this.HUB_RPC, {
                p_hub: hub
            });
            if (error) {
                if (error.code === '42P01' || error.code === '42883') {
                    logger_1.winstonLogger.warn(`[ANALYTICS] RPC ${this.HUB_RPC} or table missing. Skipping.`);
                    return false;
                }
                throw error;
            }
            logger_1.winstonLogger.debug(`[ANALYTICS] Hub success logged: ${hub}`);
            return true;
        }
        catch (err) {
            logger_1.winstonLogger.error(`[ANALYTICS] logHubSuccess failed (${hubName}): ${err.message}`);
            return false;
        }
    }
    /**
     * Internal telemetry for system health
     * (Failovers, Quota hits, Rewards, Engine events, etc.)
     */
    async trackEvent(eventType, pnr, metadata = {}) {
        if (global.SYSTEM_MODE === 'MODE_A')
            return false;
        try {
            const sessionId = (metadata?.session_id || metadata?.sessionId || metadata?.userId || metadata?.user_id || null);
            const dbPayload = {
                event_type: eventType,
                session_id: sessionId,
                metadata: metadata || {},
                payload: {
                    pnr: pnr || null,
                    client_timestamp: new Date().toISOString()
                }
            };
            // Non-blocking fire-and-forget DB write
            Promise.resolve(supabase_1.supabase
                .from(this.EVENTS_TABLE)
                .insert([dbPayload]))
                .then(({ error }) => {
                if (error) {
                    if (error.code === '42P01') {
                        logger_1.winstonLogger.warn(`[ANALYTICS] Table ${this.EVENTS_TABLE} not found yet. Skipping telemetry.`);
                    }
                    else {
                        logger_1.winstonLogger.warn(`[TELEMETRY_FAIL] ${eventType} DB write failed: ${error.message}`);
                    }
                }
                else {
                    logger_1.winstonLogger.debug(`[TELEMETRY] Event tracked successfully: ${eventType}`);
                }
            })
                .catch((err) => {
                logger_1.winstonLogger.warn(`[TELEMETRY_EXCEPTION] ${eventType} background write failed: ${err.message}`);
            });
            return true;
        }
        catch (err) {
            logger_1.winstonLogger.warn(`[TELEMETRY_FAIL] ${eventType}: ${err.message}`);
            return false;
        }
    }
}
exports.AnalyticsService = AnalyticsService;
exports.analyticsService = new AnalyticsService();
