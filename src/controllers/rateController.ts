import { Request, Response } from 'express';
import { supabase, isSupabaseConfigured } from '../config/supabase';
import { winstonLogger } from '../middleware/logger';
import { authService } from '../services/authService';
import { rateService, RateCard } from '../services/rateService';

// Fallback in-memory store for rate cards
let fallbackRateCards: RateCard[] = [
  {
    id: 'rc-mock-1',
    provider_id: '01d4df69-d510-4c38-9d95-d2d8e0f9cad4', // Mock IRCTC Provider ID
    event_type: 'search',
    cost_per_unit: 0.005,
    currency: 'USD',
    tier_threshold: 0,
    tier_discount: 0,
    effective_from: new Date().toISOString(),
    effective_to: null
  }
];

// Helper to resolve provider name in fallback mode
const getFallbackProviderName = (providerId: string): string => {
  if (providerId === '01d4df69-d510-4c38-9d95-d2d8e0f9cad4') return 'IRCTC';
  if (providerId === '02d4df69-d510-4c38-9d95-d2d8e0f9cad4') return 'RAPIDAPI';
  return 'RAILRADAR';
};

export class RateController {
  
  public async listRates(req: Request, res: Response) {
    try {
      if (!isSupabaseConfigured()) {
        const activeFallback = fallbackRateCards.filter(r => r.effective_to === null);
        return res.status(200).json({ success: true, rates: activeFallback });
      }

      try {
        const { data, error } = await supabase
          .from('api_provider_rate_cards')
          .select(`
            *,
            api_providers (
              provider_name
            )
          `)
          .is('effective_to', null);

        if (error) throw error;
        res.status(200).json({ success: true, rates: data });
      } catch (dbError: any) {
        winstonLogger.warn(`[RateController] listRates DB query failed: ${dbError.message}. Redirecting to in-memory fallback.`);
        const activeFallback = fallbackRateCards.filter(r => r.effective_to === null).map(r => ({
          ...r,
          api_providers: {
            provider_name: getFallbackProviderName(r.provider_id)
          }
        }));
        res.status(200).json({ success: true, rates: activeFallback, fallback: true });
      }
    } catch (err: any) {
      winstonLogger.error(`[RateController] listRates failed: ${err.message}`);
      res.status(500).json({ success: false, error: err.message });
    }
  }

  public async createRateCard(req: Request, res: Response) {
    try {
      const { providerId, eventType, costPerUnit, currency, tierThreshold, tierDiscount, effectiveFrom } = req.body;

      // 1. Validation Design Checks
      const costVal = Number(costPerUnit);
      const tierThreshVal = Number(tierThreshold || 0);
      const discountVal = Number(tierDiscount || 0);

      if (!providerId || !eventType) {
        return res.status(400).json({ success: false, error: 'Provider ID and Event Type are required.' });
      }
      if (isNaN(costVal) || costVal < 0) {
        return res.status(400).json({ success: false, error: 'Cost per unit must be a non-negative number.' });
      }
      if (costVal > 10.0) {
        return res.status(400).json({ success: false, error: 'Cost allocation exceeds maximum safety cap of 10.00 USD.' });
      }
      if (!currency || !['USD', 'INR'].includes(currency.toUpperCase())) {
        return res.status(400).json({ success: false, error: 'Invalid currency. Must be USD or INR.' });
      }
      if (isNaN(tierThreshVal) || tierThreshVal < 0) {
        return res.status(400).json({ success: false, error: 'Tier threshold must be a non-negative integer.' });
      }
      if (isNaN(discountVal) || discountVal < 0 || discountVal > 1.0) {
        return res.status(400).json({ success: false, error: 'Tier discount factor must satisfy: 0.0 <= discount <= 1.0.' });
      }
      if (!['search', 'split', 'pnr', 'live'].includes(eventType)) {
        return res.status(400).json({ success: false, error: 'Invalid event type.' });
      }

      const adminId = (req as any).user?.id || req.headers['x-user-id'] as string || 'unknown-admin';
      const adminUser = await authService.getUserById(adminId);
      const adminEmail = adminUser?.email || 'unknown-admin@trayago.in';

      let providerName = '';

      if (isSupabaseConfigured()) {
        try {
          // Retrieve provider name to invalidate cache key correctly
          const { data: provider, error: pErr } = await supabase
            .from('api_providers')
            .select('provider_name')
            .eq('id', providerId)
            .single();

          if (pErr || !provider) {
            throw new Error(pErr?.message || 'Referenced API provider not found.');
          }
          providerName = provider.provider_name;

          // Perform Database-level Atomic Update Transaction (RPC)
          const { error } = await supabase.rpc('admin_create_rate_card_rpc', {
            p_admin_id: adminId,
            p_admin_email: adminEmail,
            p_provider_id: providerId,
            p_event_type: eventType,
            p_cost_per_unit: costVal,
            p_currency: currency.toUpperCase(),
            p_tier_threshold: tierThreshVal,
            p_tier_discount: discountVal,
            p_effective_from: effectiveFrom || new Date().toISOString(),
            p_ip_address: req.ip || req.headers['x-forwarded-for'] as string || null,
            p_user_agent: req.headers['user-agent'] || null,
            p_details: { providerId, eventType, costPerUnit: costVal, currency }
          });

          if (error) throw error;
        } catch (dbError: any) {
          winstonLogger.warn(`[RateController] createRateCard DB query failed: ${dbError.message}. Using in-memory fallback.`);
          providerName = getFallbackProviderName(providerId);

          const vNow = effectiveFrom || new Date().toISOString();

          // Close active duplicate fallback rates
          fallbackRateCards = fallbackRateCards.map(r => {
            if (r.provider_id === providerId && r.event_type === eventType && r.tier_threshold === tierThreshVal && r.effective_to === null) {
              return { ...r, effective_to: vNow };
            }
            return r;
          });

          // Insert new fallback card version
          fallbackRateCards.push({
            id: `rc-mock-${Date.now()}`,
            provider_id: providerId,
            event_type: eventType as any,
            cost_per_unit: costVal,
            currency: currency.toUpperCase(),
            tier_threshold: tierThreshVal,
            tier_discount: discountVal,
            effective_from: vNow,
            effective_to: null
          });
          
          winstonLogger.info(`[rate_card_updated] Telemetry logged. Rate card updated for ${providerName}`);
        }
      } else {
        // Fallback Simulation Mode
        providerName = getFallbackProviderName(providerId);

        const vNow = effectiveFrom || new Date().toISOString();

        // Close active duplicate fallback rates
        fallbackRateCards = fallbackRateCards.map(r => {
          if (r.provider_id === providerId && r.event_type === eventType && r.tier_threshold === tierThreshVal && r.effective_to === null) {
            return { ...r, effective_to: vNow };
          }
          return r;
        });

        // Insert new fallback card version
        fallbackRateCards.push({
          id: `rc-mock-${Date.now()}`,
          provider_id: providerId,
          event_type: eventType as any,
          cost_per_unit: costVal,
          currency: currency.toUpperCase(),
          tier_threshold: tierThreshVal,
          tier_discount: discountVal,
          effective_from: vNow,
          effective_to: null
        });
      }

      // Evict rate cache key
      rateService.invalidateCache(providerName, eventType);

      winstonLogger.info(`[RateController] Created rate card for provider ${providerName} event ${eventType}`);
      res.status(201).json({ success: true, message: 'API provider rate card registered successfully.', fallback: true });

    } catch (err: any) {
      winstonLogger.error(`[RateController] createRateCard failed: ${err.message}`);
      res.status(500).json({ success: false, error: 'Audit transaction failed. Rate card insertion rolled back.' });
    }
  }

  public async deleteRateCard(req: Request, res: Response) {
    try {
      const { id } = req.params;
      const adminId = (req as any).user?.id || req.headers['x-user-id'] as string || 'unknown-admin';
      const adminUser = await authService.getUserById(adminId);
      const adminEmail = adminUser?.email || 'unknown-admin@trayago.in';

      if (isSupabaseConfigured()) {
        try {
          // Lookup target rate card to identify provider name and evict cache key
          const { data: rateCard, error: rErr } = await supabase
            .from('api_provider_rate_cards')
            .select(`
              event_type,
              api_providers (
                provider_name
              )
            `)
            .eq('id', id)
            .single();

          if (rErr || !rateCard) {
            throw new Error(rErr?.message || 'Rate card not found.');
          }

          const providerName = (rateCard.api_providers as any)?.provider_name;
          const eventType = rateCard.event_type;

          // Perform Database-level Atomic Update Transaction (RPC)
          const { error } = await supabase.rpc('admin_delete_rate_card_rpc', {
            p_admin_id: adminId,
            p_admin_email: adminEmail,
            p_rate_card_id: id,
            p_ip_address: req.ip || req.headers['x-forwarded-for'] as string || null,
            p_user_agent: req.headers['user-agent'] || null,
            p_details: { rateCardId: id }
          });

          if (error) throw error;

          // Evict specific cache key
          rateService.invalidateCache(providerName, eventType);

        } catch (dbError: any) {
          winstonLogger.warn(`[RateController] deleteRateCard DB query failed: ${dbError.message}. Using in-memory fallback.`);
          
          const rateCard = fallbackRateCards.find(r => r.id === id);
          if (!rateCard) {
            return res.status(404).json({ success: false, error: 'Rate card not found.' });
          }
          
          rateCard.effective_to = new Date().toISOString();
          const providerName = getFallbackProviderName(rateCard.provider_id);
          rateService.invalidateCache(providerName, rateCard.event_type);
          
          winstonLogger.info(`[rate_card_updated] Telemetry logged. Rate card deleted for ${providerName}`);
        }
      } else {
        // Fallback Simulation Mode
        const rateCard = fallbackRateCards.find(r => r.id === id);
        if (!rateCard) {
          return res.status(404).json({ success: false, error: 'Rate card not found.' });
        }
        
        rateCard.effective_to = new Date().toISOString();
        const providerName = getFallbackProviderName(rateCard.provider_id);
        rateService.invalidateCache(providerName, rateCard.event_type);
      }

      winstonLogger.warn(`[RateController] Soft deleted rate card ID: ${id}`);
      res.status(200).json({ success: true, message: 'Rate card soft-deleted successfully.', fallback: true });

    } catch (err: any) {
      winstonLogger.error(`[RateController] deleteRateCard failed: ${err.message}`);
      res.status(500).json({ success: false, error: 'Audit transaction failed. Rate card deletion rolled back.' });
    }
  }
}

export const rateController = new RateController();
