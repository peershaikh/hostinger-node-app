"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const express_1 = __importDefault(require("express"));
const railwayNewsService_1 = require("../services/railwayNewsService");
const errorHandler_1 = require("../middleware/errorHandler");
const router = express_1.default.Router();
/**
 * GET /api/news
 * Returns latest railway news articles (served from 30-min cache).
 * STRICT PUBLISHED GATE: Exposes only status === 'PUBLISHED'.
 * Optional: ?category=Delays&limit=20&offset=0
 */
router.get('/', (0, errorHandler_1.asyncHandler)(async (req, res) => {
    const { category, limit, offset } = req.query;
    const articles = await railwayNewsService_1.railwayNewsService.getLatestNews({
        category: typeof category === 'string' ? category : undefined,
        limit: limit ? parseInt(limit, 10) : undefined,
        offset: offset ? parseInt(offset, 10) : undefined,
    });
    res.json({ success: true, count: articles.length, data: articles });
}));
/**
 * GET /api/news/sitemap
 * Returns list of published article slugs and timestamps for dynamic sitemap generation.
 */
router.get('/sitemap', (0, errorHandler_1.asyncHandler)(async (_req, res) => {
    const entries = await railwayNewsService_1.railwayNewsService.getSitemapEntries();
    res.json({ success: true, count: entries.length, data: entries });
}));
/**
 * GET /api/news/sources
 * Returns health and status information for all registered news sources.
 */
router.get('/sources', (0, errorHandler_1.asyncHandler)(async (_req, res) => {
    const health = railwayNewsService_1.railwayNewsService.getSourceHealthSummary();
    res.json({ success: true, count: health.length, data: health });
}));
/**
 * GET /api/news/:slug
 * Retrieves a single published article by slug with deterministic related articles.
 * Returns 404 if article is not found or not in PUBLISHED status.
 */
router.get('/:slug', (0, errorHandler_1.asyncHandler)(async (req, res) => {
    const { slug } = req.params;
    const result = await railwayNewsService_1.railwayNewsService.getArticleBySlug(slug);
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
router.post('/refresh', (0, errorHandler_1.asyncHandler)(async (req, res) => {
    const secret = req.headers['x-refresh-secret'];
    const expectedSecret = process.env.NEWS_REFRESH_SECRET || 'trayago-news-refresh';
    if (secret !== expectedSecret) {
        return res.status(401).json({ success: false, error: 'Unauthorized' });
    }
    const articles = await railwayNewsService_1.railwayNewsService.refreshNews();
    res.json({ success: true, refreshed: articles.length, message: 'News cache refreshed' });
}));
exports.default = router;
