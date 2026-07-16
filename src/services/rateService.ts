import { supabase, isSupabaseConfigured } from '../config/supabase';
import { winstonLogger } from '../middleware/logger';
import { cacheService } from './cacheService';

export const FALLBACK_RATES: Record<string, number> = {
  search: 0.005,
  split: 0.01,
  pnr: 0.002,
  live: 0.003
};

export interface RateCard {
  id?: string;
  provider_id: string;
  event_type: 'search' | 'split' | 'pnr' | 'live';
  cost_per_unit: number;
  currency: string;
  tier_threshold: number;
  tier_discount: number;
  effective_from: string;
  effective_to: string | null;
}

class RateService {
  private readonly CACHE_TTL = 300; // 5 minutes

  /**
   * Resolves the active rate cost and currency for a provider and event type.
   * Utilizes local memory cache, database query, and fallback handlers.
   */
  public async getRate(providerName: string, eventType: 'search' | 'split' | 'pnr' | 'live'): Promise<{ costPerUnit: number; currency: string }> {
    const cleanProvider = (providerName || '').trim().toUpperCase();
    const cacheKey = `rate_card:${cleanProvider}:${eventType}`;

    // 1. Local memory cache check
    const cached = cacheService.get<{ costPerUnit: number; currency: string }>(cacheKey);
    if (cached) {
      return cached;
    }

    // 2. Fallback mode check
    if (!isSupabaseConfigured()) {
      const rate = { costPerUnit: FALLBACK_RATES[eventType] || 0.001, currency: 'USD' };
      cacheService.set(cacheKey, rate, this.CACHE_TTL);
      return rate;
    }

    try {
      // 3. Query DB joining api_providers
      const { data, error } = await supabase
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
        cacheService.set(cacheKey, rate, this.CACHE_TTL);
        return rate;
      }

      // 4. Missing rate card: Warn and use fallback
      winstonLogger.warn(`[RATE_CARD] No active rate found in DB for provider ${cleanProvider} event ${eventType}. Applying fallback.`);
      const rate = { costPerUnit: FALLBACK_RATES[eventType] || 0.001, currency: 'USD' };
      cacheService.set(cacheKey, rate, this.CACHE_TTL);
      return rate;

    } catch (err: any) {
      // 5. DB Timeout/Error fallback
      winstonLogger.error(`[RATE_CARD] DB query failed for ${cleanProvider}/${eventType}: ${err.message}. Applying fallback.`);
      return { costPerUnit: FALLBACK_RATES[eventType] || 0.001, currency: 'USD' };
    }
  }

  /**
   * Log transaction details to the ledger table in a fail-safe async manner.
   */
  public async logTransaction(providerName: string, eventType: 'search' | 'split' | 'pnr' | 'live', userId: string | null): Promise<void> {
    try {
      const { costPerUnit, currency } = await this.getRate(providerName, eventType);

      if (!isSupabaseConfigured()) {
        // Local memory fallback log
        winstonLogger.info(`[TRANSACTION_LEDGER_MOCK] Logged cost for ${providerName}/${eventType}: cost=${costPerUnit} ${currency} user=${userId}`);
        return;
      }

      // Sanitization: If userId is not a valid UUID format and is not a test/guest string, format to null
      const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
      const cleanUserId = (userId && (UUID_REGEX.test(userId) || userId.startsWith('test-') || userId.startsWith('guest-'))) ? userId : null;

      const { error } = await supabase.from('api_provider_transaction_ledger').insert({
        provider_name: providerName.trim().toUpperCase(),
        event_type: eventType,
        user_id: cleanUserId,
        applied_rate: costPerUnit,
        currency: currency
      });

      if (error) {
        throw error;
      }
    } catch (err: any) {
      // Ledger insert failures can NEVER impact search/split/PNR/live status queries.
      winstonLogger.error(`[TRANSACTION_LEDGER_ERROR] Failed to write API cost transaction: ${err.message}`);
    }
  }

  public invalidateCache(providerName: string, eventType: string) {
    const cleanProvider = (providerName || '').trim().toUpperCase();
    cacheService.del(`rate_card:${cleanProvider}:${eventType}`);
  }
}

export const rateService = new RateService();
