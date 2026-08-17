"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.railwayNewsService = void 0;
const fs_1 = __importDefault(require("fs"));
const path_1 = __importDefault(require("path"));
const logger_1 = require("../middleware/logger");
const cacheService_1 = require("./cacheService");
const supabase_1 = require("../config/supabase");
const newsSourceRegistry_1 = require("./news/newsSourceRegistry");
const newsIngestionEngine_1 = require("./news/newsIngestionEngine");
// ─── Constants ────────────────────────────────────────────────────────────────
const NEWS_CACHE_KEY = 'railway_news_v2';
const NEWS_CACHE_TTL = 30 * 60; // 30 minutes
const MAX_TOTAL_ARTICLES = 40;
const LOCAL_FALLBACK_FILE = path_1.default.join(process.cwd(), 'data', 'railway_news_cache.json');
// ─── Local Fallback Helper ────────────────────────────────────────────────────
function readLocalNewsFallback() {
    try {
        if (fs_1.default.existsSync(LOCAL_FALLBACK_FILE)) {
            const raw = fs_1.default.readFileSync(LOCAL_FALLBACK_FILE, 'utf-8');
            const parsed = JSON.parse(raw);
            if (Array.isArray(parsed))
                return parsed;
        }
    }
    catch (err) {
        logger_1.winstonLogger.warn('[NEWS_LOCAL_FALLBACK_READ_FAIL]', { error: err.message });
    }
    return [];
}
function writeLocalNewsFallback(articles) {
    try {
        const dir = path_1.default.dirname(LOCAL_FALLBACK_FILE);
        if (!fs_1.default.existsSync(dir))
            fs_1.default.mkdirSync(dir, { recursive: true });
        (0, supabase_1.safeWriteFileSync)(LOCAL_FALLBACK_FILE, JSON.stringify(articles, null, 2));
    }
    catch (err) {
        logger_1.winstonLogger.warn('[NEWS_LOCAL_FALLBACK_WRITE_FAIL]', { error: err.message });
    }
}
// ─── Schema Transformation ────────────────────────────────────────────────────
function transformToDatabasePayload(articles) {
    return articles.map(article => ({
        id: article.id,
        slug: article.slug,
        title: article.title,
        seo_title: article.seo_title,
        meta_description: article.meta_description,
        summary: article.summary,
        key_takeaways: article.key_takeaways || [],
        affected_trains: article.affected_trains || [],
        affected_stations: article.affected_stations || [],
        category: article.category,
        source_name: article.source_name,
        source_url: article.source_url,
        source_id: article.source_id,
        source_tier: article.source_tier,
        source_guid: article.source_guid,
        content_hash: article.content_hash,
        simhash: article.simhash,
        relevance_score: article.relevance_score,
        image_url: article.image_url,
        status: article.status || 'READY_FOR_AI',
        ingestion_status: article.ingestion_status || 'PENDING_AI',
        published_at: article.published_at,
        first_seen_at: article.first_seen_at,
        last_seen_at: article.last_seen_at,
        updated_at: new Date().toISOString(),
    }));
}
function transformFromDatabaseRow(row) {
    return {
        id: row.id,
        title: row.title,
        summary: row.summary || 'Official railway update.',
        sourceName: row.source_name,
        sourceUrl: row.source_url,
        publishedAt: row.published_at,
        category: row.category || 'Railway Updates',
        imageUrl: row.image_url || null,
        slug: row.slug || null,
        seoTitle: row.seo_title || null,
        metaDescription: row.meta_description || null,
        sourceId: row.source_id,
        sourceTier: row.source_tier,
        status: row.status,
        relevanceScore: row.relevance_score,
        affectedTrains: row.affected_trains || [],
        affectedStations: row.affected_stations || [],
    };
}
function canonicalToLegacyArticle(a) {
    return {
        id: a.id,
        title: a.title,
        summary: a.summary,
        sourceName: a.source_name,
        sourceUrl: a.source_url,
        publishedAt: a.published_at,
        category: a.category,
        imageUrl: a.image_url,
        slug: a.slug,
        seoTitle: a.seo_title,
        metaDescription: a.meta_description,
        sourceId: a.source_id,
        sourceTier: a.source_tier,
        status: a.status,
        relevanceScore: a.relevance_score,
        affectedTrains: a.affected_trains,
        affectedStations: a.affected_stations,
    };
}
// ─── Main Service ─────────────────────────────────────────────────────────────
exports.railwayNewsService = {
    /**
     * Returns latest railway news articles.
     * Serves from 30-minute memory cache; falls back to DB or local storage; refreshes on total miss.
     */
    getLatestNews: async () => {
        // 1. Memory cache
        const cached = cacheService_1.cacheService.get(NEWS_CACHE_KEY);
        if (cached && cached.length > 0) {
            logger_1.winstonLogger.info('[NEWS_CACHE_HIT] Serving from cache', { count: cached.length });
            return cached;
        }
        logger_1.winstonLogger.info('[NEWS_CACHE_MISS] Cache empty, checking database...');
        // 2. Database layer (Breaking news window: last 48h)
        const fortyEightHoursAgo = new Date(Date.now() - 48 * 60 * 60 * 1000).toISOString();
        try {
            if ((0, supabase_1.isSupabaseConfigured)()) {
                const { data: dbArticles, error } = await supabase_1.supabase
                    .from('railway_news')
                    .select('*')
                    .gte('published_at', fortyEightHoursAgo)
                    .order('published_at', { ascending: false })
                    .limit(MAX_TOTAL_ARTICLES);
                if (!error && dbArticles && dbArticles.length > 0) {
                    const articles = dbArticles
                        .map(transformFromDatabaseRow)
                        .filter(a => newsIngestionEngine_1.newsIngestionEngine.evaluateRelevance(a.title, a.summary, a.sourceName).isRelevant);
                    if (articles.length > 0) {
                        logger_1.winstonLogger.info('[NEWS_DB_FALLBACK] Serving from database', { count: articles.length });
                        cacheService_1.cacheService.set(NEWS_CACHE_KEY, articles, NEWS_CACHE_TTL);
                        writeLocalNewsFallback(articles);
                        return articles;
                    }
                }
            }
        }
        catch (err) {
            logger_1.winstonLogger.warn('[NEWS_DB_FALLBACK_FAIL]', { error: err.message });
        }
        // 3. Local JSON fallback
        const local = readLocalNewsFallback();
        if (local.length > 0) {
            const recent = local.filter(a => new Date(a.publishedAt).getTime() >= Date.now() - 48 * 60 * 60 * 1000);
            if (recent.length > 0) {
                logger_1.winstonLogger.info('[NEWS_LOCAL_FALLBACK] Serving from local JSON', { count: recent.length });
                cacheService_1.cacheService.set(NEWS_CACHE_KEY, recent, NEWS_CACHE_TTL);
                return recent;
            }
        }
        // 4. Trigger fresh multi-source refresh
        return exports.railwayNewsService.refreshNews();
    },
    /**
     * Ingests fresh articles across all registered and enabled sources.
     * Employs multi-layer deduplication, relevance scoring, retry isolation, and non-destructive persistence.
     */
    refreshNews: async () => {
        logger_1.winstonLogger.info('[NEWS_REFRESH_STARTED] Multi-source ingestion started...');
        const sources = newsSourceRegistry_1.newsSourceRegistry.getEnabledSources();
        // Fetch existing articles from DB/local to enable cross-source deduplication
        let existingArticles = [];
        try {
            if ((0, supabase_1.isSupabaseConfigured)()) {
                const { data } = await supabase_1.supabase
                    .from('railway_news')
                    .select('*')
                    .order('published_at', { ascending: false })
                    .limit(100);
                if (data) {
                    existingArticles = data.map(row => ({
                        id: row.id,
                        slug: row.slug || null,
                        title: row.title,
                        seo_title: row.seo_title || null,
                        meta_description: row.meta_description || null,
                        summary: row.summary || '',
                        key_takeaways: row.key_takeaways || [],
                        affected_trains: row.affected_trains || [],
                        affected_stations: row.affected_stations || [],
                        category: row.category || 'Railway Updates',
                        source_name: row.source_name,
                        source_url: row.source_url,
                        source_id: row.source_id || 'unknown',
                        source_tier: row.source_tier || 'TIER_1_OFFICIAL',
                        source_guid: row.source_guid || null,
                        content_hash: row.content_hash || '',
                        simhash: row.simhash || '',
                        relevance_score: row.relevance_score || 120,
                        image_url: row.image_url || null,
                        status: row.status || 'READY_FOR_AI',
                        ingestion_status: row.ingestion_status || 'PENDING_AI',
                        first_seen_at: row.first_seen_at || new Date().toISOString(),
                        last_seen_at: row.last_seen_at || new Date().toISOString(),
                        published_at: row.published_at,
                        created_at: row.created_at || new Date().toISOString(),
                        updated_at: row.updated_at || new Date().toISOString(),
                    }));
                }
            }
        }
        catch {
            // Non-fatal if DB query fails during warmup
        }
        // Ingest all sources in parallel with total failure isolation
        const results = await Promise.allSettled(sources.map(src => newsIngestionEngine_1.newsIngestionEngine.ingestSource(src, existingArticles)));
        const newCanonical = [];
        let successSources = 0;
        let failedSources = 0;
        for (let i = 0; i < results.length; i++) {
            const res = results[i];
            if (res.status === 'fulfilled') {
                if (res.value.status === 'SUCCESS') {
                    successSources++;
                    newCanonical.push(...res.value.accepted);
                    logger_1.winstonLogger.info(`[NEWS_INGESTION_SOURCE_SUCCESS] ${sources[i].name}: ${res.value.accepted.length} accepted, ${res.value.rejectedCount} rejected`);
                }
                else {
                    failedSources++;
                    logger_1.winstonLogger.warn(`[NEWS_INGESTION_SOURCE_WARN] ${sources[i].name} returned status ${res.value.status}: ${res.value.error}`);
                }
            }
            else {
                failedSources++;
                logger_1.winstonLogger.error(`[NEWS_INGESTION_SOURCE_CRASH] ${sources[i].name} unhandled crash: ${res.reason}`);
            }
        }
        logger_1.winstonLogger.info(`[NEWS_INGESTION_SUMMARY] ${successSources} sources succeeded, ${failedSources} failed, ${newCanonical.length} new candidate articles.`);
        // 3. AI Fact Distillation & Zero-Hallucination Validation Pipeline
        let processedCanonical = newCanonical;
        if (newCanonical.length > 0) {
            logger_1.winstonLogger.info(`[NEWS_AI_PIPELINE_START] Distilling facts and SEO for ${newCanonical.length} candidate articles...`);
            const { newsDistillationService } = require('./news/newsDistillationService');
            processedCanonical = await newsDistillationService.batchDistill(newCanonical);
            logger_1.winstonLogger.info(`[NEWS_AI_PIPELINE_COMPLETE] Processed ${processedCanonical.length} articles.`);
        }
        // If all sources failed and returned 0, return cached or fallback
        if (processedCanonical.length === 0 && existingArticles.length === 0) {
            logger_1.winstonLogger.warn('[NEWS_REFRESH_EMPTY] Zero articles ingested; serving memory or local fallback.');
            const cached = cacheService_1.cacheService.get(NEWS_CACHE_KEY);
            return cached || readLocalNewsFallback();
        }
        // Non-destructive DB persistence (additive upsert with legacy schema fallback)
        if (processedCanonical.length > 0 && (0, supabase_1.isSupabaseConfigured)()) {
            try {
                const payload = transformToDatabasePayload(processedCanonical);
                const { error } = await supabase_1.supabase
                    .from('railway_news')
                    .upsert(payload, { onConflict: 'id' });
                if (error) {
                    // If Supabase table does not have new additive columns yet, fallback to legacy schema
                    if (error.message?.includes('column') || error.code === 'PGRST204') {
                        logger_1.winstonLogger.info('[NEWS_DB_UPSERT_LEGACY_FALLBACK] Retrying with legacy schema columns...');
                        const legacyPayload = newCanonical.map(a => ({
                            id: a.id,
                            title: a.title,
                            summary: a.summary,
                            source_name: a.source_name,
                            source_url: a.source_url,
                            published_at: a.published_at,
                            category: a.category,
                            image_url: a.image_url,
                            updated_at: new Date().toISOString(),
                        }));
                        const { error: legacyErr } = await supabase_1.supabase
                            .from('railway_news')
                            .upsert(legacyPayload, { onConflict: 'id' });
                        if (legacyErr) {
                            logger_1.winstonLogger.warn('[NEWS_DB_LEGACY_UPSERT_FAIL]', { error: legacyErr.message });
                        }
                        else {
                            logger_1.winstonLogger.info('[NEWS_DB_LEGACY_UPSERT_SUCCESS]', { count: legacyPayload.length });
                        }
                    }
                    else {
                        logger_1.winstonLogger.warn('[NEWS_DB_UPSERT_FAIL]', { error: error.message });
                    }
                }
                else {
                    logger_1.winstonLogger.info('[NEWS_DB_UPSERT_SUCCESS]', { count: processedCanonical.length });
                }
            }
            catch (err) {
                logger_1.winstonLogger.error('[NEWS_DB_UPSERT_ERROR]', { error: err.message });
            }
        }
        // Combine newly ingested articles + existing articles, filter out rejected ones, filter by 48h freshness for breaking news, sort newest first
        const combined = [...processedCanonical, ...existingArticles];
        const seenIds = new Set();
        const fortyEightHoursAgoTime = Date.now() - 48 * 60 * 60 * 1000;
        const finalArticles = combined
            .filter(a => {
            if (seenIds.has(a.id))
                return false;
            seenIds.add(a.id);
            return new Date(a.published_at).getTime() >= fortyEightHoursAgoTime;
        })
            .sort((a, b) => new Date(b.published_at).getTime() - new Date(a.published_at).getTime())
            .slice(0, MAX_TOTAL_ARTICLES)
            .map(canonicalToLegacyArticle);
        // Update in-process cache and local storage
        cacheService_1.cacheService.set(NEWS_CACHE_KEY, finalArticles, NEWS_CACHE_TTL);
        writeLocalNewsFallback(finalArticles);
        logger_1.winstonLogger.info('[NEWS_REFRESH_COMPLETE]', { count: finalArticles.length });
        return finalArticles;
    },
    /**
     * Returns source health metrics for monitoring and admin diagnostics.
     */
    getSourceHealthSummary: () => {
        return newsSourceRegistry_1.newsSourceRegistry.getHealthSummary();
    },
    /**
     * Triggers push notification for high-priority rail updates.
     */
    triggerPushAlert: async (article) => {
        const alertCategories = ['Delays', 'Cancellation', 'Safety', 'Operations'];
        if (alertCategories.includes(article.category)) {
            logger_1.winstonLogger.info(`[PUSH_ALERT] Broadcasting alert: ${article.title}`);
            try {
                const { broadcastToTopic } = require('./firebaseService');
                const topic = article.category.toLowerCase().replace(/\s+/g, '_');
                await broadcastToTopic(topic, `🚨 ${article.category}`, article.title);
            }
            catch (err) {
                logger_1.winstonLogger.warn('[PUSH_ALERT_FAIL]', { error: err.message });
            }
        }
    },
};
