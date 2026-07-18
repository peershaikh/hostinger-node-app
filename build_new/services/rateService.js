"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.rateService = exports.FALLBACK_RATES = void 0;
const supabase_1 = require("../config/supabase");
const logger_1 = require("../middleware/logger");
const cacheService_1 = require("./cacheService");
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
            // 4. Missing rate card: Warn and use fallback
            logger_1.winstonLogger.warn(`[RATE_CARD] No active rate found in DB for provider ${cleanProvider} event ${eventType}. Applying fallback.`);
            const rate = { costPerUnit: exports.FALLBACK_RATES[eventType] || 0.001, currency: 'USD' };
            cacheService_1.cacheService.set(cacheKey, rate, this.CACHE_TTL);
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
     */
    async logTransaction(providerName, eventType, userId) {
        try {
            const { costPerUnit, currency } = await this.getRate(providerName, eventType);
            if (!(0, supabase_1.isSupabaseConfigured)()) {
                // Local memory fallback log
                logger_1.winstonLogger.info(`[TRANSACTION_LEDGER_MOCK] Logged cost for ${providerName}/${eventType}: cost=${costPerUnit} ${currency} user=${userId}`);
                return;
            }
            // Sanitization: If userId is not a valid UUID format and is not a test/guest string, format to null
            const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
            const cleanUserId = (userId && (UUID_REGEX.test(userId) || userId.startsWith('test-') || userId.startsWith('guest-'))) ? userId : null;
            const { error } = await supabase_1.supabase.from('api_provider_transaction_ledger').insert({
                provider_name: providerName.trim().toUpperCase(),
                event_type: eventType,
                user_id: cleanUserId,
                applied_rate: costPerUnit,
                currency: currency
            });
            if (error) {
                throw error;
            }
        }
        catch (err) {
            // Ledger insert failures can NEVER impact search/split/PNR/live status queries.
            logger_1.winstonLogger.error(`[TRANSACTION_LEDGER_ERROR] Failed to write API cost transaction: ${err.message}`);
        }
    }
    invalidateCache(providerName, eventType) {
        const cleanProvider = (providerName || '').trim().toUpperCase();
        cacheService_1.cacheService.del(`rate_card:${cleanProvider}:${eventType}`);
    }
}
exports.rateService = new RateService();
