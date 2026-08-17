"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.gptRouteEnrichmentService = exports.GptRouteEnrichmentService = void 0;
const fs_1 = __importDefault(require("fs"));
const path_1 = __importDefault(require("path"));
const supabase_1 = require("../config/supabase");
const eventTaxonomy_1 = require("../constants/eventTaxonomy");
const canonicalHub_1 = require("../knowledge/canonicalHub");
const logger_1 = require("../middleware/logger");
const universalEventEmitter_1 = require("./universalEventEmitter");
const aiProviderResolver_1 = require("./ai/aiProviderResolver");
const aiConfig_1 = require("./ai/aiConfig");
const DATA_DIR = path_1.default.join(__dirname, '../../data');
const MISSING_QUERIES_FILE = path_1.default.join(DATA_DIR, 'missing_queries.json');
class GptRouteEnrichmentService {
    async enrichMissingQuery(queryId, source, destination) {
        universalEventEmitter_1.universalEventEmitter.emit({
            eventName: eventTaxonomy_1.UniversalEventNames.ROUTE_ENRICHMENT_REQUESTED,
            searchId: queryId,
            mode: 'rail',
            route: `${source}-${destination}`,
            metadata: { source, destination, query_id: queryId }
        });
        const provider = aiProviderResolver_1.aiProviderResolver.resolveProvider('enrichRoute');
        if (!provider || typeof provider.enrichRoute !== 'function') {
            logger_1.winstonLogger.warn('[GPT_ENRICHMENT] Skipped — No capable AI provider available.');
            return;
        }
        logger_1.winstonLogger.info(`[GPT_ENRICHMENT] Starting enrichment via ${provider.providerId} for query ${queryId}: ${source} -> ${destination}`);
        try {
            const rawSuggestion = await provider.enrichRoute({ queryId, source, destination });
            // AI Authority Barrier Validation
            const validation = (0, canonicalHub_1.validateAiHubEnrichment)(rawSuggestion);
            if (!validation.valid) {
                logger_1.winstonLogger.warn(`[GPT_ENRICHMENT_REJECTED] Invalid AI suggestion for ${queryId}: ${validation.reason}`);
                universalEventEmitter_1.universalEventEmitter.emit({
                    eventName: eventTaxonomy_1.UniversalEventNames.KNOWLEDGE_REJECTED,
                    searchId: queryId,
                    mode: 'rail',
                    metadata: { query_id: queryId, reason: validation.reason, raw_hub: rawSuggestion?.candidateHub }
                });
                return;
            }
            const suggestion = {
                ...rawSuggestion,
                candidateHub: validation.canonicalHubCode,
                ai_enriched: true,
                model_version: aiConfig_1.aiConfig.gemini.model,
                enriched_at: new Date().toISOString()
            };
            logger_1.winstonLogger.info(`[GPT_ENRICHMENT] Validated suggestion received for ${queryId}: hub=${suggestion.candidateHub}`);
            universalEventEmitter_1.universalEventEmitter.emit({
                eventName: eventTaxonomy_1.UniversalEventNames.ROUTE_ENRICHMENT_COMPLETED,
                searchId: queryId,
                mode: 'rail',
                route: `${source}-${destination}`,
                metadata: {
                    query_id: queryId,
                    hub: suggestion.candidateHub,
                    confidence: suggestion.confidence,
                    ai_enriched: true
                }
            });
            // Update Local File Fallback
            if (fs_1.default.existsSync(MISSING_QUERIES_FILE)) {
                try {
                    const queries = JSON.parse(fs_1.default.readFileSync(MISSING_QUERIES_FILE, 'utf8'));
                    const idx = queries.findIndex((q) => q.id === queryId);
                    if (idx !== -1) {
                        queries[idx].gpt_suggestion = suggestion;
                        (0, supabase_1.safeWriteFileSync)(MISSING_QUERIES_FILE, JSON.stringify(queries, null, 2), 'utf8');
                        logger_1.winstonLogger.debug(`[GPT_ENRICHMENT] Local fallback query updated with GPT suggestion`);
                    }
                }
                catch (err) {
                    logger_1.winstonLogger.error(`[GPT_ENRICHMENT] Local fallback file update failed: ${err.message}`);
                }
            }
            // Update Supabase
            if ((0, supabase_1.isSupabaseConfigured)()) {
                const { error } = await supabase_1.supabase
                    .from('missing_queries')
                    .update({ gpt_suggestion: suggestion })
                    .eq('id', queryId);
                if (error) {
                    logger_1.winstonLogger.error(`[GPT_ENRICHMENT] Supabase update failed: ${error.message}`);
                }
                else {
                    logger_1.winstonLogger.info(`[GPT_ENRICHMENT] Supabase missing_queries row updated successfully`);
                }
            }
        }
        catch (err) {
            logger_1.winstonLogger.error(`[GPT_ENRICHMENT] Failed to enrich query ${queryId}: ${err.message}`);
        }
    }
}
exports.GptRouteEnrichmentService = GptRouteEnrichmentService;
exports.gptRouteEnrichmentService = new GptRouteEnrichmentService();
