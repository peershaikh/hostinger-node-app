import fs from 'fs';
import path from 'path';
import { supabase, isSupabaseConfigured, safeWriteFileSync } from '../../config/supabase';
import { winstonLogger } from '../../middleware/logger';
import { AiCapabilities } from './aiProvider';

const DATA_DIR = path.join(__dirname, '../../../data');
const CONFIG_FILE = path.join(DATA_DIR, 'ai_admin_config.json');

export type AiFeatureKey =
  | 'PNR_PREDICTION'
  | 'ROUTE_ANALYSIS'
  | 'ROUTE_ENRICHMENT'
  | 'FEEDBACK_CATEGORIZATION'
  | 'SCHEDULE_GENERATION'
  | 'AVAILABILITY_NORMALIZATION'
  | 'NEWS_DISTILLATION'
  | 'GENERIC_PROMPT';

export interface AiAdminProviderConfig {
  providerId: string;
  displayName: string;
  enabled: boolean;
  activeModel: string;
  allowedModels: string[];
  capabilities: AiCapabilities;
  lastTestedAt?: string;
  lastTestStatus?: 'SUCCESS' | 'FAILED';
}

export interface AiFeatureRouting {
  primaryProvider: string;
  fallbackProvider: string;
  model: string;
}

/**
 * Per-model metadata exposed to the Admin Panel.
 * Safe to return via API — contains no key material.
 */
export interface AiModelMeta {
  modelId: string;
  displayName: string;
  providerId: string;
  pricing: {
    inputPerMillionUsd: number;
    outputPerMillionUsd: number;
    cacheHitInputPerMillionUsd?: number;
    notes?: string;
  };
  defaultForHighVolume?: boolean;
  defaultForReasoning?: boolean;
}

export interface AiSystemConfig {
  defaultProvider: string;
  providers: Record<string, AiAdminProviderConfig>;
  routing: Record<AiFeatureKey, AiFeatureRouting>;
  /** Public model metadata for Admin UI display. Contains NO API key material. */
  modelRegistry: Record<string, AiModelMeta>;
  updatedAt: string;
  updatedBy: string;
}

const DEFAULT_AI_CONFIG: AiSystemConfig = {
  defaultProvider: 'GEMINI',
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
    PNR_PREDICTION:             { primaryProvider: 'DEEPSEEK', fallbackProvider: 'GEMINI', model: 'deepseek-chat' },
    ROUTE_ANALYSIS:             { primaryProvider: 'DEEPSEEK', fallbackProvider: 'GEMINI', model: 'deepseek-chat' },
    ROUTE_ENRICHMENT:           { primaryProvider: 'DEEPSEEK', fallbackProvider: 'GEMINI', model: 'deepseek-chat' },
    SCHEDULE_GENERATION:        { primaryProvider: 'DEEPSEEK', fallbackProvider: 'GEMINI', model: 'deepseek-chat' },
    AVAILABILITY_NORMALIZATION: { primaryProvider: 'DEEPSEEK', fallbackProvider: 'GEMINI', model: 'deepseek-chat' },
    GENERIC_PROMPT:             { primaryProvider: 'DEEPSEEK', fallbackProvider: 'GEMINI', model: 'deepseek-chat' },
    FEEDBACK_CATEGORIZATION:    { primaryProvider: 'DEEPSEEK', fallbackProvider: 'GEMINI', model: 'deepseek-chat' },
    NEWS_DISTILLATION:          { primaryProvider: 'DEEPSEEK', fallbackProvider: 'GEMINI', model: 'deepseek-chat' }
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

export class AiAdminConfigService {
  private config: AiSystemConfig = { ...DEFAULT_AI_CONFIG };
  private auditHistory: Array<{ timestamp: string; changedBy: string; snapshot: AiSystemConfig; reason?: string }> = [];

  constructor() {
    this.loadConfig();
  }

  public getConfig(): AiSystemConfig {
    return JSON.parse(JSON.stringify(this.config));
  }

  public getAuditHistory() {
    return [...this.auditHistory];
  }

  public async updateConfig(
    newConfig: Partial<AiSystemConfig>,
    updatedBy: string,
    reason?: string
  ): Promise<{ success: boolean; config: AiSystemConfig; message?: string }> {
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
      const featureCapMap: Record<AiFeatureKey, keyof AiCapabilities> = {
        PNR_PREDICTION:             'predictPnr',
        ROUTE_ANALYSIS:             'analyzeRoute',
        ROUTE_ENRICHMENT:           'enrichRoute',
        FEEDBACK_CATEGORIZATION:    'categorizeFeedback',
        SCHEDULE_GENERATION:        'generateSchedule',
        AVAILABILITY_NORMALIZATION: 'normalizeAvailability',
        NEWS_DISTILLATION:          'distillNewsArticle',
        GENERIC_PROMPT:             'genericPrompt'
      };

      for (const [feat, route] of Object.entries(newConfig.routing) as [AiFeatureKey, AiFeatureRouting][]) {
        const prov = newConfig.providers?.[route.primaryProvider] || this.config.providers[route.primaryProvider];
        if (!prov || !prov.enabled) {
          return {
            success: false,
            config: this.config,
            message: `Primary provider '${route.primaryProvider}' for ${feat} is disabled or unknown`
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
      }
    }

    // Save previous snapshot for rollback
    this.auditHistory.unshift({
      timestamp: new Date().toISOString(),
      changedBy: updatedBy,
      snapshot: JSON.parse(JSON.stringify(this.config)),
      reason: reason || 'Admin updated AI provider configuration'
    });

    if (this.auditHistory.length > 50) this.auditHistory.pop();

    this.config = {
      ...this.config,
      ...newConfig,
      updatedAt: new Date().toISOString(),
      updatedBy
    };

    this.saveConfig();

    if (isSupabaseConfigured()) {
      try {
        await supabase.from('admin_security_audit_logs').insert([{
          admin_email: updatedBy,
          action: 'UPDATE_AI_PROVIDERS',
          resource: 'ai_providers',
          details: { updatedBy, reason, snapshot: this.config },
          created_at: new Date().toISOString()
        }]);
      } catch (err: any) {
        winstonLogger.warn(`[AI_AUDIT] Failed to save DB audit log: ${err.message}`);
      }
    }

    return { success: true, config: this.getConfig() };
  }

  public async rollback(targetTimestamp: string, restoredBy: string): Promise<{ success: boolean; config: AiSystemConfig; message?: string }> {
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

    if (isSupabaseConfigured()) {
      try {
        await supabase.from('admin_security_audit_logs').insert([{
          admin_email: restoredBy,
          action: 'ROLLBACK_AI_PROVIDERS',
          resource: 'ai_providers',
          details: { restoredBy, targetTimestamp, snapshot: this.config },
          created_at: new Date().toISOString()
        }]);
      } catch (err: any) {
        winstonLogger.warn(`[AI_AUDIT] Failed to save DB rollback audit log: ${err.message}`);
      }
    }

    return { success: true, config: this.getConfig() };
  }


  private loadConfig(): void {
    if (fs.existsSync(CONFIG_FILE)) {
      try {
        const raw = fs.readFileSync(CONFIG_FILE, 'utf8');
        const parsed = JSON.parse(raw);
        this.config = {
          ...DEFAULT_AI_CONFIG,
          ...parsed,
          providers:     { ...DEFAULT_AI_CONFIG.providers,     ...(parsed.providers     || {}) },
          routing:       { ...DEFAULT_AI_CONFIG.routing,       ...(parsed.routing       || {}) },
          modelRegistry: { ...DEFAULT_AI_CONFIG.modelRegistry, ...(parsed.modelRegistry || {}) }
        };
        winstonLogger.info('[AI_ADMIN_CONFIG] Loaded configuration from file');
      } catch (err: any) {
        winstonLogger.error(`[AI_ADMIN_CONFIG] Failed to read config file: ${err.message}`);
      }
    }
  }

  private saveConfig(): void {
    try {
      safeWriteFileSync(CONFIG_FILE, JSON.stringify(this.config, null, 2), 'utf8');
      winstonLogger.info('[AI_ADMIN_CONFIG] Saved configuration to file');
    } catch (err: any) {
      winstonLogger.error(`[AI_ADMIN_CONFIG] Failed to write config file: ${err.message}`);
    }
  }
}

export const aiAdminConfigService = new AiAdminConfigService();
