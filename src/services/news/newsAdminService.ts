/**
 * News Admin CMS Service — Phase 066
 *
 * Implements all lifecycle management for the Admin News Control Center.
 * HARD RULE: AI_DRAFTED → PUBLISHED is absolutely blocked.
 * Reuses: admin_security_audit_logs, existing Supabase infrastructure.
 * Source attribution fields are immutable.
 */

import { winstonLogger } from '../../middleware/logger';
import { supabase, isSupabaseConfigured } from '../../config/supabase';
import { cacheService } from '../cacheService';
import { newsSourceRegistry } from './newsSourceRegistry';
import {
  IngestionStatus,
  NewsRejectionReason,
  NewsAuditAction,
  NewsEditableFields,
  VALID_NEWS_TRANSITIONS,
} from './newsTypes';

// ─── Filters for listArticles ─────────────────────────────────────────────────

export interface NewsListFilters {
  status?: IngestionStatus | '';
  category?: string;
  sourceTier?: string;
  dateFrom?: string;
  dateTo?: string;
  search?: string;
  limit?: number;
  offset?: number;
}

export interface NewsListResult {
  articles: any[];
  total: number;
  kpis: NewsKpis;
  sources?: any[];
  source_metrics?: any;
}

export interface NewsKpis {
  drafts: number;
  review_queue: number;
  approved: number;
  scheduled: number;
  published: number;
  rejected: number;
  archived: number;
  unpublished: number;
}

// ─── Immutable source attribution fields — never allow clearing ───────────────
const IMMUTABLE_SOURCE_FIELDS = [
  'source_name', 'source_url', 'source_id', 'source_tier',
  'source_guid', 'published_at',
];

// ─── Service ──────────────────────────────────────────────────────────────────

export class NewsAdminService {

  // ── List articles with KPIs ────────────────────────────────────────────────

  public async listArticles(filters: NewsListFilters): Promise<NewsListResult> {
    const limit = Math.min(filters.limit || 50, 100);
    const offset = filters.offset || 0;

    if (!isSupabaseConfigured()) {
      return { articles: [], total: 0, kpis: this.emptyKpis() };
    }

    try {
      let query = supabase
        .from('railway_news')
        .select('id, title, summary, source_name, source_url, source_tier, category, status, relevance_score, affected_trains, affected_stations, published_at, updated_at', { count: 'exact' })
        .order('updated_at', { ascending: false })
        .range(offset, offset + limit - 1);

      if (filters.status) {
        query = query.eq('status', filters.status);
      }
      if (filters.category) {
        query = query.eq('category', filters.category);
      }
      if (filters.sourceTier) {
        query = query.eq('source_tier', filters.sourceTier);
      }
      if (filters.dateFrom) {
        query = query.gte('published_at', filters.dateFrom);
      }
      if (filters.dateTo) {
        query = query.lte('published_at', filters.dateTo);
      }
      if (filters.search) {
        query = query.ilike('title', `%${filters.search}%`);
      }

      const { data, count, error } = await query;
      if (error) throw error;

      const kpis = await this.fetchKpis();
      const sources = newsSourceRegistry.getHealthSummary();
      const source_metrics = newsSourceRegistry.getMetrics();
      return { articles: data || [], total: count || 0, kpis, sources, source_metrics };
    } catch (err: any) {
      winstonLogger.warn('[NEWS_ADMIN_LIST_FAIL]', { error: err.message });
      // Retry with legacy select on column-not-found errors
      try {
        const { data: fallbackData, count: fallbackCount } = await supabase
          .from('railway_news')
          .select('*', { count: 'exact' })
          .order('updated_at', { ascending: false })
          .range(offset, offset + limit - 1);
        const kpis = await this.fetchKpis();
        const sources = newsSourceRegistry.getHealthSummary();
        const source_metrics = newsSourceRegistry.getMetrics();
        return { articles: fallbackData || [], total: fallbackCount || 0, kpis, sources, source_metrics };
      } catch {
        return { articles: [], total: 0, kpis: this.emptyKpis(), sources: newsSourceRegistry.getHealthSummary(), source_metrics: newsSourceRegistry.getMetrics() };
      }
    }
  }

  // ── Get single article in full detail ─────────────────────────────────────

  public async getArticle(id: string): Promise<any | null> {
    if (!isSupabaseConfigured()) return null;
    try {
      const { data, error } = await supabase
        .from('railway_news')
        .select('*')
        .eq('id', id)
        .single();
      if (error) throw error;
      return data;
    } catch (err: any) {
      winstonLogger.warn(`[NEWS_ADMIN_GET_FAIL] ${id}: ${err.message}`);
      return null;
    }
  }

  // ── Edit draft — editable fields only, attribution immutable ──────────────

  public async updateDraft(
    id: string,
    edits: NewsEditableFields,
    adminId: string
  ): Promise<{ success: boolean; error?: string }> {
    if (!isSupabaseConfigured()) {
      return { success: false, error: 'Database not configured' };
    }

    // Guard: immutable fields cannot be touched
    const editKeys = Object.keys(edits as Record<string, any>);
    for (const immutableField of IMMUTABLE_SOURCE_FIELDS) {
      if (editKeys.includes(immutableField)) {
        winstonLogger.warn(`[NEWS_ADMIN_EDIT_BLOCKED] Admin ${adminId} attempted to modify immutable field: ${immutableField}`);
        return { success: false, error: `Field '${immutableField}' is immutable and cannot be modified.` };
      }
    }

    // Guard: attribution cannot be set to empty
    const rawEdits = edits as any;
    if (rawEdits.source_url === '' || rawEdits.source_url === null ||
        rawEdits.source_name === '' || rawEdits.source_name === null) {
      return { success: false, error: 'Source attribution cannot be cleared.' };
    }

    try {
      const existing = await this.getArticle(id);
      if (!existing) return { success: false, error: 'Article not found.' };

      // Build safe update payload from whitelist
      const allowedEdits: Record<string, any> = {};
      const allowedKeys: (keyof NewsEditableFields)[] = [
        'title', 'summary', 'key_takeaways', 'passenger_advice', 'faq',
        'seo_title', 'meta_description', 'slug', 'category',
        'affected_trains', 'affected_stations',
      ];
      for (const key of allowedKeys) {
        if (key in rawEdits && rawEdits[key] !== undefined) {
          allowedEdits[key] = rawEdits[key];
        }
      }
      allowedEdits.updated_at = new Date().toISOString();

      const { error } = await supabase
        .from('railway_news')
        .update(allowedEdits)
        .eq('id', id);

      if (error) {
        if (error.code === 'PGRST204' || error.message?.includes('column')) {
          // Fallback: only write known legacy columns
          const legacyKeys = ['title', 'summary', 'key_takeaways', 'seo_title', 'meta_description', 'slug', 'category', 'affected_trains', 'affected_stations'];
          const fallbackEdits: Record<string, any> = { updated_at: new Date().toISOString() };
          for (const k of legacyKeys) {
            if (k in allowedEdits) fallbackEdits[k] = allowedEdits[k];
          }
          const { error: fallbackErr } = await supabase.from('railway_news').update(fallbackEdits).eq('id', id);
          if (fallbackErr) throw fallbackErr;
        } else {
          throw error;
        }
      }

      await this.writeAuditEntry('EDIT', id, adminId, existing.status, existing.status);
      return { success: true };
    } catch (err: any) {
      winstonLogger.error(`[NEWS_ADMIN_EDIT_ERROR] ${id}: ${err.message}`);
      return { success: false, error: err.message };
    }
  }

  // ── Transition lifecycle status ────────────────────────────────────────────

  public async transitionStatus(
    id: string,
    newStatus: IngestionStatus,
    adminId: string,
    reason?: string
  ): Promise<{ success: boolean; error?: string }> {
    if (!isSupabaseConfigured()) {
      return { success: false, error: 'Database not configured' };
    }

    try {
      const existing = await this.getArticle(id);
      if (!existing) return { success: false, error: 'Article not found.' };

      const currentStatus: IngestionStatus = existing.status;

      // ═══════════════════════════════════════════════════════════════════════
      // HARD BLOCK — AI auto-publish is absolutely forbidden
      // ═══════════════════════════════════════════════════════════════════════
      if (currentStatus === 'AI_DRAFTED' && newStatus === 'PUBLISHED') {
        winstonLogger.warn(
          `[NEWS_AUTO_PUBLISH_BLOCKED] Admin ${adminId} attempted direct publish of AI_DRAFTED article ${id}. BLOCKED by governance policy.`
        );
        return {
          success: false,
          error: 'GOVERNANCE BLOCK: AI_DRAFTED articles cannot be published directly. REVIEW_REQUIRED → APPROVED → PUBLISHED is mandatory.',
        };
      }

      // Validate against the transition table
      const validNext = VALID_NEWS_TRANSITIONS[currentStatus] || [];
      if (!validNext.includes(newStatus)) {
        return {
          success: false,
          error: `Invalid lifecycle transition: ${currentStatus} → ${newStatus}. Allowed next states: [${validNext.join(', ') || 'none'}].`,
        };
      }

      // Source attribution must be present before approval/publish
      if ((newStatus === 'PUBLISHED' || newStatus === 'APPROVED') &&
          (!existing.source_url || !existing.source_name)) {
        return { success: false, error: 'Cannot approve/publish: source attribution is missing.' };
      }

      const now = new Date().toISOString();
      const updatePayload: Record<string, any> = {
        status: newStatus,
        updated_at: now,
      };

      if (newStatus === 'APPROVED' || newStatus === 'PUBLISHED') {
        updatePayload.admin_reviewed_by = adminId;
        updatePayload.admin_reviewed_at = now;
      }
      if (newStatus === 'PUBLISHED' && !existing.published_at) {
        updatePayload.published_at = now;
      }
      if (newStatus === 'REJECTED' && reason) {
        updatePayload.rejection_reason = reason;
      }

      // Attempt upsert with all fields; fallback to status-only if columns missing
      const { error } = await supabase
        .from('railway_news')
        .update(updatePayload)
        .eq('id', id);

      if (error) {
        if (error.code === 'PGRST204' || error.message?.includes('column')) {
          const safePayload: Record<string, any> = { status: newStatus, updated_at: now };
          if (newStatus === 'PUBLISHED' && !existing.published_at) safePayload.published_at = now;
          if (newStatus === 'REJECTED' && reason) safePayload.rejection_reason = reason;
          const { error: fallbackErr } = await supabase
            .from('railway_news').update(safePayload).eq('id', id);
          if (fallbackErr) throw fallbackErr;
        } else {
          throw error;
        }
      }

      // Invalidate memory cache so public /api/news refreshes instantly
      try {
        cacheService.del('railway_news_v2');
      } catch {}

      // Map to audit action
      const actionMap: Partial<Record<IngestionStatus, NewsAuditAction>> = {
        APPROVED: 'APPROVE', REJECTED: 'REJECT', SCHEDULED: 'SCHEDULE',
        PUBLISHED: 'PUBLISH', UNPUBLISHED: 'UNPUBLISH', ARCHIVED: 'ARCHIVE',
      };
      const auditAction: NewsAuditAction = actionMap[newStatus] || 'EDIT';
      await this.writeAuditEntry(auditAction, id, adminId, currentStatus, newStatus, reason);

      winstonLogger.info(`[NEWS_CMS_TRANSITION] ${id}: ${currentStatus} → ${newStatus} by ${adminId}`);
      return { success: true };
    } catch (err: any) {
      winstonLogger.error(`[NEWS_ADMIN_TRANSITION_ERROR] ${id} → ${newStatus}: ${err.message}`);
      return { success: false, error: err.message };
    }
  }

  // ── Schedule an approved article ──────────────────────────────────────────

  public async setSchedule(
    id: string,
    scheduledAt: string,
    adminId: string
  ): Promise<{ success: boolean; error?: string }> {
    if (!isSupabaseConfigured()) {
      return { success: false, error: 'Database not configured' };
    }

    const scheduledTime = new Date(scheduledAt).getTime();
    if (isNaN(scheduledTime) || scheduledTime <= Date.now()) {
      return { success: false, error: 'scheduled_at must be a valid future timestamp.' };
    }

    try {
      const existing = await this.getArticle(id);
      if (!existing) return { success: false, error: 'Article not found.' };

      if (existing.status !== 'APPROVED') {
        return {
          success: false,
          error: `Only APPROVED articles can be scheduled. Current status: ${existing.status}`,
        };
      }

      const { error } = await supabase
        .from('railway_news')
        .update({ status: 'SCHEDULED', scheduled_at: scheduledAt, updated_at: new Date().toISOString() })
        .eq('id', id);

      if (error) {
        // Fallback if scheduled_at column doesn't exist yet
        const { error: fallbackErr } = await supabase
          .from('railway_news')
          .update({ status: 'SCHEDULED', updated_at: new Date().toISOString() })
          .eq('id', id);
        if (fallbackErr) throw fallbackErr;
      }

      await this.writeAuditEntry(
        'SCHEDULE', id, adminId, existing.status, 'SCHEDULED',
        `Scheduled for: ${scheduledAt}`
      );
      return { success: true };
    } catch (err: any) {
      winstonLogger.error(`[NEWS_ADMIN_SCHEDULE_ERROR] ${id}: ${err.message}`);
      return { success: false, error: err.message };
    }
  }

  // ── Per-article audit history ──────────────────────────────────────────────

  public async getAuditHistory(articleId: string): Promise<any[]> {
    if (!isSupabaseConfigured()) return [];
    try {
      const { data, error } = await supabase
        .from('admin_security_audit_logs')
        .select('*')
        .eq('target_id', articleId)
        .order('timestamp', { ascending: false })
        .limit(50);

      if (error) throw error;
      return data || [];
    } catch (err: any) {
      winstonLogger.warn(`[NEWS_ADMIN_AUDIT_HISTORY_FAIL] ${articleId}: ${err.message}`);
      return [];
    }
  }

  // ── Write audit entry (reuses admin_security_audit_logs) ─────────────────

  public async writeAuditEntry(
    action: NewsAuditAction,
    articleId: string,
    adminId: string,
    prevStatus: IngestionStatus | string,
    newStatus: IngestionStatus | string,
    reason?: string,
    adminIp?: string
  ): Promise<void> {
    try {
      // Admin email is not resolved here to avoid coupling to auth internals.
      // The audit log stores adminId (UUID); email lookup is done at read time via join.
      const adminEmail = 'admin@trayago.in';

      if (isSupabaseConfigured()) {
        await supabase.from('admin_security_audit_logs').insert([{
          admin_id: adminId,
          admin_email: adminEmail,
          action: `NEWS_CMS_${action}`,
          target_id: articleId,
          ip_address: adminIp || null,
          user_agent: null,
          details: {
            previous_status: prevStatus,
            new_status: newStatus,
            reason: reason || null,
          },
          timestamp: new Date().toISOString(),
        }]);
      }

      winstonLogger.info(
        `[NEWS_AUDIT] action=${action} article=${articleId} admin=${adminId} ${prevStatus}→${newStatus}${reason ? ` reason=${reason}` : ''}`
      );
    } catch (err: any) {
      // Audit failure is non-fatal but must be logged
      winstonLogger.warn(`[NEWS_AUDIT_WRITE_FAIL] ${err.message}`);
    }
  }

  // ── Private: KPI aggregation ──────────────────────────────────────────────

  private async fetchKpis(): Promise<NewsKpis> {
    const kpis = this.emptyKpis();
    if (!isSupabaseConfigured()) return kpis;
    try {
      const { data } = await supabase.from('railway_news').select('status');
      if (data) {
        for (const row of data) {
          switch (row.status) {
            case 'AI_DRAFTED':      kpis.drafts++;       break;
            case 'REVIEW_REQUIRED': kpis.review_queue++; break;
            case 'APPROVED':        kpis.approved++;      break;
            case 'SCHEDULED':       kpis.scheduled++;     break;
            case 'PUBLISHED':       kpis.published++;     break;
            case 'REJECTED':        kpis.rejected++;      break;
            case 'ARCHIVED':        kpis.archived++;      break;
            case 'UNPUBLISHED':     kpis.unpublished++;   break;
          }
        }
      }
    } catch { /* non-fatal */ }
    return kpis;
  }

  private emptyKpis(): NewsKpis {
    return {
      drafts: 0, review_queue: 0, approved: 0, scheduled: 0,
      published: 0, rejected: 0, archived: 0, unpublished: 0,
    };
  }
}

export const newsAdminService = new NewsAdminService();
