"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.aiProviderResolver = exports.AiProviderResolver = void 0;
const logger_1 = require("../../middleware/logger");
const aiProvider_1 = require("./aiProvider");
const aiAdminConfigService_1 = require("./aiAdminConfigService");
const geminiAdapter_1 = require("./geminiAdapter");
const deepseekAdapter_1 = require("./deepseekAdapter");
class AiProviderResolver {
    constructor() {
        this.providers = new Map();
        this.registerProvider(geminiAdapter_1.geminiAdapter);
        this.registerProvider(deepseekAdapter_1.deepseekAdapter);
    }
    registerProvider(provider) {
        this.providers.set(provider.providerId.toUpperCase().trim(), provider);
        logger_1.winstonLogger.info(`[AI_REGISTRY] Registered AI provider: ${provider.providerId} (${provider.displayName})`);
    }
    getProvider(providerId) {
        return this.providers.get(providerId.toUpperCase().trim());
    }
    getAllProviders() {
        return Array.from(this.providers.values());
    }
    getProvidersByCapability(capability) {
        return Array.from(this.providers.values()).filter(p => p.capabilities[capability] === true);
    }
    /**
     * Resolves the primary active AI provider for a capability.
     * Reads defaultProvider from admin config at call time — no restart needed
     * after admin switches the default provider.
     */
    resolveProvider(capability) {
        const config = aiAdminConfigService_1.aiAdminConfigService.getConfig();
        const configuredPrimary = (config.defaultProvider || 'GEMINI').toUpperCase().trim();
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
    resolveForFeature(featureKey, capability) {
        try {
            const config = aiAdminConfigService_1.aiAdminConfigService.getConfig();
            const route = config.routing[featureKey];
            if (!route)
                return this.resolveProvider(capability);
            const tryProvider = (providerId) => {
                const provConfig = config.providers[providerId?.toUpperCase?.()?.trim()];
                if (!provConfig?.enabled)
                    return null;
                const adapter = this.providers.get(providerId.toUpperCase().trim());
                if (!adapter)
                    return null;
                if (!adapter.capabilities[capability])
                    return null;
                return adapter;
            };
            return tryProvider(route.primaryProvider)
                ?? tryProvider(route.fallbackProvider)
                ?? this.resolveProvider(capability);
        }
        catch {
            // Defensive: if config read fails, fall back to default provider
            return this.resolveProvider(capability);
        }
    }
    /**
     * Safe execution wrapper with standardized fallback and error propagation.
     * Optional featureKey enables per-feature provider+model routing from admin panel.
     * All callers that don't pass featureKey continue to work unchanged.
     */
    async executeWithFallback(capability, fn, fallbackValue, featureKey) {
        const provider = featureKey
            ? this.resolveForFeature(featureKey, capability)
            : this.resolveProvider(capability);
        if (!provider) {
            logger_1.winstonLogger.warn(`[AI_RESOLVER_NO_PROVIDER] No capable provider available for ${capability}`);
            return {
                result: fallbackValue !== undefined ? fallbackValue : null,
                providerUsed: 'NONE',
                error: new aiProvider_1.AiError({
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
        }
        catch (err) {
            const aiErr = err instanceof aiProvider_1.AiError ? err : new aiProvider_1.AiError({
                code: 'PROVIDER_UNAVAILABLE',
                message: err?.message || 'AI execution failed',
                provider: provider.providerId
            });
            logger_1.winstonLogger.warn(`[AI_EXEC_FAIL] ${provider.providerId} failed for ${capability}: [${aiErr.code}] ${aiErr.message}`);
            return {
                result: fallbackValue !== undefined ? fallbackValue : null,
                providerUsed: provider.providerId,
                error: aiErr
            };
        }
    }
}
exports.AiProviderResolver = AiProviderResolver;
exports.aiProviderResolver = new AiProviderResolver();
