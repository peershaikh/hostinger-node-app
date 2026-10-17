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
    /**
     * Resolves an ordered list of candidate providers for a given capability and optional feature key.
     * Order:
     *   1. Feature routing primaryProvider (if configured, enabled, and capable)
     *   2. Feature routing fallbackProvider (if configured, enabled, and capable)
     *   3. System default provider (if enabled and capable)
     *   4. Any other registered, enabled, and capable provider
     */
    resolveCandidateProviders(capability, featureKey) {
        const config = aiAdminConfigService_1.aiAdminConfigService.getConfig();
        const candidates = [];
        const seen = new Set();
        const addIfCapable = (providerId) => {
            if (!providerId)
                return;
            const id = providerId.toUpperCase().trim();
            if (seen.has(id))
                return;
            const provConfig = config.providers[id];
            if (!provConfig?.enabled)
                return;
            const adapter = this.providers.get(id);
            if (!adapter)
                return;
            if (!adapter.capabilities[capability])
                return;
            seen.add(id);
            candidates.push(adapter);
        };
        if (featureKey && config.routing?.[featureKey]) {
            addIfCapable(config.routing[featureKey].primaryProvider);
            addIfCapable(config.routing[featureKey].fallbackProvider);
        }
        addIfCapable(config.defaultProvider || 'GEMINI');
        // Add any remaining capable providers
        for (const p of this.getProvidersByCapability(capability)) {
            addIfCapable(p.providerId);
        }
        return candidates;
    }
    /**
     * Safe execution wrapper with standardized fallback across providers and error propagation.
     * Optional featureKey enables per-feature provider+model routing from admin panel.
     */
    async executeWithFallback(capability, fn, fallbackValue, featureKey) {
        const candidates = this.resolveCandidateProviders(capability, featureKey);
        if (candidates.length === 0) {
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
        let lastError;
        for (const provider of candidates) {
            try {
                const result = await fn(provider);
                return {
                    result,
                    providerUsed: provider.providerId
                };
            }
            catch (err) {
                lastError = err instanceof aiProvider_1.AiError ? err : new aiProvider_1.AiError({
                    code: 'PROVIDER_UNAVAILABLE',
                    message: err?.message || 'AI execution failed',
                    provider: provider.providerId
                });
                logger_1.winstonLogger.warn(`[AI_EXEC_FAIL] ${provider.providerId} failed for ${capability}: [${lastError.code}] ${lastError.message}. Trying next fallback candidate...`);
            }
        }
        return {
            result: fallbackValue !== undefined ? fallbackValue : null,
            providerUsed: candidates[0]?.providerId || 'NONE',
            error: lastError
        };
    }
}
exports.AiProviderResolver = AiProviderResolver;
exports.aiProviderResolver = new AiProviderResolver();
