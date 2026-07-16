import express from 'express';
import { railwayNewsService } from '../services/railwayNewsService';
import { asyncHandler } from '../middleware/errorHandler';

const router = express.Router();

/**
 * GET /api/news
 * Returns latest railway news articles (served from 30-min cache).
 * Optional: ?category=Delays&limit=20
 */
router.get('/', asyncHandler(async (req: express.Request, res: express.Response) => {
  const { category, limit } = req.query;

  let articles = await railwayNewsService.getLatestNews();

  // Optional category filter
  if (category && typeof category === 'string') {
    articles = articles.filter(a =>
      a.category.toLowerCase() === category.toLowerCase()
    );
  }

  // Optional limit
  const maxItems = Math.min(parseInt(limit as string) || 40, 40);
  articles = articles.slice(0, maxItems);

  res.json({ success: true, count: articles.length, data: articles });
}));

/**
 * POST /api/news/refresh
 * Manually triggers a news cache refresh (for internal use).
 * Protected by a simple shared secret to prevent abuse.
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
