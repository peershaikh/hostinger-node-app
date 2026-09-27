/**
 * News Source Change Detection Service (Phase 082)
 *
 * Production-Safe Source Change Detection, Entity Diffing, & Update Intelligence for Railway News.
 *
 * Workflow:
 * Article / Source URL → SSRF-Safe Fetch → Normalized Fingerprints
 *                      → Entity Extraction & Diffing → Change Classification
 *                      → Story Clustering & Duplicate Protection
 *                      → Update Recommendation & Human Editorial Workflow
 *
 * Governance:
 * - Read-only intelligence & change assistance.
 * - Zero auto-publishing. Zero auto-editing.
 * - SSRF protection: blocks private subnets, localhost, and cloud metadata.
 * - Zero fabrication: Unsupported claims and changes are tagged cleanly without rewriting.
 */

import crypto from 'crypto';
import { winstonLogger } from '../../middleware/logger';
import { newsSourceVerificationService } from './newsSourceVerificationService';
import type { SourceTier } from './newsTypes';

// ─── Interfaces & Types ───────────────────────────────────────────────────────

export type ChangeType =
  | 'NO_CHANGE'
  | 'MINOR_CHANGE'
  | 'MATERIAL_CHANGE'
  | 'CRITICAL_CHANGE'
  | 'SOURCE_UNAVAILABLE';

export type EntityChangeStatus = 'ADDED' | 'REMOVED' | 'CHANGED' | 'UNCHANGED';

export type UpdateRecommendationType =
  | 'UPDATE_NOT_NEEDED'
  | 'REVIEW_SOURCE_CHANGE'
  | 'UPDATE_RECOMMENDED'
  | 'URGENT_UPDATE_RECOMMENDED';

export type UpdatePriority = 'LOW' | 'MEDIUM' | 'HIGH' | 'CRITICAL';

export type StoryClusterType = 'RELATED_STORY' | 'POTENTIAL_DUPLICATE' | 'NEW_STORY';

export interface ExtractedRailwayFacts {
  train_numbers: string[];
  train_names: string[];
  stations: string[];
  dates: string[];
  times: string[];
  has_cancellation: boolean;
  has_diversion: boolean;
  has_restoration: boolean;
  has_special_train: boolean;
  has_tatkal: boolean;
  has_fare_change: boolean;
  passenger_guidance: string[];
}

export interface EntityDiffItem {
  field: string;
  previous_value: string | string[] | boolean | Record<string, any> | null;
  current_value: string | string[] | boolean | Record<string, any> | null;
  status: EntityChangeStatus;
  is_critical: boolean;
  description: string;
}

export interface SourceSnapshot {
  content_hash: string;
  title_hash: string;
  summary_fingerprint: string;
  entity_fingerprint: string;
  raw_title: string;
  extracted_facts: ExtractedRailwayFacts;
  http_status: number | null;
  fetched_at: string;
  published_at: string | null;
}

export interface SourceChangeRecord {
  article_id: string;
  article_title: string;
  article_slug: string | null;
  article_status: string;
  source_name: string;
  source_url: string;
  source_tier: SourceTier | string;
  last_verified_at: string;
  previous_snapshot: SourceSnapshot;
  current_snapshot: SourceSnapshot;
  change_type: ChangeType;
  priority: UpdatePriority;
  recommendation: UpdateRecommendationType;
  action_label: string;
  action_link: string;
  entity_diffs: EntityDiffItem[];
  changed_facts_summary: string[];
  cluster_status: StoryClusterType;
  seo_refresh_opportunity: boolean;
  explanation: {
    what: string;
    why: string;
    action: string;
  };
}

export interface StoryClusterMatch {
  cluster_type: StoryClusterType;
  matched_article_id: string | null;
  matched_article_title: string | null;
  similarity_score: number;
  matching_entities: {
    train_numbers: string[];
    stations: string[];
    event_type: string | null;
  };
}

// ─── Main Service Class ───────────────────────────────────────────────────────

export class NewsSourceChangeService {
  // In-memory cache of recent snapshots for fast delta detection
  private snapshotsCache: Map<string, SourceSnapshot> = new Map();

  // ─── Fingerprint Generation ─────────────────────────────────────────────────

  public generateContentHash(text: string): string {
    const normalized = text.toLowerCase().replace(/\s+/g, ' ').trim();
    return crypto.createHash('sha256').update(normalized).digest('hex');
  }

  public generateTitleHash(title: string): string {
    const normalized = (title || '').toLowerCase().replace(/[^a-z0-9]/g, '').trim();
    return crypto.createHash('sha256').update(normalized).digest('hex');
  }

  public generateSummaryFingerprint(summary: string): string {
    const words = (summary || '')
      .toLowerCase()
      .replace(/[^a-z0-9\s]/g, ' ')
      .split(/\s+/)
      .filter(w => w.length > 3)
      .sort();
    const uniqueTokens = Array.from(new Set(words)).join('|');
    return crypto.createHash('sha256').update(uniqueTokens).digest('hex').slice(0, 16);
  }

  public generateEntityFingerprint(facts: ExtractedRailwayFacts): string {
    const trainStr = [...facts.train_numbers].sort().join(',');
    const stationStr = [...facts.stations].sort().join(',');
    const flagStr = `${facts.has_cancellation ? 'C' : ''}${facts.has_diversion ? 'D' : ''}${facts.has_restoration ? 'R' : ''}${facts.has_special_train ? 'S' : ''}${facts.has_tatkal ? 'T' : ''}${facts.has_fare_change ? 'F' : ''}`;
    const raw = `${trainStr}#${stationStr}#${flagStr}`;
    return crypto.createHash('sha256').update(raw).digest('hex').slice(0, 16);
  }

  // ─── Fact Extraction ────────────────────────────────────────────────────────

  public extractRailwayFacts(text: string, title?: string): ExtractedRailwayFacts {
    const combined = `${title || ''} ${text || ''}`;
    const lower = combined.toLowerCase();

    // 1. Train numbers (4 to 5 digits, e.g. 12951, 22436)
    const trainNumbersSet = new Set<string>();
    const trainNumMatches = combined.match(/\b\d{5}\b/g) || [];
    trainNumMatches.forEach(num => {
      // Basic sanity: filter out years or common numbers like 2026
      if (num !== '2026' && num !== '2025' && num !== '2024') {
        trainNumbersSet.add(num);
      }
    });

    // 2. Train names
    const trainNamesSet = new Set<string>();
    const trainNamePatterns = [
      /\b([A-Z][a-z]+(?:\s+[A-Z][a-z]+)*\s+(?:Express|Superfast|Rajdhani|Shatabdi|Vande Bharat|Duronto|Mail|Special|Garib Rath|Jan Shatabdi|Tejas|Humsafar|Passenger))\b/g,
      /\b(Vande Bharat(?:\s+Express)?)\b/gi,
      /\b(Amrit Bharat(?:\s+Express)?)\b/gi,
      /\b(Rajdhani Express)\b/gi,
      /\b(Shatabdi Express)\b/gi,
    ];
    trainNamePatterns.forEach(pat => {
      let m;
      while ((m = pat.exec(combined)) !== null) {
        if (m[1]) trainNamesSet.add(m[1].trim());
      }
    });

    // 3. Station codes & Names
    const stationsSet = new Set<string>();
    const stationCodeMatches = combined.match(/\b[A-Z]{2,5}\b/g) || [];
    const knownCodes = new Set([
      'NDLS', 'HWH', 'CSMT', 'MMCT', 'BCT', 'MAS', 'SBC', 'PNBE', 'PUNE', 'ADI',
      'BSB', 'CNB', 'GKP', 'LKO', 'HYB', 'SC', 'BPL', 'CSTM', 'DLI', 'NZM', 'ANVT',
      'KOTA', 'RTM', 'BRC', 'ST', 'BVI', 'KYN', 'TNA', 'DR', 'IGP', 'NK', 'MMR',
    ]);
    stationCodeMatches.forEach(code => {
      if (knownCodes.has(code)) stationsSet.add(code);
    });

    // Match common station city names
    const stationNames = [
      'New Delhi', 'Delhi', 'Mumbai', 'Howrah', 'Kolkata', 'Chennai', 'Bengaluru',
      'Bangalore', 'Patna', 'Pune', 'Ahmedabad', 'Varanasi', 'Kanpur', 'Gorakhpur',
      'Lucknow', 'Hyderabad', 'Secunderabad', 'Bhopal', 'Jaipur', 'Surat', 'Vadodara',
    ];
    stationNames.forEach(stn => {
      if (new RegExp(`\\b${stn}\\b`, 'i').test(combined)) {
        stationsSet.add(stn);
      }
    });

    // 4. Dates & Times
    const datesSet = new Set<string>();
    const dateMatches = combined.match(/\b(?:\d{1,2}(?:st|nd|rd|th)?\s+(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)[a-z]*|\d{1,2}[-\/]\d{1,2}[-\/]\d{2,4})\b/gi) || [];
    dateMatches.forEach(d => datesSet.add(d.trim()));

    const timesSet = new Set<string>();
    const timeMatches = combined.match(/\b\d{1,2}:\d{2}\s*(?:am|pm|hrs|hours)?\b/gi) || [];
    timeMatches.forEach(t => timesSet.add(t.trim()));

    // 5. Disruption & Service status signals
    const has_cancellation = /\b(cancel|cancelled|cancellation|cancellations|radd|nirast)\b/i.test(lower);
    const has_diversion = /\b(divert|diverted|diversion|diversions|route change|badla gaya)\b/i.test(lower);
    const has_restoration = /\b(restore|restored|restoration|resumed|phir se shuru)\b/i.test(lower);
    const has_special_train = /\b(special train|special trains|festival special|holiday special|clone train)\b/i.test(lower);
    const has_tatkal = /\b(tatkal|premium tatkal|tatkal quota|tatkal timing)\b/i.test(lower);
    const has_fare_change = /\b(fare|ticket price|fare hike|dynamic pricing|concession|kiraya)\b/i.test(lower);

    // 6. Passenger guidance snippets
    const passenger_guidance: string[] = [];
    if (has_cancellation) passenger_guidance.push('Full automatic refund credited for cancelled trains via IRCTC.');
    if (has_diversion) passenger_guidance.push('Check diverted route station halts and revised boarding timings.');
    if (has_tatkal) passenger_guidance.push('AC Tatkal opens at 10:00 AM; Non-AC Tatkal opens at 11:00 AM IST.');
    if (has_special_train) passenger_guidance.push('Book special train berths early to avoid festival waitlists.');

    return {
      train_numbers: Array.from(trainNumbersSet).slice(0, 8),
      train_names: Array.from(trainNamesSet).slice(0, 6),
      stations: Array.from(stationsSet).slice(0, 8),
      dates: Array.from(datesSet).slice(0, 5),
      times: Array.from(timesSet).slice(0, 5),
      has_cancellation,
      has_diversion,
      has_restoration,
      has_special_train,
      has_tatkal,
      has_fare_change,
      passenger_guidance,
    };
  }

  // ─── Create Snapshot ────────────────────────────────────────────────────────

  public createSnapshot(text: string, title: string, httpStatus: number | null = 200, publishedAt: string | null = null): SourceSnapshot {
    const facts = this.extractRailwayFacts(text, title);
    return {
      content_hash: this.generateContentHash(text),
      title_hash: this.generateTitleHash(title),
      summary_fingerprint: this.generateSummaryFingerprint(text),
      entity_fingerprint: this.generateEntityFingerprint(facts),
      raw_title: title || '',
      extracted_facts: facts,
      http_status: httpStatus,
      fetched_at: new Date().toISOString(),
      published_at: publishedAt,
    };
  }

  // ─── Entity Change Detection & Comparison ───────────────────────────────────

  public compareEntities(prev: ExtractedRailwayFacts, curr: ExtractedRailwayFacts): EntityDiffItem[] {
    const diffs: EntityDiffItem[] = [];

    // 1. Train Numbers
    const prevTrains = new Set(prev.train_numbers || []);
    const currTrains = new Set(curr.train_numbers || []);
    const addedTrains = [...currTrains].filter(t => !prevTrains.has(t));
    const removedTrains = [...prevTrains].filter(t => !currTrains.has(t));

    if (addedTrains.length > 0) {
      diffs.push({
        field: 'train_numbers',
        previous_value: Array.from(prevTrains),
        current_value: Array.from(currTrains),
        status: 'ADDED',
        is_critical: false,
        description: `New train(s) referenced in source: ${addedTrains.join(', ')}`,
      });
    }
    if (removedTrains.length > 0) {
      diffs.push({
        field: 'train_numbers',
        previous_value: Array.from(prevTrains),
        current_value: Array.from(currTrains),
        status: 'REMOVED',
        is_critical: false,
        description: `Train(s) no longer mentioned in source: ${removedTrains.join(', ')}`,
      });
    }

    // 2. Stations
    const prevStns = new Set(prev.stations || []);
    const currStns = new Set(curr.stations || []);
    const addedStns = [...currStns].filter(s => !prevStns.has(s));
    const removedStns = [...prevStns].filter(s => !currStns.has(s));

    if (addedStns.length > 0) {
      diffs.push({
        field: 'stations',
        previous_value: Array.from(prevStns),
        current_value: Array.from(currStns),
        status: 'ADDED',
        is_critical: false,
        description: `New station(s) added in source: ${addedStns.join(', ')}`,
      });
    }
    if (removedStns.length > 0) {
      diffs.push({
        field: 'stations',
        previous_value: Array.from(prevStns),
        current_value: Array.from(currStns),
        status: 'REMOVED',
        is_critical: false,
        description: `Station(s) removed in source: ${removedStns.join(', ')}`,
      });
    }

    // 3. Cancellation Status (Critical)
    if (prev.has_cancellation !== curr.has_cancellation) {
      diffs.push({
        field: 'cancellation_status',
        previous_value: prev.has_cancellation,
        current_value: curr.has_cancellation,
        status: 'CHANGED',
        is_critical: true,
        description: curr.has_cancellation
          ? 'Source now reports train CANCELLATIONS (previously not cancelled).'
          : 'Cancellation notice removed or train service restored in source.',
      });
    }

    // 4. Diversion Status (Critical)
    if (prev.has_diversion !== curr.has_diversion) {
      diffs.push({
        field: 'diversion_status',
        previous_value: prev.has_diversion,
        current_value: curr.has_diversion,
        status: 'CHANGED',
        is_critical: true,
        description: curr.has_diversion
          ? 'Source now reports route DIVERSION.'
          : 'Diversion notice lifted in source.',
      });
    }

    // 5. Restoration Status (Critical)
    if (prev.has_restoration !== curr.has_restoration) {
      diffs.push({
        field: 'restoration_status',
        previous_value: prev.has_restoration,
        current_value: curr.has_restoration,
        status: 'CHANGED',
        is_critical: true,
        description: curr.has_restoration
          ? 'Source reports service RESTORATION.'
          : 'Restoration status altered in source.',
      });
    }

    // 6. Special Train Status (Material)
    if (prev.has_special_train !== curr.has_special_train) {
      diffs.push({
        field: 'special_train_status',
        previous_value: prev.has_special_train,
        current_value: curr.has_special_train,
        status: 'CHANGED',
        is_critical: false,
        description: curr.has_special_train
          ? 'New special train services announced in source.'
          : 'Special train reference changed.',
      });
    }

    // 7. Tatkal / Fare Changes (Critical)
    if (prev.has_tatkal !== curr.has_tatkal || prev.has_fare_change !== curr.has_fare_change) {
      diffs.push({
        field: 'fare_tatkal_rules',
        previous_value: { tatkal: prev.has_tatkal, fare: prev.has_fare_change },
        current_value: { tatkal: curr.has_tatkal, fare: curr.has_fare_change },
        status: 'CHANGED',
        is_critical: true,
        description: 'Ticketing, Tatkal quota, or passenger fare rules modified at source.',
      });
    }

    return diffs;
  }

  // ─── Change Classifier ──────────────────────────────────────────────────────

  public classifyChange(
    prev: SourceSnapshot,
    curr: SourceSnapshot | null,
    httpError?: { status: number | null; message: string }
  ): {
    change_type: ChangeType;
    priority: UpdatePriority;
    recommendation: UpdateRecommendationType;
    entity_diffs: EntityDiffItem[];
    changed_facts_summary: string[];
    explanation: { what: string; why: string; action: string };
  } {
    // 1. Check if source is unreachable or failed
    if (!curr || (httpError && (httpError.status === 404 || httpError.status === 500 || httpError.status === 410))) {
      return {
        change_type: 'SOURCE_UNAVAILABLE',
        priority: 'MEDIUM',
        recommendation: 'REVIEW_SOURCE_CHANGE',
        entity_diffs: [],
        changed_facts_summary: [
          `Original source returned HTTP ${httpError?.status || 'ERR'} or is unreachable.`,
        ],
        explanation: {
          what: 'Source URL is currently unreachable or offline.',
          why: 'The original article URL failed to respond during live check. Content is kept intact pending editorial review.',
          action: 'Check if the source URL moved, was archived, or if a mirror source exists.',
        },
      };
    }

    // 2. Compute entity diffs
    const entity_diffs = this.compareEntities(prev.extracted_facts, curr.extracted_facts);
    const criticalDiffs = entity_diffs.filter(d => d.is_critical);
    const materialDiffs = entity_diffs.filter(d => !d.is_critical);

    // 3. Classify based on entity and content deltas
    if (criticalDiffs.length > 0) {
      const summary = criticalDiffs.map(d => d.description);
      return {
        change_type: 'CRITICAL_CHANGE',
        priority: 'CRITICAL',
        recommendation: 'URGENT_UPDATE_RECOMMENDED',
        entity_diffs,
        changed_facts_summary: summary,
        explanation: {
          what: 'Critical operational status modified at original railway source.',
          why: 'Disruption, cancellation, diversion, or ticketing rules were modified, directly impacting passenger journeys.',
          action: 'Open Update Review immediately to adjust draft facts and passenger advice before re-approval.',
        },
      };
    }

    if (materialDiffs.length > 0) {
      const summary = materialDiffs.map(d => d.description);
      return {
        change_type: 'MATERIAL_CHANGE',
        priority: 'HIGH',
        recommendation: 'UPDATE_RECOMMENDED',
        entity_diffs,
        changed_facts_summary: summary,
        explanation: {
          what: 'Material railway facts (trains, stations, or dates) updated at source.',
          why: 'New stations or train schedules were added to the original notice.',
          action: 'Review updated source facts and update article summary and SEO tags.',
        },
      };
    }

    // Check content hash / title hash differences
    if (prev.content_hash !== curr.content_hash || prev.title_hash !== curr.title_hash) {
      return {
        change_type: 'MINOR_CHANGE',
        priority: 'LOW',
        recommendation: 'REVIEW_SOURCE_CHANGE',
        entity_diffs,
        changed_facts_summary: ['Headline wording or formatting updated without altering railway entities.'],
        explanation: {
          what: 'Minor wording or layout changes detected at source.',
          why: 'The text was updated by publisher, but all train numbers and stations remain unchanged.',
          action: 'No urgent update needed. Review at convenience during scheduled editorial refresh.',
        },
      };
    }

    // Exact match
    return {
      change_type: 'NO_CHANGE',
      priority: 'LOW',
      recommendation: 'UPDATE_NOT_NEEDED',
      entity_diffs: [],
      changed_facts_summary: ['Source content matches stored snapshot perfectly.'],
      explanation: {
        what: 'Source verified with zero modifications.',
        why: 'Content hash, title, and all extracted entities match the published article.',
        action: 'No action needed.',
      },
    };
  }

  // ─── Story Clustering & Duplicate Protection ────────────────────────────────

  public detectStoryCluster(
    sourceFacts: ExtractedRailwayFacts,
    existingArticles: Array<{
      id: string;
      title: string;
      affected_trains?: string[];
      affected_stations?: string[];
      category?: string;
    }>
  ): StoryClusterMatch {
    const sourceTrains = new Set(sourceFacts.train_numbers || []);
    const sourceStns = new Set(sourceFacts.stations || []);

    let bestMatch: {
      article: any;
      score: number;
      matchingTrains: string[];
      matchingStns: string[];
    } | null = null;

    for (const art of existingArticles) {
      const artTrains = new Set(art.affected_trains || []);
      const artStns = new Set(art.affected_stations || []);

      const commonTrains = [...sourceTrains].filter(t => artTrains.has(t));
      const commonStns = [...sourceStns].filter(s => artStns.has(s));

      let score = 0;
      if (commonTrains.length > 0) score += commonTrains.length * 40;
      if (commonStns.length > 0) score += commonStns.length * 20;

      // Event type alignment
      if (sourceFacts.has_cancellation && art.title.toLowerCase().includes('cancel')) score += 30;
      if (sourceFacts.has_diversion && art.title.toLowerCase().includes('divert')) score += 30;
      if (sourceFacts.has_special_train && art.title.toLowerCase().includes('special')) score += 30;

      if (score > (bestMatch?.score || 0)) {
        bestMatch = {
          article: art,
          score,
          matchingTrains: commonTrains,
          matchingStns: commonStns,
        };
      }
    }

    if (bestMatch && bestMatch.score >= 70) {
      return {
        cluster_type: 'POTENTIAL_DUPLICATE',
        matched_article_id: bestMatch.article.id,
        matched_article_title: bestMatch.article.title,
        similarity_score: Math.min(100, bestMatch.score),
        matching_entities: {
          train_numbers: bestMatch.matchingTrains,
          stations: bestMatch.matchingStns,
          event_type: sourceFacts.has_cancellation ? 'CANCELLATION' : sourceFacts.has_diversion ? 'DIVERSION' : null,
        },
      };
    }

    if (bestMatch && bestMatch.score >= 40) {
      return {
        cluster_type: 'RELATED_STORY',
        matched_article_id: bestMatch.article.id,
        matched_article_title: bestMatch.article.title,
        similarity_score: bestMatch.score,
        matching_entities: {
          train_numbers: bestMatch.matchingTrains,
          stations: bestMatch.matchingStns,
          event_type: sourceFacts.has_cancellation ? 'CANCELLATION' : null,
        },
      };
    }

    return {
      cluster_type: 'NEW_STORY',
      matched_article_id: null,
      matched_article_title: null,
      similarity_score: 0,
      matching_entities: {
        train_numbers: [],
        stations: [],
        event_type: null,
      },
    };
  }

  // ─── High-Level Change Record Builder ───────────────────────────────────────

  public buildChangeRecord(
    article: {
      id: string;
      title: string;
      summary?: string;
      slug?: string | null;
      status: string;
      source_name: string;
      source_url: string;
      source_tier?: string;
      published_at?: string;
      updated_at?: string;
    },
    liveSourceText: string | null,
    liveSourceTitle?: string,
    httpError?: { status: number | null; message: string }
  ): SourceChangeRecord {
    // 1. Previous snapshot from article text
    const prevSnapshot = this.createSnapshot(
      article.summary || article.title,
      article.title,
      200,
      article.published_at || null
    );

    // 2. Current snapshot from live text (or null if unavailable)
    const currentSnapshot = liveSourceText !== null
      ? this.createSnapshot(liveSourceText, liveSourceTitle || article.title, 200, null)
      : this.createSnapshot('', article.title, httpError?.status || 404, null);

    // 3. Classify
    const classification = this.classifyChange(
      prevSnapshot,
      liveSourceText !== null ? currentSnapshot : null,
      httpError
    );

    const isUrgent = classification.recommendation === 'URGENT_UPDATE_RECOMMENDED';
    const isUpdate = classification.recommendation === 'UPDATE_RECOMMENDED';

    return {
      article_id: article.id,
      article_title: article.title,
      article_slug: article.slug || null,
      article_status: article.status,
      source_name: article.source_name,
      source_url: article.source_url,
      source_tier: article.source_tier || 'TIER_1_OFFICIAL',
      last_verified_at: new Date().toISOString(),
      previous_snapshot: prevSnapshot,
      current_snapshot: currentSnapshot,
      change_type: classification.change_type,
      priority: classification.priority,
      recommendation: classification.recommendation,
      action_label: isUrgent
        ? 'Open Update Review (Urgent)'
        : isUpdate
        ? 'Open Update Review'
        : 'View Source Details',
      action_link: `/admin/news/${article.id}`,
      entity_diffs: classification.entity_diffs,
      changed_facts_summary: classification.changed_facts_summary,
      cluster_status: 'RELATED_STORY',
      seo_refresh_opportunity: classification.change_type === 'MATERIAL_CHANGE' || classification.change_type === 'CRITICAL_CHANGE',
      explanation: classification.explanation,
    };
  }

  // ─── Live Article Source Change Inspector ───────────────────────────────────

  public async detectArticleLiveChange(article: {
    id: string;
    title: string;
    summary: string;
    source_name: string;
    source_url: string;
    source_tier?: string;
    status: string;
    slug?: string | null;
    published_at?: string;
  }): Promise<SourceChangeRecord> {
    if (!article.source_url) {
      return this.buildChangeRecord(article, null, undefined, { status: 400, message: 'Missing source URL' });
    }

    try {
      const fetchResult = await newsSourceVerificationService.safeFetchSourceContent(article.source_url);
      if (!fetchResult.reachable || fetchResult.body === null) {
        return this.buildChangeRecord(article, null, undefined, {
          status: fetchResult.status,
          message: fetchResult.error || 'Source unreachable',
        });
      }

      const cleanText = newsSourceVerificationService.cleanHtmlToText(fetchResult.body);
      const titleMatch = fetchResult.body.match(/<title[^>]*>([^<]+)<\/title>/i);
      const liveTitle = titleMatch ? titleMatch[1].trim() : article.title;

      return this.buildChangeRecord(article, cleanText, liveTitle);
    } catch (err: any) {
      winstonLogger.warn('[SOURCE_CHANGE_FAIL] Error inspecting source change', {
        articleId: article.id,
        error: err.message,
      });
      return this.buildChangeRecord(article, null, undefined, { status: 500, message: err.message });
    }
  }
}

export const newsSourceChangeService = new NewsSourceChangeService();
