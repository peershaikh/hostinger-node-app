import { supabase, isSupabaseConfigured } from '../config/supabase';
import { winstonLogger } from '../middleware/logger';
import { cacheService } from './cacheService';
import { universalEventEmitter } from './universalEventEmitter';
import { UniversalEventNames } from '../constants/eventTaxonomy';
import { userFeedbackIntelligenceService } from './userFeedbackIntelligenceService';

export interface LiveObservationInput {
  trainNumber: string;
  stationCode?: string;
  delayMinutes: number;
  observedAt?: string | Date;
  status?: string;
  journeyDate?: string;
  source?: 'IRCTC' | 'RAILRADAR' | 'RAILYATRI' | 'CONFIRMTKT' | 'MANUAL' | 'LOCAL';
}

export interface ValidatedObservation {
  trainNumber: string;
  stationCode: string;
  delayMinutes: number;
  observedAt: Date;
  journeyDate: string;
  source: string;
  id: string;
}

export interface FeedbackSignalSummary {
  feedbackScore: number;        // 0 - 100
  feedbackConfidence: number;   // 0 - 100
  sampleCount: number;
  netSentiment: number;         // -1.0 to +1.0
  averageRating?: number;
}

export interface TrainReliabilityResult {
  trainNumber: string;
  reliabilityScore: number;       // 0 - 100 (deterministic composite)
  operationalReliabilityScore?: number; // Raw operational score before feedback reinforcement
  confidenceScore: number;        // 0 - 100 (based on sample size & recency)
  sampleSize: number;             // Total valid deduplicated observations
  effectiveSampleSize: number;    // Recency-weighted sample size
  averageDelayMinutes: number;    // Weighted average delay
  medianDelayMinutes: number;     // Median delay
  onTimeRate: number;             // 0.0 - 1.0 (fraction of runs with <= 15m delay)
  punctualRate: number;           // 0.0 - 1.0 (fraction of runs with <= 5m delay)
  severeDelayRate: number;        // 0.0 - 1.0 (fraction of runs with >= 60m delay)
  feedbackSignal?: FeedbackSignalSummary;
  recentPerformance: {
    score: number;                // 0 - 100 for recent window
    averageDelayMinutes: number;  // Avg delay of recent runs
    trend: 'IMPROVING' | 'DEGRADING' | 'STABLE' | 'UNKNOWN';
  };
  dataQuality: {
    validObservations: number;
    rejectedObservations: number;
    duplicateCount: number;
  };
  classification: 'EXCELLENT' | 'GOOD' | 'MODERATE' | 'POOR' | 'CRITICAL' | 'UNKNOWN';
  lastUpdated: string;
}

export class TrainReliabilityService {
  // Deterministic algorithm constants
  private static readonly MIN_SAMPLE_SIZE = 5;
  private static readonly TARGET_SAMPLE_SIZE = 25;
  private static readonly PRIOR_RELIABILITY = 72.0; // Network baseline prior
  private static readonly PRIOR_WEIGHT = 5.0;       // Bayesian shrinkage weight
  private static readonly RECENCY_HALF_LIFE_DAYS = 14;
  private static readonly MAX_VALID_DELAY_MINS = 1440; // 24 hours
  private static readonly ON_TIME_THRESHOLD_MINS = 15;
  private static readonly PUNCTUAL_THRESHOLD_MINS = 5;
  private static readonly SEVERE_DELAY_THRESHOLD_MINS = 60;
  private static readonly RETENTION_DAYS = 60;
  private static readonly CACHE_TTL_SECONDS = 900; // 15 minutes

  // In-memory observation store for local / cached runs
  private localObservations: Map<string, ValidatedObservation[]> = new Map();
  private cache: Map<string, { result: TrainReliabilityResult; cachedAt: number }> = new Map();

  constructor() {
    this.setupEventListener();
  }

  /**
   * Handles live tracking event to update observations dynamically
   */
  public handleLiveTrackEvent(event: { trainNumber?: string; delayMinutes?: number; stationCode?: string; timestamp?: string | Date }): void {
    if (event?.trainNumber && typeof event.delayMinutes === 'number') {
      this.recordObservation({
        trainNumber: String(event.trainNumber),
        stationCode: event.stationCode || 'UNKNOWN',
        delayMinutes: event.delayMinutes,
        observedAt: event.timestamp || new Date(),
        source: 'LOCAL'
      }).catch(err => {
        winstonLogger.debug(`[RELIABILITY_EVENT_ERR] ${err.message}`);
      });
    }
  }

  private setupEventListener(): void {
    // Registered hook for event pipeline
  }

  /**
   * Validates and cleanses raw observation inputs according to strict data quality rules
   */
  public validateObservation(raw: LiveObservationInput): { observation: ValidatedObservation | null; reason?: string } {
    if (!raw) return { observation: null, reason: 'NULL_INPUT' };

    const trainNo = String(raw.trainNumber || '').trim();
    if (!trainNo || trainNo.length < 4 || trainNo.length > 6 || !/^\d+$/.test(trainNo)) {
      return { observation: null, reason: 'INVALID_TRAIN_NUMBER' };
    }

    const delay = Number(raw.delayMinutes);
    if (isNaN(delay) || delay < 0) {
      return { observation: null, reason: 'NEGATIVE_OR_NAN_DELAY' };
    }

    if (delay > TrainReliabilityService.MAX_VALID_DELAY_MINS) {
      return { observation: null, reason: 'EXCESSIVE_OUTLIER_DELAY' };
    }

    let observedDate: Date;
    if (raw.observedAt instanceof Date) {
      observedDate = raw.observedAt;
    } else if (typeof raw.observedAt === 'string') {
      observedDate = new Date(raw.observedAt);
      if (isNaN(observedDate.getTime())) {
        return { observation: null, reason: 'INVALID_OBSERVED_DATE' };
      }
    } else {
      observedDate = new Date();
    }

    // Check retention window
    const now = Date.now();
    const ageDays = (now - observedDate.getTime()) / (1000 * 60 * 60 * 24);
    if (ageDays > TrainReliabilityService.RETENTION_DAYS) {
      return { observation: null, reason: 'STALE_OUTSIDE_RETENTION' };
    }

    const stationCode = String(raw.stationCode || 'UNKNOWN').trim().toUpperCase();
    const journeyDate = raw.journeyDate || observedDate.toISOString().split('T')[0];
    const source = raw.source || 'LOCAL';
    const id = `${trainNo}_${journeyDate}_${stationCode}_${Math.floor(observedDate.getTime() / (1000 * 60 * 30))}`;

    return {
      observation: {
        trainNumber: trainNo,
        stationCode,
        delayMinutes: Math.round(delay),
        observedAt: observedDate,
        journeyDate,
        source,
        id
      }
    };
  }

  /**
   * Records a single live observation into the in-memory store and invalidates cache
   */
  public async recordObservation(raw: LiveObservationInput): Promise<{ success: boolean; reason?: string }> {
    const { observation, reason } = this.validateObservation(raw);
    if (!observation) {
      winstonLogger.debug(`[RELIABILITY_REJECT] train=${raw?.trainNumber} reason=${reason}`);
      return { success: false, reason };
    }

    const trainNo = observation.trainNumber;
    let list = this.localObservations.get(trainNo) || [];

    // Deduplicate
    const isDuplicate = list.some(o => o.id === observation.id || (o.journeyDate === observation.journeyDate && o.stationCode === observation.stationCode));
    if (isDuplicate) {
      return { success: false, reason: 'DUPLICATE_OBSERVATION' };
    }

    list.push(observation);
    // Keep list bounded to last 200 records per train
    if (list.length > 200) {
      list.sort((a, b) => b.observedAt.getTime() - a.observedAt.getTime());
      list = list.slice(0, 200);
    }
    this.localObservations.set(trainNo, list);

    // Invalidate caches
    this.cache.delete(trainNo);
    cacheService.del(`reliability:${trainNo}`);

    return { success: true };
  }

  /**
   * Ingests a batch of observations (cleanses, validates, and deduplicates)
   */
  public async recordBatch(rawList: LiveObservationInput[]): Promise<{ valid: number; rejected: number; duplicates: number }> {
    let valid = 0;
    let rejected = 0;
    let duplicates = 0;

    for (const raw of rawList) {
      const res = await this.recordObservation(raw);
      if (res.success) {
        valid++;
      } else if (res.reason === 'DUPLICATE_OBSERVATION') {
        duplicates++;
      } else {
        rejected++;
      }
    }

    return { valid, rejected, duplicates };
  }

  /**
   * Computes deterministic train reliability metrics from a list of validated observations
   */
  public computeReliabilityFromObservations(
    trainNumber: string,
    rawObservations: LiveObservationInput[],
    asOfDate: Date = new Date()
  ): TrainReliabilityResult {
    let rejectedCount = 0;
    let duplicateCount = 0;
    const dedupeMap = new Map<string, ValidatedObservation>();

    // Step 1: Validate and deduplicate
    for (const raw of rawObservations) {
      const { observation, reason } = this.validateObservation(raw);
      if (!observation) {
        rejectedCount++;
        continue;
      }

      const dedupeKey = `${observation.journeyDate}_${observation.stationCode}_${observation.delayMinutes}`;
      if (dedupeMap.has(dedupeKey)) {
        duplicateCount++;
        continue;
      }

      dedupeMap.set(dedupeKey, observation);
    }

    const observations = Array.from(dedupeMap.values());
    const sampleSize = observations.length;

    // Step 2: Handle Unknown / Empty Train
    if (sampleSize === 0) {
      let feedbackSignal: FeedbackSignalSummary | undefined = undefined;
      let finalScore = TrainReliabilityService.PRIOR_RELIABILITY;

      try {
        const fb = userFeedbackIntelligenceService.getTrainFeedbackAggregate(trainNumber);
        if (fb && fb.sampleCount >= 3) {
          const sampleSat = Math.min(1.0, Math.pow(fb.sampleCount / 20.0, 0.75));
          const feedbackConfidence = Math.round(sampleSat * 50); // Attenuated without operational data
          const feedbackScore = fb.averageRating ? Math.round((fb.averageRating / 5.0) * 100) : Math.round((fb.netSentimentScore + 1.0) * 50);
          feedbackSignal = {
            feedbackScore,
            feedbackConfidence,
            sampleCount: fb.sampleCount,
            netSentiment: fb.netSentimentScore,
            averageRating: fb.averageRating
          };
          const delta = feedbackScore - TrainReliabilityService.PRIOR_RELIABILITY;
          finalScore = Math.round(TrainReliabilityService.PRIOR_RELIABILITY + delta * (feedbackConfidence / 100.0) * 0.08);
        }
      } catch {
        // Ignore
      }

      return {
        trainNumber,
        reliabilityScore: finalScore,
        operationalReliabilityScore: TrainReliabilityService.PRIOR_RELIABILITY,
        confidenceScore: 0,
        sampleSize: 0,
        effectiveSampleSize: 0,
        averageDelayMinutes: 0,
        medianDelayMinutes: 0,
        onTimeRate: 1.0,
        punctualRate: 1.0,
        severeDelayRate: 0.0,
        feedbackSignal,
        recentPerformance: {
          score: TrainReliabilityService.PRIOR_RELIABILITY,
          averageDelayMinutes: 0,
          trend: 'UNKNOWN'
        },
        dataQuality: {
          validObservations: 0,
          rejectedObservations: rejectedCount,
          duplicateCount
        },
        classification: 'UNKNOWN',
        lastUpdated: asOfDate.toISOString()
      };
    }

    // Step 3: Compute Recency Weights (Exponential Decay: half-life = 14 days)
    const asOfMs = asOfDate.getTime();
    const lambda = Math.log(2) / TrainReliabilityService.RECENCY_HALF_LIFE_DAYS;

    let totalWeight = 0;
    let weightedDelaySum = 0;
    let weightedOnTimeSum = 0;
    let weightedPunctualSum = 0;
    let weightedSevereDelaySum = 0;
    let latestObservationMs = 0;

    const delayValues: number[] = [];

    observations.forEach(obs => {
      const ageDays = Math.max(0, (asOfMs - obs.observedAt.getTime()) / (1000 * 60 * 60 * 24));
      const weight = Math.exp(-lambda * ageDays);

      totalWeight += weight;
      weightedDelaySum += obs.delayMinutes * weight;

      if (obs.delayMinutes <= TrainReliabilityService.ON_TIME_THRESHOLD_MINS) {
        weightedOnTimeSum += weight;
      }
      if (obs.delayMinutes <= TrainReliabilityService.PUNCTUAL_THRESHOLD_MINS) {
        weightedPunctualSum += weight;
      }
      if (obs.delayMinutes >= TrainReliabilityService.SEVERE_DELAY_THRESHOLD_MINS) {
        weightedSevereDelaySum += weight;
      }

      delayValues.push(obs.delayMinutes);
      if (obs.observedAt.getTime() > latestObservationMs) {
        latestObservationMs = obs.observedAt.getTime();
      }
    });

    // Step 4: Aggregate Statistical Metrics
    const weightedAvgDelay = totalWeight > 0 ? weightedDelaySum / totalWeight : 0;
    const onTimeRate = totalWeight > 0 ? weightedOnTimeSum / totalWeight : 0;
    const punctualRate = totalWeight > 0 ? weightedPunctualSum / totalWeight : 0;
    const severeDelayRate = totalWeight > 0 ? weightedSevereDelaySum / totalWeight : 0;

    // Median Delay
    delayValues.sort((a, b) => a - b);
    const mid = Math.floor(delayValues.length / 2);
    const medianDelay = delayValues.length % 2 !== 0 ? delayValues[mid] : Math.round((delayValues[mid - 1] + delayValues[mid]) / 2);

    // Step 5: Deterministic Reliability Calculation
    // Delay Penalty: max(0, 100 - (avgDelay / 1.2) - (120 * severeDelayRate))
    const delayPenaltyComponent = Math.max(0, 100 - (weightedAvgDelay / 1.2) - (120 * severeDelayRate));
    // Punctuality Component: (onTimeRate * 70) + (punctualRate * 30)
    const punctualityComponent = (onTimeRate * 70) + (punctualRate * 30);
    // Composite raw score: 55% punctuality + 45% delay penalty
    const rawReliability = Math.max(0, Math.min(100, 0.55 * punctualityComponent + 0.45 * delayPenaltyComponent));

    // Step 6: Low Sample Size Protection (Bayesian Shrinkage)
    const effectiveN = totalWeight;
    const m = TrainReliabilityService.PRIOR_WEIGHT;
    const prior = TrainReliabilityService.PRIOR_RELIABILITY;

    const shrunkReliability = Math.round(
      Math.max(0, Math.min(100, (effectiveN * rawReliability + m * prior) / (effectiveN + m)))
    );

    // Step 7: Confidence Score
    // Confidence is a function of total sample count, sample saturation, and freshness
    const sampleRatio = Math.min(1.0, sampleSize / TrainReliabilityService.TARGET_SAMPLE_SIZE);
    const saturation = Math.pow(sampleRatio, 0.7);
    const avgAgeDays = observations.reduce((sum, o) => sum + (asOfMs - o.observedAt.getTime()) / (1000 * 60 * 60 * 24), 0) / sampleSize;
    const freshnessFactor = Math.max(0.6, 1.0 - (avgAgeDays / (TrainReliabilityService.RETENTION_DAYS * 1.5)));
    const confidenceScore = Math.round(Math.max(0, Math.min(100, saturation * freshnessFactor * 100)));

    // Step 8: Recent Performance & Trend
    // Split into recent (last 7 days / top 30% most recent) vs historical
    observations.sort((a, b) => b.observedAt.getTime() - a.observedAt.getTime());
    const recentWindowSize = Math.max(1, Math.ceil(sampleSize * 0.35));
    const recentSubset = observations.slice(0, recentWindowSize);
    const olderSubset = observations.slice(recentWindowSize);

    const recentAvgDelay = recentSubset.reduce((sum, o) => sum + o.delayMinutes, 0) / recentSubset.length;
    const recentOnTime = recentSubset.filter(o => o.delayMinutes <= TrainReliabilityService.ON_TIME_THRESHOLD_MINS).length / recentSubset.length;
    const recentScore = Math.round(Math.max(0, Math.min(100, (recentOnTime * 60) + Math.max(0, 40 - (recentAvgDelay / 3)))));

    let trend: 'IMPROVING' | 'DEGRADING' | 'STABLE' | 'UNKNOWN' = 'STABLE';
    if (olderSubset.length > 0) {
      const olderAvgDelay = olderSubset.reduce((sum, o) => sum + o.delayMinutes, 0) / olderSubset.length;
      if (recentAvgDelay < olderAvgDelay - 10) {
        trend = 'IMPROVING';
      } else if (recentAvgDelay > olderAvgDelay + 15) {
        trend = 'DEGRADING';
      } else {
        trend = 'STABLE';
      }
    } else {
      trend = sampleSize >= 3 ? 'STABLE' : 'UNKNOWN';
    }

    // Step 9: Feedback Intelligence Signal Integration (Controlled Secondary Refinement)
    let feedbackSignal: FeedbackSignalSummary | undefined = undefined;
    let finalReliability = shrunkReliability;

    try {
      const fb = userFeedbackIntelligenceService.getTrainFeedbackAggregate(trainNumber);
      if (fb && fb.sampleCount >= 3) {
        const sampleSat = Math.min(1.0, Math.pow(fb.sampleCount / 20.0, 0.75));
        const totalDist = (fb.signalDistribution?.strongCount || 0) + (fb.signalDistribution?.mediumCount || 0) + (fb.signalDistribution?.weakCount || 0);
        const distWeight = totalDist > 0
          ? ((fb.signalDistribution.strongCount * 1.0) + (fb.signalDistribution.mediumCount * 0.5) + (fb.signalDistribution.weakCount * 0.2)) / totalDist
          : 0.5;

        let recencyFactor = 1.0;
        if (fb.lastUpdated) {
          const ageDays = Math.max(0, (asOfDate.getTime() - new Date(fb.lastUpdated).getTime()) / (1000 * 60 * 60 * 24));
          recencyFactor = Math.max(0.6, 1.0 - (ageDays / 120.0));
        }

        const feedbackConfidence = Math.round(Math.max(0, Math.min(100, sampleSat * distWeight * recencyFactor * 100)));

        let feedbackScore = 70.0;
        if (fb.averageRating !== undefined) {
          const ratingScore = (fb.averageRating / 5.0) * 100;
          feedbackScore = Math.round(ratingScore * 0.7 + ((fb.netSentimentScore + 1.0) * 50) * 0.3);
        } else {
          feedbackScore = Math.round((fb.netSentimentScore + 1.0) * 50);
        }

        feedbackSignal = {
          feedbackScore,
          feedbackConfidence,
          sampleCount: fb.sampleCount,
          netSentiment: fb.netSentimentScore,
          averageRating: fb.averageRating
        };

        // Controlled secondary reinforcement: max ±6 points (8% max weight at 100% confidence)
        const feedbackDelta = feedbackScore - shrunkReliability;
        const feedbackModifier = Math.round(feedbackDelta * (feedbackConfidence / 100.0) * 0.08 * 10) / 10;
        finalReliability = Math.max(0, Math.min(100, Math.round(shrunkReliability + feedbackModifier)));
      }
    } catch {
      // Fail-safe: operational reliability remains unaffected
    }

    // Step 10: Classification
    let classification: 'EXCELLENT' | 'GOOD' | 'MODERATE' | 'POOR' | 'CRITICAL' | 'UNKNOWN';
    if (sampleSize === 0) {
      classification = 'UNKNOWN';
    } else if (finalReliability >= 85) {
      classification = 'EXCELLENT';
    } else if (finalReliability >= 70) {
      classification = 'GOOD';
    } else if (finalReliability >= 55) {
      classification = 'MODERATE';
    } else if (finalReliability >= 40) {
      classification = 'POOR';
    } else {
      classification = 'CRITICAL';
    }

    return {
      trainNumber,
      reliabilityScore: finalReliability,
      operationalReliabilityScore: shrunkReliability,
      confidenceScore,
      sampleSize,
      effectiveSampleSize: Math.round(effectiveN * 10) / 10,
      averageDelayMinutes: Math.round(weightedAvgDelay * 10) / 10,
      medianDelayMinutes: medianDelay,
      onTimeRate: Math.round(onTimeRate * 100) / 100,
      punctualRate: Math.round(punctualRate * 100) / 100,
      severeDelayRate: Math.round(severeDelayRate * 100) / 100,
      feedbackSignal,
      recentPerformance: {
        score: recentScore,
        averageDelayMinutes: Math.round(recentAvgDelay * 10) / 10,
        trend
      },
      dataQuality: {
        validObservations: sampleSize,
        rejectedObservations: rejectedCount,
        duplicateCount
      },
      classification,
      lastUpdated: latestObservationMs > 0 ? new Date(latestObservationMs).toISOString() : asOfDate.toISOString()
    };
  }

  /**
   * Fetches historical live observations for a train from Supabase live_learning and local memory
   */
  public async fetchHistoricalObservations(trainNumber: string): Promise<LiveObservationInput[]> {
    const list: LiveObservationInput[] = [];

    // 1. Add local memory observations
    const local = this.localObservations.get(trainNumber) || [];
    local.forEach(o => {
      list.push({
        trainNumber: o.trainNumber,
        stationCode: o.stationCode,
        delayMinutes: o.delayMinutes,
        observedAt: o.observedAt,
        journeyDate: o.journeyDate,
        source: 'LOCAL'
      });
    });

    // 2. Add Supabase observations if configured
    if (isSupabaseConfigured()) {
      try {
        const since = new Date();
        since.setDate(since.getDate() - TrainReliabilityService.RETENTION_DAYS);

        const { data, error } = await supabase
          .from('live_learning')
          .select('train_no, current_station, delay_mins, created_at')
          .eq('train_no', trainNumber)
          .gte('created_at', since.toISOString())
          .not('delay_mins', 'is', null)
          .order('created_at', { ascending: false })
          .limit(100);

        if (!error && data && Array.isArray(data)) {
          data.forEach(r => {
            const delay = Number(r.delay_mins);
            if (!isNaN(delay)) {
              list.push({
                trainNumber: String(r.train_no || trainNumber),
                stationCode: String(r.current_station || 'UNKNOWN'),
                delayMinutes: delay,
                observedAt: r.created_at || new Date(),
                source: 'IRCTC'
              });
            }
          });
        }
      } catch (err: any) {
        winstonLogger.debug(`[RELIABILITY_FETCH_ERR] Train ${trainNumber}: ${err.message}`);
      }
    }

    return list;
  }

  /**
   * Primary Service API: Retrieves the calculated reliability profile for a train
   */
  public async getTrainReliability(trainNumber: string): Promise<TrainReliabilityResult> {
    const cleanTrainNo = String(trainNumber || '').trim();
    if (!cleanTrainNo) {
      return this.computeReliabilityFromObservations('00000', []);
    }

    // 1. Check in-memory cache
    const cached = this.cache.get(cleanTrainNo);
    const now = Date.now();
    if (cached && (now - cached.cachedAt) < TrainReliabilityService.CACHE_TTL_SECONDS * 1000) {
      return cached.result;
    }

    // 2. Fetch observations
    const observations = await this.fetchHistoricalObservations(cleanTrainNo);

    // 3. Compute deterministic metrics
    const result = this.computeReliabilityFromObservations(cleanTrainNo, observations);

    // 4. Update cache
    this.cache.set(cleanTrainNo, { result, cachedAt: now });
    cacheService.set(`reliability:${cleanTrainNo}`, result, TrainReliabilityService.CACHE_TTL_SECONDS);

    return result;
  }

  /**
   * Batch API: Computes reliability for multiple train numbers in parallel
   */
  public async batchGetReliability(trainNumbers: string[]): Promise<Map<string, TrainReliabilityResult>> {
    const results = new Map<string, TrainReliabilityResult>();
    const uniqueTrains = Array.from(new Set(trainNumbers.map(t => String(t || '').trim()).filter(Boolean)));

    await Promise.all(
      uniqueTrains.map(async (t) => {
        try {
          const res = await this.getTrainReliability(t);
          results.set(t, res);
        } catch (e: any) {
          results.set(t, this.computeReliabilityFromObservations(t, []));
        }
      })
    );

    return results;
  }

  /**
   * Clears internal caches
   */
  public clearCache(): void {
    this.cache.clear();
    this.localObservations.clear();
  }
}

export const trainReliabilityService = new TrainReliabilityService();
