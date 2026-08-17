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
  | 'AVAILABILITY_NORMALIZATION';

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

export interface AiSystemConfig {
  defaultProvider: string;
  providers: Record<string, AiAdminProviderConfig>;
  routing: Record<AiFeatureKey, AiFeatureRouting>;
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
      activeModel: 'gemini-2.5-flash',
      allowedModels: ['gemini-2.5-flash', 'gemini-1.5-flash', 'gemini-1.5-pro'],
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
    PNR_PREDICTION: { primaryProvider: 'GEMINI', fallbackProvider: 'GEMINI', model: 'gemini-2.5-flash' },
    ROUTE_ANALYSIS: { primaryProvider: 'GEMINI', fallbackProvider: 'GEMINI', model: 'gemini-2.5-flash' },
    ROUTE_ENRICHMENT: { primaryProvider: 'GEMINI', fallbackProvider: 'GEMINI', model: 'gemini-2.5-flash' },
    FEEDBACK_CATEGORIZATION: { primaryProvider: 'GEMINI', fallbackProvider: 'GEMINI', model: 'gemini-2.5-flash' },
    SCHEDULE_GENERATION: { primaryProvider: 'GEMINI', fallbackProvider: 'GEMINI', model: 'gemini-2.5-flash' },
    AVAILABILITY_NORMALIZATION: { primaryProvider: 'GEMINI', fallbackProvider: 'GEMINI', model: 'gemini-2.5-flash' }
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
        PNR_PREDICTION: 'predictPnr',
        ROUTE_ANALYSIS: 'analyzeRoute',
        ROUTE_ENRICHMENT: 'enrichRoute',
        FEEDBACK_CATEGORIZATION: 'categorizeFeedback',
        SCHEDULE_GENERATION: 'generateSchedule',
        AVAILABILITY_NORMALIZATION: 'normalizeAvailability'
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
          providers: { ...DEFAULT_AI_CONFIG.providers, ...(parsed.providers || {}) },
          routing: { ...DEFAULT_AI_CONFIG.routing, ...(parsed.routing || {}) }
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
