import fs from 'fs';
import path from 'path';
import { isSupabaseConfigured, safeWriteFileSync, supabase } from '../config/supabase';
import { UniversalEventNames } from '../constants/eventTaxonomy';
import { validateAiHubEnrichment } from '../knowledge/canonicalHub';
import { winstonLogger } from '../middleware/logger';
import { universalEventEmitter } from './universalEventEmitter';
import { aiProviderResolver } from './ai/aiProviderResolver';
import { aiConfig } from './ai/aiConfig';

const DATA_DIR = path.join(__dirname, '../../data');
const MISSING_QUERIES_FILE = path.join(DATA_DIR, 'missing_queries.json');

export class GptRouteEnrichmentService {
  public async enrichMissingQuery(queryId: string, source: string, destination: string): Promise<void> {
    universalEventEmitter.emit({
      eventName: UniversalEventNames.ROUTE_ENRICHMENT_REQUESTED,
      searchId: queryId,
      mode: 'rail',
      route: `${source}-${destination}`,
      metadata: { source, destination, query_id: queryId }
    });

    const provider = aiProviderResolver.resolveProvider('enrichRoute');
    if (!provider || typeof provider.enrichRoute !== 'function') {
      winstonLogger.warn('[GPT_ENRICHMENT] Skipped — No capable AI provider available.');
      return;
    }

    winstonLogger.info(`[GPT_ENRICHMENT] Starting enrichment via ${provider.providerId} for query ${queryId}: ${source} -> ${destination}`);

    try {
      const rawSuggestion = await provider.enrichRoute({ queryId, source, destination });

      // AI Authority Barrier Validation
      const validation = validateAiHubEnrichment(rawSuggestion);
      if (!validation.valid) {
        winstonLogger.warn(`[GPT_ENRICHMENT_REJECTED] Invalid AI suggestion for ${queryId}: ${validation.reason}`);
        universalEventEmitter.emit({
          eventName: UniversalEventNames.KNOWLEDGE_REJECTED,
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
        model_version: aiConfig.gemini.model,
        enriched_at: new Date().toISOString()
      };

      winstonLogger.info(`[GPT_ENRICHMENT] Validated suggestion received for ${queryId}: hub=${suggestion.candidateHub}`);

      universalEventEmitter.emit({
        eventName: UniversalEventNames.ROUTE_ENRICHMENT_COMPLETED,
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
      if (fs.existsSync(MISSING_QUERIES_FILE)) {
        try {
          const queries = JSON.parse(fs.readFileSync(MISSING_QUERIES_FILE, 'utf8'));
          const idx = queries.findIndex((q: any) => q.id === queryId);
          if (idx !== -1) {
            queries[idx].gpt_suggestion = suggestion;
            safeWriteFileSync(MISSING_QUERIES_FILE, JSON.stringify(queries, null, 2), 'utf8');
            winstonLogger.debug(`[GPT_ENRICHMENT] Local fallback query updated with GPT suggestion`);
          }
        } catch (err: any) {
          winstonLogger.error(`[GPT_ENRICHMENT] Local fallback file update failed: ${err.message}`);
        }
      }

      // Update Supabase
      if (isSupabaseConfigured()) {
        const { error } = await supabase
          .from('missing_queries')
          .update({ gpt_suggestion: suggestion })
          .eq('id', queryId);

        if (error) {
          winstonLogger.error(`[GPT_ENRICHMENT] Supabase update failed: ${error.message}`);
        } else {
          winstonLogger.info(`[GPT_ENRICHMENT] Supabase missing_queries row updated successfully`);
        }
      }
    } catch (err: any) {
      winstonLogger.error(`[GPT_ENRICHMENT] Failed to enrich query ${queryId}: ${err.message}`);
    }
  }
}

export const gptRouteEnrichmentService = new GptRouteEnrichmentService();
