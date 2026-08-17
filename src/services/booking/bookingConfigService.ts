import fs from 'fs';
import path from 'path';
import { supabase, isSupabaseConfigured, safeWriteFileSync } from '../../config/supabase';
import { winstonLogger } from '../../middleware/logger';
import { BookingCapabilities } from './bookingProvider';

const DATA_DIR = path.join(__dirname, '../../../data');
const CONFIG_FILE = path.join(DATA_DIR, 'booking_provider_config.json');

export type BookingFeatureKey = 'SEARCH_BOOKING' | 'SPLIT_BOOKING' | 'RESCUE_BOOKING';

export interface BookingProviderConfig {
  providerId: string;
  displayName: string;
  enabled: boolean;
  isOfficial: boolean;
  priority: number;
  capabilities: BookingCapabilities;
  partnerId?: string;
  affiliateId?: string;
  campaignId?: string;
  trackingParameter?: string;
  deepLinkTemplate?: string;
  lastTestedAt?: string;
  lastTestStatus?: 'SUCCESS' | 'FAILED';
}

export interface BookingFeatureRouting {
  primaryProvider: string;
  fallbackProvider: string;
}

export interface BookingSystemConfig {
  providers: Record<string, BookingProviderConfig>;
  routing: Record<BookingFeatureKey, BookingFeatureRouting>;
  updatedAt: string;
  updatedBy: string;
}

const DEFAULT_BOOKING_CONFIG: BookingSystemConfig = {
  providers: {
    IRCTC: {
      providerId: 'IRCTC',
      displayName: 'IRCTC Official Booking',
      enabled: true,
      isOfficial: true,
      priority: 1,
      capabilities: {
        directBooking: true,
        splitBooking: true,
        deepLinkGeneration: true,
        partnerAttribution: true
      },
      partnerId: '',
      campaignId: 'ai_booking',
      trackingParameter: 'utm_source=trayago'
    },
    CONFIRMTKT: {
      providerId: 'CONFIRMTKT',
      displayName: 'ConfirmTkt Fast Checkout',
      enabled: false,
      isOfficial: false,
      priority: 2,
      capabilities: {
        directBooking: true,
        splitBooking: false,
        deepLinkGeneration: true,
        partnerAttribution: true
      },
      partnerId: '',
      campaignId: '',
      trackingParameter: ''
    },
    IXIGO: {
      providerId: 'IXIGO',
      displayName: 'Ixigo Trains Affiliate',
      enabled: false,
      isOfficial: false,
      priority: 3,
      capabilities: {
        directBooking: true,
        splitBooking: false,
        deepLinkGeneration: true,
        partnerAttribution: true
      },
      partnerId: '',
      campaignId: '',
      trackingParameter: ''
    },
    MAKEMYTRIP: {
      providerId: 'MAKEMYTRIP',
      displayName: 'MakeMyTrip Rail Partner',
      enabled: false,
      isOfficial: false,
      priority: 4,
      capabilities: {
        directBooking: true,
        splitBooking: false,
        deepLinkGeneration: true,
        partnerAttribution: true
      },
      partnerId: '',
      campaignId: '',
      trackingParameter: ''
    }
  },
  routing: {
    SEARCH_BOOKING: { primaryProvider: 'IRCTC', fallbackProvider: 'IRCTC' },
    SPLIT_BOOKING: { primaryProvider: 'IRCTC', fallbackProvider: 'IRCTC' },
    RESCUE_BOOKING: { primaryProvider: 'IRCTC', fallbackProvider: 'IRCTC' }
  },
  updatedAt: new Date().toISOString(),
  updatedBy: 'SYSTEM'
};

export class BookingConfigService {
  private config: BookingSystemConfig = { ...DEFAULT_BOOKING_CONFIG };
  private auditHistory: Array<{ timestamp: string; changedBy: string; snapshot: BookingSystemConfig; reason?: string }> = [];

  constructor() {
    this.loadConfig();
  }

  public getConfig(): BookingSystemConfig {
    return JSON.parse(JSON.stringify(this.config));
  }

  public getAuditHistory() {
    return [...this.auditHistory];
  }

  public async updateConfig(
    newConfig: Partial<BookingSystemConfig>,
    updatedBy: string,
    reason?: string
  ): Promise<{ success: boolean; config: BookingSystemConfig; message?: string }> {
    // Validation
    if (newConfig.routing) {
      for (const [feat, route] of Object.entries(newConfig.routing)) {
        const primary = newConfig.providers?.[route.primaryProvider] || this.config.providers[route.primaryProvider];
        if (!primary || !primary.enabled) {
          return { success: false, config: this.config, message: `Primary provider '${route.primaryProvider}' for ${feat} is disabled or unknown` };
        }
        if (feat === 'SPLIT_BOOKING' && !primary.capabilities.splitBooking) {
          return { success: false, config: this.config, message: `Primary provider '${route.primaryProvider}' does not support split booking` };
        }
      }
    }

    // Save previous snapshot for rollback
    this.auditHistory.unshift({
      timestamp: new Date().toISOString(),
      changedBy: updatedBy,
      snapshot: JSON.parse(JSON.stringify(this.config)),
      reason: reason || 'Admin updated booking provider configuration'
    });

    if (this.auditHistory.length > 50) this.auditHistory.pop();

    this.config = {
      ...this.config,
      ...newConfig,
      updatedAt: new Date().toISOString(),
      updatedBy
    };

    this.saveConfig();

    // Log to Supabase audit logs if configured
    if (isSupabaseConfigured()) {
      try {
        await supabase.from('admin_security_audit_logs').insert([{
          admin_email: updatedBy,
          action: 'UPDATE_BOOKING_PROVIDERS',
          resource: 'booking_providers',
          details: { updatedBy, reason, snapshot: this.config },
          created_at: new Date().toISOString()
        }]);
      } catch (err: any) {
        winstonLogger.warn(`[BOOKING_AUDIT] Failed to save DB audit log: ${err.message}`);
      }
    }

    return { success: true, config: this.getConfig() };
  }

  public async rollback(targetTimestamp: string, restoredBy: string): Promise<{ success: boolean; config: BookingSystemConfig; message?: string }> {
    const entryIndex = this.auditHistory.findIndex(h => h.timestamp === targetTimestamp);
    if (entryIndex === -1) {
      return { success: false, config: this.config, message: 'Snapshot not found in history' };
    }

    const targetSnapshot = this.auditHistory[entryIndex].snapshot;

    // Save current as a new snapshot before rolling back
    this.auditHistory.unshift({
      timestamp: new Date().toISOString(),
      changedBy: restoredBy,
      snapshot: JSON.parse(JSON.stringify(this.config)),
      reason: `Rollback to configuration from ${targetTimestamp}`
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
          action: 'ROLLBACK_BOOKING_PROVIDERS',
          resource: 'booking_providers',
          details: { restoredBy, targetTimestamp, snapshot: this.config },
          created_at: new Date().toISOString()
        }]);
      } catch (err: any) {
        winstonLogger.warn(`[BOOKING_AUDIT] Failed to save DB rollback audit log: ${err.message}`);
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
          ...DEFAULT_BOOKING_CONFIG,
          ...parsed,
          providers: { ...DEFAULT_BOOKING_CONFIG.providers, ...(parsed.providers || {}) },
          routing: { ...DEFAULT_BOOKING_CONFIG.routing, ...(parsed.routing || {}) }
        };
        winstonLogger.info('[BOOKING_CONFIG] Loaded configuration from file');
      } catch (err: any) {
        winstonLogger.error(`[BOOKING_CONFIG] Failed to read config file: ${err.message}`);
      }
    }
  }

  private saveConfig(): void {
    try {
      safeWriteFileSync(CONFIG_FILE, JSON.stringify(this.config, null, 2), 'utf8');
      winstonLogger.info('[BOOKING_CONFIG] Saved configuration to file');
    } catch (err: any) {
      winstonLogger.error(`[BOOKING_CONFIG] Failed to write config file: ${err.message}`);
    }
  }
}

export const bookingConfigService = new BookingConfigService();
