/**
 * PHASE_DYNAMIC_RAIL_PROVIDER_RESOLVER_045 — Feature-Aware Dynamic Rail Provider Resolver
 *
 * Connects Admin Panel provider configuration (priority, enablement, health)
 * to runtime feature execution with capability-aware filtering and safe fallback.
 */

import { winstonLogger } from '../middleware/logger';
import { providerConfigService } from './providerConfigService';
import { railProviderRegistry, RailProvider, ProviderCapabilities } from './railProviderRegistry';

export interface ProviderExecutionResult<T> {
  result: T | null;
  providerUsed: string;
  fallbackUsed: boolean;
  attemptedProviders: string[];
  latencyMs: number;
}

export class RailProviderResolver {
  /**
   * Resolves an ordered list of valid, capable, and enabled providers for a given feature.
   */
  public async resolveProviderChain(feature: keyof ProviderCapabilities): Promise<RailProvider[]> {
    const configs = await providerConfigService.getProviderConfigs();
    const configMap = new Map<string, { priority: number; enabled: boolean; health_status: string }>();

    for (const c of configs) {
      configMap.set(c.provider_name.toUpperCase().trim(), {
        priority: typeof c.priority === 'number' ? c.priority : 99,
        enabled: c.enabled === true,
        health_status: (c.health_status || 'ACTIVE').toUpperCase().trim()
      });
    }

    // Get all registered providers that support this capability
    const capableProviders = railProviderRegistry.getProvidersByCapability(feature);

    const candidates: Array<{ provider: RailProvider; priority: number }> = [];

    for (const provider of capableProviders) {
      const pId = provider.providerId.toUpperCase().trim();
      const cfg = configMap.get(pId);

      // Check if provider is enabled in config (or default fallback)
      const isEnabled = cfg ? cfg.enabled : (pId === 'IRCTC' || pId === 'DATABASE');
      if (!isEnabled) {
        continue;
      }

      // Check health status (IRCTC has resilient env fallback)
      if (cfg && cfg.health_status === 'DISABLED') {
        continue;
      }
      if (cfg && cfg.health_status === 'CRITICAL' && pId !== 'IRCTC') {
        continue;
      }

      // Check in-memory circuit breaker status
      if (providerConfigService.isCircuitBreakerBlocked(pId) && pId !== 'IRCTC' && pId !== 'DATABASE') {
        continue;
      }

      const priority = cfg ? cfg.priority : (pId === 'IRCTC' ? 1 : pId === 'DATABASE' ? 99 : 50);
      candidates.push({ provider, priority });
    }

    // Sort by configured priority (ascending: 1 > 2 > 3)
    candidates.sort((a, b) => a.priority - b.priority);

    const resolved = candidates.map(c => c.provider);

    winstonLogger.info(
      `[PROVIDER_RESOLVER] Feature: ${feature} -> Resolved Chain: [${resolved.map(p => p.providerId).join(' -> ') || 'NONE'}]`
    );

    return resolved;
  }

  /**
   * Resolves the single highest-priority provider for a feature.
   */
  public async resolvePrimaryProvider(feature: keyof ProviderCapabilities): Promise<RailProvider | null> {
    const chain = await this.resolveProviderChain(feature);
    return chain.length > 0 ? chain[0] : null;
  }

  /**
   * Executes an operation with automatic fallback through the resolved provider chain.
   */
  public async executeWithFallback<T>(
    feature: keyof ProviderCapabilities,
    operation: (provider: RailProvider) => Promise<T | null>
  ): Promise<ProviderExecutionResult<T>> {
    const chain = await this.resolveProviderChain(feature);
    const attemptedProviders: string[] = [];
    const startTime = Date.now();

    if (chain.length === 0) {
      winstonLogger.warn(`[PROVIDER_RESOLVER_EMPTY] No capable and enabled provider available for feature: ${feature}`);
      return {
        result: null,
        providerUsed: 'NO_PROVIDER_AVAILABLE',
        fallbackUsed: false,
        attemptedProviders: [],
        latencyMs: 0
      };
    }

    for (let i = 0; i < chain.length; i++) {
      const provider = chain[i];
      const pId = provider.providerId;
      attemptedProviders.push(pId);
      const attemptStart = Date.now();

      try {
        winstonLogger.info(`[PROVIDER_EXEC] Attempting ${pId} for ${feature} (priority rank ${i + 1}/${chain.length})`);
        const res = await operation(provider);

        const isOk = res !== null && res !== undefined && (
          Array.isArray(res) ? res.length > 0 :
          typeof res === 'object' ? Object.keys(res).length > 0 : true
        );

        if (isOk) {
          const latency = Date.now() - attemptStart;
          winstonLogger.info(
            `[PROVIDER_EXEC_SUCCESS] ${pId} succeeded for ${feature} in ${latency}ms (Fallback used: ${i > 0})`
          );
          return {
            result: res,
            providerUsed: pId,
            fallbackUsed: i > 0,
            attemptedProviders,
            latencyMs: Date.now() - startTime
          };
        } else {
          winstonLogger.warn(`[PROVIDER_EXEC_EMPTY] ${pId} returned empty response for ${feature}`);
        }
      } catch (err: any) {
        winstonLogger.warn(`[PROVIDER_EXEC_FAILED] ${pId} failed for ${feature}: ${err.message}`);
      }
    }

    winstonLogger.warn(
      `[PROVIDER_ALL_EXHAUSTED] All providers [${attemptedProviders.join(', ')}] failed for ${feature}`
    );

    return {
      result: null,
      providerUsed: 'NO_PROVIDER_AVAILABLE',
      fallbackUsed: attemptedProviders.length > 1,
      attemptedProviders,
      latencyMs: Date.now() - startTime
    };
  }
}

export const railProviderResolver = new RailProviderResolver();
