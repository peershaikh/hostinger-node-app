"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.gptRouteEnrichmentService = exports.GptRouteEnrichmentService = void 0;
const axios_1 = __importDefault(require("axios"));
const fs_1 = __importDefault(require("fs"));
const path_1 = __importDefault(require("path"));
const supabase_1 = require("../config/supabase");
const logger_1 = require("../middleware/logger");
const DATA_DIR = path_1.default.join(__dirname, '../../data');
const MISSING_QUERIES_FILE = path_1.default.join(DATA_DIR, 'missing_queries.json');
class GptRouteEnrichmentService {
    constructor() {
        this.GEMINI_KEY = process.env.GEMINI_API_KEY || process.env.OPENAI_API_KEY || '';
    }
    async enrichMissingQuery(queryId, source, destination) {
        if (!this.GEMINI_KEY) {
            logger_1.winstonLogger.warn('[GEMINI_ENRICHMENT] Skipped — GEMINI_API_KEY not configured.');
            return;
        }
        logger_1.winstonLogger.info(`[GPT_ENRICHMENT] Starting enrichment for query ${queryId}: ${source} -> ${destination}`);
        const prompt = `
      You are an expert Indian Railways transit analyst.
      Analyze this missing route search from "${source}" to "${destination}".
      The direct search returned zero results.
      
      Suggest:
      1. A candidate hub/junction station code for a split journey (e.g., "ET", "BPL", "NGP", "BZA", "KYN", "BSB").
      2. A logical train routing (list of train numbers for Leg 1 and Leg 2).
      3. A candidate station alias or correction if one of the codes might be misspelled or represent a secondary station (e.g., "NDLS" for Delhi).
      4. An alternate train code or alias.
      
      Format the output as a JSON object with these exact keys:
      {
        "candidateRoute": "FROM -> HUB -> TO",
        "candidateHub": "HUB_CODE",
        "trainNos": ["TRAIN1", "TRAIN2"],
        "stationAlias": "STATION_ALIAS_CORRECTION",
        "trainAlias": "TRAIN_ALIAS_CORRECTION",
        "confidence": "HIGH|MEDIUM|LOW",
        "reason": "Explain why this route works or what alternative trains serve this corridor."
      }
      
      Return ONLY valid JSON. Do not include markdown formatting or backticks.
    `.trim();
        try {
            const finalPrompt = prompt + "\n\nIMPORTANT: Return ONLY a valid JSON object without markdown formatting, backticks, or extra text.";
            const response = await axios_1.default.post(`https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${this.GEMINI_KEY}`, {
                contents: [{ parts: [{ text: finalPrompt }] }],
                generationConfig: {
                    temperature: 0.3,
                    responseMimeType: "application/json"
                }
            }, {
                timeout: 10000
            });
            const text = response.data.candidates[0].content.parts[0].text;
            const jsonStr = text.replace(/```json/gi, '').replace(/```/g, '').trim();
            const suggestion = JSON.parse(jsonStr);
            logger_1.winstonLogger.info(`[GEMINI_ENRICHMENT] Gemini suggestion received for ${queryId}: ${JSON.stringify(suggestion)}`);
            // Update Local File Fallback
            if (fs_1.default.existsSync(MISSING_QUERIES_FILE)) {
                try {
                    const queries = JSON.parse(fs_1.default.readFileSync(MISSING_QUERIES_FILE, 'utf8'));
                    const idx = queries.findIndex((q) => q.id === queryId);
                    if (idx !== -1) {
                        queries[idx].gpt_suggestion = suggestion;
                        fs_1.default.writeFileSync(MISSING_QUERIES_FILE, JSON.stringify(queries, null, 2), 'utf8');
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
