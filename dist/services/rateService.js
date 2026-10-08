"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.rateService = exports.FALLBACK_RATES = void 0;
const supabase_1 = require("../config/supabase");
const logger_1 = require("../middleware/logger");
const cacheService_1 = require("./cacheService");
const ledgerTransport_1 = require("./ledger/ledgerTransport");
exports.FALLBACK_RATES = {
    search: 0.005,
    split: 0.01,
    pnr: 0.002,
    live: 0.003
};
class RateService {
    constructor() {
        this.CACHE_TTL = 300; // 5 minutes
    }
    /**
     * Resolves the active rate cost and currency for a provider and event type.
     * Utilizes local memory cache, database query, and fallback handlers.
     */
    async getRate(providerName, eventType) {
        const cleanProvider = (providerName || '').trim().toUpperCase();
        const cacheKey = `rate_card:${cleanProvider}:${eventType}`;
        // 1. Local memory cache check
        const cached = cacheService_1.cacheService.get(cacheKey);
        if (cached) {
            return cached;
        }
        // 2. Fallback mode check
        if (!(0, supabase_1.isSupabaseConfigured)()) {
            const rate = { costPerUnit: exports.FALLBACK_RATES[eventType] || 0.001, currency: 'USD' };
            cacheService_1.cacheService.set(cacheKey, rate, this.CACHE_TTL);
            return rate;
        }
        try {
            // 3. Query DB joining api_providers
            const { data, error } = await supabase_1.supabase
                .from('api_provider_rate_cards')
                .select(`
          cost_per_unit,
          currency,
          api_providers!inner(provider_name)
        `)
                .eq('api_providers.provider_name', cleanProvider)
                .eq('event_type', eventType)
                .is('effective_to', null)
                .limit(1)
                .maybeSingle();
            if (error) {
                throw error;
            }
            if (data) {
                const rate = { costPerUnit: Number(data.cost_per_unit), currency: data.currency || 'USD' };
                cacheService_1.cacheService.set(cacheKey, rate, this.CACHE_TTL);
                return rate;
            }
            // 4. Missing rate card: Log debug note and use standard fallback rate
            logger_1.winstonLogger.debug(`[RATE_CARD] Using fallback rate for provider ${cleanProvider} event ${eventType}.`);
            const rate = { costPerUnit: exports.FALLBACK_RATES[eventType] || 0.001, currency: 'USD' };
            cacheService_1.cacheService.set(cacheKey, rate, 3600); // Cache fallback for 1 hour to prevent DB spam
            return rate;
        }
        catch (err) {
            // 5. DB Timeout/Error fallback
            logger_1.winstonLogger.error(`[RATE_CARD] DB query failed for ${cleanProvider}/${eventType}: ${err.message}. Applying fallback.`);
            return { costPerUnit: exports.FALLBACK_RATES[eventType] || 0.001, currency: 'USD' };
        }
    }
    /**
     * Log transaction details to the ledger table in a fail-safe async manner.
     * Delegated to LedgerTransport for bounded async batching and disk spillover.
     */
    async logTransaction(providerName, eventType, userId) {
        try {
            const { costPerUnit, currency } = await this.getRate(providerName, eventType);
            ledgerTransport_1.ledgerTransport.enqueue({
                provider_name: providerName,
                event_type: eventType,
                user_id: userId,
                applied_rate: costPerUnit,
                currency: currency,
                success: true,
                caller_feature: 'rateService.logTransaction'
            });
        }
        catch (err) {
            // Ledger insert failures can NEVER impact search/split/PNR/live status queries.
            logger_1.winstonLogger.error(`[TRANSACTION_LEDGER_ERROR] Failed to enqueue API cost transaction: ${err.message}`);
        }
    }
    invalidateCache(providerName, eventType) {
        const cleanProvider = (providerName || '').trim().toUpperCase();
        cacheService_1.cacheService.del(`rate_card:${cleanProvider}:${eventType}`);
    }
}
exports.rateService = new RateService();
