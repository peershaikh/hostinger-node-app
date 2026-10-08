import { supabase, isSupabaseConfigured } from '../config/supabase';
import { winstonLogger } from '../middleware/logger';
import { cacheService } from './cacheService';
import { ledgerTransport } from './ledger/ledgerTransport';

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

      // 4. Missing rate card: Log debug note and use standard fallback rate
      winstonLogger.debug(`[RATE_CARD] Using fallback rate for provider ${cleanProvider} event ${eventType}.`);
      const rate = { costPerUnit: FALLBACK_RATES[eventType] || 0.001, currency: 'USD' };
      cacheService.set(cacheKey, rate, 3600); // Cache fallback for 1 hour to prevent DB spam
      return rate;

    } catch (err: any) {
      // 5. DB Timeout/Error fallback
      winstonLogger.error(`[RATE_CARD] DB query failed for ${cleanProvider}/${eventType}: ${err.message}. Applying fallback.`);
      return { costPerUnit: FALLBACK_RATES[eventType] || 0.001, currency: 'USD' };
    }
  }

  /**
   * Log transaction details to the ledger table in a fail-safe async manner.
   * Delegated to LedgerTransport for bounded async batching and disk spillover.
   */
  public async logTransaction(providerName: string, eventType: 'search' | 'split' | 'pnr' | 'live', userId: string | null): Promise<void> {
    try {
      const { costPerUnit, currency } = await this.getRate(providerName, eventType);

      ledgerTransport.enqueue({
        provider_name: providerName,
        event_type: eventType,
        user_id: userId,
        applied_rate: costPerUnit,
        currency: currency,
        success: true,
        caller_feature: 'rateService.logTransaction'
      });
    } catch (err: any) {
      // Ledger insert failures can NEVER impact search/split/PNR/live status queries.
      winstonLogger.error(`[TRANSACTION_LEDGER_ERROR] Failed to enqueue API cost transaction: ${err.message}`);
    }
  }

  public invalidateCache(providerName: string, eventType: string) {
    const cleanProvider = (providerName || '').trim().toUpperCase();
    cacheService.del(`rate_card:${cleanProvider}:${eventType}`);
  }
}

export const rateService = new RateService();
