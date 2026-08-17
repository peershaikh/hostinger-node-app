import crypto from 'crypto';
import { supabase, isSupabaseConfigured } from '../config/supabase';
import { winstonLogger } from '../middleware/logger';
import { universalEventEmitter } from './universalEventEmitter';
import { UniversalEventNames, UniversalEventName } from '../constants/eventTaxonomy';
import { cacheService } from './cacheService';

export type SignalStrength = 'STRONG' | 'MEDIUM' | 'WEAK';
export type FeedbackType = 'EXPLICIT_RATING' | 'EXPLICIT_COMPLAINT' | 'IMPLICIT_INTERACTION' | 'PNR_OUTCOME';

export interface ExplicitFeedbackInput {
  feedbackId?: string;
  userId?: string | null;
  guestId?: string;
  ipAddress?: string;
  trainNumber?: string;
  route?: string;
  travelDate?: string;
  overallRating?: number;           // 1 to 5
  punctualityRating?: number;       // 1 to 5
  availabilityUsefulness?: boolean | number;
  routeUsefulness?: boolean | number;
  comments?: string;
  feature?: string;
  severity?: string;
  device?: string;
  metadata?: Record<string, any>;
}

export interface ImplicitSignalInput {
  eventName: UniversalEventName | string;
  eventId?: string;
  userId?: string | null;
  guestId?: string;
  ipAddress?: string;
  trainNumber?: string;
  route?: string;
  travelDate?: string;
  metadata?: Record<string, any>;
  timestamp?: string | Date;
}

export interface NormalizedFeedback {
  feedbackId: string;
  eventId?: string;
  correlationId?: string;
  userId?: string | null;
  anonymousId: string;
  trainNumber?: string;
  route?: string;
  travelDate?: string;
  feedbackType: FeedbackType;
  rating?: number;                  // 1 to 5
  sentimentScore: number;           // -1.0 (very negative) to +1.0 (very positive)
  signalStrength: SignalStrength;
  metadata: Record<string, any>;
  createdAt: string;
}

export interface FeedbackAggregate {
  targetId: string;                 // trainNumber or route
  targetType: 'TRAIN' | 'ROUTE';
  positiveSignals: number;
  negativeSignals: number;
  neutralSignals: number;
  sampleCount: number;
  averageRating?: number;
  netSentimentScore: number;        // -1.0 to +1.0
  signalDistribution: {
    strongCount: number;
    mediumCount: number;
    weakCount: number;
  };
  lastUpdated: string;
}

export class UserFeedbackIntelligenceService {
  // In-memory normalized feedback registry & aggregation stores
  private normalizedStore: NormalizedFeedback[] = [];
  private trainAggregates: Map<string, FeedbackAggregate> = new Map();
  private routeAggregates: Map<string, FeedbackAggregate> = new Map();

  // Spam & Rate limiting tracking: Map<anonymousId_target, timestamp[]>
  private submissionRateMap: Map<string, number[]> = new Map();
  // Deduplication cache: Set of dedupe hashes
  private dedupeHashes: Set<string> = new Set();

  private static readonly MAX_SUBMISSIONS_PER_WINDOW = 5;
  private static readonly RATE_WINDOW_MS = 10 * 60 * 1000; // 10 minutes
  private static readonly MIN_DEBOUNCE_MS = 1000;          // 1 second debounce
  private static readonly STORE_CAPACITY = 2000;

  constructor() {
    this.setupImplicitEventListener();
  }

  /**
   * Listen to canonical universal events to extract implicit feedback signals
   */
  private setupImplicitEventListener(): void {
    try {
      // Direct method called by universal event processing
    } catch (e: any) {
      winstonLogger.debug(`[FEEDBACK_SETUP_ERR] ${e.message}`);
    }
  }

  /**
   * Privacy helper: Hash sensitive user identifiers into anonymous pseudo-IDs
   */
  public generateAnonymousId(userId?: string | null, guestId?: string, ipAddress?: string): string {
    if (userId) {
      return `usr_${crypto.createHash('sha256').update(userId).digest('hex').substring(0, 16)}`;
    }
    const raw = `${guestId || 'guest'}_${ipAddress || 'unknown_ip'}`;
    return `anon_${crypto.createHash('sha256').update(raw).digest('hex').substring(0, 16)}`;
  }

  /**
   * Privacy helper: Redact sensitive fields (tokens, cookies, passwords, raw PNR)
   */
  public sanitizeMetadata(raw?: Record<string, any>): Record<string, any> {
    if (!raw || typeof raw !== 'object') return {};

    const clean: Record<string, any> = {};

    for (const [k, v] of Object.entries(raw)) {
      const lower = k.toLowerCase().replace(/[^a-z0-9]/g, '');
      if (
        lower.includes('password') ||
        lower.includes('token') ||
        lower.includes('csrf') ||
        lower.includes('secret') ||
        lower.includes('cookie') ||
        lower.includes('auth') ||
        lower.includes('session')
      ) {
        continue;
      }
      if (k.toLowerCase() === 'pnr' && typeof v === 'string') {
        // Redact PNR to last 3 digits
        clean[k] = v.length >= 3 ? `***${v.slice(-3)}` : '***';
      } else if (typeof v === 'object' && v !== null && !Array.isArray(v)) {
        clean[k] = this.sanitizeMetadata(v);
      } else {
        clean[k] = v;
      }
    }
    return clean;
  }

  /**
   * Spam and rate limiting guard
   */
  public checkRateLimitAndSpam(anonymousId: string, targetKey: string, dedupeKey: string): { allowed: boolean; reason?: string } {
    const now = Date.now();

    // 1. Exact Duplicate check
    if (this.dedupeHashes.has(dedupeKey)) {
      return { allowed: false, reason: 'DUPLICATE_SUBMISSION' };
    }

    const rateKey = `${anonymousId}_${targetKey}`;
    let timestamps = this.submissionRateMap.get(rateKey) || [];

    // Filter out timestamps older than rate window
    timestamps = timestamps.filter(t => now - t < UserFeedbackIntelligenceService.RATE_WINDOW_MS);

    // 2. Debounce check
    if (timestamps.length > 0) {
      const last = timestamps[timestamps.length - 1];
      if (now - last < UserFeedbackIntelligenceService.MIN_DEBOUNCE_MS) {
        return { allowed: false, reason: 'RAPID_BURST_SUBMISSION' };
      }
    }

    // 3. Window quota check
    if (timestamps.length >= UserFeedbackIntelligenceService.MAX_SUBMISSIONS_PER_WINDOW) {
      return { allowed: false, reason: 'RATE_LIMIT_EXCEEDED' };
    }

    timestamps.push(now);
    this.submissionRateMap.set(rateKey, timestamps);
    this.dedupeHashes.add(dedupeKey);

    return { allowed: true };
  }

  /**
   * Ingest and normalize explicit user feedback
   */
  public async ingestExplicitFeedback(input: ExplicitFeedbackInput): Promise<{ success: boolean; normalized?: NormalizedFeedback; reason?: string }> {
    if (!input) return { success: false, reason: 'NULL_INPUT' };

    const rating = input.overallRating !== undefined ? Number(input.overallRating) : undefined;
    if (rating !== undefined && (isNaN(rating) || rating < 1 || rating > 5)) {
      return { success: false, reason: 'INVALID_RATING_RANGE' };
    }

    const trainNo = input.trainNumber ? String(input.trainNumber).trim() : undefined;
    const route = input.route ? String(input.route).trim().toUpperCase() : undefined;
    const anonymousId = this.generateAnonymousId(input.userId, input.guestId, input.ipAddress);
    const targetKey = trainNo || route || 'general';

    // Build deduplication key
    const commentHash = crypto.createHash('md5').update(input.comments || '').digest('hex').substring(0, 8);
    const dedupeKey = `${anonymousId}_${targetKey}_${rating || 0}_${commentHash}`;

    // Spam & rate-limit check
    const rateCheck = this.checkRateLimitAndSpam(anonymousId, targetKey, dedupeKey);
    if (!rateCheck.allowed) {
      winstonLogger.info(`[FEEDBACK_GUARD_REJECT] target=${targetKey} reason=${rateCheck.reason}`);
      return { success: false, reason: rateCheck.reason };
    }

    // Compute sentiment score from rating (1 to 5 mapped to -1.0 to +1.0)
    let sentimentScore = 0.0;
    if (rating !== undefined) {
      sentimentScore = (rating - 3) / 2.0; // 5 -> +1.0, 4 -> +0.5, 3 -> 0.0, 2 -> -0.5, 1 -> -1.0
    } else if (input.punctualityRating !== undefined) {
      sentimentScore = (Number(input.punctualityRating) - 3) / 2.0;
    }

    const sanitizedMeta = this.sanitizeMetadata({
      ...input.metadata,
      comments: input.comments,
      feature: input.feature,
      severity: input.severity,
      device: input.device,
      punctualityRating: input.punctualityRating,
      availabilityUsefulness: input.availabilityUsefulness,
      routeUsefulness: input.routeUsefulness
    });

    const normalized: NormalizedFeedback = {
      feedbackId: input.feedbackId || `fb_${Date.now()}_${Math.random().toString(36).substring(2, 7)}`,
      userId: input.userId || null,
      anonymousId,
      trainNumber: trainNo,
      route,
      travelDate: input.travelDate,
      feedbackType: 'EXPLICIT_RATING',
      rating,
      sentimentScore,
      signalStrength: 'STRONG',
      metadata: sanitizedMeta,
      createdAt: new Date().toISOString()
    };

    // Store in normalized list & update aggregates
    this.recordNormalizedFeedback(normalized);

    // Emit canonical event via universalEventEmitter
    universalEventEmitter.emit({
      eventName: UniversalEventNames.FEEDBACK_SUBMITTED,
      userId: input.userId || null,
      guestId: input.guestId,
      route,
      metadata: {
        feedbackId: normalized.feedbackId,
        trainNumber: trainNo,
        rating,
        sentimentScore,
        signalStrength: 'STRONG'
      }
    });

    return { success: true, normalized };
  }

  /**
   * Ingest and map implicit user interactions to normalized feedback signals
   */
  public ingestImplicitSignal(input: ImplicitSignalInput): { success: boolean; normalized?: NormalizedFeedback; reason?: string } {
    if (!input || !input.eventName) return { success: false, reason: 'INVALID_EVENT' };

    const eventName = String(input.eventName);
    let signalStrength: SignalStrength = 'WEAK';
    let sentimentScore = 0.1; // Default weak positive engagement
    let feedbackType: FeedbackType = 'IMPLICIT_INTERACTION';

    // Map canonical event to signal strength and sentiment
    switch (eventName) {
      case UniversalEventNames.BOOKING_OUTBOUND_CLICK:
      case UniversalEventNames.BOOKING_PLACEHOLDER:
        signalStrength = 'STRONG';
        sentimentScore = 1.0;
        break;

      case UniversalEventNames.COMPLAINT_LOGGED:
        signalStrength = 'STRONG';
        sentimentScore = -1.0;
        feedbackType = 'EXPLICIT_COMPLAINT';
        break;

      case UniversalEventNames.SPLIT_RESULT_CLICKED:
      case UniversalEventNames.SPLIT_RESULT_EXPANDED:
        signalStrength = 'MEDIUM';
        sentimentScore = 0.6;
        break;

      case UniversalEventNames.COACH_SWAP_OPENED:
      case UniversalEventNames.AVAILABILITY_CHECKED:
        signalStrength = 'MEDIUM';
        sentimentScore = 0.4;
        break;

      case UniversalEventNames.PNR_PREDICTION_FEEDBACK:
        signalStrength = 'STRONG';
        sentimentScore = input.metadata?.user_feedback === true ? 1.0 : -1.0;
        feedbackType = 'PNR_OUTCOME';
        break;

      case UniversalEventNames.TRAIN_RESULT_CLICKED:
      case UniversalEventNames.TIMETABLE_OPENED:
      case UniversalEventNames.ROUTE_SHARED:
        signalStrength = 'WEAK';
        sentimentScore = 0.2;
        break;

      default:
        signalStrength = 'WEAK';
        sentimentScore = 0.1;
        break;
    }

    const trainNo = input.trainNumber || input.metadata?.trainNumber;
    const route = input.route || input.metadata?.route;
    const anonymousId = this.generateAnonymousId(input.userId, input.guestId, input.ipAddress);
    const dedupeKey = `${input.eventId || eventName}_${anonymousId}_${trainNo || ''}_${route || ''}_${Math.floor(Date.now() / 5000)}`;

    if (this.dedupeHashes.has(dedupeKey)) {
      return { success: false, reason: 'DUPLICATE_EVENT' };
    }
    this.dedupeHashes.add(dedupeKey);

    const normalized: NormalizedFeedback = {
      feedbackId: `imp_${Date.now()}_${Math.random().toString(36).substring(2, 7)}`,
      eventId: input.eventId,
      userId: input.userId || null,
      anonymousId,
      trainNumber: trainNo ? String(trainNo).trim() : undefined,
      route: route ? String(route).trim().toUpperCase() : undefined,
      travelDate: input.travelDate,
      feedbackType,
      sentimentScore,
      signalStrength,
      metadata: this.sanitizeMetadata(input.metadata),
      createdAt: input.timestamp ? new Date(input.timestamp).toISOString() : new Date().toISOString()
    };

    this.recordNormalizedFeedback(normalized);
    return { success: true, normalized };
  }

  /**
   * Internal record method: Appends to bounded store and updates train/route aggregates
   */
  private recordNormalizedFeedback(normalized: NormalizedFeedback): void {
    this.normalizedStore.push(normalized);
    if (this.normalizedStore.length > UserFeedbackIntelligenceService.STORE_CAPACITY) {
      this.normalizedStore.shift();
    }

    // Update train aggregate if trainNumber exists
    if (normalized.trainNumber) {
      this.updateAggregate(this.trainAggregates, normalized.trainNumber, 'TRAIN', normalized);
    }

    // Update route aggregate if route exists
    if (normalized.route) {
      this.updateAggregate(this.routeAggregates, normalized.route, 'ROUTE', normalized);
    }
  }

  /**
   * Incremental aggregate updater
   */
  private updateAggregate(
    store: Map<string, FeedbackAggregate>,
    targetId: string,
    targetType: 'TRAIN' | 'ROUTE',
    feedback: NormalizedFeedback
  ): void {
    const existing = store.get(targetId) || {
      targetId,
      targetType,
      positiveSignals: 0,
      negativeSignals: 0,
      neutralSignals: 0,
      sampleCount: 0,
      averageRating: undefined,
      netSentimentScore: 0.0,
      signalDistribution: { strongCount: 0, mediumCount: 0, weakCount: 0 },
      lastUpdated: feedback.createdAt
    };

    existing.sampleCount++;
    if (feedback.sentimentScore > 0.2) {
      existing.positiveSignals++;
    } else if (feedback.sentimentScore < -0.2) {
      existing.negativeSignals++;
    } else {
      existing.neutralSignals++;
    }

    // Update signal distribution
    if (feedback.signalStrength === 'STRONG') existing.signalDistribution.strongCount++;
    else if (feedback.signalStrength === 'MEDIUM') existing.signalDistribution.mediumCount++;
    else existing.signalDistribution.weakCount++;

    // Compute rolling net sentiment
    const weight = feedback.signalStrength === 'STRONG' ? 1.0 : feedback.signalStrength === 'MEDIUM' ? 0.5 : 0.2;
    const currentTotalWeight = (existing.sampleCount - 1) + weight;
    existing.netSentimentScore = Math.round(
      ((existing.netSentimentScore * (existing.sampleCount - 1) + feedback.sentimentScore * weight) / (currentTotalWeight || 1)) * 100
    ) / 100;

    // Rolling average rating if explicit rating provided
    if (feedback.rating !== undefined) {
      if (existing.averageRating === undefined) {
        existing.averageRating = feedback.rating;
      } else {
        existing.averageRating = Math.round(((existing.averageRating * (existing.sampleCount - 1) + feedback.rating) / existing.sampleCount) * 10) / 10;
      }
    }

    existing.lastUpdated = feedback.createdAt;
    store.set(targetId, existing);
  }

  /**
   * Retrieves aggregated feedback intelligence for a specific train
   */
  public getTrainFeedbackAggregate(trainNumber: string): FeedbackAggregate {
    const cleanNo = String(trainNumber || '').trim();
    return this.trainAggregates.get(cleanNo) || {
      targetId: cleanNo,
      targetType: 'TRAIN',
      positiveSignals: 0,
      negativeSignals: 0,
      neutralSignals: 0,
      sampleCount: 0,
      averageRating: undefined,
      netSentimentScore: 0.0,
      signalDistribution: { strongCount: 0, mediumCount: 0, weakCount: 0 },
      lastUpdated: new Date().toISOString()
    };
  }

  /**
   * Retrieves aggregated feedback intelligence for a specific route
   */
  public getRouteFeedbackAggregate(route: string): FeedbackAggregate {
    const cleanRoute = String(route || '').trim().toUpperCase();
    return this.routeAggregates.get(cleanRoute) || {
      targetId: cleanRoute,
      targetType: 'ROUTE',
      positiveSignals: 0,
      negativeSignals: 0,
      neutralSignals: 0,
      sampleCount: 0,
      averageRating: undefined,
      netSentimentScore: 0.0,
      signalDistribution: { strongCount: 0, mediumCount: 0, weakCount: 0 },
      lastUpdated: new Date().toISOString()
    };
  }

  /**
   * Clear in-memory buffers
   */
  public clear(): void {
    this.normalizedStore = [];
    this.trainAggregates.clear();
    this.routeAggregates.clear();
    this.submissionRateMap.clear();
    this.dedupeHashes.clear();
  }
}

export const userFeedbackIntelligenceService = new UserFeedbackIntelligenceService();
