/**
 * News Internet Search Service — Real-Time Web & News Grounding Engine
 *
 * Fetches live real-world news headlines, recent cancellations, diversion alerts,
 * and authoritative Wikipedia encyclopedia knowledge for Indian Trains & Railway topics.
 *
 * Features:
 * - Google News RSS query engine with timeout protection
 * - Wikipedia Action API for authoritative history, inaugural dates, and speed records
 * - Resilient fallback: never crashes or blocks article generation on network hiccups
 * - Extracts recent live advisories, cancellations, and official railway press releases
 */

import axios from 'axios';
import Parser from 'rss-parser';
import { winstonLogger } from '../../middleware/logger';

export interface LiveNewsItem {
  title: string;
  source: string;
  pubDate: string;
  link: string;
}

export interface LiveInternetResearchResult {
  query: string;
  newsHeadlines: LiveNewsItem[];
  wikipediaSummary?: string;
  summary?: string;
  wikipediaTitle?: string;
  verifiedFacts: string[];
  recentAdvisories: string[];
  sourceLinks?: string[];
}

export type LiveInternetData = LiveInternetResearchResult;

export class NewsInternetSearchService {
  private parser: Parser;

  constructor() {
    this.parser = new Parser({
      timeout: 6000,
      headers: {
        'User-Agent': 'Mozilla/5.0 (compatible; TrayagoBot/1.0; +https://www.trayago.in)'
      }
    });
  }

  /**
   * Performs multi-source live internet research for a train, route, or custom keywords.
   */
  public async searchLiveInternetData(
    trainNo?: string,
    trainName?: string,
    keywords?: string
  ): Promise<LiveInternetResearchResult> {
    const rawNo = (trainNo || '').trim();
    const rawName = (trainName || '').trim();
    const rawKw = (keywords || '').trim();

    const queryParts = [rawNo, rawName, rawKw].filter(Boolean);
    const primaryQuery = queryParts.length > 0 ? queryParts.join(' ') : 'Indian Railways news passenger advisory';

    const result: LiveInternetResearchResult = {
      query: primaryQuery,
      newsHeadlines: [],
      wikipediaSummary: undefined,
      wikipediaTitle: undefined,
      verifiedFacts: [],
      recentAdvisories: []
    };

    // 1. Fetch Live Google News RSS (Timeout safe)
    try {
      const gnewsUrl = `https://news.google.com/rss/search?q=${encodeURIComponent(primaryQuery)}&hl=en-IN&gl=IN&ceid=IN:en`;
      const feed = await this.parser.parseURL(gnewsUrl);

      if (feed && Array.isArray(feed.items) && feed.items.length > 0) {
        result.newsHeadlines = feed.items.slice(0, 5).map((item: any) => ({
          title: String(item.title || '').replace(/\s+-\s+[^-]+$/, '').trim(),
          source: String(item.source?._ || item.source || '').trim() || 'Official News Feed',
          pubDate: String(item.pubDate || '').trim(),
          link: String(item.link || '').trim()
        }));

        // Filter out any headlines mentioning cancellation, diversion, or delays
        for (const item of result.newsHeadlines) {
          const lower = item.title.toLowerCase();
          if (lower.includes('cancel') || lower.includes('divert') || lower.includes('delay') || lower.includes('reschedul')) {
            result.recentAdvisories.push(item.title);
          }
        }
      }
    } catch (newsErr: any) {
      winstonLogger.warn(`[INTERNET_SEARCH_NEWS_WARN] Google News RSS query failed: ${newsErr.message}`);
    }

    // 2. Fetch Authoritative Wikipedia Data (if train number or train name exists)
    if (rawNo || rawName) {
      try {
        const wikiSearchTerm = `${rawNo} ${rawName}`.trim();
        const wikiSearchUrl = `https://en.wikipedia.org/w/api.php?action=query&list=search&srsearch=${encodeURIComponent(wikiSearchTerm)}&utf8=&format=json`;

        const searchRes = await axios.get(wikiSearchUrl, {
          timeout: 5000,
          headers: { 'User-Agent': 'TrayagoBot/1.0 (contact@trayago.in)' }
        });

        const hits = searchRes.data?.query?.search || [];
        if (hits.length > 0) {
          const topHit = hits[0];
          result.wikipediaTitle = topHit.title;

          // Fetch introductory summary
          const extractUrl = `https://en.wikipedia.org/w/api.php?action=query&prop=extracts&exintro&explaintext&titles=${encodeURIComponent(topHit.title)}&format=json`;
          const extRes = await axios.get(extractUrl, {
            timeout: 5000,
            headers: { 'User-Agent': 'TrayagoBot/1.0 (contact@trayago.in)' }
          });

          const pages = extRes.data?.query?.pages;
          const pid = Object.keys(pages || {})[0];
          if (pid && pages[pid]?.extract) {
            result.wikipediaSummary = String(pages[pid].extract).trim();
            result.summary = result.wikipediaSummary;
            // Split into clean sentence-level facts
            const sentences = result.wikipediaSummary.split(/(?<=[.?!])\s+/).slice(0, 4);
            result.verifiedFacts = sentences.filter(s => s.length > 25);
          }
        }
      } catch (wikiErr: any) {
        winstonLogger.warn(`[INTERNET_SEARCH_WIKI_WARN] Wikipedia query failed: ${wikiErr.message}`);
      }
    }

    winstonLogger.info(
      `[INTERNET_SEARCH_SUCCESS] Grounding complete for "${primaryQuery}": ${result.newsHeadlines.length} news items, ${result.verifiedFacts.length} verified facts.`
    );

    return result;
  }
}

export const newsInternetSearchService = new NewsInternetSearchService();
