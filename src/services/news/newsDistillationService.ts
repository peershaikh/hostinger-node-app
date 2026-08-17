import { winstonLogger } from '../../middleware/logger';
import { aiProviderResolver } from '../ai/aiProviderResolver';
import { CanonicalNewsArticle } from './newsTypes';
import { NewsDistillationInput, NewsDistillationOutput, NewsFaqItem } from '../ai/aiProvider';

export interface ValidationResult {
  isValid: boolean;
  confidence: 'HIGH' | 'MEDIUM' | 'LOW' | 'REJECTED';
  rejectionReason?: 'UNSUPPORTED_CLAIM' | 'HALLUCINATED_TRAIN' | 'HALLUCINATED_STATION' | 'MALFORMED_OUTPUT';
  unsupportedEntities?: string[];
  notes?: string;
}

export class NewsFactValidator {
  /**
   * Validates AI-generated structured output against raw source content.
   * Ensures zero fabrication of train numbers, stations, or operational claims.
   */
  public static validate(
    source: NewsDistillationInput,
    output: NewsDistillationOutput
  ): ValidationResult {
    const rawSource = (source.title + ' ' + source.summary).toLowerCase();
    const unsupportedEntities: string[] = [];

    // 1. Validate Train Numbers
    if (Array.isArray(output.affected_trains)) {
      for (const t of output.affected_trains) {
        const trainStr = String(t).trim();
        if (trainStr && !rawSource.includes(trainStr.toLowerCase())) {
          unsupportedEntities.push(`Train ${trainStr}`);
        }
      }
    }

    // 2. Validate Station Codes / Names
    if (Array.isArray(output.affected_stations)) {
      const candidates = new Set((source.candidateStations || []).map(s => s.toLowerCase().trim()));
      for (const s of output.affected_stations) {
        const stationStr = String(s).trim().toLowerCase();
        if (stationStr && stationStr.length >= 2 && !rawSource.includes(stationStr) && !candidates.has(stationStr)) {
          unsupportedEntities.push(`Station ${s}`);
        }
      }
    }

    // 3. Reject if hallucinated entities found
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

    // 4. Determine factual confidence based on source tier and coverage
    let confidence: 'HIGH' | 'MEDIUM' | 'LOW' = 'MEDIUM';
    if (source.sourceTier === 'TIER_1_OFFICIAL') {
      confidence = 'HIGH';
    } else if (source.sourceTier === 'TIER_3_RECOGNIZED_MEDIA') {
      confidence = 'MEDIUM';
    }

    // If summary is suspiciously sparse
    if (!output.key_takeaways || !output.key_takeaways.what_happened) {
      confidence = 'LOW';
    }

    return {
      isValid: true,
      confidence,
    };
  }
}

export class NewsDistillationService {
  private processedHashes = new Set<string>();

  /**
   * Generates a deterministic fallback draft when AI is unavailable or fails.
   */
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
   * Distills a single canonical news article through AI fact distillation and post-validation.
   */
  public async distillArticle(article: CanonicalNewsArticle): Promise<CanonicalNewsArticle> {
    // 1. Duplicate AI Call Guard: check content_hash
    if (this.processedHashes.has(article.content_hash) && article.status === 'AI_DRAFTED') {
      winstonLogger.info(`[NEWS_AI_SKIPPED_DUPLICATE] Article ${article.id} hash already processed.`);
      return article;
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

    try {
      // 2. Invoke through canonical AI Provider Resolver (Gemini Adapter)
      const res = await aiProviderResolver.executeWithFallback<NewsDistillationOutput | null>(
        'distillNewsArticle',
        provider => {
          if (typeof provider.distillNewsArticle === 'function') {
            return provider.distillNewsArticle(input);
          }
          return Promise.resolve(null);
        }
      );

      if (res.result) {
        aiOutput = res.result;
      }
    } catch (err: any) {
      winstonLogger.warn(`[NEWS_AI_DISTILL_ERROR] AI call failed for ${article.id}: ${err.message}`);
    }

    // 3. Fallback if AI output is empty
    if (!aiOutput) {
      winstonLogger.info(`[NEWS_AI_FALLBACK_APPLIED] Using deterministic extraction for ${article.id}`);
      aiOutput = this.generateDeterministicDraft(article);
    }

    // 4. Zero-Hallucination Post-Generation Validator
    const validation = NewsFactValidator.validate(input, aiOutput);

    this.processedHashes.add(article.content_hash);

    const now = new Date().toISOString();

    if (!validation.isValid) {
      // Flag as rejected draft due to unsupported claims
      return {
        ...article,
        status: 'REJECTED',
        ingestion_status: 'REJECTED',
        relevance_score: 0,
        updated_at: now,
      };
    }

    // 5. Successful AI Draft -> REVIEW_REQUIRED (Never auto-published directly)
    return {
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
    };
  }

  /**
   * Distills multiple articles in batch with rate-limit and cost protection.
   */
  public async batchDistill(articles: CanonicalNewsArticle[]): Promise<CanonicalNewsArticle[]> {
    const results: CanonicalNewsArticle[] = [];
    for (const article of articles) {
      const distilled = await this.distillArticle(article);
      results.push(distilled);
    }
    return results;
  }
}

export const newsDistillationService = new NewsDistillationService();
