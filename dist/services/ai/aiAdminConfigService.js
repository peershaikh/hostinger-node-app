"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.aiAdminConfigService = exports.AiAdminConfigService = void 0;
const fs_1 = __importDefault(require("fs"));
const path_1 = __importDefault(require("path"));
const supabase_1 = require("../../config/supabase");
const logger_1 = require("../../middleware/logger");
const DATA_DIR = path_1.default.join(__dirname, '../../../data');
const CONFIG_FILE = path_1.default.join(DATA_DIR, 'ai_admin_config.json');
const DEFAULT_AI_CONFIG = {
    defaultProvider: 'DEEPSEEK',
    providers: {
        GEMINI: {
            providerId: 'GEMINI',
            displayName: 'Google Gemini',
            enabled: true,
            activeModel: 'gemini-3.6-flash',
            allowedModels: ['gemini-3.6-flash', 'gemini-1.5-flash', 'gemini-1.5-pro'],
            capabilities: {
                predictPnr: true,
                analyzeRoute: true,
                enrichRoute: true,
                categorizeFeedback: true,
                generateSchedule: true,
                normalizeAvailability: true,
                suggestAlternatives: true,
                genericPrompt: true
            }
        },
        DEEPSEEK: {
            providerId: 'DEEPSEEK',
            displayName: 'DeepSeek',
            enabled: true,
            activeModel: 'deepseek-chat',
            allowedModels: ['deepseek-chat', 'deepseek-reasoner', 'deepseek-v4-flash', 'deepseek-v4-pro'],
            capabilities: {
                predictPnr: true,
                analyzeRoute: true,
                enrichRoute: true,
                categorizeFeedback: true,
                generateSchedule: true,
                normalizeAvailability: true,
                suggestAlternatives: true,
                genericPrompt: true,
                distillNewsArticle: true
            }
        },
        OPENAI: {
            providerId: 'OPENAI',
            displayName: 'OpenAI GPT',
            enabled: false,
            activeModel: 'gpt-4o-mini',
            allowedModels: ['gpt-4o-mini', 'gpt-4o'],
            capabilities: {
                predictPnr: true,
                analyzeRoute: true,
                enrichRoute: true,
                categorizeFeedback: true,
                generateSchedule: false,
                normalizeAvailability: true,
                suggestAlternatives: true,
                genericPrompt: true
            }
        },
        ANTHROPIC: {
            providerId: 'ANTHROPIC',
            displayName: 'Anthropic Claude',
            enabled: false,
            activeModel: 'claude-3-5-haiku',
            allowedModels: ['claude-3-5-haiku', 'claude-3-5-sonnet'],
            capabilities: {
                predictPnr: true,
                analyzeRoute: true,
                enrichRoute: false,
                categorizeFeedback: true,
                generateSchedule: false,
                normalizeAvailability: true,
                suggestAlternatives: true,
                genericPrompt: true
            }
        }
    },
    routing: {
        PNR_PREDICTION: { primaryProvider: 'DEEPSEEK', fallbackProvider: 'GEMINI', model: 'deepseek-chat' },
        ROUTE_ANALYSIS: { primaryProvider: 'DEEPSEEK', fallbackProvider: 'GEMINI', model: 'deepseek-chat' },
        ROUTE_ENRICHMENT: { primaryProvider: 'DEEPSEEK', fallbackProvider: 'GEMINI', model: 'deepseek-chat' },
        SCHEDULE_GENERATION: { primaryProvider: 'DEEPSEEK', fallbackProvider: 'GEMINI', model: 'deepseek-chat' },
        AVAILABILITY_NORMALIZATION: { primaryProvider: 'DEEPSEEK', fallbackProvider: 'GEMINI', model: 'deepseek-chat' },
        GENERIC_PROMPT: { primaryProvider: 'DEEPSEEK', fallbackProvider: 'GEMINI', model: 'deepseek-chat' },
        FEEDBACK_CATEGORIZATION: { primaryProvider: 'DEEPSEEK', fallbackProvider: 'GEMINI', model: 'deepseek-chat' },
        NEWS_DISTILLATION: { primaryProvider: 'DEEPSEEK', fallbackProvider: 'GEMINI', model: 'deepseek-chat' }
    },
    modelRegistry: {
        // Gemini models
        'gemini-3.6-flash': {
            modelId: 'gemini-3.6-flash', displayName: 'Gemini 3.6 Flash', providerId: 'GEMINI',
            pricing: {
                inputPerMillionUsd: 0.75, outputPerMillionUsd: 3.75,
                notes: 'Introductory pricing through Dec 31, 2026 ($0.75/$3.75). Standard: $1.50/$7.50.'
            },
            defaultForHighVolume: true
        },
        'gemini-1.5-flash': {
            modelId: 'gemini-1.5-flash', displayName: 'Gemini 1.5 Flash', providerId: 'GEMINI',
            pricing: { inputPerMillionUsd: 0.075, outputPerMillionUsd: 0.30 }
        },
        'gemini-1.5-pro': {
            modelId: 'gemini-1.5-pro', displayName: 'Gemini 1.5 Pro', providerId: 'GEMINI',
            pricing: { inputPerMillionUsd: 1.25, outputPerMillionUsd: 5.00 },
            defaultForReasoning: true
        },
        // DeepSeek official models
        'deepseek-chat': {
            modelId: 'deepseek-chat', displayName: 'DeepSeek Chat (V3)', providerId: 'DEEPSEEK',
            pricing: {
                inputPerMillionUsd: 0.14, outputPerMillionUsd: 0.28,
                cacheHitInputPerMillionUsd: 0.014,
                notes: 'DeepSeek official chat completions API ($0.14/$0.28 per M tokens).'
            },
            defaultForHighVolume: true
        },
        'deepseek-reasoner': {
            modelId: 'deepseek-reasoner', displayName: 'DeepSeek Reasoner (R1)', providerId: 'DEEPSEEK',
            pricing: {
                inputPerMillionUsd: 0.55, outputPerMillionUsd: 2.19,
                cacheHitInputPerMillionUsd: 0.14,
                notes: 'DeepSeek official reasoning model.'
            },
            defaultForReasoning: true
        },
        'deepseek-v4-flash': {
            modelId: 'deepseek-v4-flash', displayName: 'DeepSeek V4 Flash', providerId: 'DEEPSEEK',
            pricing: {
                inputPerMillionUsd: 0.22, outputPerMillionUsd: 0.66,
                cacheHitInputPerMillionUsd: 0.007,
                notes: 'Off-peak cache-miss rates. Peak is 2x. Cache-hit input $0.007/M.'
            },
            defaultForHighVolume: true
        },
        'deepseek-v4-pro': {
            modelId: 'deepseek-v4-pro', displayName: 'DeepSeek V4 Pro', providerId: 'DEEPSEEK',
            pricing: {
                inputPerMillionUsd: 0.66, outputPerMillionUsd: 1.98,
                cacheHitInputPerMillionUsd: 0.022,
                notes: 'Off-peak cache-miss rates. Peak is 2x. Cache-hit input $0.022/M.'
            },
            defaultForReasoning: true
        }
    },
    updatedAt: new Date().toISOString(),
    updatedBy: 'SYSTEM'
};
class AiAdminConfigService {
    constructor() {
        this.config = { ...DEFAULT_AI_CONFIG };
        this.auditHistory = [];
        this.loadConfig();
    }
    getConfig() {
        return JSON.parse(JSON.stringify(this.config));
    }
    getAuditHistory() {
        return [...this.auditHistory];
    }
    async updateConfig(newConfig, updatedBy, reason) {
        // 1. Validate Provider Models
        if (newConfig.providers) {
            for (const [id, prov] of Object.entries(newConfig.providers)) {
                if (!prov.allowedModels.includes(prov.activeModel)) {
                    return {
                        success: false,
                        config: this.config,
                        message: `Model '${prov.activeModel}' is not in the allowed list for provider ${id}`
                    };
                }
            }
        }
        // 2. Validate Routing & Capabilities
        if (newConfig.routing) {
            const featureCapMap = {
                PNR_PREDICTION: 'predictPnr',
                ROUTE_ANALYSIS: 'analyzeRoute',
                ROUTE_ENRICHMENT: 'enrichRoute',
                FEEDBACK_CATEGORIZATION: 'categorizeFeedback',
                SCHEDULE_GENERATION: 'generateSchedule',
                AVAILABILITY_NORMALIZATION: 'normalizeAvailability',
                NEWS_DISTILLATION: 'distillNewsArticle',
                GENERIC_PROMPT: 'genericPrompt'
            };
            for (const [feat, route] of Object.entries(newConfig.routing)) {
                const prov = newConfig.providers?.[route.primaryProvider] || this.config.providers[route.primaryProvider];
                if (!prov) {
                    return {
                        success: false,
                        config: this.config,
                        message: `Primary provider '${route.primaryProvider}' for ${feat} is unknown`
                    };
                }
                const requiredCap = featureCapMap[feat];
                if (requiredCap && !prov.capabilities[requiredCap]) {
                    return {
                        success: false,
                        config: this.config,
                        message: `Provider '${route.primaryProvider}' does not support required capability '${requiredCap}' for ${feat}`
                    };
                }
                if (route.fallbackProvider) {
                    const fallbackProv = newConfig.providers?.[route.fallbackProvider] || this.config.providers[route.fallbackProvider];
                    if (!fallbackProv) {
                        return {
                            success: false,
                            config: this.config,
                            message: `Fallback provider '${route.fallbackProvider}' for ${feat} is unknown`
                        };
                    }
                    if (requiredCap && !fallbackProv.capabilities[requiredCap]) {
                        return {
                            success: false,
                            config: this.config,
                            message: `Fallback provider '${route.fallbackProvider}' does not support required capability '${requiredCap}' for ${feat}`
                        };
                    }
                    if (route.primaryProvider === route.fallbackProvider) {
                        return {
                            success: false,
                            config: this.config,
                            message: `Primary and fallback providers cannot be identical for ${feat}`
                        };
                    }
                }
            }
        }
        // Capture PNR prediction audit delta
        const prevRoutingPnr = this.config.routing?.PNR_PREDICTION;
        const newRoutingPnr = newConfig.routing?.PNR_PREDICTION || prevRoutingPnr;
        const prevDeepseek = this.config.providers?.DEEPSEEK?.enabled ?? false;
        const newDeepseek = newConfig.providers?.DEEPSEEK?.enabled ?? prevDeepseek;
        const prevGemini = this.config.providers?.GEMINI?.enabled ?? false;
        const newGemini = newConfig.providers?.GEMINI?.enabled ?? prevGemini;
        const auditEntry = {
            timestamp: new Date().toISOString(),
            changedBy: updatedBy,
            feature: 'PNR_PREDICTION',
            previousPrimary: prevRoutingPnr?.primaryProvider,
            newPrimary: newRoutingPnr?.primaryProvider,
            previousFallback: prevRoutingPnr?.fallbackProvider,
            newFallback: newRoutingPnr?.fallbackProvider,
            previousDeepseekEnabled: prevDeepseek,
            newDeepseekEnabled: newDeepseek,
            previousGeminiEnabled: prevGemini,
            newGeminiEnabled: newGemini,
            snapshot: JSON.parse(JSON.stringify(this.config)),
            reason: reason || 'Admin updated AI provider configuration'
        };
        // Save previous snapshot for rollback
        this.auditHistory.unshift(auditEntry);
        if (this.auditHistory.length > 50)
            this.auditHistory.pop();
        this.config = {
            ...this.config,
            ...newConfig,
            updatedAt: new Date().toISOString(),
            updatedBy
        };
        this.saveConfig();
        if ((0, supabase_1.isSupabaseConfigured)()) {
            try {
                await supabase_1.supabase.from('admin_security_audit_logs').insert([{
                        admin_email: updatedBy,
                        action: 'UPDATE_AI_PROVIDERS',
                        resource: 'ai_providers',
                        details: {
                            updatedBy,
                            reason: auditEntry.reason,
                            feature: 'PNR_PREDICTION',
                            previousPrimary: auditEntry.previousPrimary,
                            newPrimary: auditEntry.newPrimary,
                            previousFallback: auditEntry.previousFallback,
                            newFallback: auditEntry.newFallback,
                            previousDeepseekEnabled: auditEntry.previousDeepseekEnabled,
                            newDeepseekEnabled: auditEntry.newDeepseekEnabled,
                            previousGeminiEnabled: auditEntry.previousGeminiEnabled,
                            newGeminiEnabled: auditEntry.newGeminiEnabled,
                            timestamp: auditEntry.timestamp
                        },
                        created_at: new Date().toISOString()
                    }]);
            }
            catch (err) {
                logger_1.winstonLogger.warn(`[AI_AUDIT] Failed to save DB audit log: ${err.message}`);
            }
        }
        return { success: true, config: this.getConfig() };
    }
    async rollback(targetTimestamp, restoredBy) {
        const entryIndex = this.auditHistory.findIndex(h => h.timestamp === targetTimestamp);
        if (entryIndex === -1) {
            return { success: false, config: this.config, message: 'Snapshot not found in history' };
        }
        const targetSnapshot = this.auditHistory[entryIndex].snapshot;
        this.auditHistory.unshift({
            timestamp: new Date().toISOString(),
            changedBy: restoredBy,
            snapshot: JSON.parse(JSON.stringify(this.config)),
            reason: `Rollback to AI configuration from ${targetTimestamp}`
        });
        this.config = {
            ...targetSnapshot,
            updatedAt: new Date().toISOString(),
            updatedBy: restoredBy
        };
        this.saveConfig();
        if ((0, supabase_1.isSupabaseConfigured)()) {
            try {
                await supabase_1.supabase.from('admin_security_audit_logs').insert([{
                        admin_email: restoredBy,
                        action: 'ROLLBACK_AI_PROVIDERS',
                        resource: 'ai_providers',
                        details: { restoredBy, targetTimestamp, snapshot: this.config },
                        created_at: new Date().toISOString()
                    }]);
            }
            catch (err) {
                logger_1.winstonLogger.warn(`[AI_AUDIT] Failed to save DB rollback audit log: ${err.message}`);
            }
        }
        return { success: true, config: this.getConfig() };
    }
    loadConfig() {
        if (fs_1.default.existsSync(CONFIG_FILE)) {
            try {
                const raw = fs_1.default.readFileSync(CONFIG_FILE, 'utf8');
                const parsed = JSON.parse(raw);
                this.config = {
                    ...DEFAULT_AI_CONFIG,
                    ...parsed,
                    providers: { ...DEFAULT_AI_CONFIG.providers, ...(parsed.providers || {}) },
                    routing: { ...DEFAULT_AI_CONFIG.routing, ...(parsed.routing || {}) },
                    modelRegistry: { ...DEFAULT_AI_CONFIG.modelRegistry, ...(parsed.modelRegistry || {}) }
                };
                logger_1.winstonLogger.info('[AI_ADMIN_CONFIG] Loaded configuration from file');
            }
            catch (err) {
                logger_1.winstonLogger.error(`[AI_ADMIN_CONFIG] Failed to read config file: ${err.message}`);
            }
        }
    }
    saveConfig() {
        try {
            (0, supabase_1.safeWriteFileSync)(CONFIG_FILE, JSON.stringify(this.config, null, 2), 'utf8');
            logger_1.winstonLogger.info('[AI_ADMIN_CONFIG] Saved configuration to file');
        }
        catch (err) {
            logger_1.winstonLogger.error(`[AI_ADMIN_CONFIG] Failed to write config file: ${err.message}`);
        }
    }
}
exports.AiAdminConfigService = AiAdminConfigService;
exports.aiAdminConfigService = new AiAdminConfigService();
