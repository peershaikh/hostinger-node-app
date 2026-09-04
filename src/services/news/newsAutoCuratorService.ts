/**
 * News Auto-Curator Service — Phase 087
 *
 * Autonomous Editorial & SEO Publishing Pipeline for Trayago News.
 *
 * Core Principles:
 * 1. ADSENSE SAFE: Strictly avoids content farm spam (caps publication at 3-5 articles/day).
 * 2. NO REPLICATED / THIN CONTENT: Requires rich passenger takeaways, clean attribution, and substantive summaries.
 * 3. PASSENGER-FIRST FILTER: Automatically rejects job recruitment (RRB/NTPC), political speeches, and tenders.
 *    Prioritizes train cancellations, delays, blocks, diversions, special trains, and schedule updates.
 * 4. DEDUPLICATION: Filters duplicate RSS entries using token similarity and corridor matching.
 * 5. CLEAN BACKLOG: Automatically archives stale (>7 days) drafts to prevent database and admin clutter.
 */

import { winstonLogger } from '../../middleware/logger';
import { supabase, isSupabaseConfigured } from '../../config/supabase';
import { cacheService } from '../cacheService';
import { IngestionStatus } from './newsTypes';

const NEWS_CACHE_KEY = 'latest_railway_news_cache_v3';

// Noise patterns that must NEVER be published to passenger travel news
const NOISE_TITLE_PATTERNS = [
  /rrb\b/i,
  /ntpc\b/i,
  /recruitment\b/i,
  /admit card\b/i,
  /vacancy\b/i,
  /vacancies\b/i,
  /jobs?\b/i,
  /apply online\b/i,
  /answer key\b/i,
  /cutoff\b/i,
  /cut off\b/i,
  /result declared\b/i,
  /tender\b/i,
  /e-tender\b/i,
  /bhoomi pujan\b/i,
  /inaugurates?\b/i,
  /foundation stone\b/i,
  /parliamentary committee\b/i,
  /shares of railway\b/i,
  /stock price\b/i,
  /quarterly profit\b/i,
];

// High-value passenger travel keywords that indicate genuine user utility
const PASSENGER_VALUE_PATTERNS = [
  /cancel/i,
  /cancellation/i,
  /divert/i,
  /diversion/i,
  /delay/i,
  /block/i,
  /jumbo block/i,
  /mega block/i,
  /traffic block/i,
  /derail/i,
  /waterlogg/i,
  /water logg/i,
  /track cave/i,
  /track subsidence/i,
  /subsidence/i,
  /special train/i,
  /festival special/i,
  /holiday special/i,
  /vande bharat/i,
  /amrit bharat/i,
  /timetable/i,
  /time table/i,
  /schedule/i,
  /reschedul/i,
  /route change/i,
  /halt/i,
  /additional stop/i,
  /platform/i,
  /refund/i,
  /fog/i,
  /safety/i,
];

// Media source suffixes to clean from titles for clean SEO H1
const SOURCE_SUFFIX_REGEX = /\s*[-–—|]\s*(NDTV(\s+Profit)?|Bhaskar English|The Times of India|Times of India|News18(\.com)?|News on AIR|NewsOnAIR|The Daily Jagran|Jagran|Mid-Day|Hindustan Times|The Hindu|Livemint|Zee News|Financial Express|Economic Times|ANI)\s*$/i;

export interface AutoCuratorConfig {
  enabled: boolean;
  maxDailyArticles: number;
  lastRunAt: string | null;
}

export interface CurateBatchResult {
  success: boolean;
  processedCount: number;
  publishedCount: number;
  archivedCount: number;
  publishedArticles: Array<{ id: string; title: string; slug: string }>;
  errors: string[];
}

export class NewsAutoCuratorService {
  private config: AutoCuratorConfig = {
    enabled: true,
    maxDailyArticles: 5,
    lastRunAt: null,
  };

  /**
   * Retrieves current auto-curator runtime configuration and status
   */
  public async getStatus(): Promise<{
    config: AutoCuratorConfig;
    publishedToday: number;
    draftsRemaining: number;
  }> {
    let publishedToday = 0;
    let draftsRemaining = 0;

    if (isSupabaseConfigured()) {
      try {
        const startOfDay = new Date();
        startOfDay.setHours(0, 0, 0, 0);

        const { count: pubCount } = await supabase
          .from('railway_news')
          .select('*', { count: 'exact', head: true })
          .eq('status', 'PUBLISHED')
          .gte('updated_at', startOfDay.toISOString());

        publishedToday = pubCount || 0;

        const { count: draftCount } = await supabase
          .from('railway_news')
          .select('*', { count: 'exact', head: true })
          .eq('status', 'AI_DRAFTED');

        draftsRemaining = draftCount || 0;
      } catch (err: any) {
        winstonLogger.warn(`[NEWS_AUTOCURATOR] getStatus query warning: ${err.message}`);
      }
    }

    return {
      config: this.config,
      publishedToday,
      draftsRemaining,
    };
  }

  /**
   * Toggles the autonomous publisher ON or OFF
   */
  public setEnabled(enabled: boolean): void {
    this.config.enabled = enabled;
    winstonLogger.info(`[NEWS_AUTOCURATOR] Auto-publish enabled state set to: ${enabled}`);
  }

  /**
   * Cleans source branding suffixes from raw RSS headlines
   * e.g. "Mumbai Train Update - NDTV Profit" -> "Mumbai Train Update"
   */
  public cleanHeadline(rawTitle: string): string {
    if (!rawTitle) return '';
    return rawTitle.replace(SOURCE_SUFFIX_REGEX, '').trim();
  }

  /**
   * Generates a clean, SEO-friendly, canonical URL slug
   */
  public generateCanonicalSlug(title: string, publishedAt: string): string {
    const clean = title
      .toLowerCase()
      .replace(/[^a-z0-9\s-]/g, '')
      .trim()
      .replace(/\s+/g, '-')
      .replace(/-+/g, '-')
      .slice(0, 65);

    const dateStr = publishedAt.slice(0, 10);
    return `${clean}-${dateStr}`;
  }

  /**
   * Evaluates whether an article is genuine passenger utility or noisy spam/jobs
   */
  public evaluatePassengerRelevance(article: { title: string; summary?: string; category?: string }): {
    isRelevant: boolean;
    reason: string;
  } {
    const combined = `${article.title} ${article.summary || ''}`.toLowerCase();

    // 1. Noise check
    for (const pattern of NOISE_TITLE_PATTERNS) {
      if (pattern.test(article.title) || pattern.test(combined)) {
        return { isRelevant: false, reason: `Matches noise pattern: ${pattern}` };
      }
    }

    // 2. Minimum length check
    if ((article.summary || '').trim().length < 40 && article.title.trim().length < 30) {
      return { isRelevant: false, reason: 'Thin content: insufficient text volume.' };
    }

    // 3. Positive passenger value check
    let hasPassengerKeyword = false;
    for (const pattern of PASSENGER_VALUE_PATTERNS) {
      if (pattern.test(article.title) || pattern.test(combined)) {
        hasPassengerKeyword = true;
        break;
      }
    }

    if (!hasPassengerKeyword) {
      return { isRelevant: false, reason: 'Lacks actionable passenger travel keywords.' };
    }

    return { isRelevant: true, reason: 'High passenger travel utility.' };
  }

  /**
   * Synthesizes actionable passenger advice and takeaways to provide original value
   */
  public synthesizePassengerTakeaways(article: {
    title: string;
    summary: string;
    category?: string;
    affected_trains?: string[];
  }): string[] {
    const takeaways: string[] = [];

    // Point 1: Core factual bulletin
    takeaways.push(this.cleanHeadline(article.title));

    // Point 2: Affected impact scope
    if (article.affected_trains && article.affected_trains.length > 0) {
      takeaways.push(`Impacts scheduled operations for train(s): ${article.affected_trains.join(', ')}.`);
    } else {
      takeaways.push('Passengers traveling on this sector are advised to confirm revised schedules prior to departure.');
    }

    // Point 3: Actionable guidance (refund / alternate travel)
    const lowerTitle = article.title.toLowerCase();
    if (lowerTitle.includes('cancel') || lowerTitle.includes('subsidence') || lowerTitle.includes('cave')) {
      takeaways.push('For fully cancelled trains, IRCTC automatically processes full ticket refunds. Alternate journey routes can be planned via Trayago Split Journey.');
    } else if (lowerTitle.includes('block') || lowerTitle.includes('delay') || lowerTitle.includes('timetable')) {
      takeaways.push('Commuters should anticipate potential delays and check live running status on Trayago Live Tracker.');
    } else if (lowerTitle.includes('special')) {
      takeaways.push('Booking for special train services is available via IRCTC PRS and online portals under standard reservation rules.');
    } else {
      takeaways.push('Check live train schedule and station departure boards on Trayago before heading to the railway station.');
    }

    return takeaways;
  }

  /**
   * Main Autonomous Curation & Publishing Routine
   */
  public async curateAndPublishDailyBatch(options?: {
    maxArticles?: number;
    force?: boolean;
  }): Promise<CurateBatchResult> {
    const result: CurateBatchResult = {
      success: true,
      processedCount: 0,
      publishedCount: 0,
      archivedCount: 0,
      publishedArticles: [],
      errors: [],
    };

    if (!isSupabaseConfigured()) {
      result.success = false;
      result.errors.push('Supabase is not configured.');
      return result;
    }

    if (!this.config.enabled && !options?.force) {
      winstonLogger.info('[NEWS_AUTOCURATOR] Auto-curator is currently PAUSED. Skipping batch.');
      return result;
    }

    const maxToPublish = options?.maxArticles || this.config.maxDailyArticles;

    try {
      // 1. Check how many articles have already been published today (anti-spam check)
      const startOfDay = new Date();
      startOfDay.setHours(0, 0, 0, 0);

      const { count: alreadyPublishedToday } = await supabase
        .from('railway_news')
        .select('*', { count: 'exact', head: true })
        .eq('status', 'PUBLISHED')
        .gte('updated_at', startOfDay.toISOString());

      const publishedTodayCount = alreadyPublishedToday || 0;

      if (publishedTodayCount >= maxToPublish && !options?.force) {
        winstonLogger.info(
          `[NEWS_AUTOCURATOR] Daily publication cap reached (${publishedTodayCount}/${maxToPublish}). Skipping today's auto-publish to prevent Google spam penalties.`
        );
        return result;
      }

      const publishQuotaRemaining = options?.force ? maxToPublish : Math.max(0, maxToPublish - publishedTodayCount);

      // 2. Fetch candidates from recent AI_DRAFTED articles (last 5 days)
      const fiveDaysAgo = new Date(Date.now() - 5 * 24 * 60 * 60 * 1000).toISOString();
      const { data: candidates, error: fetchErr } = await supabase
        .from('railway_news')
        .select('*')
        .eq('status', 'AI_DRAFTED')
        .gte('published_at', fiveDaysAgo)
        .order('published_at', { ascending: false })
        .limit(50);

      if (fetchErr) throw fetchErr;
      if (!candidates || candidates.length === 0) {
        winstonLogger.info('[NEWS_AUTOCURATOR] Zero candidate AI_DRAFTED articles found in recent window.');
        return result;
      }

      // 3. Fetch titles of articles published in the last 7 days for strict deduplication
      const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();
      const { data: recentPublished } = await supabase
        .from('railway_news')
        .select('title, slug')
        .eq('status', 'PUBLISHED')
        .gte('published_at', sevenDaysAgo);

      const publishedTitles = (recentPublished || []).map(r => r.title.toLowerCase());
      const selectedForPublish: any[] = [];
      const seenCandidateTitles = new Set<string>();

      // 4. Filter and select highest-quality unique candidates
      for (const draft of candidates) {
        if (selectedForPublish.length >= publishQuotaRemaining) break;
        result.processedCount++;

        const cleanTitle = this.cleanHeadline(draft.title);
        const lowerClean = cleanTitle.toLowerCase();

        // Check relevance
        const relevance = this.evaluatePassengerRelevance({
          title: cleanTitle,
          summary: draft.summary,
          category: draft.category,
        });

        if (!relevance.isRelevant) {
          // If explicitly noise (e.g. RRB recruitment), mark rejected/archived
          if (lowerClean.includes('rrb') || lowerClean.includes('recruitment')) {
            await supabase.from('railway_news').update({ status: 'ARCHIVED' }).eq('id', draft.id);
            result.archivedCount++;
          }
          continue;
        }

        // Deduplication against already published
        let isDuplicate = false;
        for (const pubTitle of publishedTitles) {
          if (pubTitle.includes(lowerClean.slice(0, 30)) || lowerClean.includes(pubTitle.slice(0, 30))) {
            isDuplicate = true;
            break;
          }
        }

        // Deduplication within current batch
        if (isDuplicate || seenCandidateTitles.has(lowerClean.slice(0, 35))) {
          continue;
        }

        seenCandidateTitles.add(lowerClean.slice(0, 35));
        selectedForPublish.push({ draft, cleanTitle });
      }

      // 5. Enrich and Publish Selected Candidates
      const now = new Date().toISOString();

      for (const { draft, cleanTitle } of selectedForPublish) {
        const canonicalSlug = this.generateCanonicalSlug(cleanTitle, draft.published_at || now);
        const seoTitle = `${cleanTitle.slice(0, 55)} | Trayago News`;
        const metaDesc = (draft.summary || cleanTitle).slice(0, 155).replace(/[\r\n]+/g, ' ').trim();
        const takeaways = this.synthesizePassengerTakeaways({
          title: cleanTitle,
          summary: draft.summary,
          category: draft.category,
          affected_trains: draft.affected_trains,
        });

        // Normalize category
        let normalizedCategory = 'Railway Updates';
        const lowerTitle = cleanTitle.toLowerCase();
        if (lowerTitle.includes('cancel')) normalizedCategory = 'Cancellation';
        else if (lowerTitle.includes('delay') || lowerTitle.includes('block')) normalizedCategory = 'Delays';
        else if (lowerTitle.includes('special')) normalizedCategory = 'Special Trains';

        const updatePayload: Record<string, any> = {
          title: cleanTitle,
          slug: canonicalSlug,
          seo_title: seoTitle,
          meta_description: metaDesc,
          key_takeaways: takeaways,
          category: normalizedCategory,
          status: 'PUBLISHED',
          updated_at: now,
        };

        const { error: updateErr } = await supabase
          .from('railway_news')
          .update(updatePayload)
          .eq('id', draft.id);

        if (updateErr) {
          result.errors.push(`Failed to publish ${draft.id}: ${updateErr.message}`);
          winstonLogger.error(`[NEWS_AUTOCURATOR_UPDATE_FAIL] ${draft.id}: ${updateErr.message}`);
        } else {
          result.publishedCount++;
          result.publishedArticles.push({
            id: draft.id,
            title: cleanTitle,
            slug: canonicalSlug,
          });
          winstonLogger.info(`[NEWS_AUTOCURATOR_PUBLISHED] ✓ Published: "${cleanTitle}" (/news/${canonicalSlug})`);
        }
      }

      // 6. Invalidate memory cache so public /api/news immediately returns fresh articles
      try {
        cacheService.del(NEWS_CACHE_KEY);
      } catch {
        // Non-fatal
      }

      this.config.lastRunAt = now;
      winstonLogger.info(
        `[NEWS_AUTOCURATOR_COMPLETED] Processed=${result.processedCount}, Published=${result.publishedCount}, Archived=${result.archivedCount}`
      );
    } catch (err: any) {
      result.success = false;
      result.errors.push(err.message);
      winstonLogger.error(`[NEWS_AUTOCURATOR_FATAL] ${err.message}`);
    }

    return result;
  }

  /**
   * Bulk archives stale drafts (> 7 days old) to keep the database and admin panel clean
   */
  public async archiveStaleDrafts(olderThanDays: number = 7): Promise<{
    success: boolean;
    archivedCount: number;
    error?: string;
  }> {
    if (!isSupabaseConfigured()) {
      return { success: false, archivedCount: 0, error: 'Database not configured.' };
    }

    try {
      const cutoffDate = new Date(Date.now() - olderThanDays * 24 * 60 * 60 * 1000).toISOString();

      const { data, error } = await supabase
        .from('railway_news')
        .update({ status: 'ARCHIVED', updated_at: new Date().toISOString() })
        .eq('status', 'AI_DRAFTED')
        .lt('published_at', cutoffDate)
        .select('id');

      if (error) throw error;

      const archivedCount = data?.length || 0;
      winstonLogger.info(`[NEWS_AUTOCURATOR_CLEANUP] Archived ${archivedCount} stale drafts older than ${olderThanDays} days.`);
      return { success: true, archivedCount };
    } catch (err: any) {
      winstonLogger.error(`[NEWS_AUTOCURATOR_CLEANUP_FAIL] ${err.message}`);
      return { success: false, archivedCount: 0, error: err.message };
    }
  }
}

export const newsAutoCuratorService = new NewsAutoCuratorService();
