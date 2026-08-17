import { winstonLogger } from '../../middleware/logger';
import { aiConfig } from './aiConfig';
import {
  AiProvider,
  AiCapabilities,
  AiError
} from './aiProvider';
import { geminiAdapter } from './geminiAdapter';

export class AiProviderResolver {
  private providers = new Map<string, AiProvider>();

  constructor() {
    this.registerProvider(geminiAdapter);
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
   * Resolves the primary active AI provider for a requested capability.
   */
  public resolveProvider(capability: keyof AiCapabilities): AiProvider | null {
    const configuredPrimary = (aiConfig.defaultProvider || 'GEMINI').toUpperCase().trim();
    const candidate = this.providers.get(configuredPrimary);

    if (candidate && candidate.capabilities[capability]) {
      return candidate;
    }

    // Fallback: Pick any registered provider supporting this capability
    const capable = this.getProvidersByCapability(capability);
    return capable.length > 0 ? capable[0] : null;
  }

  /**
   * Safe execution wrapper with standardized fallback and telemetry
   */
  public async executeWithFallback<T>(
    capability: keyof AiCapabilities,
    fn: (provider: AiProvider) => Promise<T>,
    fallbackValue?: T
  ): Promise<{ result: T | null; providerUsed: string; error?: AiError }> {
    const provider = this.resolveProvider(capability);

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
