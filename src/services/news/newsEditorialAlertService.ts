/**
 * newsEditorialAlertService.ts
 *
 * Safe Admin Source-Change Alerts & Editorial Monitoring Engine (Phase 083)
 *
 * Consolidates operational intelligence from:
 * - newsSourceChangeService (Source & Entity Change Deltas)
 * - newsSourceVerificationService (Source Integrity & Fact Evidence)
 * - newsContentGrowthService (Demand, Freshness & Coverage)
 *
 * Strictly Read-Only Observability & Decision Guidance for Human Editors:
 * - Deterministic alert types & severity hierarchy (CRITICAL, HIGH, MEDIUM, LOW, INFO)
 * - Deterministic SHA-256 deduplication to prevent repetitive alert spam
 * - Lifecycle state machine (OPEN -> ACKNOWLEDGED -> RESOLVED / DISMISSED)
 * - Zero auto-edit, zero auto-publish, zero public push/SMS notifications
 */

import crypto from 'crypto';
import { winstonLogger } from '../../middleware/logger';
import { newsSourceChangeService, SourceChangeRecord } from './newsSourceChangeService';
import { newsAdminService } from './newsAdminService';

// ─── TYPES & INTERFACES ────────────────────────────────────────────────────────

export type AlertSeverity = 'CRITICAL' | 'HIGH' | 'MEDIUM' | 'LOW' | 'INFO';

export type AlertType =
  | 'SOURCE_CHANGE_CRITICAL'
  | 'SOURCE_CHANGE_MATERIAL'
  | 'SOURCE_UNAVAILABLE'
  | 'ARTICLE_STALE'
  | 'DUPLICATE_STORY'
  | 'UPDATE_RECOMMENDED'
  | 'VERIFICATION_REQUIRED';

export type AlertStatus = 'OPEN' | 'ACKNOWLEDGED' | 'RESOLVED' | 'DISMISSED';

export type AlertFreshness = 'NEW' | 'RECENT' | 'AGING';

export interface EditorialAlert {
  alertId: string;
  articleId?: string | null;
  slug?: string | null;
  source: string;
  title: string;
  severity: AlertSeverity;
  type: AlertType;
  reason: string;
  changedFacts: string[];
  detectedAt: string;
  lastVerified: string;
  recommendedAction: string;
  status: AlertStatus;
  freshness: AlertFreshness;
  age_hours: number;
  explanation: {
    what: string;
    why: string;
    action: string;
  };
  dedupKey: string;
  metadata: {
    entity_diff_hash?: string;
    admin_id?: string | null;
    updated_at?: string;
    acknowledged_at?: string | null;
    resolved_at?: string | null;
    dismissed_at?: string | null;
  };
}

export interface AlertFilterOptions {
  severity?: AlertSeverity | 'ALL';
  type?: AlertType | 'ALL';
  status?: AlertStatus | 'ALL';
  source?: string;
  search?: string;
  limit?: number;
  offset?: number;
}

export interface EditorialAlertKPIs {
  total_alerts: number;
  open_alerts: number;
  critical_alerts: number;
  high_alerts: number;
  source_failures: number;
  stale_articles: number;
  acknowledged_alerts: number;
  resolved_alerts: number;
  last_evaluated: string;
}

// ─── DEDUPLICATION & SANITIZATION HELPERS ──────────────────────────────────────

/**
 * Generate deterministic SHA-256 deduplication key for an alert.
 */
export function generateAlertDedupKey(
  articleId: string | null | undefined,
  alertType: AlertType,
  sourceUrlOrName: string,
  entityHash?: string
): string {
  const normId = (articleId || 'global').trim();
  const normType = alertType.trim();
  const normSource = (sourceUrlOrName || '').toLowerCase().trim();
  const normEntity = (entityHash || 'base').trim();

  return crypto
    .createHash('sha256')
    .update(`${normId}:${normType}:${normSource}:${normEntity}`)
    .digest('hex');
}

/**
 * Scrub sensitive credentials, tokens, or JWTs from strings.
 */
export function sanitizeAlertText(input: string): string {
  if (!input) return '';
  return input
    .replace(/(?:password|token|secret|key|authorization|bearer)=[^&\s]+/gi, '$1=[REDACTED]')
    .replace(/bearer\s+[A-Za-z0-9\-_.]+/gi, 'Bearer [REDACTED]');
}

/**
 * Compute alert freshness category based on age in hours.
 */
export function computeFreshness(detectedAtIso: string): { freshness: AlertFreshness; age_hours: number } {
  const detected = new Date(detectedAtIso).getTime();
  const now = Date.now();
  const diffHours = Math.max(0, Math.round((now - detected) / (1000 * 60 * 60) * 10) / 10);

  let freshness: AlertFreshness = 'NEW';
  if (diffHours >= 24) {
    freshness = 'AGING';
  } else if (diffHours >= 2) {
    freshness = 'RECENT';
  }

  return { freshness, age_hours: diffHours };
}

// ─── IN-MEMORY ALERT STORE ────────────────────────────────────────────────────

class NewsEditorialAlertService {
  private alertsStore: Map<string, EditorialAlert> = new Map();
  private dedupIndex: Map<string, string> = new Map(); // dedupKey -> alertId
  private lastEvaluationTime: string = new Date().toISOString();

  /**
   * Reset store (useful for test isolation).
   */
  public resetStore() {
    this.alertsStore.clear();
    this.dedupIndex.clear();
  }

  /**
   * Ingest a single alert payload with strict deduplication.
   * If an identical alert already exists in OPEN or ACKNOWLEDGED status,
   * updates the existing alert rather than spawning duplicates.
   */
  public upsertAlert(alertData: Omit<EditorialAlert, 'alertId' | 'freshness' | 'age_hours'>): EditorialAlert {
    const dedupKey = alertData.dedupKey || generateAlertDedupKey(
      alertData.articleId,
      alertData.type,
      alertData.source,
      alertData.metadata?.entity_diff_hash
    );

    const existingAlertId = this.dedupIndex.get(dedupKey);
    const existingAlert = existingAlertId ? this.alertsStore.get(existingAlertId) : undefined;

    const { freshness, age_hours } = computeFreshness(alertData.detectedAt);

    if (existingAlert && (existingAlert.status === 'OPEN' || existingAlert.status === 'ACKNOWLEDGED')) {
      // Update existing alert timestamp & metadata without duplicating
      existingAlert.title = sanitizeAlertText(alertData.title);
      existingAlert.reason = sanitizeAlertText(alertData.reason);
      existingAlert.changedFacts = alertData.changedFacts.map(sanitizeAlertText);
      existingAlert.lastVerified = alertData.lastVerified;
      existingAlert.severity = alertData.severity;
      existingAlert.recommendedAction = sanitizeAlertText(alertData.recommendedAction);
      existingAlert.explanation = {
        what: sanitizeAlertText(alertData.explanation.what),
        why: sanitizeAlertText(alertData.explanation.why),
        action: sanitizeAlertText(alertData.explanation.action),
      };
      existingAlert.metadata.updated_at = new Date().toISOString();
      const updatedFreshness = computeFreshness(existingAlert.detectedAt);
      existingAlert.freshness = updatedFreshness.freshness;
      existingAlert.age_hours = updatedFreshness.age_hours;

      this.alertsStore.set(existingAlert.alertId, existingAlert);
      return existingAlert;
    }

    const alertId = `alert_${crypto.randomBytes(8).toString('hex')}`;
    const newAlert: EditorialAlert = {
      alertId,
      articleId: alertData.articleId || null,
      slug: alertData.slug || null,
      source: sanitizeAlertText(alertData.source),
      title: sanitizeAlertText(alertData.title),
      severity: alertData.severity,
      type: alertData.type,
      reason: sanitizeAlertText(alertData.reason),
      changedFacts: alertData.changedFacts.map(sanitizeAlertText),
      detectedAt: alertData.detectedAt,
      lastVerified: alertData.lastVerified,
      recommendedAction: sanitizeAlertText(alertData.recommendedAction),
      status: alertData.status || 'OPEN',
      freshness,
      age_hours,
      explanation: {
        what: sanitizeAlertText(alertData.explanation.what),
        why: sanitizeAlertText(alertData.explanation.why),
        action: sanitizeAlertText(alertData.explanation.action),
      },
      dedupKey,
      metadata: {
        ...alertData.metadata,
        updated_at: new Date().toISOString(),
        admin_id: null,
      },
    };

    this.alertsStore.set(alertId, newAlert);
    this.dedupIndex.set(dedupKey, alertId);

    return newAlert;
  }

  /**
   * Convert SourceChangeRecord into corresponding Editorial Alert.
   */
  public mapSourceChangeToAlert(change: SourceChangeRecord): EditorialAlert | null {
    if (change.change_type === 'NO_CHANGE') {
      return null; // No alert needed for identical content
    }

    let severity: AlertSeverity = 'LOW';
    let alertType: AlertType = 'UPDATE_RECOMMENDED';
    let recommendedAction = 'MANUAL_REVIEW';

    switch (change.change_type) {
      case 'CRITICAL_CHANGE':
        severity = 'CRITICAL';
        alertType = 'SOURCE_CHANGE_CRITICAL';
        recommendedAction = 'URGENT_EDITORIAL_UPDATE';
        break;

      case 'MATERIAL_CHANGE':
        severity = 'HIGH';
        alertType = 'SOURCE_CHANGE_MATERIAL';
        recommendedAction = 'UPDATE_RECOMMENDED';
        break;

      case 'SOURCE_UNAVAILABLE':
        severity = 'HIGH';
        alertType = 'SOURCE_UNAVAILABLE';
        recommendedAction = 'MANUAL_REVIEW';
        break;

      case 'MINOR_CHANGE':
        severity = 'LOW';
        alertType = 'UPDATE_RECOMMENDED';
        recommendedAction = 'REVIEW_SOURCE_CHANGE';
        break;
    }

    const dedupKey = generateAlertDedupKey(
      change.article_id,
      alertType,
      change.source_url || change.source_name,
      change.entity_diffs?.map(d => `${d.field}:${d.description}`).join(',')
    );

    const title = change.article_title || (change as any).title || 'Railway Source Update';
    const slug = change.article_slug || (change as any).slug || null;
    const lastVerified = change.last_verified_at || (change as any).detected_at || new Date().toISOString();

    return this.upsertAlert({
      articleId: change.article_id,
      slug,
      source: change.source_name,
      title,
      severity,
      type: alertType,
      reason: change.explanation?.why || change.change_type,
      changedFacts: change.changed_facts_summary || [],
      detectedAt: change.last_verified_at || new Date().toISOString(),
      lastVerified,
      recommendedAction,
      status: 'OPEN',
      explanation: {
        what: change.explanation?.what || 'Source content changed',
        why: change.explanation?.why || 'Original publisher updated railway details',
        action: change.explanation?.action || recommendedAction,
      },
      dedupKey,
      metadata: {
        entity_diff_hash: change.entity_diffs?.length ? `${change.entity_diffs.length}_diffs` : undefined,
      },
    });
  }

  /**
   * Evaluate all tracked articles & registered sources to generate live alerts.
   */
  public async evaluateAllAlerts(): Promise<EditorialAlert[]> {
    try {
      const result = await newsAdminService.listArticles({ limit: 100, offset: 0 });
      const articles = result.articles || [];
      const generatedAlerts: EditorialAlert[] = [];
      const now = new Date().toISOString();

      for (const article of articles) {
        // 1. Source Change Detection Alert
        if (article.source_url) {
          const changeRecord = await newsSourceChangeService.detectArticleLiveChange({
            id: article.id,
            title: article.title,
            summary: article.summary,
            source_name: article.source_name,
            source_url: article.source_url,
            source_tier: article.source_tier,
            status: article.status,
            slug: article.slug,
            published_at: article.published_at,
          });

          const alert = this.mapSourceChangeToAlert(changeRecord);
          if (alert) {
            generatedAlerts.push(alert);
          }
        }

        // 2. Stale Operational Article Alert (>72h old for operational disruptions)
        const isDisruptionCategory = ['CANCELLATION', 'DIVERSION', 'SPECIAL_TRAIN', 'MAINTENANCE'].includes(article.category?.toUpperCase() || '');
        if (isDisruptionCategory && article.published_at) {
          const pubDate = new Date(article.published_at).getTime();
          const ageHours = (Date.now() - pubDate) / (1000 * 60 * 60);

          if (ageHours > 72 && article.status === 'published') {
            const dedupKey = generateAlertDedupKey(article.id, 'ARTICLE_STALE', article.source_name, 'stale_72h');
            const staleAlert = this.upsertAlert({
              articleId: article.id,
              slug: article.slug,
              source: article.source_name,
              title: `Operational advisory may be stale: ${article.title}`,
              severity: 'MEDIUM',
              type: 'ARTICLE_STALE',
              reason: `Article published ${Math.round(ageHours)} hours ago for operational disruptions. Advisory needs freshness verification.`,
              changedFacts: [`Published ${Math.round(ageHours / 24)} days ago`, `Category: ${article.category}`],
              detectedAt: now,
              lastVerified: article.published_at,
              recommendedAction: 'VERIFY_OR_ARCHIVE',
              status: 'OPEN',
              explanation: {
                what: 'Disruption advisory published over 72 hours ago.',
                why: 'Train cancellations and diversions typically normalize within 24-48 hours. Stale notices confuse travelers.',
                action: 'Verify current IRCTC/railway circulars and update or archive if restored.',
              },
              dedupKey,
              metadata: {},
            });
            generatedAlerts.push(staleAlert);
          }
        }
      }

      this.lastEvaluationTime = now;
      return Array.from(this.alertsStore.values());
    } catch (err: any) {
      winstonLogger.error(`[NEWS_EDITORIAL_ALERTS_EVAL] ${err.message}`);
      return Array.from(this.alertsStore.values());
    }
  }

  /**
   * Query and filter alerts.
   */
  public getAlerts(options: AlertFilterOptions = {}): { alerts: EditorialAlert[]; total: number; kpis: EditorialAlertKPIs } {
    let list = Array.from(this.alertsStore.values());

    // Update freshness on read
    list = list.map(a => {
      const { freshness, age_hours } = computeFreshness(a.detectedAt);
      a.freshness = freshness;
      a.age_hours = age_hours;
      return a;
    });

    if (options.severity && options.severity !== 'ALL') {
      list = list.filter(a => a.severity === options.severity);
    }

    if (options.type && options.type !== 'ALL') {
      list = list.filter(a => a.type === options.type);
    }

    if (options.status && options.status !== 'ALL') {
      list = list.filter(a => a.status === options.status);
    }

    if (options.source) {
      const s = options.source.toLowerCase();
      list = list.filter(a => a.source.toLowerCase().includes(s));
    }

    if (options.search) {
      const q = options.search.toLowerCase();
      list = list.filter(a =>
        a.title.toLowerCase().includes(q) ||
        a.reason.toLowerCase().includes(q) ||
        a.source.toLowerCase().includes(q) ||
        a.changedFacts.some(f => f.toLowerCase().includes(q))
      );
    }

    // Sort: CRITICAL first, then HIGH, then NEWEST
    const severityOrder: Record<AlertSeverity, number> = {
      CRITICAL: 0,
      HIGH: 1,
      MEDIUM: 2,
      LOW: 3,
      INFO: 4,
    };

    list.sort((a, b) => {
      // 1. OPEN before ACKNOWLEDGED before RESOLVED/DISMISSED
      const statusOrder: Record<AlertStatus, number> = { OPEN: 0, ACKNOWLEDGED: 1, RESOLVED: 2, DISMISSED: 3 };
      if (statusOrder[a.status] !== statusOrder[b.status]) {
        return statusOrder[a.status] - statusOrder[b.status];
      }

      // 2. Severity order
      if (severityOrder[a.severity] !== severityOrder[b.severity]) {
        return severityOrder[a.severity] - severityOrder[b.severity];
      }

      // 3. Newest first
      return new Date(b.detectedAt).getTime() - new Date(a.detectedAt).getTime();
    });

    const total = list.length;
    const limit = options.limit && options.limit > 0 ? options.limit : 50;
    const offset = options.offset && options.offset >= 0 ? options.offset : 0;
    const paginated = list.slice(offset, offset + limit);

    return {
      alerts: paginated,
      total,
      kpis: this.getKPIs(),
    };
  }

  /**
   * Get single alert by ID.
   */
  public getAlertById(alertId: string): EditorialAlert | null {
    const alert = this.alertsStore.get(alertId);
    if (!alert) return null;
    const { freshness, age_hours } = computeFreshness(alert.detectedAt);
    alert.freshness = freshness;
    alert.age_hours = age_hours;
    return alert;
  }

  /**
   * Lifecycle transition: OPEN -> ACKNOWLEDGED
   */
  public acknowledgeAlert(alertId: string, adminId?: string): EditorialAlert | null {
    const alert = this.alertsStore.get(alertId);
    if (!alert) return null;

    if (alert.status !== 'OPEN') {
      // Invalid transition if already resolved or dismissed
      if (alert.status === 'RESOLVED' || alert.status === 'DISMISSED') {
        throw new Error(`Cannot acknowledge alert in '${alert.status}' state.`);
      }
      return alert; // Already acknowledged
    }

    alert.status = 'ACKNOWLEDGED';
    alert.metadata.acknowledged_at = new Date().toISOString();
    alert.metadata.updated_at = new Date().toISOString();
    if (adminId) alert.metadata.admin_id = adminId;

    this.alertsStore.set(alertId, alert);
    return alert;
  }

  /**
   * Lifecycle transition: OPEN / ACKNOWLEDGED -> RESOLVED
   */
  public resolveAlert(alertId: string, adminId?: string): EditorialAlert | null {
    const alert = this.alertsStore.get(alertId);
    if (!alert) return null;

    if (alert.status === 'DISMISSED') {
      throw new Error("Cannot resolve a dismissed alert.");
    }

    alert.status = 'RESOLVED';
    alert.metadata.resolved_at = new Date().toISOString();
    alert.metadata.updated_at = new Date().toISOString();
    if (adminId) alert.metadata.admin_id = adminId;

    this.alertsStore.set(alertId, alert);
    return alert;
  }

  /**
   * Lifecycle transition: OPEN / ACKNOWLEDGED -> DISMISSED
   */
  public dismissAlert(alertId: string, adminId?: string): EditorialAlert | null {
    const alert = this.alertsStore.get(alertId);
    if (!alert) return null;

    if (alert.status === 'RESOLVED') {
      throw new Error("Cannot dismiss an already resolved alert.");
    }

    alert.status = 'DISMISSED';
    alert.metadata.dismissed_at = new Date().toISOString();
    alert.metadata.updated_at = new Date().toISOString();
    if (adminId) alert.metadata.admin_id = adminId;

    this.alertsStore.set(alertId, alert);
    return alert;
  }

  /**
   * Compute aggregate KPI summary.
   */
  public getKPIs(): EditorialAlertKPIs {
    const all = Array.from(this.alertsStore.values());
    const open = all.filter(a => a.status === 'OPEN');

    return {
      total_alerts: all.length,
      open_alerts: open.length,
      critical_alerts: open.filter(a => a.severity === 'CRITICAL').length,
      high_alerts: open.filter(a => a.severity === 'HIGH').length,
      source_failures: open.filter(a => a.type === 'SOURCE_UNAVAILABLE').length,
      stale_articles: open.filter(a => a.type === 'ARTICLE_STALE').length,
      acknowledged_alerts: all.filter(a => a.status === 'ACKNOWLEDGED').length,
      resolved_alerts: all.filter(a => a.status === 'RESOLVED').length,
      last_evaluated: this.lastEvaluationTime,
    };
  }
}

export const newsEditorialAlertService = new NewsEditorialAlertService();
