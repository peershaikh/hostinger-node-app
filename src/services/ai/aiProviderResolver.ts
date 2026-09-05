import { winstonLogger } from '../../middleware/logger';
import {
  AiProvider,
  AiCapabilities,
  AiError
} from './aiProvider';
import { aiAdminConfigService, AiFeatureKey } from './aiAdminConfigService';
import { geminiAdapter } from './geminiAdapter';
import { deepseekAdapter } from './deepseekAdapter';

export class AiProviderResolver {
  private providers = new Map<string, AiProvider>();

  constructor() {
    this.registerProvider(geminiAdapter);
    this.registerProvider(deepseekAdapter);
  }

  public registerProvider(provider: AiProvider): void {
    this.providers.set(provider.providerId.toUpperCase().trim(), provider);
    winstonLogger.info(`[AI_REGISTRY] Registered AI provider: ${provider.providerId} (${provider.displayName})`);
  }

  public getProvider(providerId: string): AiProvider | undefined {
    return this.providers.get(providerId.toUpperCase().trim());
  }

  public getAllProviders(): AiProvider[] {
    return Array.from(this.providers.values());
  }

  public getProvidersByCapability(capability: keyof AiCapabilities): AiProvider[] {
    return Array.from(this.providers.values()).filter(p => p.capabilities[capability] === true);
  }

  /**
   * Resolves the primary active AI provider for a capability.
   * Reads defaultProvider from admin config at call time — no restart needed
   * after admin switches the default provider.
   */
  public resolveProvider(capability: keyof AiCapabilities): AiProvider | null {
    const config = aiAdminConfigService.getConfig();
    const configuredPrimary = (
      config.defaultProvider || 'GEMINI'
    ).toUpperCase().trim();

    const candidate = this.providers.get(configuredPrimary);
    const candidateConfig = config.providers?.[configuredPrimary];
    if (candidate && candidateConfig?.enabled && candidate.capabilities[capability]) {
      return candidate;
    }

    // Fallback: any enabled registered provider supporting this capability
    const capable = this.getProvidersByCapability(capability).filter(p => {
      const pConfig = config.providers?.[p.providerId.toUpperCase().trim()];
      return Boolean(pConfig?.enabled);
    });
    return capable.length > 0 ? capable[0] : null;
  }

  /**
   * Resolves the best provider for a specific feature key using the routing table.
   * Runtime — reads from admin config at call time, no restart needed.
   *
   * Resolution order:
   *   1. routing[featureKey].primaryProvider  (if registered + enabled + has capability)
   *   2. routing[featureKey].fallbackProvider (if registered + enabled + has capability)
   *   3. resolveProvider(capability)           (default provider + capability scan)
   */
  public resolveForFeature(
    featureKey: AiFeatureKey,
    capability: keyof AiCapabilities
  ): AiProvider | null {
    try {
      const config = aiAdminConfigService.getConfig();
      const route = config.routing[featureKey];
      if (!route) return this.resolveProvider(capability);

      const tryProvider = (providerId: string): AiProvider | null => {
        const provConfig = config.providers[providerId?.toUpperCase?.()?.trim()];
        if (!provConfig?.enabled) return null;
        const adapter = this.providers.get(providerId.toUpperCase().trim());
        if (!adapter) return null;
        if (!adapter.capabilities[capability]) return null;
        return adapter;
      };

      return tryProvider(route.primaryProvider)
        ?? tryProvider(route.fallbackProvider)
        ?? this.resolveProvider(capability);
    } catch {
      // Defensive: if config read fails, fall back to default provider
      return this.resolveProvider(capability);
    }
  }

  /**
   * Safe execution wrapper with standardized fallback and error propagation.
   * Optional featureKey enables per-feature provider+model routing from admin panel.
   * All callers that don't pass featureKey continue to work unchanged.
   */
  public async executeWithFallback<T>(
    capability: keyof AiCapabilities,
    fn: (provider: AiProvider) => Promise<T>,
    fallbackValue?: T,
    featureKey?: AiFeatureKey
  ): Promise<{ result: T | null; providerUsed: string; error?: AiError }> {
    const provider = featureKey
      ? this.resolveForFeature(featureKey, capability)
      : this.resolveProvider(capability);

    if (!provider) {
      winstonLogger.warn(`[AI_RESOLVER_NO_PROVIDER] No capable provider available for ${capability}`);
      return {
        result: fallbackValue !== undefined ? fallbackValue : null,
        providerUsed: 'NONE',
        error: new AiError({
          code: 'UNSUPPORTED_CAPABILITY',
          message: `No active AI provider supports capability '${capability}'`,
          provider: 'SYSTEM'
        })
      };
    }

    try {
      const result = await fn(provider);
      return {
        result,
        providerUsed: provider.providerId
      };
    } catch (err: any) {
      const aiErr = err instanceof AiError ? err : new AiError({
        code: 'PROVIDER_UNAVAILABLE',
        message: err?.message || 'AI execution failed',
        provider: provider.providerId
      });

      winstonLogger.warn(`[AI_EXEC_FAIL] ${provider.providerId} failed for ${capability}: [${aiErr.code}] ${aiErr.message}`);

      return {
        result: fallbackValue !== undefined ? fallbackValue : null,
        providerUsed: provider.providerId,
        error: aiErr
      };
    }
  }
}

export const aiProviderResolver = new AiProviderResolver();
