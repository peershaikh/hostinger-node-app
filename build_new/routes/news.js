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
 * Optional: ?category=Delays&limit=20
 */
router.get('/', (0, errorHandler_1.asyncHandler)(async (req, res) => {
    const { category, limit } = req.query;
    let articles = await railwayNewsService_1.railwayNewsService.getLatestNews();
    // Optional category filter
    if (category && typeof category === 'string') {
        articles = articles.filter(a => a.category.toLowerCase() === category.toLowerCase());
    }
    // Optional limit
    const maxItems = Math.min(parseInt(limit) || 40, 40);
    articles = articles.slice(0, maxItems);
    res.json({ success: true, count: articles.length, data: articles });
}));
/**
 * POST /api/news/refresh
 * Manually triggers a news cache refresh (for internal use).
 * Protected by a simple shared secret to prevent abuse.
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
