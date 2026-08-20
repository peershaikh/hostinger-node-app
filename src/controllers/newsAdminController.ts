/**
 * News Admin CMS Controller — Phase 066
 *
 * Express handlers for /api/admin/news
 * All routes protected by requireAuth + requireAdmin (enforced in router).
 * Delegates business logic to newsAdminService.
 * Never exposes tokens, API keys, or auth secrets.
 */

import { Request, Response } from 'express';
import { winstonLogger } from '../middleware/logger';
import { newsAdminService } from '../services/news/newsAdminService';
import { IngestionStatus, NewsRejectionReason } from '../services/news/newsTypes';

// ─── Helper: extract admin identity from request ──────────────────────────────
function getAdminId(req: Request): string {
  return ((req as any).user?.id || req.headers['x-user-id'] as string || 'unknown-admin').trim();
}

// ─── Controller ───────────────────────────────────────────────────────────────

export class NewsAdminController {

  // GET /api/admin/news — list with KPIs, filters, pagination
  async listArticles(req: Request, res: Response) {
    try {
      const filters = {
        status: ((req.query.status as string) || '') as IngestionStatus | '',
        category: req.query.category as string | undefined,
        sourceTier: req.query.sourceTier as string | undefined,
        dateFrom: req.query.dateFrom as string | undefined,
        dateTo: req.query.dateTo as string | undefined,
        search: req.query.search as string | undefined,
        limit: parseInt(req.query.limit as string || '50', 10),
        offset: parseInt(req.query.offset as string || '0', 10),
      };

      const result = await newsAdminService.listArticles(filters);
      res.json({ success: true, ...result });
    } catch (err: any) {
      winstonLogger.error(`[NEWS_ADMIN_CTRL_LIST] ${err.message}`);
      res.status(500).json({ success: false, error: 'Failed to fetch news articles.' });
    }
  }

  // GET /api/admin/news/:id — full article detail
  async getArticle(req: Request, res: Response) {
    try {
      const { id } = req.params;
      const article = await newsAdminService.getArticle(id);
      if (!article) {
        return res.status(404).json({ success: false, error: 'Article not found.' });
      }

      const auditHistory = await newsAdminService.getAuditHistory(id);
      res.json({ success: true, data: { ...article, audit_history: auditHistory } });
    } catch (err: any) {
      winstonLogger.error(`[NEWS_ADMIN_CTRL_GET] ${err.message}`);
      res.status(500).json({ success: false, error: 'Failed to fetch article.' });
    }
  }

  // PATCH /api/admin/news/:id/draft — edit editorial fields
  async editDraft(req: Request, res: Response) {
    try {
      const { id } = req.params;
      const adminId = getAdminId(req);
      const edits = req.body || {};

      const result = await newsAdminService.updateDraft(id, edits, adminId);
      if (!result.success) {
        return res.status(400).json({ success: false, error: result.error });
      }
      res.json({ success: true, message: 'Draft updated successfully.' });
    } catch (err: any) {
      winstonLogger.error(`[NEWS_ADMIN_CTRL_EDIT] ${err.message}`);
      res.status(500).json({ success: false, error: 'Failed to update draft.' });
    }
  }

  // POST /api/admin/news/:id/approve — REVIEW_REQUIRED → APPROVED
  async approve(req: Request, res: Response) {
    try {
      const { id } = req.params;
      const adminId = getAdminId(req);
      const { attestation } = req.body;

      // Require explicit attestation from UI confirmation
      if (!attestation || attestation !== 'I verified the source and approve this article.') {
        return res.status(400).json({
          success: false,
          error: 'Missing or invalid attestation. You must confirm: "I verified the source and approve this article."',
        });
      }

      const result = await newsAdminService.transitionStatus(id, 'APPROVED', adminId);
      if (!result.success) {
        return res.status(400).json({ success: false, error: result.error });
      }
      res.json({ success: true, message: 'Article approved.' });
    } catch (err: any) {
      winstonLogger.error(`[NEWS_ADMIN_CTRL_APPROVE] ${err.message}`);
      res.status(500).json({ success: false, error: 'Failed to approve article.' });
    }
  }

  // POST /api/admin/news/:id/reject — → REJECTED
  async reject(req: Request, res: Response) {
    try {
      const { id } = req.params;
      const adminId = getAdminId(req);
      const { reason, note } = req.body;

      const validReasons: NewsRejectionReason[] = [
        'UNSUPPORTED_CLAIM', 'LOW_CONFIDENCE', 'DUPLICATE', 'SOURCE_UNTRUSTED',
        'OUTDATED', 'INCORRECT', 'OFF_TOPIC', 'OTHER',
      ];
      if (!reason || !validReasons.includes(reason)) {
        return res.status(400).json({
          success: false,
          error: `Invalid rejection reason. Must be one of: ${validReasons.join(', ')}`,
        });
      }

      const reasonString = note ? `${reason}: ${note}` : reason;
      const result = await newsAdminService.transitionStatus(id, 'REJECTED', adminId, reasonString);
      if (!result.success) {
        return res.status(400).json({ success: false, error: result.error });
      }
      res.json({ success: true, message: 'Article rejected.' });
    } catch (err: any) {
      winstonLogger.error(`[NEWS_ADMIN_CTRL_REJECT] ${err.message}`);
      res.status(500).json({ success: false, error: 'Failed to reject article.' });
    }
  }

  // POST /api/admin/news/:id/schedule — APPROVED → SCHEDULED
  async schedule(req: Request, res: Response) {
    try {
      const { id } = req.params;
      const adminId = getAdminId(req);
      const { scheduled_at } = req.body;

      if (!scheduled_at) {
        return res.status(400).json({ success: false, error: 'scheduled_at is required.' });
      }

      const result = await newsAdminService.setSchedule(id, scheduled_at, adminId);
      if (!result.success) {
        return res.status(400).json({ success: false, error: result.error });
      }
      res.json({ success: true, message: 'Article scheduled.', scheduled_at });
    } catch (err: any) {
      winstonLogger.error(`[NEWS_ADMIN_CTRL_SCHEDULE] ${err.message}`);
      res.status(500).json({ success: false, error: 'Failed to schedule article.' });
    }
  }

  // POST /api/admin/news/:id/publish — APPROVED → PUBLISHED
  async publish(req: Request, res: Response) {
    try {
      const { id } = req.params;
      const adminId = getAdminId(req);

      const result = await newsAdminService.transitionStatus(id, 'PUBLISHED', adminId);
      if (!result.success) {
        return res.status(400).json({ success: false, error: result.error });
      }
      res.json({ success: true, message: 'Article published.' });
    } catch (err: any) {
      winstonLogger.error(`[NEWS_ADMIN_CTRL_PUBLISH] ${err.message}`);
      res.status(500).json({ success: false, error: 'Failed to publish article.' });
    }
  }

  // POST /api/admin/news/:id/unpublish — PUBLISHED → UNPUBLISHED
  async unpublish(req: Request, res: Response) {
    try {
      const { id } = req.params;
      const adminId = getAdminId(req);

      const result = await newsAdminService.transitionStatus(id, 'UNPUBLISHED', adminId);
      if (!result.success) {
        return res.status(400).json({ success: false, error: result.error });
      }
      res.json({ success: true, message: 'Article unpublished.' });
    } catch (err: any) {
      winstonLogger.error(`[NEWS_ADMIN_CTRL_UNPUBLISH] ${err.message}`);
      res.status(500).json({ success: false, error: 'Failed to unpublish article.' });
    }
  }

  // POST /api/admin/news/:id/archive — → ARCHIVED
  async archive(req: Request, res: Response) {
    try {
      const { id } = req.params;
      const adminId = getAdminId(req);

      const result = await newsAdminService.transitionStatus(id, 'ARCHIVED', adminId);
      if (!result.success) {
        return res.status(400).json({ success: false, error: result.error });
      }
      res.json({ success: true, message: 'Article archived.' });
    } catch (err: any) {
      winstonLogger.error(`[NEWS_ADMIN_CTRL_ARCHIVE] ${err.message}`);
      res.status(500).json({ success: false, error: 'Failed to archive article.' });
    }
  }

  // GET /api/admin/news/analytics — aggregate editorial KPIs, top content, SEO health, and opportunities
  async getAnalytics(req: Request, res: Response) {
    try {
      const windowParam = (req.query.window as string || '7d').toLowerCase();
      const validWindow = (['today', '7d', '30d'].includes(windowParam) ? windowParam : '7d') as 'today' | '7d' | '30d';

      const { newsAnalyticsService } = require('../services/news/newsAnalyticsService');
      const analytics = await newsAnalyticsService.getDashboardAnalytics(validWindow);
      res.json(analytics);
    } catch (err: any) {
      winstonLogger.error(`[NEWS_ADMIN_CTRL_ANALYTICS] ${err.message}`);
      res.status(500).json({ success: false, error: 'Failed to fetch news analytics.' });
    }
  }

  // GET /api/admin/news/search-console — Google Search Console intelligence (7d, 28d, 30d)
  async getSearchConsoleAnalytics(req: Request, res: Response) {
    try {
      const windowParam = (req.query.window as string || '28d').toLowerCase();
      const validWindow = (['7d', '28d', '30d'].includes(windowParam) ? windowParam : '28d') as '7d' | '28d' | '30d';

      const { googleSearchConsoleService } = require('../services/news/googleSearchConsoleService');
      const data = await googleSearchConsoleService.getPerformanceData(validWindow);
      res.json({ success: true, data });
    } catch (err: any) {
      winstonLogger.error(`[NEWS_ADMIN_CTRL_GSC] ${err.message}`);
      res.status(500).json({ success: false, error: 'Failed to fetch Search Console performance data.' });
    }
  }

  // GET /api/admin/news/conversion-funnel — Partner affiliate conversions & business funnel
  async getConversionFunnel(req: Request, res: Response) {
    try {
      const windowParam = (req.query.window as string || '7d').toLowerCase();
      const validWindow = (['today', '7d', '28d', '30d'].includes(windowParam) ? windowParam : '7d') as 'today' | '7d' | '30d';
      const serviceWindow = validWindow === 'today' ? 'today' : validWindow === '30d' ? '30d' : '7d';

      const { newsRevenueIntelligenceService } = require('../services/news/newsRevenueIntelligenceService');
      const data = await newsRevenueIntelligenceService.getRevenueIntelligence(serviceWindow);
      res.json({ success: true, data });
    } catch (err: any) {
      winstonLogger.error(`[NEWS_ADMIN_CTRL_CONVERSION] ${err.message}`);
      res.status(500).json({ success: false, error: 'Failed to fetch conversion funnel data.' });
    }
  }

  // GET /api/admin/news/revenue-intelligence — Full Phase 073 Revenue Intelligence Engine
  async getRevenueIntelligence(req: Request, res: Response) {
    try {
      const windowParam = (req.query.window as string || '7d').toLowerCase();
      const validWindow = (['today', '7d', '30d'].includes(windowParam) ? windowParam : '7d') as 'today' | '7d' | '30d';

      const { newsRevenueIntelligenceService } = require('../services/news/newsRevenueIntelligenceService');
      const data = await newsRevenueIntelligenceService.getRevenueIntelligence(validWindow);
      res.json(data);
    } catch (err: any) {
      winstonLogger.error(`[NEWS_ADMIN_CTRL_REV_INTEL] ${err.message}`);
      res.status(500).json({ success: false, error: 'Failed to fetch revenue intelligence data.' });
    }
  }

  // GET /api/admin/news/:id/audit — per-article audit trail
  async getAuditHistory(req: Request, res: Response) {
    try {
      const { id } = req.params;
      const history = await newsAdminService.getAuditHistory(id);
      res.json({ success: true, data: history, count: history.length });
    } catch (err: any) {
      winstonLogger.error(`[NEWS_ADMIN_CTRL_AUDIT] ${err.message}`);
      res.status(500).json({ success: false, error: 'Failed to fetch audit history.' });
    }
  }
}

export const newsAdminController = new NewsAdminController();
