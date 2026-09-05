/**
 * PHASE_RAIL_PROVIDER_REGISTRY_044 — Capability-Aware Rail Provider Registry
 *
 * Defines the standard RailProvider contract, explicit capability matrix,
 * provider adapters wrapping existing services, and a centralized registry.
 *
 * Note: Runtime routing remains untouched in this phase (Phase 044 is abstraction only).
 */

import { winstonLogger } from '../middleware/logger';
import { irctcService } from './irctcService';
import { railRadarService } from './railRadarService';
import { confirmtktService } from './confirmtktService';
import { railyatriService } from './railyatriService';
import { rapidApiService } from './rapidApiService';
import { dbService } from './dbService';
import { providerConfigService } from './providerConfigService';

export interface ProviderCapabilities {
  search: boolean;
  availability: boolean;
  liveTracking: boolean;
  pnr: boolean;
  schedule: boolean;
}

export interface SearchParams {
  from: string;
  to: string;
  date: string;
}

export interface AvailabilityParams {
  trainNo: string;
  from: string;
  to: string;
  date: string;
  classType?: string;
  quota?: string;
}

export interface LiveStatusParams {
  trainNo: string;
  date?: string;
}

export interface PNRParams {
  pnr: string;
}

export interface ScheduleParams {
  trainNo: string;
}

export type HealthStatus = 'HEALTHY' | 'DEGRADED' | 'NOT_CONFIGURED' | 'UNAVAILABLE' | 'UNSUPPORTED_PROBE' | 'UNKNOWN';

export interface HealthCheckResult {
  status: HealthStatus;
  latencyMs?: number;
  message?: string;
  timestamp: string;
}

function mapGuardToHealthStatus(guard: { enabled: boolean; reason: string }, latencyMs: number): HealthCheckResult {
  let status: HealthStatus = 'UNAVAILABLE';
  if (guard.enabled) {
    status = 'HEALTHY';
  } else if (guard.reason === 'PROVIDER_NOT_CONFIGURED' || guard.reason === 'MISSING_CREDENTIALS') {
    status = 'NOT_CONFIGURED';
  } else if (guard.reason === 'CIRCUIT_BREAKER_BLOCKED' || guard.reason === 'RATE_LIMITED') {
    status = 'DEGRADED';
  } else {
    status = 'UNAVAILABLE';
  }

  return {
    status,
    latencyMs,
    message: guard.reason,
    timestamp: new Date().toISOString()
  };
}

export class UnsupportedCapabilityError extends Error {
  public readonly providerId: string;
  public readonly capability: keyof ProviderCapabilities;

  constructor(providerId: string, capability: keyof ProviderCapabilities) {
    super(`UNSUPPORTED_CAPABILITY: Provider '${providerId}' does not support '${capability}'`);
    this.name = 'UnsupportedCapabilityError';
    this.providerId = providerId;
    this.capability = capability;
  }
}

export interface RailProvider {
  readonly providerId: string;
  readonly displayName: string;
  readonly capabilities: Readonly<ProviderCapabilities>;

  searchTrains(params: SearchParams): Promise<any[]>;
  checkAvailability(params: AvailabilityParams): Promise<any>;
  getLiveStatus(params: LiveStatusParams): Promise<any>;
  getPNRStatus(params: PNRParams): Promise<any>;
  getTrainSchedule(params: ScheduleParams): Promise<any>;
  healthCheck?(): Promise<HealthCheckResult>;
}

// ─── 1. IRCTC ADAPTER ──────────────────────────────────────────────────────────
export class IRCTCAdapter implements RailProvider {
  public readonly providerId = 'IRCTC';
  public readonly displayName = 'IRCTC Official / Connect API';
  public readonly capabilities: Readonly<ProviderCapabilities> = {
    search: true,
    availability: true,
    liveTracking: true,
    pnr: true,
    schedule: true
  };

  async searchTrains(params: SearchParams): Promise<any[]> {
    return irctcService.search(params.from, params.to, params.date);
  }

  async checkAvailability(params: AvailabilityParams): Promise<any> {
    return irctcService.getAvailability(
      params.trainNo,
      params.date,
      params.from,
      params.to,
      params.classType || '3A',
      params.quota || 'GN'
    );
  }

  async getLiveStatus(params: LiveStatusParams): Promise<any> {
    return irctcService.getLiveStatus(params.trainNo, params.date);
  }

  async getPNRStatus(params: PNRParams): Promise<any> {
    return irctcService.checkPNRStatus(params.pnr);
  }

  async getTrainSchedule(params: ScheduleParams): Promise<any> {
    return irctcService.getTrainInfo(params.trainNo);
  }

  async healthCheck(): Promise<HealthCheckResult> {
    const start = Date.now();
    try {
      const guard = await providerConfigService.isProviderEnabled('IRCTC');
      return mapGuardToHealthStatus(guard, Date.now() - start);
    } catch (e: any) {
      return {
        status: 'UNAVAILABLE',
        latencyMs: Date.now() - start,
        message: e.message,
        timestamp: new Date().toISOString()
      };
    }
  }
}

// ─── 2. RAILRADAR ADAPTER ──────────────────────────────────────────────────────
export class RailRadarAdapter implements RailProvider {
  public readonly providerId = 'RAILRADAR';
  public readonly displayName = 'RailRadar Real-Time Tracking';
  public readonly capabilities: Readonly<ProviderCapabilities> = {
    search: false,
    availability: false,
    liveTracking: true,
    pnr: true,
    schedule: false
  };

  async searchTrains(params: SearchParams): Promise<any[]> {
    throw new UnsupportedCapabilityError(this.providerId, 'search');
  }

  async checkAvailability(params: AvailabilityParams): Promise<any> {
    throw new UnsupportedCapabilityError(this.providerId, 'availability');
  }

  async getLiveStatus(params: LiveStatusParams): Promise<any> {
    return railRadarService.getTrainStatus(params.trainNo);
  }

  async getPNRStatus(params: PNRParams): Promise<any> {
    return railRadarService.getPNRStatus(params.pnr);
  }

  async getTrainSchedule(params: ScheduleParams): Promise<any> {
    throw new UnsupportedCapabilityError(this.providerId, 'schedule');
  }

  async healthCheck(): Promise<HealthCheckResult> {
    const start = Date.now();
    try {
      const guard = await providerConfigService.isProviderEnabled('RAILRADAR');
      const serviceHealth = railRadarService.getHealthStatus();
      if (serviceHealth.status === 'UNHEALTHY') {
        return {
          status: 'UNAVAILABLE',
          latencyMs: Date.now() - start,
          message: serviceHealth.message || 'AUTH_FAILURE_401',
          timestamp: new Date().toISOString()
        };
      }
      return mapGuardToHealthStatus(guard, Date.now() - start);
    } catch (e: any) {
      return {
        status: 'UNAVAILABLE',
        latencyMs: Date.now() - start,
        message: e.message,
        timestamp: new Date().toISOString()
      };
    }
  }
}

// ─── 3. CONFIRMTKT ADAPTER ─────────────────────────────────────────────────────
export class ConfirmTktAdapter implements RailProvider {
  public readonly providerId = 'CONFIRMTKT';
  public readonly displayName = 'ConfirmTkt Live Running Status';
  public readonly capabilities: Readonly<ProviderCapabilities> = {
    search: false,
    availability: false,
    liveTracking: true,
    pnr: false,
    schedule: false
  };

  async searchTrains(params: SearchParams): Promise<any[]> {
    throw new UnsupportedCapabilityError(this.providerId, 'search');
  }

  async checkAvailability(params: AvailabilityParams): Promise<any> {
    throw new UnsupportedCapabilityError(this.providerId, 'availability');
  }

  async getLiveStatus(params: LiveStatusParams): Promise<any> {
    return confirmtktService.getTrainStatus(params.trainNo, params.date);
  }

  async getPNRStatus(params: PNRParams): Promise<any> {
    throw new UnsupportedCapabilityError(this.providerId, 'pnr');
  }

  async getTrainSchedule(params: ScheduleParams): Promise<any> {
    throw new UnsupportedCapabilityError(this.providerId, 'schedule');
  }

  async healthCheck(): Promise<HealthCheckResult> {
    const start = Date.now();
    try {
      const guard = await providerConfigService.isProviderEnabled('CONFIRMTKT');
      return mapGuardToHealthStatus(guard, Date.now() - start);
    } catch (e: any) {
      return {
        status: 'UNAVAILABLE',
        latencyMs: Date.now() - start,
        message: e.message,
        timestamp: new Date().toISOString()
      };
    }
  }
}

// ─── 4. RAILYATRI ADAPTER ──────────────────────────────────────────────────────
export class RailYatriAdapter implements RailProvider {
  public readonly providerId = 'RAILYATRI';
  public readonly displayName = 'RailYatri Live Running Status';
  public readonly capabilities: Readonly<ProviderCapabilities> = {
    search: false,
    availability: false,
    liveTracking: true,
    pnr: false,
    schedule: false
  };

  async searchTrains(params: SearchParams): Promise<any[]> {
    throw new UnsupportedCapabilityError(this.providerId, 'search');
  }

  async checkAvailability(params: AvailabilityParams): Promise<any> {
    throw new UnsupportedCapabilityError(this.providerId, 'availability');
  }

  async getLiveStatus(params: LiveStatusParams): Promise<any> {
    return railyatriService.getTrainStatus(params.trainNo, params.date);
  }

  async getPNRStatus(params: PNRParams): Promise<any> {
    throw new UnsupportedCapabilityError(this.providerId, 'pnr');
  }

  async getTrainSchedule(params: ScheduleParams): Promise<any> {
    throw new UnsupportedCapabilityError(this.providerId, 'schedule');
  }

  async healthCheck(): Promise<HealthCheckResult> {
    const start = Date.now();
    try {
      const guard = await providerConfigService.isProviderEnabled('RAILYATRI');
      return mapGuardToHealthStatus(guard, Date.now() - start);
    } catch (e: any) {
      return {
        status: 'UNAVAILABLE',
        latencyMs: Date.now() - start,
        message: e.message,
        timestamp: new Date().toISOString()
      };
    }
  }
}

// ─── 5. RAPIDAPI ADAPTER (Disabled) ────────────────────────────────────────────
export class RapidApiAdapter implements RailProvider {
  public readonly providerId = 'RAPIDAPI';
  public readonly displayName = 'RapidAPI Legacy Gateway';
  public readonly capabilities: Readonly<ProviderCapabilities> = {
    search: false,
    availability: false,
    liveTracking: false,
    pnr: false,
    schedule: false
  };

  async searchTrains(params: SearchParams): Promise<any[]> {
    throw new UnsupportedCapabilityError(this.providerId, 'search');
  }

  async checkAvailability(params: AvailabilityParams): Promise<any> {
    throw new UnsupportedCapabilityError(this.providerId, 'availability');
  }

  async getLiveStatus(params: LiveStatusParams): Promise<any> {
    throw new UnsupportedCapabilityError(this.providerId, 'liveTracking');
  }

  async getPNRStatus(params: PNRParams): Promise<any> {
    throw new UnsupportedCapabilityError(this.providerId, 'pnr');
  }

  async getTrainSchedule(params: ScheduleParams): Promise<any> {
    throw new UnsupportedCapabilityError(this.providerId, 'schedule');
  }

  async healthCheck(): Promise<HealthCheckResult> {
    return {
      status: 'NOT_CONFIGURED',
      latencyMs: 0,
      message: 'RAPIDAPI_EXPLICITLY_DISABLED',
      timestamp: new Date().toISOString()
    };
  }
}

// ─── 6. DATABASE SCHEDULE ADAPTER ──────────────────────────────────────────────
export class DatabaseScheduleAdapter implements RailProvider {
  public readonly providerId = 'DATABASE';
  public readonly displayName = 'Internal Timetable & Cache Database';
  public readonly capabilities: Readonly<ProviderCapabilities> = {
    search: true,
    availability: false,
    liveTracking: false,
    pnr: false,
    schedule: true
  };

  async searchTrains(params: SearchParams): Promise<any[]> {
    return dbService.searchTrains(params.from, params.to, params.date);
  }

  async checkAvailability(params: AvailabilityParams): Promise<any> {
    throw new UnsupportedCapabilityError(this.providerId, 'availability');
  }

  async getLiveStatus(params: LiveStatusParams): Promise<any> {
    throw new UnsupportedCapabilityError(this.providerId, 'liveTracking');
  }

  async getPNRStatus(params: PNRParams): Promise<any> {
    throw new UnsupportedCapabilityError(this.providerId, 'pnr');
  }

  async getTrainSchedule(params: ScheduleParams): Promise<any> {
    try {
      const { supabase } = require('../config/supabase');
      const { data, error } = await supabase
        .from('train_schedule')
        .select('*')
        .eq('train_number', params.trainNo)
        .order('sn', { ascending: true });
      if (!error && data && data.length > 0) {
        return { train_number: params.trainNo, stations: data };
      }
      return null;
    } catch {
      return null;
    }
  }

  async healthCheck(): Promise<HealthCheckResult> {
    return {
      status: 'HEALTHY',
      message: 'LOCAL_DB_ONLINE',
      timestamp: new Date().toISOString()
    };
  }
}

// ─── CENTRAL REGISTRY ─────────────────────────────────────────────────────────
export class RailProviderRegistry {
  private providers: Map<string, RailProvider> = new Map();

  constructor() {
    this.register(new IRCTCAdapter());
    this.register(new RailRadarAdapter());
    this.register(new ConfirmTktAdapter());
    this.register(new RailYatriAdapter());
    this.register(new RapidApiAdapter());
    this.register(new DatabaseScheduleAdapter());
  }

  public register(provider: RailProvider): void {
    const key = provider.providerId.toUpperCase().trim();
    this.providers.set(key, provider);
    winstonLogger.debug(`[RAIL_REGISTRY] Registered provider: ${key}`);
  }

  public getProvider(providerId: string): RailProvider | undefined {
    if (!providerId) return undefined;
    const key = providerId.toUpperCase().trim();
    if (this.providers.has(key)) return this.providers.get(key);
    for (const [pKey, provider] of this.providers.entries()) {
      if (key.includes(pKey) || pKey.includes(key)) {
        return provider;
      }
    }
    return undefined;
  }

  public getAllProviders(): RailProvider[] {
    return Array.from(this.providers.values());
  }

  public getProvidersByCapability(capability: keyof ProviderCapabilities): RailProvider[] {
    return Array.from(this.providers.values()).filter(p => p.capabilities[capability] === true);
  }

  public hasCapability(providerId: string, capability: keyof ProviderCapabilities): boolean {
    const provider = this.getProvider(providerId);
    if (!provider) return false;
    return provider.capabilities[capability] === true;
  }
}

export const railProviderRegistry = new RailProviderRegistry();
