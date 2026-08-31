import { winstonLogger } from '../../middleware/logger';
import { aiProviderResolver } from '../ai/aiProviderResolver';
import { CanonicalNewsArticle } from './newsTypes';
import { NewsDistillationInput, NewsDistillationOutput, NewsFaqItem, AiErrorCode } from '../ai/aiProvider';

export interface ValidationResult {
  isValid: boolean;
  confidence: 'HIGH' | 'MEDIUM' | 'LOW' | 'REJECTED';
  rejectionReason?: 'UNSUPPORTED_CLAIM' | 'HALLUCINATED_TRAIN' | 'HALLUCINATED_STATION' | 'MALFORMED_OUTPUT';
  unsupportedEntities?: string[];
  notes?: string;
}

export class NewsFactValidator {
  public static validate(
    source: NewsDistillationInput,
    output: NewsDistillationOutput
  ): ValidationResult {
    const rawSource = (source.title + ' ' + source.summary).toLowerCase();
    const unsupportedEntities: string[] = [];

    // Trusted source trains: extracted by ingestion engine from source text before AI.
    // These are pre-verified — do NOT reject them as hallucinations.
    const trustedTrains = new Set((source.candidateTrains || []).map(t => String(t).trim()));

    if (Array.isArray(output.affected_trains)) {
      for (const t of output.affected_trains) {
        const trainStr = String(t).trim();
        if (trainStr && !trustedTrains.has(trainStr) && !rawSource.includes(trainStr.toLowerCase())) {
          unsupportedEntities.push(`Train ${trainStr}`);
        }
      }
    }

    if (Array.isArray(output.affected_stations)) {
      // candidateStations: trusted codes extracted by ingestion engine.
      const candidates = new Set((source.candidateStations || []).map(s => s.toLowerCase().trim()));
      for (const s of output.affected_stations) {
        const stationStr = String(s).trim().toLowerCase();
        if (stationStr && stationStr.length >= 2 && !rawSource.includes(stationStr) && !candidates.has(stationStr)) {
          unsupportedEntities.push(`Station ${s}`);
        }
      }
    }

    if (unsupportedEntities.length > 0) {
      winstonLogger.warn('[NEWS_AI_VALIDATOR_REJECT] Hallucinated/unsupported entities detected in AI draft', {
        sourceTitle: source.title.slice(0, 50),
        unsupportedEntities,
      });
      return {
        isValid: false,
        confidence: 'REJECTED',
        rejectionReason: 'UNSUPPORTED_CLAIM',
        unsupportedEntities,
        notes: `AI generated entities not present in source: ${unsupportedEntities.join(', ')}`,
      };
    }

    let confidence: 'HIGH' | 'MEDIUM' | 'LOW' = 'MEDIUM';
    if (source.sourceTier === 'TIER_1_OFFICIAL') {
      confidence = 'HIGH';
    } else if (source.sourceTier === 'TIER_3_RECOGNIZED_MEDIA') {
      confidence = 'MEDIUM';
    }

    if (!output.key_takeaways || !output.key_takeaways.what_happened) {
      confidence = 'LOW';
    }

    return { isValid: true, confidence };
  }
}

// Internal result type — propagates circuit-open state to batchDistill.
// wasRateLimited = true when the provider returns RATE_LIMITED (429),
// TIMEOUT, or PROVIDER_UNAVAILABLE — any of which halts Gemini calls for
// the remainder of the batch. triggerReason holds the exact error code.
interface DistillResult {
  article: CanonicalNewsArticle;
  wasRateLimited: boolean;
  triggerReason?: AiErrorCode;
}

const DELAY_NORMAL_MS      = 2000;  // Inter-article pause to stay comfortably below 15 RPM
const GLOBAL_COOLDOWN_MS   = 60000; // 60s cooldown after HTTP 429 (quota signal)
const TRANSIENT_COOLDOWN_MS = 30000; // 30s cooldown after TIMEOUT or PROVIDER_UNAVAILABLE

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

export class NewsDistillationService {
  private processedHashes = new Set<string>();
  private lastRateLimitTimestamp  = 0; // set on HTTP 429 — 60s GLOBAL_COOLDOWN_MS
  private lastTransientFailTimestamp = 0; // set on TIMEOUT or PROVIDER_UNAVAILABLE — 30s TRANSIENT_COOLDOWN_MS

  /**
   * Records a provider failure and selects the appropriate cooldown duration.
   * - RATE_LIMITED (429): GLOBAL_COOLDOWN_MS (60s) — quota signal
   * - TIMEOUT / PROVIDER_UNAVAILABLE: TRANSIENT_COOLDOWN_MS (30s) — transient signal
   */
  public recordRateLimit(errorCode: string = 'RATE_LIMITED'): void {
    if (errorCode === 'RATE_LIMITED') {
      this.lastRateLimitTimestamp = Date.now();
    } else {
      this.lastTransientFailTimestamp = Date.now();
    }
  }

  public isCooldownActive(): { active: boolean; remainingMs: number } {
    const now = Date.now();
    const rateLimitElapsed  = now - this.lastRateLimitTimestamp;
    const transientElapsed  = now - this.lastTransientFailTimestamp;

    if (rateLimitElapsed < GLOBAL_COOLDOWN_MS) {
      return { active: true, remainingMs: GLOBAL_COOLDOWN_MS - rateLimitElapsed };
    }
    if (transientElapsed < TRANSIENT_COOLDOWN_MS) {
      return { active: true, remainingMs: TRANSIENT_COOLDOWN_MS - transientElapsed };
    }
    return { active: false, remainingMs: 0 };
  }

  public resetCooldownForTesting(): void {
    this.lastRateLimitTimestamp    = 0;
    this.lastTransientFailTimestamp = 0;
  }

  public generateDeterministicDraft(article: CanonicalNewsArticle): NewsDistillationOutput {
    const title = article.title;
    const summary = article.summary;

    const takeaways = {
      what_happened: summary.slice(0, 200) || 'Official Indian Railway operational announcement.',
      who_is_affected: article.category === 'Cancellation' || article.category === 'Delays'
        ? 'Passengers on affected routes and connecting services.'
        : 'General railway passengers and commuters.',
      what_passengers_should_do: article.category === 'Cancellation'
        ? 'Verify live train status or check PNR for automated refund.'
        : 'Check IRCTC timetable and arrival/departure updates before travel.',
    };

    const faqs: NewsFaqItem[] = [
      {
        question: `How does this ${article.category} update affect travelers?`,
        answer: takeaways.what_happened,
      },
      {
        question: 'Where can passengers verify the latest schedule?',
        answer: 'Passengers should check Trayago Live Train Status or the official IRCTC portal.',
      },
    ];

    return {
      title,
      summary,
      key_takeaways: takeaways,
      affected_trains: article.affected_trains || [],
      affected_stations: article.affected_stations || [],
      seo_title: `${title.slice(0, 50)} | Trayago News`,
      meta_description: summary.slice(0, 150),
      slug: article.slug || `railway-news-${Date.now()}`,
      faqs,
      confidence: 'LOW',
      model: 'DETERMINISTIC_FALLBACK',
    };
  }

  /**
   * Distills a single article. Returns DistillResult with wasRateLimited flag
   * so batchDistill can apply structured backoff via AiError.code check.
   */
  public async distillArticle(article: CanonicalNewsArticle): Promise<DistillResult> {
    if (this.processedHashes.has(article.content_hash) && article.status === 'AI_DRAFTED') {
      winstonLogger.info(`[NEWS_AI_SKIPPED_DUPLICATE] Article ${article.id} hash already processed.`);
      return { article, wasRateLimited: false };
    }

    const input: NewsDistillationInput = {
      title: article.title,
      summary: article.summary,
      sourceName: article.source_name,
      sourceUrl: article.source_url,
      sourceTier: article.source_tier,
      publishedAt: article.published_at,
      category: article.category,
      candidateTrains: article.affected_trains,
      candidateStations: article.affected_stations,
    };

    let aiOutput: NewsDistillationOutput | null = null;
    let wasRateLimited = false;
    let triggerReason: AiErrorCode | undefined;

    try {
      const res = await aiProviderResolver.executeWithFallback<NewsDistillationOutput | null>(
        'distillNewsArticle',
        provider => {
          if (typeof provider.distillNewsArticle === 'function') {
            return provider.distillNewsArticle(input);
          }
          return Promise.resolve(null);
        },
        null,
        'NEWS_DISTILLATION'
      );

      if (res.result) {
        aiOutput = res.result;
      }

      // Structured check via typed AiError.code — no string matching.
      // Circuit opens on 429 (quota), TIMEOUT (network/load), or PROVIDER_UNAVAILABLE (5xx).
      const CIRCUIT_TRIGGER_CODES = new Set(['RATE_LIMITED', 'TIMEOUT', 'PROVIDER_UNAVAILABLE']);
      if (!aiOutput && res.error?.code && CIRCUIT_TRIGGER_CODES.has(res.error.code)) {
        wasRateLimited = true;
        triggerReason = res.error.code as AiErrorCode;
        this.recordRateLimit(res.error.code);
      }
    } catch (err: any) {
      winstonLogger.warn(`[NEWS_AI_DISTILL_ERROR] AI call failed for ${article.id}: ${err.message}`);
    }

    if (!aiOutput) {
      winstonLogger.info(`[NEWS_AI_FALLBACK_APPLIED] Using deterministic extraction for ${article.id}`);
      aiOutput = this.generateDeterministicDraft(article);
    }

    const validation = NewsFactValidator.validate(input, aiOutput);
    this.processedHashes.add(article.content_hash);
    const now = new Date().toISOString();

    if (!validation.isValid) {
      return {
        article: {
          ...article,
          status: 'REJECTED',
          ingestion_status: 'REJECTED',
          relevance_score: 0,
          updated_at: now,
        },
        wasRateLimited,
        triggerReason,
      };
    }

    return {
      article: {
        ...article,
        title: aiOutput.title || article.title,
        summary: aiOutput.summary || article.summary,
        key_takeaways: [
          aiOutput.key_takeaways.what_happened,
          aiOutput.key_takeaways.who_is_affected,
          aiOutput.key_takeaways.what_passengers_should_do,
        ].filter(Boolean),
        affected_trains: aiOutput.affected_trains.length > 0 ? aiOutput.affected_trains : article.affected_trains,
        affected_stations: aiOutput.affected_stations.length > 0 ? aiOutput.affected_stations : article.affected_stations,
        seo_title: aiOutput.seo_title,
        meta_description: aiOutput.meta_description,
        slug: aiOutput.slug || article.slug,
        status: 'AI_DRAFTED',
        ingestion_status: 'INGESTION_COMPLETE',
        updated_at: now,
      },
      wasRateLimited,
      triggerReason,
    };
  }

  /**
   * Distills multiple articles in batch with rate-limit and cost protection.
   *
   * - Global Cooldown: If a 429 occurred within the last 60s, bypass Gemini entirely.
   * - Batch Circuit Breaker: If any article hits 429, immediately switch all remaining
   *   articles in the batch to deterministic fallback (0 additional Gemini calls).
   * - Normal spacing: 2000ms delay between successful Gemini calls (< 10 RPM).
   * - GEMINI_NEWS_BATCH_MAX (default 10): only first N articles call Gemini.
   */
  public async batchDistill(articles: CanonicalNewsArticle[]): Promise<CanonicalNewsArticle[]> {
    const batchMax      = Math.max(1, parseInt(process.env.GEMINI_NEWS_BATCH_MAX ?? '10', 10));
    const aiSlice       = articles.slice(0, batchMax);
    const fallbackSlice = articles.slice(batchMax);

    if (fallbackSlice.length > 0) {
      winstonLogger.info(
        `[DISTILL_BATCH_LIMIT] requested=${articles.length} processed=${aiSlice.length} fallback=${fallbackSlice.length}`
      );
    }

    const cooldown = this.isCooldownActive();
    let circuitOpen = cooldown.active;

    if (circuitOpen) {
      winstonLogger.warn(
        `[GEMINI_COOLDOWN_ACTIVE] remaining_ms=${cooldown.remainingMs}. Routing entire batch (${articles.length} articles) directly to deterministic fallback.`
      );
    }

    const results: CanonicalNewsArticle[] = [];

    for (let i = 0; i < aiSlice.length; i++) {
      if (circuitOpen) {
        // Direct deterministic fallback without calling Gemini
        const article = aiSlice[i];
        const aiOutput = this.generateDeterministicDraft(article);
        const validation = NewsFactValidator.validate(
          {
            title:             article.title,
            summary:           article.summary,
            sourceName:        article.source_name,
            sourceUrl:         article.source_url,
            sourceTier:        article.source_tier,
            publishedAt:       article.published_at,
            category:          article.category,
            candidateTrains:   article.affected_trains,
            candidateStations: article.affected_stations,
          },
          aiOutput
        );
        this.processedHashes.add(article.content_hash);
        const now = new Date().toISOString();
        results.push(
          validation.isValid
            ? {
                ...article,
                title:            aiOutput.title   || article.title,
                summary:          aiOutput.summary || article.summary,
                key_takeaways:    [
                  aiOutput.key_takeaways.what_happened,
                  aiOutput.key_takeaways.who_is_affected,
                  aiOutput.key_takeaways.what_passengers_should_do,
                ].filter(Boolean),
                affected_trains:  aiOutput.affected_trains.length > 0 ? aiOutput.affected_trains : article.affected_trains,
                affected_stations:aiOutput.affected_stations.length > 0 ? aiOutput.affected_stations : article.affected_stations,
                seo_title:        aiOutput.seo_title,
                meta_description: aiOutput.meta_description,
                slug:             aiOutput.slug    || article.slug,
                status:           'AI_DRAFTED',
                ingestion_status: 'INGESTION_COMPLETE',
                updated_at:       now,
              }
            : {
                ...article,
                status:           'REJECTED',
                ingestion_status: 'REJECTED',
                relevance_score:  0,
                updated_at:       now,
              }
        );
        continue;
      }

      const { article, wasRateLimited, triggerReason } = await this.distillArticle(aiSlice[i]);
      results.push(article);

      if (wasRateLimited) {
        circuitOpen = true;
        const reason = triggerReason || 'RATE_LIMITED';
        winstonLogger.warn(
          `[BATCH_CIRCUIT_OPEN] Gemini ${reason} encountered at article ${i + 1}/${aiSlice.length}. Switching remaining ${aiSlice.length - (i + 1)} articles in this batch to deterministic fallback.`
        );
      } else if (i < aiSlice.length - 1) {
        await sleep(DELAY_NORMAL_MS);
      }
    }

    const now = new Date().toISOString();
    for (const article of fallbackSlice) {
      const aiOutput   = this.generateDeterministicDraft(article);
      const validation = NewsFactValidator.validate(
        {
          title:             article.title,
          summary:           article.summary,
          sourceName:        article.source_name,
          sourceUrl:         article.source_url,
          sourceTier:        article.source_tier,
          publishedAt:       article.published_at,
          category:          article.category,
          candidateTrains:   article.affected_trains,
          candidateStations: article.affected_stations,
        },
        aiOutput
      );
      this.processedHashes.add(article.content_hash);
      results.push(
        validation.isValid
          ? {
              ...article,
              title:            aiOutput.title   || article.title,
              summary:          aiOutput.summary || article.summary,
              seo_title:        aiOutput.seo_title,
              meta_description: aiOutput.meta_description,
              slug:             aiOutput.slug    || article.slug,
              status:           'AI_DRAFTED',
              ingestion_status: 'INGESTION_COMPLETE',
              updated_at:       now,
            }
          : {
              ...article,
              status:           'REJECTED',
              ingestion_status: 'REJECTED',
              relevance_score:  0,
              updated_at:       now,
            }
      );
    }

    return results;
  }
}

export const newsDistillationService = new NewsDistillationService();
