import { winstonLogger } from '../middleware/logger';
import { cacheService } from './cacheService';
import { supabase } from '../config/supabase';
import Parser from 'rss-parser';
import crypto from 'crypto';

// ─── Interface ────────────────────────────────────────────────────────────────

export interface NewsArticle {
  id: string;
  title: string;
  summary: string;
  sourceName: string;
  sourceUrl: string;
  publishedAt: string;
  category: string;
  imageUrl: string | null;
}

// ─── Constants ────────────────────────────────────────────────────────────────

const NEWS_CACHE_KEY = 'railway_news_v2';
const NEWS_CACHE_TTL = 30 * 60; // 30 minutes
const MAX_ARTICLES_PER_FEED = 200;
const MAX_TOTAL_ARTICLES = 40;

// ─── RSS Sources ──────────────────────────────────────────────────────────────
// Priority order: official government sources first, then trusted media.
// PIB feed removed due to persistent HTTP 403 errors (PHASE_4C756 diagnostic)

const NEWS_SOURCES = [
  {
    name: 'The Hindu',
    url: 'https://www.thehindu.com/news/national/feeder/default.rss',
    category: 'Railway Updates',
  },
  {
    name: 'Times of India (Business)',
    url: 'https://timesofindia.indiatimes.com/rssfeeds/1898055.cms',
    category: 'Railway Updates',
  },
  {
    name: 'Times of India (India)',
    url: 'https://timesofindia.indiatimes.com/rssfeeds/-2128936835.cms',
    category: 'Railway Updates',
  },
  {
    name: 'Indian Express',
    url: 'https://indianexpress.com/section/india/feed/',
    category: 'Railway Updates',
  },
  {
    name: 'Hindustan Times',
    url: 'https://www.hindustantimes.com/feeds/rss/india-news/rssfeed.xml',
    category: 'Railway Updates',
  },
  {
    name: 'News18',
    url: 'https://www.news18.com/rss/india.xml',
    category: 'Railway Updates',
  },
  {
    name: 'NDTV',
    url: 'https://feeds.feedburner.com/ndtvnews-india-news',
    category: 'Railway Updates',
  },
];

// ─── Schema Transformation ────────────────────────────────────────────────────
// Transforms NewsArticle (camelCase) → railway_news table (snake_case)

function transformForDatabase(articles: NewsArticle[]): any[] {
  return articles.map(article => ({
    id: article.id,
    title: article.title,
    summary: article.summary,
    source_name: article.sourceName,
    source_url: article.sourceUrl,
    published_at: article.publishedAt,
    category: article.category,
    image_url: article.imageUrl,
    updated_at: new Date().toISOString(),
  }));
}

// ─── Railway relevance filter ───────────────────────────────────────────────────
// Drops articles from broad feeds (PIB, ToI, IE) that have no railway relevance.

function isRailwayRelevant(title: string, summary: string, sourceName: string): boolean {
  const text = (title + ' ' + summary).toLowerCase();

  // 1. REJECT CATEGORY PENALTIES
  let penalty = 0;

  // General politics & elections
  if (/\b(elections?|polls?|voting|voters?|constituency|constituencies|seat\s+sharing|bjp|congress|political\s+rally|campaigning|opposition\s+party|parties|parliament\s+session|parliamentary)\b/i.test(text)) {
    penalty += 60;
  }

  // Minister speeches (unless specifically containing high-score railway words)
  const isRailwaySpecific = /\b(indian\s+railways?|irctc|vande\s+bharat|railway\s+board|railway\s+ministry|ministry\s+of\s+railways)\b/i.test(text);
  if (!isRailwaySpecific && /\b(speeches?|addressed|addresses|remarks|tribute|condolences?|mourns?|demise|death\s+anniversary)\b/i.test(text)) {
    penalty += 50;
  }

  // Obituaries
  if (/\b(obituary|demise|passes\s+away|mourned|condolences?|tribute\s+to|sad\s+demise|posthumous|funeral)\b/i.test(text)) {
    penalty += 80;
  }

  // Education (exclude unless this is specifically a RAILWAY recruitment/exam article).
  // PHASE_4C796 FIX: bare 'recruitment' without 'rrb' / 'railway' must NOT suppress education penalty.
  // The false positive 'Maharashtra teacher recruitment test cancelled' had recruitment=true
  // but zero railway context — the guard was too broad.
  const isRailwayRecruitment = /\b(rrb|railway\s+recruitment|railway\s+jobs?|railway\s+exam|rrc|ntpc\s+cbt)\b/i.test(text);
  if (!isRailwayRecruitment && /\b(schools?|colleges?|universit(y|ies)|admissions?|board\s+exams?|results?|syllabus|students?|education|academics?|teachers?|paper\s+leak|tet\b|cet\b|neet\b|jee\b|upsc\b|mpsc\b|entrance\s+exams?|eligibility\s+test)\b/i.test(text)) {
    penalty += 60;
  }

  // Farming / Agriculture (exclude unless track blockade/protest is mentioned)
  const isBlockade = /\b(protests?|blockade|tracks?|agitation|disrupt(ed|ion)?)\b/i.test(text);
  if (!isBlockade && /\b(farming|farmers?|crops?|agriculture|harvest|sowing|cultivation)\b/i.test(text)) {
    penalty += 60;
  }

  // Crime
  const isRailwayCrime = /\b(train|station|railway|platform)\b/i.test(text);
  if (!isRailwayCrime && /\b(murder(ed)?|kidnap(ped)?|smuggling|extortion|robbery|heist|arrested\s+for|police\s+custody|convicted|court\s+sentenced)\b/i.test(text)) {
    penalty += 50;
  }

  // Celebrity / Entertainment
  if (/\b(bollywood|hollywood|actors?|actress|movies?|films?|box\s+office|celebrity|singer|concerts?|song|album|releasing\s+date|theatre|music\s+video)\b/i.test(text)) {
    penalty += 80;
  }

  // Sports
  if (/\b(sports|cricket|football|hockey|tennis|olympics|ipl|dhoni|kohli|world\s+cup|trophy|athletics|medals?|badminton|wimbledon|stadium)\b/i.test(text)) {
    penalty += 80;
  }

  // Metro-only exclusion
  if (/\bmetros?\b/i.test(text)) {
    const hasStrongNationalRailway = /\b(indian\s+railways?|irctc|vande\s+bharat|railway\s+board|railway\s+ministry|ministry\s+of\s+railways)\b/i.test(text);
    if (!hasStrongNationalRailway) {
      penalty += 80;
    }
  }

  // 2. POSITIVE WEIGHTED SCORING
  let score = 0;

  // Extremely High Quality Indicators (+50 points each)
  const primaryIndicators = [
    /\bindian\s+railways?\b/i,
    /\birctc\b/i,
    /\bvande\s+bharat\b/i,
    /\bbullet\s+trains?\b/i,
    /\brailway\s+board\b/i,
    /\b(railway\s+)?minist(er|ry)\b/i,
    /\bamrit\s+bharat\b/i,
    /\brrb\b/i,
    /\brail(way)?\s+budget\b/i,
    /\b(train|railway)\s+cancellations?\b/i,
    /\b(train|railway)\s+diversions?\b/i,
    /\bderail(ment)?|train\s+accidents?\b/i
  ];
  primaryIndicators.forEach(regex => {
    if (regex.test(text)) {
      score += 50;
    }
  });

  // Secondary Railway terms (+30 points each)
  const secondaryIndicators = [
    /\btrains?\b/i,
    /\brailways?\b/i,
    /\brail\b/i, // standalone word
    /\blocomotives?|locos?\b/i,
    /\brailway\s+stations?\b/i,
    /\bplatforms?\b/i,
    /\bfreight|goods\s+trains?\b/i,
    /\bjunctions?\b/i,
    /\btatkals?\b/i,
    /\bpnr\b/i,
    /\bwaitlists?\b/i,
    /\bsleeper\s+class\b/i,
    /\brailway\s+coaches?\b/i,
    /\bpassenger\s+services?\b/i,
    /\bstation\s+development\b/i,
    /\brail(way)?\s+safety\b/i,
    /\bdivisional\s+railway\s+manager|drm\b/i,
    /\bgoods\s+sheds?\b/i,
    // PHASE_4C796: targeted additions to fix FN articles with thin context
    /\bflagged\s+off\b/i,                    // train inauguration phrasing
    /\blhb\s+coaches?\b/i,                   // LHB (Linke-Hofmann-Busch) coaches
    /\brailway\s+bridge\b/i,                 // bridge infrastructure stories
    /\bkonkan\s+railway\b/i,                 // named railway zone
    /\bcentral\s+railway\b/i,               // named railway zone
    /\bwestern\s+railway\b/i,               // named railway zone
    /\b(southern|northern|eastern|western|south\s+eastern|north\s+eastern|northeast\s+frontier)\s+railway\b/i, // all zones
    /\btrain\s+services?\s+suspended\b/i,   // service suspension phrasing
    /(रेल|ट्रेन|रेलवे)/i
  ];
  secondaryIndicators.forEach(regex => {
    if (regex.test(text)) {
      score += 30;
    }
  });

  // Supporting/Contextual terms (+20 points each)
  const contextualIndicators = [
    /\bbooking|reservation\b/i,
    /\btickets?\b/i,
    /\btimetables?\b/i,
    /\bdelays?|late\s+running\b/i,
    /\bschedule\b/i,
    /\bcollision|crash|accident\b/i,
    /\bsafety\b/i,
    /\brecruitment\b/i,
    /\bdevelopment|upgrade\b/i,
    /\bdivert(ed)?|cancell(ed)?|restored\b/i,
    // PHASE_4C796: additional contextual terms
    /\bsuspended?\b/i,        // train service suspension
    /\brefund\b/i,            // IRCTC refund policy stories
    /\binaugurat(ed|ion)?\b/i, // infrastructure/train inaugurations
  ];
  contextualIndicators.forEach(regex => {
    if (regex.test(text)) {
      score += 20;
    }
  });

  // Combination Bonus rule (+30 points)
  const hasRailwayBase = /\b(trains?|railways?|rail|station|platform|junction|locomotive|locos?)\b/i.test(text) || /(रेल|ट्रेन|रेलवे)/i.test(text);
  const hasOperationalEvent = /\b(cancell(ed|ation)?|divert(ed|sion)?|delay(ed)?|late|running|booking|reservation|tickets?|timetable|schedule|derail(ment)?|accident|crash|collision|safety|recruitment|upgrade|development|restored)\b/i.test(text);
  if (hasRailwayBase && hasOperationalEvent) {
    score += 30;
  }

  const finalScore = Math.max(0, score - penalty);
  const isRelevant = finalScore >= 80;

  if (isRelevant) {
    winstonLogger.info(`[NEWS_RELEVANCE_PASS] "${title.slice(0, 60)}" | Score: ${finalScore} | Positives: ${score} | Penalty: ${penalty}`);
  } else {
    winstonLogger.debug(`[NEWS_RELEVANCE_FAIL] "${title.slice(0, 60)}" | Score: ${finalScore} | Positives: ${score} | Penalty: ${penalty}`);
  }

  return isRelevant;
}

// ─── Category classifier ──────────────────────────────────────────────────────

function classifyCategory(title: string, summary: string): string {
  const text = (title + ' ' + summary).toLowerCase();
  if (/cancel|cancelled|suspension|suspended/.test(text)) return 'Cancellation';
  if (/delay|late|slow|fog|monsoon|rainfall|flood|landslide|derail/.test(text)) return 'Delays';
  if (/tatkal|premium tatkal/.test(text)) return 'Tatkal';
  if (/new train|new route|launch|inaugurate|new express|new superfast/.test(text)) return 'New Routes';
  if (/irctc|booking|ticket|reservation|waitlist|chart/.test(text)) return 'IRCTC';
  if (/vande bharat|bullet train|high.?speed|semi.?high/.test(text)) return 'Vande Bharat';
  if (/accident|crash|collision|derailment/.test(text)) return 'Safety';
  if (/strike|protest|agitation/.test(text)) return 'Operations';
  if (/fare|price|hike|revision|charge/.test(text)) return 'Fares';
  if (/platform|station|terminal|junction/.test(text)) return 'Infrastructure';
  return 'Railway Updates';
}

// ─── Image extractor ──────────────────────────────────────────────────────────

function extractImage(item: any): string | null {
  // Try media:content, enclosure, or content fields
  const media = item['media:content'] || item['media:thumbnail'];
  if (media && typeof media === 'object' && media.$ && media.$.url) return media.$.url;
  if (item.enclosure && item.enclosure.url && item.enclosure.type?.startsWith('image')) return item.enclosure.url;
  // Try to extract from content HTML
  if (item.content || item['content:encoded']) {
    const html = item.content || item['content:encoded'] || '';
    const match = html.match(/<img[^>]+src=["']([^"']+)["']/i);
    if (match) return match[1];
  }
  return null;
}

// ─── RSS Parser ───────────────────────────────────────────────────────────────
// PHASE_4C756: RSS reader headers - NO Accept-Encoding (gzip causes binary response that parser can't decompress)

const parser = new Parser({
  timeout: 10000,
  headers: {
    'User-Agent': 'FeedParser/6.0 (+https://trayago.in)',
    'Accept': 'application/rss+xml, application/xml, text/xml, */*',
  },
  customFields: {
    item: ['source', 'media:content', 'media:thumbnail', 'content:encoded', 'enclosure'],
  },
});

// ─── Retry Logic ──────────────────────────────────────────────────────────────
// PHASE_4C756: Exponential backoff for transient 503/timeout errors

async function fetchWithRetry(
  url: string,
  maxRetries: number = 3,
  baseDelay: number = 1000
): Promise<any> {
  let lastError: any;
  
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      const feed = await parser.parseURL(url);
      return feed;
    } catch (err: any) {
      lastError = err;
      
      // Don't retry on permanent failures (403, 404, invalid feed)
      const isPermanent = 
        err.message?.includes('403') ||
        err.message?.includes('404') ||
        err.message?.includes('Invalid XML') ||
        err.message?.includes('Not Found');
      
      if (isPermanent || attempt === maxRetries) {
        throw err;
      }
      
      // Exponential backoff: 1s, 2s, 4s
      const delay = baseDelay * Math.pow(2, attempt - 1);
      winstonLogger.warn(
        `[NEWS_FETCH_RETRY] Attempt ${attempt}/${maxRetries} failed, retrying in ${delay}ms: ${err.message}`,
        { url }
      );
      await new Promise(resolve => setTimeout(resolve, delay));
    }
  }
  
  throw lastError;
}

// ─── Status Code Helper ───────────────────────────────────────────────────────
// PHASE_4C756: Enhanced error logging

function getStatusCode(error: any): string {
  const msg = error.message || '';
  if (msg.includes('403')) return 'SOURCE_HTTP_403';
  if (msg.includes('503')) return 'SOURCE_HTTP_503';
  if (msg.includes('timeout') || msg.includes('ETIMEDOUT')) return 'SOURCE_TIMEOUT';
  if (msg.includes('ENOTFOUND') || msg.includes('ECONNREFUSED')) return 'SOURCE_UNREACHABLE';
  if (msg.includes('Invalid XML')) return 'SOURCE_INVALID_FEED';
  return 'SOURCE_ERROR';
}

// ─── Deduplication ────────────────────────────────────────────────────────────

function deduplicateArticles(articles: NewsArticle[]): NewsArticle[] {
  const seen = new Set<string>();
  return articles.filter(article => {
    // Deduplicate strictly by the generated ID to prevent DB upsert conflicts
    if (seen.has(article.id)) return false;
    seen.add(article.id);
    return true;
  });
}

// ─── Source URL validator ─────────────────────────────────────────────────────

function isValidSourceUrl(url: string | undefined | null): boolean {
  if (!url || url === '#' || url.trim() === '') return false;
  try {
    const u = new URL(url);
    return u.protocol === 'https:' || u.protocol === 'http:';
  } catch {
    return false;
  }
}

// ─── Feed fetcher ─────────────────────────────────────────────────────────────

async function fetchFeed(source: typeof NEWS_SOURCES[0]): Promise<{ accepted: NewsArticle[], rejected: number }> {
  const articles: NewsArticle[] = [];
  let rejectedCount = 0;
  const start = Date.now();
  try {
    winstonLogger.info(`[NEWS_FETCH_START] Fetching feed: ${source.name}`);
    const feed = await fetchWithRetry(source.url); // PHASE_4C756: Use retry wrapper
    
    const rawCount = feed.items?.length || 0;
    winstonLogger.info(`[NEWS_FETCH_RAW] ${source.name}: ${rawCount} raw items received`);
    
    let filteredCount = 0;
    let relevanceDropped = 0;
    let urlDropped = 0;
    let titleDropped = 0;
    
    for (const item of (feed.items || []).slice(0, MAX_ARTICLES_PER_FEED)) {
      const title = (item.title || '').trim();
      if (!title || title.length < 10) {
        titleDropped++;
        rejectedCount++;
        continue;
      }

      // Validate source URL — skip article if link is dead/missing
      const rawLink = item.link || item.guid || '';
      if (!isValidSourceUrl(rawLink)) {
        urlDropped++;
        rejectedCount++;
        winstonLogger.debug(`[NEWS_FETCH_URL_DROP] ${source.name}: "${title.slice(0, 50)}" — invalid URL: ${rawLink}`);
        continue;
      }

      const summary = (item.contentSnippet || item.summary || item.content || '')
        .replace(/<[^>]+>/g, '')
        .trim()
        .slice(0, 300);

      // Railway relevance guard — filters out off-topic articles from broad feeds
      if (!isRailwayRelevant(title, summary || '', source.name)) {
        relevanceDropped++;
        rejectedCount++;
        winstonLogger.debug(`[NEWS_FETCH_RELEVANCE_DROP] ${source.name}: "${title.slice(0, 50)}"`);
        continue;
      }

      const category = classifyCategory(title, summary);

      // publishedAt: prefer pubDate, then isoDate, then current time
      // PIB often omits per-item dates — acceptable to use fetch time
      const publishedAt = item.pubDate
        ? new Date(item.pubDate).toISOString()
        : item.isoDate
          ? new Date(item.isoDate).toISOString()
          : new Date().toISOString();

      // Determine source name: for Google News results the publisher is in item.source
      let sourceName = source.name;
      if (item.source && typeof item.source === 'string' && item.source.trim()) {
        sourceName = item.source.trim();
      } else if (item.source && typeof item.source === 'object' && (item.source as any).name) {
        sourceName = (item.source as any).name;
      }

      const id = crypto.createHash('md5')
        .update(title.slice(0, 60) + publishedAt.slice(0, 10))
        .digest('hex');

      articles.push({
        id,
        title,
        summary: summary || 'Read the full article for details.',
        sourceName,
        sourceUrl: rawLink,
        publishedAt,
        category,
        imageUrl: extractImage(item),
      });
      
      filteredCount++;
    }
    
    const fetchLatency = Date.now() - start;
    winstonLogger.info(`[NEWS_FETCH_OBSERVABILITY] SOURCE: ${source.name} | STATUS: SUCCESS | LATENCY: ${fetchLatency}ms | ARTICLE COUNT: ${articles.length}`);
    
    // PHASE_4C756: Enhanced success logging
    if (articles.length > 0) {
      winstonLogger.info(`[SOURCE_SUCCESS] ${source.name}: ${articles.length} articles accepted`);
    }
    winstonLogger.info(`[NEWS_FETCH_COMPLETE] ${source.name}: ${filteredCount} passed filters (dropped: ${relevanceDropped} relevance, ${urlDropped} URL, ${titleDropped} title)`);
    
  } catch (err: any) {
    const fetchLatency = Date.now() - start;
    const statusCode = getStatusCode(err);
    winstonLogger.info(`[NEWS_FETCH_OBSERVABILITY] SOURCE: ${source.name} | STATUS: FAILED (${statusCode}) | LATENCY: ${fetchLatency}ms | ARTICLE COUNT: 0`);
    
    // PHASE_4C756: Enhanced error logging with status codes
    const stackPreview = err.stack ? err.stack.split('\n').slice(0, 3).join('\n') : '';
    winstonLogger.error(`[${statusCode}] ${source.name} failed: ${err.message}`, { 
      url: source.url,
      stackPreview
    });
  }
  return { accepted: articles, rejected: rejectedCount };
}

// ─── Main service ─────────────────────────────────────────────────────────────

export const railwayNewsService = {
  /**
   * Returns the latest railway news articles.
   * Serves from 30-minute cache; fetches fresh on cache miss.
   * Falls back to database if cache empty.
   */
  getLatestNews: async (): Promise<NewsArticle[]> => {
    // 1. Serve from cache if warm
    const cached = cacheService.get<NewsArticle[]>(NEWS_CACHE_KEY);
    if (cached && cached.length > 0) {
      winstonLogger.info('[NEWS_CACHE_HIT] Serving from cache', { count: cached.length });
      return cached;
    }

    winstonLogger.info('[NEWS_CACHE_MISS] Cache empty, checking database...');

    // 2. Database fallback layer (Filter out older than 48h)
    const fortyEightHoursAgo = new Date(Date.now() - 48 * 60 * 60 * 1000).toISOString();
    try {
      const { data: dbArticles, error } = await supabase
        .from('railway_news')
        .select('*')
        .gte('published_at', fortyEightHoursAgo)
        .order('published_at', { ascending: false })
        .limit(MAX_TOTAL_ARTICLES);

      if (error) {
        winstonLogger.warn('[NEWS_DB_FALLBACK] Database query failed', { error: error.message });
      } else if (dbArticles && dbArticles.length > 0) {
        // Transform snake_case → camelCase
        const rawArticles: NewsArticle[] = dbArticles.map(row => ({
          id: row.id,
          title: row.title,
          summary: row.summary,
          sourceName: row.source_name,
          sourceUrl: row.source_url,
          publishedAt: row.published_at,
          category: row.category,
          imageUrl: row.image_url,
        }));

        // PHASE_4C796 FIX: Re-apply relevance filter on DB articles so stale
        // false-positives stored before filter tightening are evicted on read.
        const articles = rawArticles.filter(a => isRailwayRelevant(a.title, a.summary, a.sourceName));
        const evicted = rawArticles.length - articles.length;
        if (evicted > 0) {
          winstonLogger.info(`[NEWS_DB_FALLBACK] Evicted ${evicted} stale false-positive(s) from DB result`);
        }

        winstonLogger.info('[NEWS_DB_FALLBACK] Serving from database', { count: articles.length });

        // Repopulate cache with filtered set
        cacheService.set(NEWS_CACHE_KEY, articles, NEWS_CACHE_TTL);
        return articles;
      }
    } catch (err: any) {
      winstonLogger.error('[NEWS_DB_FALLBACK] Database error', { error: err.message });
    }

    // 3. Cache and DB both empty → trigger refresh
    return railwayNewsService.refreshNews();
  },

  /**
   * Force-fetches from all RSS sources, deduplicates, sorts newest-first,
   * persists to database, and writes to cache. Called by scheduler every 6 hours and on cache miss.
   */
  refreshNews: async (): Promise<NewsArticle[]> => {
    winstonLogger.info('[NEWS_REFRESH_STARTED] Refreshing news from all sources...');

    // Fetch all feeds in parallel, tolerate individual failures
    const results = await Promise.allSettled(
      NEWS_SOURCES.map(source => fetchFeed(source))
    );

    const allArticles: NewsArticle[] = [];
    let successCount = 0;
    let failCount = 0;
    let totalRejected = 0;
    
    results.forEach((result, i) => {
      if (result.status === 'fulfilled') {
        successCount++;
        winstonLogger.info(`[NEWS_AGGREGATION] ${NEWS_SOURCES[i].name}: ${result.value.accepted.length} articles accepted`);
        allArticles.push(...result.value.accepted);
        totalRejected += result.value.rejected;
      } else {
        failCount++;
        winstonLogger.error(`[NEWS_AGGREGATION] ${NEWS_SOURCES[i].name}: REJECTED — ${result.reason}`);
      }
    });
    
    winstonLogger.info(`[NEWS_AGGREGATION_SUMMARY] ${successCount} feeds succeeded, ${failCount} failed, ${allArticles.length} total articles pre-dedup`);

    if (allArticles.length === 0) {
      winstonLogger.error('[NEWS_REFRESH_FAILED] All feeds failed or returned zero articles — returning stale cache or empty');
      const stale = cacheService.get<NewsArticle[]>(NEWS_CACHE_KEY);
      return stale || [];
    }

    // Deduplicate, drop older than 48h, sort newest-first, cap at MAX_TOTAL_ARTICLES
    const preDedup = allArticles.length;
    const fortyEightHoursAgoTime = Date.now() - 48 * 60 * 60 * 1000;
    
    const deduped = deduplicateArticles(allArticles)
      .filter(a => new Date(a.publishedAt).getTime() >= fortyEightHoursAgoTime)
      .sort((a, b) => new Date(b.publishedAt).getTime() - new Date(a.publishedAt).getTime())
      .slice(0, MAX_TOTAL_ARTICLES);
    
    const dedupDropped = preDedup - deduped.length;
    totalRejected += dedupDropped;

    winstonLogger.info('[NEWS_REFRESH_DEDUP] Deduplication complete', { 
      before: preDedup, 
      after: deduped.length,
      dropped: dedupDropped
    });

    // Clean up expired (>48h) articles during refresh
    try {
      const fortyEightHoursAgo = new Date(Date.now() - 48 * 60 * 60 * 1000).toISOString();
      const { error: delErr } = await supabase
        .from('railway_news')
        .delete()
        .lt('published_at', fortyEightHoursAgo);
      if (delErr) winstonLogger.warn('[NEWS_CLEANUP] Failed to delete expired articles', { error: delErr.message });
      else winstonLogger.info('[NEWS_CLEANUP] Deleted articles older than 48 hours');
    } catch (err: any) {
      winstonLogger.error('[NEWS_CLEANUP] Error', { error: err.message });
    }

    // Database persistence layer (write first, then cache)
    try {
      const dbPayload = transformForDatabase(deduped);

      const { error } = await supabase
        .from('railway_news')
        .upsert(dbPayload, { onConflict: 'id' });

      if (error) {
        winstonLogger.error('[NEWS_REFRESH_DB_UPSERT] Database upsert failed', { 
          error: error.message,
          hint: 'Articles still cached but will not survive restart'
        });
      } else {
        winstonLogger.info('[NEWS_REFRESH_DB_UPSERT] Database persistence complete', { count: deduped.length });
        winstonLogger.info(`[NEWS_AGGREGATION_FINAL_SUMMARY]
Feeds attempted: ${NEWS_SOURCES.length}
Feeds succeeded: ${successCount}
Feeds failed: ${failCount}
Articles accepted: ${allArticles.length}
Articles rejected: ${totalRejected}
Articles stored: ${deduped.length}`);
      }
    } catch (err: any) {
      winstonLogger.error('[NEWS_REFRESH_DB_UPSERT] Database error', { error: err.message });
    }

    // Database consolidation (use DB as canonical cache source)
    try {
      const fortyEightHoursAgo = new Date(Date.now() - 48 * 60 * 60 * 1000).toISOString();
      const { data: dbArticles, error: queryError } = await supabase
        .from('railway_news')
        .select('*')
        .gte('published_at', fortyEightHoursAgo)
        .order('published_at', { ascending: false })
        .limit(MAX_TOTAL_ARTICLES);

      if (queryError) throw queryError;
      
      if (dbArticles && dbArticles.length > 0) {
        const rawConsolidated: NewsArticle[] = dbArticles.map(row => ({
          id: row.id,
          title: row.title,
          summary: row.summary,
          sourceName: row.source_name,
          sourceUrl: row.source_url,
          publishedAt: row.published_at,
          category: row.category,
          imageUrl: row.image_url,
        }));

        // PHASE_4C796 FIX: Re-apply relevance filter on DB consolidation read
        // to evict articles stored before filter was tightened.
        const consolidatedArticles = rawConsolidated.filter(a => isRailwayRelevant(a.title, a.summary, a.sourceName));
        const evicted = rawConsolidated.length - consolidatedArticles.length;
        if (evicted > 0) {
          winstonLogger.info(`[NEWS_CONSOLIDATION] Evicted ${evicted} stale false-positive(s) on consolidation read`);
        }
        
        cacheService.set(NEWS_CACHE_KEY, consolidatedArticles, NEWS_CACHE_TTL);
        winstonLogger.info(`[NEWS_REFRESH_COMPLETE] Cache consolidated from DB: ${consolidatedArticles.length} articles`);
        return consolidatedArticles;
      }
    } catch (err: any) {
      winstonLogger.error('[NEWS_CACHE_CONSOLIDATION] Failed to query DB, falling back to delta cache', { error: err.message });
    }

    // Fallback: Write delta to cache (30 min TTL) if DB query fails or is empty
    cacheService.set(NEWS_CACHE_KEY, deduped, NEWS_CACHE_TTL);
    winstonLogger.info(`[NEWS_REFRESH_COMPLETE] Cache refreshed with delta fallback: ${deduped.length} articles`);

    return deduped;
  },

  /**
   * Triggers push notifications for breaking news alerts via Firebase FCM.
   */
  triggerPushAlert: async (article: NewsArticle) => {
    const alertCategories = ['Delays', 'Cancellation', 'Safety', 'Operations'];
    if (alertCategories.includes(article.category)) {
      winstonLogger.info(`[PUSH_ALERT] Broadcasting alert: ${article.title}`);
      const { broadcastToTopic } = require('./firebaseService');
      const topic = article.category.toLowerCase().replace(/\s+/g, '_');
      await broadcastToTopic(topic, `🚨 ${article.category}`, article.title);
    }
  },
};