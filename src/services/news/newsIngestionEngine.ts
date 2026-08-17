import Parser from 'rss-parser';
import crypto from 'crypto';
import { winstonLogger } from '../../middleware/logger';
import { CanonicalNewsArticle, IngestionResult, NewsSource, RelevanceScoreResult } from './newsTypes';
import { newsSourceRegistry } from './newsSourceRegistry';
import { SimHash } from './simHash';

export class NewsIngestionEngine {
  private parser: Parser;

  constructor() {
    this.parser = new Parser({
      timeout: 10000,
      headers: {
        'User-Agent': 'FeedParser/6.0 (+https://trayago.in)',
        'Accept': 'application/rss+xml, application/xml, text/xml, */*',
      },
      customFields: {
        item: ['source', 'media:content', 'media:thumbnail', 'content:encoded', 'enclosure', 'guid'],
      },
    });
  }

  /**
   * Normalizes an external URL by stripping tracking parameters, hash fragments, and trailing slashes.
   */
  public normalizeUrl(rawUrl: string | undefined | null): string {
    if (!rawUrl || rawUrl.trim() === '' || rawUrl === '#') return '';
    try {
      const u = new URL(rawUrl.trim());
      // Strip common tracking and referral parameters
      const trackingParams = [
        'utm_source', 'utm_medium', 'utm_campaign', 'utm_term', 'utm_content',
        'fbclid', 'gclid', 'msclkid', 'ref', 'source', 'ocid'
      ];
      for (const param of trackingParams) {
        u.searchParams.delete(param);
      }
      u.hash = '';
      let clean = u.toString();
      if (clean.endsWith('/') && clean.length > (u.protocol + '//' + u.host).length + 1) {
        clean = clean.slice(0, -1);
      }
      return clean;
    } catch {
      return rawUrl.trim();
    }
  }

  /**
   * Generates a safe, clean SEO URL slug from an article title and publication date.
   */
  public generateSlug(title: string, publishedAt: string): string {
    const dateStr = publishedAt ? publishedAt.slice(0, 10) : new Date().toISOString().slice(0, 10);
    const cleanTitle = title
      .toLowerCase()
      .replace(/[^\w\s-]/g, '')
      .trim()
      .replace(/\s+/g, '-')
      .slice(0, 70)
      .replace(/-+$/, '');
    return `${cleanTitle}-${dateStr}`;
  }

  /**
   * Evaluates if an article is strictly relevant to Indian Railways.
   * Employs deterministic positive weights and domain-specific negative penalties.
   */
  public evaluateRelevance(title: string, summary: string, sourceName: string): RelevanceScoreResult {
    const text = (title + ' ' + summary).toLowerCase();

    // 1. REJECT CATEGORY PENALTIES
    let penalty = 0;

    // General politics & elections
    if (/\b(elections?|polls?|voting|voters?|constituency|constituencies|seat\s+sharing|bjp|congress|political\s+rally|campaigning|opposition\s+party|parties|parliament\s+session|parliamentary)\b/i.test(text)) {
      penalty += 60;
    }

    // Speeches/Condolences (unless specifically containing strong railway phrases)
    const isRailwaySpecific = /\b(indian\s+railways?|irctc|vande\s+bharat|railway\s+board|railway\s+ministry|ministry\s+of\s+railways)\b/i.test(text);
    if (!isRailwaySpecific && /\b(speeches?|addressed|addresses|remarks|tribute|condolences?|mourns?|demise|death\s+anniversary)\b/i.test(text)) {
      penalty += 50;
    }

    // Obituaries
    if (/\b(obituary|demise|passes\s+away|mourned|condolences?|tribute\s+to|sad\s+demise|posthumous|funeral)\b/i.test(text)) {
      penalty += 80;
    }

    // Education (exclude unless this is specifically a RAILWAY recruitment/exam)
    const isRailwayRecruitment = /\b(rrb|railway\s+recruitment|railway\s+jobs?|railway\s+exam|rrc|ntpc\s+cbt)\b/i.test(text);
    if (!isRailwayRecruitment && /\b(schools?|colleges?|universit(y|ies)|admissions?|board\s+exams?|results?|syllabus|students?|education|academics?|teachers?|paper\s+leak|tet\b|cet\b|neet\b|jee\b|upsc\b|mpsc\b|entrance\s+exams?|eligibility\s+test)\b/i.test(text)) {
      penalty += 60;
    }

    // Farming / Agriculture
    const isBlockade = /\b(protests?|blockade|tracks?|agitation|disrupt(ed|ion)?)\b/i.test(text);
    if (!isBlockade && /\b(farming|farmers?|crops?|agriculture|harvest|sowing|cultivation)\b/i.test(text)) {
      penalty += 60;
    }

    // Generic Crime without railway context
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

    // 2. POSITIVE INDICATORS
    let score = 0;

    // Primary High-Value Indicators (+50 points each)
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
    for (const regex of primaryIndicators) {
      if (regex.test(text)) score += 50;
    }

    // Secondary Indicators (+30 points each)
    const secondaryIndicators = [
      /\btrains?\b/i,
      /\brailways?\b/i,
      /\brail\b/i,
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
      /\bflagged\s+off\b/i,
      /\blhb\s+coaches?\b/i,
      /\brailway\s+bridge\b/i,
      /\bkonkan\s+railway\b/i,
      /\bcentral\s+railway\b/i,
      /\bwestern\s+railway\b/i,
      /\b(southern|northern|eastern|western|south\s+eastern|north\s+eastern|northeast\s+frontier)\s+railway\b/i,
      /\btrain\s+services?\s+suspended\b/i,
      /(रेल|ट्रेन|रेलवे)/i
    ];
    for (const regex of secondaryIndicators) {
      if (regex.test(text)) score += 30;
    }

    // Contextual Indicators (+20 points each)
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
      /\bsuspended?\b/i,
      /\brefund\b/i,
      /\binaugurat(ed|ion)?\b/i
    ];
    for (const regex of contextualIndicators) {
      if (regex.test(text)) score += 20;
    }

    // Combination Bonus (+30 points)
    const hasRailwayBase = /\b(trains?|railways?|rail|station|platform|junction|locomotive|locos?)\b/i.test(text) || /(रेल|ट्रेन|रेलवे)/i.test(text);
    const hasOperationalEvent = /\b(cancell(ed|ation)?|divert(ed|sion)?|delay(ed)?|late|running|booking|reservation|tickets?|timetable|schedule|derail(ment)?|accident|crash|collision|safety|recruitment|upgrade|development|restored)\b/i.test(text);
    if (hasRailwayBase && hasOperationalEvent) {
      score += 30;
    }

    // Foreign policy penalty
    if (/\b(foreign\s+minister|external\s+affairs|embassy|ambassador|bilateral|geopolitics|sanctions|diplomacy|visa|passport)\b/i.test(text)) {
      const isRailwayInternational = /\b(bullet\s+train\s+project|japan|shinkansen|high.?speed\s+rail\s+project|india.japan)\b/i.test(text);
      if (!isRailwayInternational) penalty += 70;
    }

    const finalScore = Math.max(0, score - penalty);
    const isRelevant = finalScore >= 120;

    let rejectionReason: RelevanceScoreResult['rejectionReason'] = undefined;
    if (!isRelevant) {
      rejectionReason = penalty >= 50 ? 'OFF_TOPIC' : 'LOW_RELEVANCE';
    }

    return {
      isRelevant,
      score: finalScore,
      positiveScore: score,
      penalty,
      rejectionReason,
    };
  }

  /**
   * Classifies an article into a standard passenger category.
   */
  public classifyCategory(title: string, summary: string): string {
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

  /**
   * Extracts train numbers (5 digits) from article text.
   */
  public extractTrainNumbers(text: string): string[] {
    const matches = text.match(/\b(1\d{4}|2\d{4}|0\d{4})\b/g);
    if (!matches) return [];
    return Array.from(new Set(matches));
  }

  /**
   * Extracts potential railway station codes (2 to 4 capital letters) from article text.
   */
  public extractStationCodes(text: string): string[] {
    const matches = text.match(/\b([A-Z]{2,4})\b/g);
    if (!matches) return [];
    // Filter common words that look like station codes
    const blacklist = new Set(['IRCTC', 'PIB', 'NEW', 'THE', 'AND', 'FOR', 'NOT', 'ALL', 'OFF', 'ANY', 'OUT', 'GET', 'RUN']);
    return Array.from(new Set(matches.filter(m => !blacklist.has(m))));
  }

  /**
   * Extracts media image from feed item.
   */
  private extractImage(item: any): string | null {
    const media = item['media:content'] || item['media:thumbnail'];
    if (media && typeof media === 'object' && media.$ && media.$.url) return media.$.url;
    if (item.enclosure && item.enclosure.url && item.enclosure.type?.startsWith('image')) return item.enclosure.url;
    if (item.content || item['content:encoded']) {
      const html = item.content || item['content:encoded'] || '';
      const match = html.match(/<img[^>]+src=["']([^"']+)["']/i);
      if (match) return match[1];
    }
    return null;
  }

  /**
   * Fetches an RSS feed with retry and exponential backoff.
   */
  public async fetchFeedWithRetry(
    url: string,
    maxRetries: number = 3,
    baseDelayMs: number = 1000
  ): Promise<any> {
    let lastError: any;
    for (let attempt = 1; attempt <= maxRetries; attempt++) {
      try {
        const feed = await this.parser.parseURL(url);
        return feed;
      } catch (err: any) {
        lastError = err;
        const msg = err.message || '';
        const isPermanent =
          msg.includes('403') ||
          msg.includes('404') ||
          msg.includes('Invalid XML') ||
          msg.includes('Not Found');

        if (isPermanent || attempt === maxRetries) {
          throw err;
        }

        const delay = baseDelayMs * Math.pow(2, attempt - 1);
        winstonLogger.warn(`[NEWS_FETCH_RETRY] Attempt ${attempt}/${maxRetries} failed: ${msg}. Retrying in ${delay}ms`);
        await new Promise(res => setTimeout(res, delay));
      }
    }
    throw lastError;
  }

  /**
   * Ingests news from a single source.
   */
  public async ingestSource(
    source: NewsSource,
    existingArticles: CanonicalNewsArticle[] = []
  ): Promise<IngestionResult> {
    const start = Date.now();
    const result: IngestionResult = {
      sourceId: source.id,
      sourceName: source.name,
      status: 'SUCCESS',
      totalRaw: 0,
      accepted: [],
      rejectedCount: 0,
      rejectedReasons: {},
      latencyMs: 0,
    };

    if (!newsSourceRegistry.canAttempt(source.id)) {
      winstonLogger.warn(`[NEWS_INGESTION_SKIPPED] Source ${source.name} circuit-broken. Skipping.`);
      result.status = 'SKIPPED';
      return result;
    }

    try {
      const feed = await this.fetchFeedWithRetry(source.url);
      const items = feed.items || [];
      result.totalRaw = items.length;

      const maxItems = source.maxItemsPerFetch || 50;
      for (const item of items.slice(0, maxItems)) {
        const title = (item.title || '').trim();
        if (!title || title.length < 10) {
          result.rejectedCount++;
          result.rejectedReasons['MALFORMED_TITLE'] = (result.rejectedReasons['MALFORMED_TITLE'] || 0) + 1;
          continue;
        }

        const rawUrl = item.link || item.guid || '';
        const cleanUrl = this.normalizeUrl(rawUrl);
        if (!cleanUrl || !cleanUrl.startsWith('http')) {
          result.rejectedCount++;
          result.rejectedReasons['MALFORMED_URL'] = (result.rejectedReasons['MALFORMED_URL'] || 0) + 1;
          continue;
        }

        const summary = (item.contentSnippet || item.summary || item.content || '')
          .replace(/<[^>]+>/g, '')
          .trim()
          .slice(0, 400);

        // Relevance evaluation
        const relEval = this.evaluateRelevance(title, summary, source.name);
        if (!relEval.isRelevant) {
          result.rejectedCount++;
          const reason = relEval.rejectionReason || 'LOW_RELEVANCE';
          result.rejectedReasons[reason] = (result.rejectedReasons[reason] || 0) + 1;
          continue;
        }

        const publishedAt = item.pubDate
          ? new Date(item.pubDate).toISOString()
          : item.isoDate
            ? new Date(item.isoDate).toISOString()
            : new Date().toISOString();

        // Source publisher name
        let publisher = source.name;
        if (item.source && typeof item.source === 'string' && item.source.trim()) {
          publisher = item.source.trim();
        } else if (item.source && typeof item.source === 'object' && (item.source as any).name) {
          publisher = (item.source as any).name;
        }

        const contentHash = crypto
          .createHash('sha256')
          .update((title + ' ' + summary).toLowerCase().trim())
          .digest('hex');

        const simhash = SimHash.compute(title + ' ' + summary);

        // Multi-layer deduplication against currently accepted and existing articles
        const isDuplicate = this.isDuplicateArticle(
          cleanUrl,
          item.guid || null,
          contentHash,
          simhash,
          [...existingArticles, ...result.accepted]
        );

        if (isDuplicate) {
          result.rejectedCount++;
          result.rejectedReasons['DUPLICATE'] = (result.rejectedReasons['DUPLICATE'] || 0) + 1;
          continue;
        }

        const id = crypto
          .createHash('md5')
          .update(title.slice(0, 60) + publishedAt.slice(0, 10))
          .digest('hex');

        const slug = this.generateSlug(title, publishedAt);
        const category = this.classifyCategory(title, summary);
        const affectedTrains = this.extractTrainNumbers(title + ' ' + summary);
        const affectedStations = this.extractStationCodes(title + ' ' + summary);

        const now = new Date().toISOString();
        const article: CanonicalNewsArticle = {
          id,
          slug,
          title,
          seo_title: title.slice(0, 60),
          meta_description: summary.slice(0, 155),
          summary: summary || 'Detailed report from official railway updates.',
          key_takeaways: [],
          affected_trains: affectedTrains,
          affected_stations: affectedStations,
          category,
          source_name: publisher,
          source_url: cleanUrl,
          source_id: source.id,
          source_tier: source.tier,
          source_guid: item.guid || null,
          content_hash: contentHash,
          simhash,
          relevance_score: relEval.score,
          image_url: this.extractImage(item),
          status: 'READY_FOR_AI',
          ingestion_status: 'PENDING_AI',
          first_seen_at: now,
          last_seen_at: now,
          published_at: publishedAt,
          created_at: now,
          updated_at: now,
        };

        result.accepted.push(article);
      }

      result.latencyMs = Date.now() - start;
      newsSourceRegistry.recordSuccess(source.id, result.latencyMs);
      return result;
    } catch (err: any) {
      result.latencyMs = Date.now() - start;
      result.status = 'FAILED';
      const errMsg = err?.message || 'Unknown fetch error';
      result.error = errMsg;
      newsSourceRegistry.recordFailure(source.id, errMsg, result.latencyMs);
      winstonLogger.error(`[NEWS_INGESTION_SOURCE_FAIL] Source ${source.name} failed: ${err.message}`);
      return result;
    }
  }

  /**
   * Checks multi-layer duplicate rules:
   * 1. Exact URL match
   * 2. GUID match
   * 3. Exact Content SHA-256 hash match
   * 4. SimHash near-duplicate match (Hamming distance <= 3)
   */
  public isDuplicateArticle(
    cleanUrl: string,
    guid: string | null,
    contentHash: string,
    simhash: string,
    existingList: CanonicalNewsArticle[]
  ): boolean {
    for (const existing of existingList) {
      // 1. Exact URL match
      if (existing.source_url === cleanUrl) return true;

      // 2. GUID match
      if (guid && existing.source_guid && existing.source_guid === guid) return true;

      // 3. Exact content SHA-256 match
      if (existing.content_hash === contentHash) return true;

      // 4. Near-duplicate SimHash match (Hamming distance <= 6)
      if (existing.simhash && SimHash.isNearDuplicate(existing.simhash, simhash, 6)) {
        return true;
      }
    }
    return false;
  }
}

export const newsIngestionEngine = new NewsIngestionEngine();
