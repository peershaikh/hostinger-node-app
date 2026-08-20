import express from 'express';
import { railwayNewsService } from '../services/railwayNewsService';
import { asyncHandler } from '../middleware/errorHandler';

const router = express.Router();

/**
 * GET /api/news
 * Returns latest railway news articles (served from 30-min cache).
 * STRICT PUBLISHED GATE: Exposes only status === 'PUBLISHED'.
 * Optional: ?category=Delays&limit=20&offset=0
 */
router.get('/', asyncHandler(async (req: express.Request, res: express.Response) => {
  const { category, limit, offset } = req.query;

  const articles = await railwayNewsService.getLatestNews({
    category: typeof category === 'string' ? category : undefined,
    limit: limit ? parseInt(limit as string, 10) : undefined,
    offset: offset ? parseInt(offset as string, 10) : undefined,
  });

  res.json({ success: true, count: articles.length, data: articles });
}));

/**
 * GET /api/news/sitemap
 * Returns list of published article slugs and timestamps for dynamic sitemap generation.
 */
router.get('/sitemap', asyncHandler(async (_req: express.Request, res: express.Response) => {
  const entries = await railwayNewsService.getSitemapEntries();
  res.json({ success: true, count: entries.length, data: entries });
}));

/**
 * GET /api/news/sources
 * Returns health and status information for all registered news sources.
 */
router.get('/sources', asyncHandler(async (_req: express.Request, res: express.Response) => {
  const health = railwayNewsService.getSourceHealthSummary();
  res.json({ success: true, count: health.length, data: health });
}));

/**
 * GET /api/news/:slug
 * Retrieves a single published article by slug with deterministic related articles.
 * Returns 404 if article is not found or not in PUBLISHED status.
 */
router.get('/:slug', asyncHandler(async (req: express.Request, res: express.Response) => {
  const { slug } = req.params;
  const result = await railwayNewsService.getArticleBySlug(slug);

  if (!result || !result.article) {
    return res.status(404).json({ success: false, error: 'Article not found.' });
  }

  res.json({
    success: true,
    data: result.article,
    related: result.related,
  });
}));

/**
 * POST /api/news/refresh
 * Manually triggers a news cache refresh (for internal use).
 * Protected by a shared secret or authenticated admin session.
 */
router.post('/refresh', asyncHandler(async (req: express.Request, res: express.Response) => {
  const secret = req.headers['x-refresh-secret'];
  const expectedSecret = process.env.NEWS_REFRESH_SECRET || 'trayago-news-refresh';
  if (secret !== expectedSecret) {
    return res.status(401).json({ success: false, error: 'Unauthorized' });
  }
  const articles = await railwayNewsService.refreshNews();
  res.json({ success: true, refreshed: articles.length, message: 'News cache refreshed' });
}));

export default router;
