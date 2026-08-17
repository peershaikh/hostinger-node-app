import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { supabase, isSupabaseConfigured, safeWriteFileSync } from '../config/supabase';
import { winstonLogger } from '../middleware/logger';

const DATA_DIR = path.join(__dirname, '../../data');
const FLAGS_FILE = path.join(DATA_DIR, 'feature_flags.json');
const AUDIT_FILE = path.join(DATA_DIR, 'feature_flag_audit.json');

export type FeatureFlagKey =
  | 'TRAIN_SEARCH_MASTER'
  | 'TRAIN_SEARCH_CACHE_FALLBACK'
  | 'SPLIT_JOURNEY_MASTER'
  | 'SPLIT_JOURNEY_AI_RESCUE'
  | 'AI_PNR_PREDICTION_MASTER'
  | 'AI_ROUTE_ENRICHMENT_MASTER'
  | 'LIVE_TRACKING_MASTER'
  | 'LIVE_TRACKING_RADAR'
  | 'SMART_AVAILABILITY_CACHE'
  | 'AVAILABILITY_MULTI_PROVIDER'
  | 'SMART_RANKING_MASTER'
  | 'TRAIN_RELIABILITY_SCORES'
  | 'USER_FEEDBACK_INTELLIGENCE'
  | 'RAIL_PROVIDER_CIRCUIT_BREAKER'
  | 'BOOKING_GATEWAY_MASTER'
  | 'AI_PROVIDER_ROUTING_MASTER'
  | 'REWARDED_ADS_MASTER'
  | 'ADMIN_BULK_OPERATIONS_MASTER';

export type FeatureFlagCategory =
  | 'CORE_SEARCH'
  | 'SPLIT_ENGINE'
  | 'PNR_PREDICTIONS'
  | 'AI_SERVICES'
  | 'LIVE_TRACKING'
  | 'AVAILABILITY'
  | 'RANKING_SCORING'
  | 'RELIABILITY'
  | 'USER_FEEDBACK'
  | 'EXTERNAL_PROVIDERS'
  | 'BOOKING_GATEWAY'
  | 'AI_PROVIDERS'
  | 'MONETIZATION'
  | 'ADMINISTRATION';

export type FeatureFlagState = 'ENABLED' | 'DISABLED' | 'EMERGENCY_OFF';
export type FeatureFlagRisk = 'LOW' | 'MEDIUM' | 'HIGH';

export interface FeatureFlagDefinition {
  key: FeatureFlagKey;
  name: string;
  category: FeatureFlagCategory;
  riskLevel: FeatureFlagRisk;
  description: string;
  state: FeatureFlagState;
  killSwitchEnabled: boolean;
  updatedAt: string;
  updatedBy: string;
  reason?: string;
  killSwitchActivatedAt?: string;
  killSwitchActivatedBy?: string;
}

export interface FeatureFlagAuditEntry {
  id: string;
  key: FeatureFlagKey;
  action: 'UPDATE' | 'KILL_SWITCH' | 'ROLLBACK';
  previousState: FeatureFlagState;
  newState: FeatureFlagState;
  adminId: string;
  adminEmail: string;
  reason: string;
  timestamp: string;
  snapshot: FeatureFlagDefinition;
}

export interface FeatureImpactPreview {
  key: FeatureFlagKey;
  name: string;
  category: FeatureFlagCategory;
  riskLevel: FeatureFlagRisk;
  currentState: FeatureFlagState;
  targetState: FeatureFlagState;
  isEmergencyKill: boolean;
  warnings: string[];
  affectedSubsystems: string[];
  safeFallbackDescription: string;
  confirmationCode?: string;
}

const DEFAULT_FEATURE_FLAGS: Record<FeatureFlagKey, FeatureFlagDefinition> = {
  TRAIN_SEARCH_MASTER: {
    key: 'TRAIN_SEARCH_MASTER',
    name: 'Live Train Search Master',
    category: 'CORE_SEARCH',
    riskLevel: 'HIGH',
    description: 'Master switch for live train search routing, schedules, and station lookups.',
    state: 'ENABLED',
    killSwitchEnabled: true,
    updatedAt: '2026-08-17T00:00:00.000Z',
    updatedBy: 'SYSTEM'
  },
  TRAIN_SEARCH_CACHE_FALLBACK: {
    key: 'TRAIN_SEARCH_CACHE_FALLBACK',
    name: 'Search Cache Fallback',
    category: 'CORE_SEARCH',
    riskLevel: 'LOW',
    description: 'Offline station and schedule cache fallback when external search providers fail.',
    state: 'ENABLED',
    killSwitchEnabled: false,
    updatedAt: '2026-08-17T00:00:00.000Z',
    updatedBy: 'SYSTEM'
  },
  SPLIT_JOURNEY_MASTER: {
    key: 'SPLIT_JOURNEY_MASTER',
    name: 'Split Journey Engine Master',
    category: 'SPLIT_ENGINE',
    riskLevel: 'HIGH',
    description: 'Master toggle for Split Journey routing, point-to-point combos, and layout rendering.',
    state: 'ENABLED',
    killSwitchEnabled: true,
    updatedAt: '2026-08-17T00:00:00.000Z',
    updatedBy: 'SYSTEM'
  },
  SPLIT_JOURNEY_AI_RESCUE: {
    key: 'SPLIT_JOURNEY_AI_RESCUE',
    name: 'AI Smart Rescue Journey Hubs',
    category: 'SPLIT_ENGINE',
    riskLevel: 'HIGH',
    description: 'AI-assisted alternate hub suggestions and smart transfer station planning.',
    state: 'ENABLED',
    killSwitchEnabled: true,
    updatedAt: '2026-08-17T00:00:00.000Z',
    updatedBy: 'SYSTEM'
  },
  AI_PNR_PREDICTION_MASTER: {
    key: 'AI_PNR_PREDICTION_MASTER',
    name: 'AI PNR Confirmation Prediction',
    category: 'PNR_PREDICTIONS',
    riskLevel: 'HIGH',
    description: 'Machine learning confirmation probabilities and WL status forecasting.',
    state: 'ENABLED',
    killSwitchEnabled: true,
    updatedAt: '2026-08-17T00:00:00.000Z',
    updatedBy: 'SYSTEM'
  },
  AI_ROUTE_ENRICHMENT_MASTER: {
    key: 'AI_ROUTE_ENRICHMENT_MASTER',
    name: 'AI Route & Station Enrichment',
    category: 'AI_SERVICES',
    riskLevel: 'MEDIUM',
    description: 'GPT-powered route guidance, scenic highlights, and station intelligence.',
    state: 'ENABLED',
    killSwitchEnabled: true,
    updatedAt: '2026-08-17T00:00:00.000Z',
    updatedBy: 'SYSTEM'
  },
  LIVE_TRACKING_MASTER: {
    key: 'LIVE_TRACKING_MASTER',
    name: 'Live GPS Train Tracking Master',
    category: 'LIVE_TRACKING',
    riskLevel: 'HIGH',
    description: 'Live train GPS tracking, current station arrival forecasts, and delay detection.',
    state: 'ENABLED',
    killSwitchEnabled: true,
    updatedAt: '2026-08-17T00:00:00.000Z',
    updatedBy: 'SYSTEM'
  },
  LIVE_TRACKING_RADAR: {
    key: 'LIVE_TRACKING_RADAR',
    name: 'RailRadar Map Visualization',
    category: 'LIVE_TRACKING',
    riskLevel: 'MEDIUM',
    description: 'RailRadar interactive visual GPS map for real-time train positions.',
    state: 'ENABLED',
    killSwitchEnabled: true,
    updatedAt: '2026-08-17T00:00:00.000Z',
    updatedBy: 'SYSTEM'
  },
  SMART_AVAILABILITY_CACHE: {
    key: 'SMART_AVAILABILITY_CACHE',
    name: 'Smart Availability Cache (L1/L2)',
    category: 'AVAILABILITY',
    riskLevel: 'LOW',
    description: 'In-memory LRU and Redis L2 seat availability caching layer.',
    state: 'ENABLED',
    killSwitchEnabled: false,
    updatedAt: '2026-08-17T00:00:00.000Z',
    updatedBy: 'SYSTEM'
  },
  AVAILABILITY_MULTI_PROVIDER: {
    key: 'AVAILABILITY_MULTI_PROVIDER',
    name: 'Multi-Provider Availability Fallback',
    category: 'AVAILABILITY',
    riskLevel: 'HIGH',
    description: 'Dynamic fallback across live IRCTC and RapidAPI seat status endpoints.',
    state: 'ENABLED',
    killSwitchEnabled: true,
    updatedAt: '2026-08-17T00:00:00.000Z',
    updatedBy: 'SYSTEM'
  },
  SMART_RANKING_MASTER: {
    key: 'SMART_RANKING_MASTER',
    name: 'Smart Train Route Ranking',
    category: 'RANKING_SCORING',
    riskLevel: 'LOW',
    description: 'Multi-factor sorting algorithm balancing speed, punctuality, and comfort.',
    state: 'ENABLED',
    killSwitchEnabled: false,
    updatedAt: '2026-08-17T00:00:00.000Z',
    updatedBy: 'SYSTEM'
  },
  TRAIN_RELIABILITY_SCORES: {
    key: 'TRAIN_RELIABILITY_SCORES',
    name: 'Historical Train Reliability Scores',
    category: 'RELIABILITY',
    riskLevel: 'LOW',
    description: 'Historical on-time score metrics and platform punctuality badges.',
    state: 'ENABLED',
    killSwitchEnabled: false,
    updatedAt: '2026-08-17T00:00:00.000Z',
    updatedBy: 'SYSTEM'
  },
  USER_FEEDBACK_INTELLIGENCE: {
    key: 'USER_FEEDBACK_INTELLIGENCE',
    name: 'User Feedback Intelligence AI',
    category: 'USER_FEEDBACK',
    riskLevel: 'LOW',
    description: 'AI automated categorization, sentiment analysis, and Twitter complaint routing.',
    state: 'ENABLED',
    killSwitchEnabled: false,
    updatedAt: '2026-08-17T00:00:00.000Z',
    updatedBy: 'SYSTEM'
  },
  RAIL_PROVIDER_CIRCUIT_BREAKER: {
    key: 'RAIL_PROVIDER_CIRCUIT_BREAKER',
    name: 'Rail Provider Circuit Breakers',
    category: 'EXTERNAL_PROVIDERS',
    riskLevel: 'HIGH',
    description: 'Automated 3-strike circuit breaker protection on external rail provider APIs.',
    state: 'ENABLED',
    killSwitchEnabled: true,
    updatedAt: '2026-08-17T00:00:00.000Z',
    updatedBy: 'SYSTEM'
  },
  BOOKING_GATEWAY_MASTER: {
    key: 'BOOKING_GATEWAY_MASTER',
    name: 'Booking Gateway & Partner Routing',
    category: 'BOOKING_GATEWAY',
    riskLevel: 'HIGH',
    description: 'Affiliate partner redirection and direct IRCTC agent booking gateways.',
    state: 'ENABLED',
    killSwitchEnabled: true,
    updatedAt: '2026-08-17T00:00:00.000Z',
    updatedBy: 'SYSTEM'
  },
  AI_PROVIDER_ROUTING_MASTER: {
    key: 'AI_PROVIDER_ROUTING_MASTER',
    name: 'AI Dynamic Provider Routing',
    category: 'AI_PROVIDERS',
    riskLevel: 'HIGH',
    description: 'Multi-model LLM provider balancing between Gemini, OpenAI, and Anthropic.',
    state: 'ENABLED',
    killSwitchEnabled: true,
    updatedAt: '2026-08-17T00:00:00.000Z',
    updatedBy: 'SYSTEM'
  },
  REWARDED_ADS_MASTER: {
    key: 'REWARDED_ADS_MASTER',
    name: 'Rewarded Video Ads & Bonus Credits',
    category: 'MONETIZATION',
    riskLevel: 'MEDIUM',
    description: 'Ad viewing quota bonuses allowing users to unlock premium features.',
    state: 'ENABLED',
    killSwitchEnabled: true,
    updatedAt: '2026-08-17T00:00:00.000Z',
    updatedBy: 'SYSTEM'
  },
  ADMIN_BULK_OPERATIONS_MASTER: {
    key: 'ADMIN_BULK_OPERATIONS_MASTER',
    name: 'Admin Safe Bulk Operations Engine',
    category: 'ADMINISTRATION',
    riskLevel: 'MEDIUM',
    description: 'Bulk user plan modifications, credit adjustments, and coupon generators.',
    state: 'ENABLED',
    killSwitchEnabled: true,
    updatedAt: '2026-08-17T00:00:00.000Z',
    updatedBy: 'SYSTEM'
  }
};

export class FeatureFlagService {
  private flags: Record<FeatureFlagKey, FeatureFlagDefinition> = { ...DEFAULT_FEATURE_FLAGS };
  private auditHistory: FeatureFlagAuditEntry[] = [];
  private isInitialized = false;

  constructor() {
    this.init();
  }

  private async init() {
    this.loadLocalData();
    await this.syncWithCanonicalDb();
    this.isInitialized = true;
  }

  // ── O(1) Fast Runtime Checkers ─────────────────────────────────────────────

  /**
   * Fast, non-blocking check whether a feature is currently enabled.
   * Returns true ONLY if state === 'ENABLED'.
   */
  public isFeatureEnabled(key: FeatureFlagKey): boolean {
    const flag = this.flags[key];
    if (!flag) return false;
    return flag.state === 'ENABLED';
  }

  /**
   * Returns full state ('ENABLED', 'DISABLED', 'EMERGENCY_OFF')
   */
  public getFeatureState(key: FeatureFlagKey): FeatureFlagState {
    const flag = this.flags[key];
    if (!flag) return 'DISABLED';
    return flag.state;
  }

  /**
   * Returns structured safe fallback response if feature is disabled/killed.
   */
  public getSafeFallback(key: FeatureFlagKey): { enabled: boolean; state: FeatureFlagState; message: string; safeCode: string } {
    const flag = this.flags[key];
    if (!flag || flag.state !== 'ENABLED') {
      const state = flag?.state || 'DISABLED';
      return {
        enabled: false,
        state,
        message: state === 'EMERGENCY_OFF'
          ? 'This service is temporarily suspended for maintenance. Please check back shortly.'
          : 'This feature is currently offline. Standard service continues uninterrupted.',
        safeCode: `FEATURE_${key}_${state}`
      };
    }
    return {
      enabled: true,
      state: 'ENABLED',
      message: 'Feature operational',
      safeCode: `FEATURE_${key}_OPERATIONAL`
    };
  }

  /**
   * Get all registered flags.
   */
  public getAllFlags(): FeatureFlagDefinition[] {
    return Object.values(this.flags);
  }

  /**
   * Get a single flag definition.
   */
  public getFlag(key: FeatureFlagKey): FeatureFlagDefinition | undefined {
    return this.flags[key] ? { ...this.flags[key] } : undefined;
  }

  /**
   * Get audit history.
   */
  public getAuditHistory(): FeatureFlagAuditEntry[] {
    return [...this.auditHistory];
  }

  // ── Preview Generation ──────────────────────────────────────────────────────

  public generatePreview(
    key: FeatureFlagKey,
    targetState: FeatureFlagState,
    isKillSwitch = false
  ): FeatureImpactPreview {
    const flag = this.flags[key];
    if (!flag) {
      throw new Error(`Unknown feature flag: ${key}`);
    }

    const warnings: string[] = [];
    const affectedSubsystems: string[] = [];
    let safeFallbackDescription = '';

    if (key === 'TRAIN_SEARCH_MASTER') {
      affectedSubsystems.push('Search Page', 'API /api/trains/search', 'PNR Route Auto-detect');
      safeFallbackDescription = 'Returns cached routes or structured maintenance response without crashing UI.';
      if (targetState !== 'ENABLED') {
        warnings.push('CRITICAL: Users will not receive live train search results.');
      }
    } else if (key === 'SPLIT_JOURNEY_MASTER') {
      affectedSubsystems.push('Split Journey Results', 'API /api/trains/split');
      safeFallbackDescription = 'UI gracefully hides Split Route recommendations and falls back to direct trains.';
      if (targetState !== 'ENABLED') {
        warnings.push('Split ticket calculations will be bypassed.');
      }
    } else if (key === 'SPLIT_JOURNEY_AI_RESCUE') {
      affectedSubsystems.push('AI Smart Rescue Hubs', 'Alternative Route Finder');
      safeFallbackDescription = 'Falls back to standard deterministic midpoint stations.';
      if (targetState !== 'ENABLED') {
        warnings.push('LLM-based multi-hop station rescue will be paused.');
      }
    } else if (key === 'AI_PNR_PREDICTION_MASTER') {
      affectedSubsystems.push('PNR Confirmation Meter', 'WL Prediction Widget');
      safeFallbackDescription = 'Displays official Indian Railways WL status without custom ML probability bar.';
      if (targetState !== 'ENABLED') {
        warnings.push('AI confirmation probability score will be hidden.');
      }
    } else if (key === 'LIVE_TRACKING_MASTER') {
      affectedSubsystems.push('Live Status Page', 'GPS Location Feed', 'Delay Timelines');
      safeFallbackDescription = 'Shows scheduled timetable with notice to check station announcements.';
      if (targetState !== 'ENABLED') {
        warnings.push('Live GPS location tracking will be unavailable.');
      }
    } else if (key === 'AI_PROVIDER_ROUTING_MASTER') {
      affectedSubsystems.push('Gemini API', 'OpenAI API', 'Claude API', 'AI Prompts');
      safeFallbackDescription = 'Returns rule-based deterministic responses for summaries and queries.';
      if (targetState !== 'ENABLED') {
        warnings.push('All LLM calls will return safe static fallback templates.');
      }
    } else if (key === 'REWARDED_ADS_MASTER') {
      affectedSubsystems.push('Watch Ad Modal', 'Credit Rewards', 'Monetization Engine');
      safeFallbackDescription = 'Disables ad watch trigger; users can use standard free daily quotas.';
      if (targetState !== 'ENABLED') {
        warnings.push('Ad viewing bonus credits will be suspended.');
      }
    } else {
      affectedSubsystems.push(flag.category);
      safeFallbackDescription = 'Subsystem executes fallback handlers without throwing unhandled errors.';
      if (targetState !== 'ENABLED') {
        warnings.push(`Feature ${flag.name} will be deactivated.`);
      }
    }

    if (isKillSwitch || targetState === 'EMERGENCY_OFF') {
      warnings.unshift('EMERGENCY KILL SWITCH: This immediately cuts traffic to this subsystem.');
    }

    const confirmationCode = `KILL-SWITCH-${key}`;

    return {
      key,
      name: flag.name,
      category: flag.category,
      riskLevel: flag.riskLevel,
      currentState: flag.state,
      targetState,
      isEmergencyKill: isKillSwitch || targetState === 'EMERGENCY_OFF',
      warnings,
      affectedSubsystems,
      safeFallbackDescription,
      confirmationCode: (isKillSwitch || targetState === 'EMERGENCY_OFF') ? confirmationCode : undefined
    };
  }

  // ── Standard State Update ───────────────────────────────────────────────────

  public async updateFlagState(
    key: FeatureFlagKey,
    newState: FeatureFlagState,
    adminId: string,
    adminEmail: string,
    reason?: string
  ): Promise<{ success: boolean; flag: FeatureFlagDefinition; message: string }> {
    const flag = this.flags[key];
    if (!flag) {
      throw new Error(`Unknown feature flag: ${key}`);
    }

    if ((newState === 'DISABLED' || newState === 'EMERGENCY_OFF') && (!reason || !reason.trim())) {
      throw new Error('A descriptive reason is mandatory when disabling or emergency-killing a feature.');
    }

    const previousState = flag.state;
    const now = new Date().toISOString();

    // Snapshot current state for rollback
    const auditEntry: FeatureFlagAuditEntry = {
      id: `audit_${Date.now()}_${crypto.randomBytes(4).toString('hex')}`,
      key,
      action: 'UPDATE',
      previousState,
      newState,
      adminId,
      adminEmail,
      reason: reason?.trim() || 'Admin updated feature state',
      timestamp: now,
      snapshot: { ...flag }
    };

    // Update in-memory canonical state
    flag.state = newState;
    flag.updatedAt = now;
    flag.updatedBy = adminEmail;
    flag.reason = reason?.trim() || flag.reason;

    if (newState === 'EMERGENCY_OFF') {
      flag.killSwitchActivatedAt = now;
      flag.killSwitchActivatedBy = adminEmail;
    } else {
      flag.killSwitchActivatedAt = undefined;
      flag.killSwitchActivatedBy = undefined;
    }

    this.auditHistory.unshift(auditEntry);
    if (this.auditHistory.length > 200) this.auditHistory.pop();

    // Persist
    await this.persistFlagsAndAudit(auditEntry);

    winstonLogger.info(
      `[FEATURE_FLAG] Admin ${adminEmail} updated ${key} from ${previousState} to ${newState}. Reason: ${reason || 'N/A'}`
    );

    return {
      success: true,
      flag: { ...flag },
      message: `Feature '${flag.name}' updated to ${newState}.`
    };
  }

  // ── Emergency Kill Switch ───────────────────────────────────────────────────

  public async triggerKillSwitch(
    key: FeatureFlagKey,
    confirmationCode: string,
    adminId: string,
    adminEmail: string,
    reason: string
  ): Promise<{ success: boolean; flag: FeatureFlagDefinition; message: string }> {
    const flag = this.flags[key];
    if (!flag) {
      throw new Error(`Unknown feature flag: ${key}`);
    }

    if (!flag.killSwitchEnabled) {
      throw new Error(`Emergency Kill Switch is not configured for feature '${key}'. Use standard toggle.`);
    }

    const expectedCode = `KILL-SWITCH-${key}`;
    if (!confirmationCode || confirmationCode.trim() !== expectedCode) {
      throw new Error(`Invalid confirmation code. Expected '${expectedCode}', received '${confirmationCode}'.`);
    }

    if (!reason || !reason.trim() || reason.trim().length < 5) {
      throw new Error('A detailed operational reason (min 5 characters) is required to engage the emergency kill switch.');
    }

    const previousState = flag.state;
    const now = new Date().toISOString();

    const auditEntry: FeatureFlagAuditEntry = {
      id: `audit_${Date.now()}_${crypto.randomBytes(4).toString('hex')}`,
      key,
      action: 'KILL_SWITCH',
      previousState,
      newState: 'EMERGENCY_OFF',
      adminId,
      adminEmail,
      reason: reason.trim(),
      timestamp: now,
      snapshot: { ...flag }
    };

    flag.state = 'EMERGENCY_OFF';
    flag.updatedAt = now;
    flag.updatedBy = adminEmail;
    flag.reason = reason.trim();
    flag.killSwitchActivatedAt = now;
    flag.killSwitchActivatedBy = adminEmail;

    this.auditHistory.unshift(auditEntry);
    if (this.auditHistory.length > 200) this.auditHistory.pop();

    await this.persistFlagsAndAudit(auditEntry);

    winstonLogger.warn(
      `[FEATURE_FLAG_KILL_SWITCH] EMERGENCY KILL SWITCH TRIGGERED for ${key} by ${adminEmail}. Reason: ${reason}`
    );

    return {
      success: true,
      flag: { ...flag },
      message: `EMERGENCY KILL SWITCH ENGAGED: Feature '${flag.name}' is now completely offline.`
    };
  }

  // ── Rollback ────────────────────────────────────────────────────────────────

  public async rollbackFlag(
    key: FeatureFlagKey,
    adminId: string,
    adminEmail: string,
    confirmation: boolean
  ): Promise<{ success: boolean; flag: FeatureFlagDefinition; message: string }> {
    if (!confirmation) {
      throw new Error('Rollback requires explicit confirmation.');
    }

    const flag = this.flags[key];
    if (!flag) {
      throw new Error(`Unknown feature flag: ${key}`);
    }

    // Find the latest audit entry for this key
    const lastAudit = this.auditHistory.find(a => a.key === key);
    if (!lastAudit) {
      throw new Error(`No previous snapshot available for feature flag '${key}'.`);
    }

    const previousSnapshot = lastAudit.snapshot;
    const currentState = flag.state;
    const now = new Date().toISOString();

    const rollbackAudit: FeatureFlagAuditEntry = {
      id: `audit_${Date.now()}_${crypto.randomBytes(4).toString('hex')}`,
      key,
      action: 'ROLLBACK',
      previousState: currentState,
      newState: previousSnapshot.state,
      adminId,
      adminEmail,
      reason: `Rollback to state from ${previousSnapshot.updatedAt} (previously ${previousSnapshot.state})`,
      timestamp: now,
      snapshot: { ...flag }
    };

    // Restore previous state
    this.flags[key] = {
      ...previousSnapshot,
      updatedAt: now,
      updatedBy: adminEmail,
      reason: `Rolled back by ${adminEmail} to previous state (${previousSnapshot.state})`
    };

    this.auditHistory.unshift(rollbackAudit);
    if (this.auditHistory.length > 200) this.auditHistory.pop();

    await this.persistFlagsAndAudit(rollbackAudit);

    winstonLogger.info(
      `[FEATURE_FLAG_ROLLBACK] Rolled back ${key} from ${currentState} to ${previousSnapshot.state} by ${adminEmail}`
    );

    return {
      success: true,
      flag: { ...this.flags[key] },
      message: `Feature '${flag.name}' successfully restored to ${previousSnapshot.state}.`
    };
  }

  // ── Persistence & Conflict Resolution ───────────────────────────────────────

  /**
   * Deterministic Source of Truth Resolution:
   * 1. Default code configuration (baseline).
   * 2. Local JSON file (fallback).
   * 3. Supabase DB (canonical persistent source).
   * If DB has newer or equal updatedAt, DB wins.
   * If local has newer updatedAt, local state synchronizes to DB.
   */
  private loadLocalData(): void {
    if (!fs.existsSync(DATA_DIR)) {
      try {
        fs.mkdirSync(DATA_DIR, { recursive: true });
      } catch (err: any) {
        winstonLogger.warn(`[FEATURE_FLAG] Failed to create data dir: ${err.message}`);
      }
    }

    // Load audit history
    if (fs.existsSync(AUDIT_FILE)) {
      try {
        const auditRaw = fs.readFileSync(AUDIT_FILE, 'utf8');
        this.auditHistory = JSON.parse(auditRaw);
      } catch (err: any) {
        winstonLogger.warn(`[FEATURE_FLAG] Failed to parse audit file: ${err.message}`);
      }
    }

    // Load flags from local JSON fallback
    if (fs.existsSync(FLAGS_FILE)) {
      try {
        const raw = fs.readFileSync(FLAGS_FILE, 'utf8');
        const parsed: Record<string, FeatureFlagDefinition> = JSON.parse(raw);
        for (const [k, item] of Object.entries(parsed)) {
          const key = k as FeatureFlagKey;
          if (this.flags[key]) {
            this.flags[key] = {
              ...this.flags[key],
              ...item
            };
          }
        }
        winstonLogger.info('[FEATURE_FLAG] Loaded flags from local JSON cache');
      } catch (err: any) {
        winstonLogger.error(`[FEATURE_FLAG] Failed to read local flags: ${err.message}`);
      }
    }
  }

  private async syncWithCanonicalDb(): Promise<void> {
    if (!isSupabaseConfigured()) {
      return;
    }

    try {
      // 1. Fetch DB records
      const { data, error } = await supabase
        .from('feature_flags')
        .select('*');

      if (error) {
        // Table might not exist yet in older migrations — log and rely on local + audit logs
        winstonLogger.info(`[FEATURE_FLAG] DB feature_flags table query info: ${error.message}`);
        return;
      }

      if (data && Array.isArray(data)) {
        for (const record of data) {
          const key = record.key as FeatureFlagKey;
          if (this.flags[key]) {
            const dbUpdatedAt = record.updated_at ? new Date(record.updated_at).getTime() : 0;
            const localUpdatedAt = this.flags[key].updatedAt ? new Date(this.flags[key].updatedAt).getTime() : 0;

            if (dbUpdatedAt >= localUpdatedAt) {
              // Canonical DB wins
              this.flags[key].state = record.state as FeatureFlagState;
              this.flags[key].updatedAt = record.updated_at || this.flags[key].updatedAt;
              this.flags[key].updatedBy = record.updated_by || this.flags[key].updatedBy;
              this.flags[key].reason = record.reason || this.flags[key].reason;
              this.flags[key].killSwitchActivatedAt = record.kill_switch_activated_at || undefined;
              this.flags[key].killSwitchActivatedBy = record.kill_switch_activated_by || undefined;
            } else {
              // Local fallback was newer (e.g. offline mutation), sync local back to DB
              await this.upsertDbFlag(this.flags[key]);
            }
          }
        }
        // Save merged state back to local cache
        this.saveLocalData();
      }
    } catch (err: any) {
      winstonLogger.warn(`[FEATURE_FLAG] DB sync skipped: ${err.message}`);
    }
  }

  private async persistFlagsAndAudit(auditEntry: FeatureFlagAuditEntry): Promise<void> {
    this.saveLocalData();

    if (isSupabaseConfigured()) {
      try {
        const flag = this.flags[auditEntry.key];
        await this.upsertDbFlag(flag);

        await supabase.from('admin_security_audit_logs').insert([{
          admin_id: auditEntry.adminId,
          admin_email: auditEntry.adminEmail,
          action: `FEATURE_FLAG_${auditEntry.action}`,
          resource: `feature_flags/${auditEntry.key}`,
          details: {
            key: auditEntry.key,
            previousState: auditEntry.previousState,
            newState: auditEntry.newState,
            reason: auditEntry.reason,
            timestamp: auditEntry.timestamp
          },
          created_at: auditEntry.timestamp
        }]);
      } catch (err: any) {
        winstonLogger.warn(`[FEATURE_FLAG] Failed to persist to Supabase: ${err.message}`);
      }
    }
  }

  private async upsertDbFlag(flag: FeatureFlagDefinition): Promise<void> {
    if (!isSupabaseConfigured()) return;
    try {
      await supabase.from('feature_flags').upsert({
        key: flag.key,
        name: flag.name,
        category: flag.category,
        risk_level: flag.riskLevel,
        description: flag.description,
        state: flag.state,
        kill_switch_enabled: flag.killSwitchEnabled,
        updated_at: flag.updatedAt,
        updated_by: flag.updatedBy,
        reason: flag.reason || null,
        kill_switch_activated_at: flag.killSwitchActivatedAt || null,
        kill_switch_activated_by: flag.killSwitchActivatedBy || null
      }, { onConflict: 'key' });
    } catch (err: any) {
      // Non-fatal if table not created
      winstonLogger.debug(`[FEATURE_FLAG] DB upsert notification: ${err.message}`);
    }
  }

  private saveLocalData(): void {
    try {
      safeWriteFileSync(FLAGS_FILE, JSON.stringify(this.flags, null, 2), 'utf8');
      safeWriteFileSync(AUDIT_FILE, JSON.stringify(this.auditHistory.slice(0, 100), null, 2), 'utf8');
    } catch (err: any) {
      winstonLogger.error(`[FEATURE_FLAG] Failed to save local flags: ${err.message}`);
    }
  }
}

export const featureFlagService = new FeatureFlagService();
