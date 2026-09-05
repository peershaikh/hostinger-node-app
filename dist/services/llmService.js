"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.llmService = exports.LlmService = void 0;
const logger_1 = require("../middleware/logger");
const aiProviderResolver_1 = require("./ai/aiProviderResolver");
const aiAdminConfigService_1 = require("./ai/aiAdminConfigService");
class LlmService {
    /**
     * Generates a comprehensive route analysis for the user.
     */
    async getRouteAnalysis(routeDetails) {
        const fallback = {
            insight: 'Review confirmed real-time availability for this route.',
            recommendation_reason: 'Primary verified option for your journey.',
            risk_level: 'Medium'
        };
        try {
            logger_1.winstonLogger.info(`[LLM] Route analysis for ${routeDetails.source} -> ${routeDetails.destination}`);
            const provider = aiProviderResolver_1.aiProviderResolver.resolveProvider('analyzeRoute');
            if (!provider || typeof provider.analyzeRoute !== 'function') {
                return fallback;
            }
            return await provider.analyzeRoute(routeDetails);
        }
        catch {
            return fallback;
        }
    }
    /**
     * Predicts PNR confirmation probability with safe configuration-driven multi-provider fallback.
     */
    async predictPNRConfirmation(pnrData) {
        let primary = null;
        let fallback = null;
        try {
            const config = aiAdminConfigService_1.aiAdminConfigService.getConfig();
            const route = config?.routing?.['PNR_PREDICTION'];
            const isEligible = (providerId) => {
                if (!providerId)
                    return false;
                const pId = providerId.toUpperCase().trim();
                const provConfig = config?.providers?.[pId];
                if (!provConfig?.enabled)
                    return false;
                const candidate = aiProviderResolver_1.aiProviderResolver.getProvider(pId);
                return Boolean(candidate && typeof candidate.predictPnr === 'function');
            };
            const preferredPrimary = route?.primaryProvider;
            const preferredFallback = route?.fallbackProvider;
            if (isEligible(preferredPrimary)) {
                primary = aiProviderResolver_1.aiProviderResolver.getProvider(preferredPrimary);
                if (isEligible(preferredFallback) && preferredFallback.toUpperCase() !== preferredPrimary.toUpperCase()) {
                    fallback = aiProviderResolver_1.aiProviderResolver.getProvider(preferredFallback);
                }
            }
            else if (isEligible(preferredFallback)) {
                logger_1.winstonLogger.info(`[LLM] Persisted primary '${preferredPrimary}' is disabled or unavailable. Promoting fallback '${preferredFallback}' as effective primary.`);
                primary = aiProviderResolver_1.aiProviderResolver.getProvider(preferredFallback);
                fallback = null;
            }
        }
        catch (e) {
            logger_1.winstonLogger.warn(`[LLM] Error resolving routing from admin config: ${e.message}`);
        }
        if (!primary || typeof primary.predictPnr !== 'function') {
            primary = aiProviderResolver_1.aiProviderResolver.resolveForFeature('PNR_PREDICTION', 'predictPnr');
        }
        if (!primary || typeof primary.predictPnr !== 'function') {
            throw new Error('No capable AI provider available for PNR prediction');
        }
        // 1. Attempt PRIMARY provider exactly once
        try {
            logger_1.winstonLogger.info(`[LLM] PNR prediction for ${pnrData.pnr || 'unknown'} using primary provider ${primary.providerId}`);
            const res = await primary.predictPnr(pnrData);
            return {
                ...res,
                providerId: primary.providerId
            };
        }
        catch (primaryErr) {
            if (primaryErr?.code === 'RATE_LIMITED' || primaryErr?.message?.includes('rate limit') || primaryErr?.message?.includes('quota')) {
                logger_1.winstonLogger.info(`[LLM] Primary AI provider ${primary.providerId} rate limited (${primaryErr.message}).`);
            }
            else {
                logger_1.winstonLogger.warn(`[LLM] Primary AI provider ${primary.providerId} failed: ${primaryErr.message}`);
            }
            // 2. Attempt CONFIGURED FALLBACK provider exactly once if distinct and capable
            if (fallback && fallback.providerId !== primary.providerId && typeof fallback.predictPnr === 'function') {
                try {
                    logger_1.winstonLogger.info(`[LLM] Attempting fallback AI provider ${fallback.providerId} for PNR ${pnrData.pnr || 'unknown'}`);
                    const fbRes = await fallback.predictPnr(pnrData);
                    return {
                        ...fbRes,
                        providerId: fallback.providerId
                    };
                }
                catch (fallbackErr) {
                    logger_1.winstonLogger.warn(`[LLM] Fallback AI provider ${fallback.providerId} also failed: ${fallbackErr.message}`);
                }
            }
            // 3. Propagate error to pnrController for HEURISTIC/CALIBRATED safety fallback
            throw primaryErr;
        }
    }
    /**
     * Suggests alternative travel options (Bus/Flight)
     */
    async suggestAlternativeTravel(source, destination) {
        const provider = aiProviderResolver_1.aiProviderResolver.resolveProvider('suggestAlternatives');
        if (!provider || typeof provider.suggestAlternatives !== 'function') {
            return [];
        }
        try {
            logger_1.winstonLogger.info(`[LLM] Alternative travel for ${source} -> ${destination}`);
            return await provider.suggestAlternatives(source, destination);
        }
        catch {
            return [];
        }
    }
    /**
     * GPT Feedback Categorization
     * Classifies a user's feedback text into a structured category with priority and action.
     * Returns null silently if AI is unavailable — never blocks feedback submission.
     */
    async categorizeFeedback(feedbackText, metadata = {}) {
        const provider = aiProviderResolver_1.aiProviderResolver.resolveProvider('categorizeFeedback');
        if (!provider || typeof provider.categorizeFeedback !== 'function') {
            logger_1.winstonLogger.warn('[LLM] categorizeFeedback skipped — AI provider unavailable');
            return null;
        }
        try {
            logger_1.winstonLogger.info(`[LLM] categorizeFeedback invoked`);
            return await provider.categorizeFeedback({ feedbackText, metadata });
        }
        catch (err) {
            logger_1.winstonLogger.warn(`[LLM] categorizeFeedback failed silently: ${err.message}`);
            return null;
        }
    }
    /**
     * Smart Split Route Recommendation
     */
    async getOptimalSplitRoute(source, destination) {
        const popularHubs = ['KYN', 'BPL', 'ET', 'NGP', 'BZA', 'UBL'];
        const fallbackResult = {
            route: `${source} → ${popularHubs[0]} → ${destination}`,
            legs: [{ from: source, to: popularHubs[0] }, { from: popularHubs[0], to: destination }],
            reason: 'AI Suggested best hub based on historical confirmation rate'
        };
        const provider = aiProviderResolver_1.aiProviderResolver.resolveProvider('genericPrompt');
        if (!provider || typeof provider.generateText !== 'function') {
            return fallbackResult;
        }
        try {
            logger_1.winstonLogger.info(`[LLM] Asking for optimal split: ${source} → ${destination}`);
            const prompt = `Find best split journey from ${source} to ${destination}. Return ONLY JSON: {"route": "FROM -> HUB -> TO", "legs": [{"from":"...","to":"...","reason":"..."}], "confidence": "High", "reason": "..."}`;
            const result = await provider.generateText(prompt, { json: true });
            if (result && result.route && result.legs) {
                return {
                    route: result.route,
                    legs: result.legs,
                    reason: result.reason || 'AI Suggested route',
                    confidence: result.confidence
                };
            }
            return fallbackResult;
        }
        catch {
            logger_1.winstonLogger.warn(`[LLM] AI Call failed, using smart fallback`);
            return fallbackResult;
        }
    }
    /**
     * Cleans messy availability text into structured JSON using AI Provider
     */
    async cleanAvailabilityData(rawAvailString) {
        if (!rawAvailString || rawAvailString.trim() === '')
            return [];
        const provider = aiProviderResolver_1.aiProviderResolver.resolveProvider('normalizeAvailability');
        if (!provider || typeof provider.normalizeAvailability !== 'function') {
            logger_1.winstonLogger.warn('[LLM] Provider missing, falling back to basic parsing');
            return [{ class: 'UNK', status: rawAvailString, count: 0 }];
        }
        try {
            logger_1.winstonLogger.info(`[AI_CALL] Cleaning availability data`);
            return await provider.normalizeAvailability(rawAvailString);
        }
        catch {
            logger_1.winstonLogger.error('[LLM] Availability normalization failed');
            return [];
        }
    }
    async callAi(prompt, json = false) {
        const provider = aiProviderResolver_1.aiProviderResolver.resolveProvider('genericPrompt');
        if (!provider || typeof provider.generateText !== 'function') {
            throw new Error('No active AI provider available');
        }
        return provider.generateText(prompt, { json });
    }
}
exports.LlmService = LlmService;
exports.llmService = new LlmService();
