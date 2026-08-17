import { winstonLogger } from '../middleware/logger';
import { trainReliabilityService, TrainReliabilityResult } from './trainReliabilityService';

export interface SmartScoreResult {
  baseScore: number;
  reliabilityScore: number;
  reliabilityConfidence: number;
  sampleSize: number;
  reliabilityBonus: number;
  finalSmartScore: number;
  rankingReason: string;
  classification: string;
}

export interface SmartRankedItem<T = Leg | SplitJourney> {
  item: T;
  smartScore: SmartScoreResult;
}

export interface Leg {
  trainNo: string;
  name: string;
  trainName: string;
  departure: string;
  arrival: string;
  dayNumber: number;
  /** Computed leg duration in minutes (parsed from all available API fields) */
  durationMins?: number;
  duration?: number;
  api_used?: string;
  availability?: {
    status: string;
    wlCount: number;
    coach?: string;
  };
  classes?: Array<{ class: string; status: string; count: number }>;
  confirmation_probability?: number;
  confidence_badge?: string;
}


export interface TransferMeta {
  transferType: 'SAME_STATION' | 'INTER_STATION';
  stationChange: boolean;
  arrivalStation: { code: string; name: string };
  boardingStation: { code: string; name: string };
  distanceKm: number;
  transitMode: string;
  estimatedTransferMinutes: number;
  minimumRequiredBufferMinutes: number;
  actualBufferMinutes: number;
  bufferSurplusMinutes: number;
  transportSuggestion: string;
}


export interface SplitJourney {
  hub: string;
  leg1: Leg;
  leg2: Leg;
  bufferMinutes: number;
  totalDuration: number;
  /** Leg 1 travel time in minutes */
  leg1Duration?: number;
  /** Leg 2 travel time in minutes */
  leg2Duration?: number;
  score: number;
  badges: string[];
  travelDate: string;
  leg1Date?: string;
  leg2Date?: string;
  rollover: boolean;
  ai_strategy?: string;
  ai_insight?: string;
  recommendation_insight?: string;
  delayRisk?: string;
  /** Inter-station transfer metadata (optional) */
  transferMeta?: TransferMeta;
  /** On-time percentage based on historical live data (0-100) */
  punctualityScore?: number;
  /** Effective buffer after accounting for historical avg delay of Leg1 */
  effectiveBufferMins?: number;
  legs?: Leg[];
  success_percent?: number;
  risk_level?: "LOW" | "MEDIUM" | "HIGH";
  ai_reason?: string;
  confirmation_probability?: number;
  confidence_badge?: string;
  steps?: string[];
  wait_time?: number;
  /** Human-readable total duration e.g. "20h 30m" */
  total_duration?: string;
  /** Human-readable leg1 travel duration e.g. "5h 35m" */
  leg1_duration?: string;
  /** Human-readable leg2 travel duration e.g. "1h 48m" */
  leg2_duration?: string;
  /** Human-readable wait time e.g. "13h 25m" */
  wait_formatted?: string;
  isBest?: boolean;
  suggestions?: string[];
  advisory?: string[];
  /** Marks this as a same-train segment (seat change, not train change) */
  isSameTrain?: boolean;
  /** Rescue type classification */
  rescueType?: 'SAME_TRAIN_SEGMENT' | 'AI_SPLIT_ROUTE' | 'PARTIAL_RAC';
  /** Confidence tier for partial rescues (PARTIAL_RAC only) */
  confidence?: 'HIGH' | 'MEDIUM' | 'LOW';
  /** User-facing warning for partial rescues */
  warning?: string;
  explanation?: {
    reason: string;
    summary: string;
    scoreBreakdown: {
      totalTime: number;
      waitTime: number;
      reliability: number;
      seatChance: number;
    };
  };
}


export class RankingService {
  calculateScore(item: Leg | SplitJourney): number {
    if ('leg1' in item && 'leg2' in item) {
      // --- SPLIT JOURNEY SCORING ---
      const split = item as SplitJourney;
      let score = 0;

      // 1. Availability Score (40%)
      const getAvailScore = (avail: any) => {
        if (!avail || !avail.status) return 0;
        const status = avail.status.toUpperCase();
        if (status.includes('AVAILABLE') || status.includes('CNF')) return 40;
        if (status.includes('RAC')) return 35;
        if (status.includes('WL') || status.includes('WAITLIST')) {
          const wl = avail.wlCount || 0;
          if (wl <= 5) return 25;
          if (wl <= 20) return 15;
          if (wl <= 50) return 10;
          return 5;
        }
        return 0; // Regret / Unavailable
      };
      
      const avail1 = getAvailScore(split.leg1.availability);
      const avail2 = getAvailScore(split.leg2.availability);
      score += (avail1 + avail2) / 2;

      // 2. Connection Safety (25%) — delay-aware & transfer-aware
      const isSameTrain = split.leg1.trainNo === split.leg2.trainNo;
      split.isSameTrain = isSameTrain;
      if (isSameTrain) {
        if (!split.badges) split.badges = [];
        if (!split.badges.includes('Same Train Rescue')) split.badges.push('Same Train Rescue');
        score += 25; // Perfect connection
      } else {
        const buffer = split.bufferMinutes;
        // Use pre-computed effective buffer if delay stats were injected by the engine
        // (effectiveBufferMins = scheduledBuffer - historicalAvgDelay of Leg1)
        const effectiveBuf = (split as any).effectiveBufferMins ?? buffer;

        const minReqBuf = split.transferMeta?.minimumRequiredBufferMinutes ?? 25;
        const minOptimal = minReqBuf + 5;     // SAME_STATION (25): 30
        const maxOptimal = minReqBuf + 95;    // SAME_STATION (25): 120
        const maxGood = minReqBuf + 155;      // SAME_STATION (25): 180
        const maxAcceptable = minReqBuf + 215;// SAME_STATION (25): 240

        if (effectiveBuf >= minOptimal && effectiveBuf <= maxOptimal) score += 25;       // Optimal wait
        else if (effectiveBuf > maxOptimal && effectiveBuf <= maxGood) score += 15;  // Good wait
        else if (effectiveBuf > maxGood && effectiveBuf <= maxAcceptable) score += 5;   // Acceptable
        else if (effectiveBuf < minOptimal) score -= 20;                          // Dangerous connection (penalty)
        else score -= 10;                                                  // >240 penalty

        // Populate delayRisk taking minReqBuf into account
        const surplus = effectiveBuf - minReqBuf;
        if (surplus < -5) split.delayRisk = 'High';
        else if (surplus < 35) split.delayRisk = 'Medium';
        else split.delayRisk = 'Low';
      }

      // 3. Confirmation Prediction (20%)
      const getPredPercentage = (avail: any) => {
        if (!avail || !avail.status) return 0;
        const status = avail.status.toUpperCase();
        if (status.includes('AVAILABLE') || status.includes('CNF')) return 100;
        if (status.includes('RAC')) return 85;
        if (status.includes('WL') || status.includes('WAITLIST')) {
          const wl = avail.wlCount || 0;
          if (wl <= 5) return 75;
          if (wl <= 20) return 50;
          if (wl <= 50) return 25;
          return 10;
        }
        return 0;
      };

      const pred1 = getPredPercentage(split.leg1.availability);
      const pred2 = getPredPercentage(split.leg2.availability);
      const avgPred = Math.round((pred1 + pred2) / 2);

      // Attach frontend fields
      split.confirmation_probability = avgPred;
      if (avgPred >= 85) split.confidence_badge = 'Very High';
      else if (avgPred >= 70) split.confidence_badge = 'High';
      else if (avgPred >= 40) split.confidence_badge = 'Medium';
      else if (avgPred >= 15) split.confidence_badge = 'Low';
      else split.confidence_badge = 'Very Low';

      score += (avgPred * 0.20); // 20% weight

      // 4. Travel Time (10%)
      if (isSameTrain || split.bufferMinutes <= 60) score += 10;
      else if (split.bufferMinutes <= 120) score += 8;
      else if (split.bufferMinutes <= 240) score += 5;
      else score += 2;

      // 5. Platform / Transfer Change (5%)
      if (isSameTrain) {
        score += 5;
      } else if (split.transferMeta?.transferType === 'INTER_STATION') {
        score -= 5; // Inter-station road transit friction penalty
      }

      split.recommendation_insight = this.generateAiInsight(split);

      winstonLogger.debug(`[RANKING] Split via ${split.hub} | Score: ${score}/100`);
      return score;
    }
    else {
      // --- DIRECT TRAIN SCORING ---
      const leg = item as Leg;
      let score = 0;
      
      const avail = leg.availability;
      if (!avail || !avail.status) return 0;
      const status = avail.status.toUpperCase();

      const getPredPercentage = (statusStr: string, wlCount: number = 0) => {
        if (statusStr.includes('AVAILABLE') || statusStr.includes('CNF')) return 100;
        if (statusStr.includes('RAC')) return 85;
        if (statusStr.includes('WL') || statusStr.includes('WAITLIST')) {
          if (wlCount <= 5) return 75;
          if (wlCount <= 20) return 50;
          if (wlCount <= 50) return 25;
          return 10;
        }
        return 0;
      };

      const pred = getPredPercentage(status, avail.wlCount);
      leg.confirmation_probability = pred;
      
      if (pred >= 85) leg.confidence_badge = 'Very High';
      else if (pred >= 70) leg.confidence_badge = 'High';
      else if (pred >= 40) leg.confidence_badge = 'Medium';
      else if (pred >= 15) leg.confidence_badge = 'Low';
      else leg.confidence_badge = 'Very Low';

      if (status.includes('AVAILABLE') || status.includes('CNF')) score = 100;
      else if (status.includes('RAC')) score = 80;
      else if (status.includes('WL') || status.includes('WAITLIST')) {
        const wl = avail.wlCount || 0;
        if (wl <= 5) score = 65;
        else if (wl <= 20) score = 45;
        else if (wl <= 50) score = 25;
        else score = 10;
      }

      winstonLogger.debug(`[RANKING] Direct ${leg.trainNo} | Score: ${score}/100`);
      return score;
    }
  }

  generateAiInsight(split: SplitJourney): string {
    const insights: string[] = [];
    
    if (split.confirmation_probability && split.confirmation_probability >= 85) {
      insights.push("High confirmation chance due to CNF/RAC availability");
    } else if (split.confirmation_probability && split.confirmation_probability >= 50) {
      insights.push("Moderate confirmation chance based on waitlist trends");
    }

    if (split.isSameTrain) {
      insights.push("Same train continues after quota change (no platform change required)");
    } else {
      insights.push(`Connection time is ${split.bufferMinutes} minutes`);
    }

    return insights.join(". ") + ".";
  }

  private isGoodAvailability(avail: any): boolean {
    if (!avail) return false;
    const status = (avail.status || '').toUpperCase();
    return status.includes('AVAILABLE') || status.includes('CNF');
  }

  /**
   * Accurate duration calculation (handles day rollover)
   */
  calculateCorrectDuration(
    depTime: string,
    arrTime: string,
    depDay: number = 1,
    arrDay: number = 1
  ): number {
    if (!depTime || !arrTime) return 0;

    const parseMins = (time: string, day: number): number => {
      const [h, m] = time.split(':').map(Number);
      return ((day - 1) * 1440) + ((h || 0) * 60) + (m || 0);
    };

    const depTotal = parseMins(depTime, depDay);
    const arrTotal = parseMins(arrTime, arrDay);

    let duration = arrTotal - depTotal;
    if (duration <= 0) duration += 1440;   // overnight fallback

    return duration;
  }

  formatDuration(mins: number): string {
    const h = Math.floor(mins / 60);
    const m = mins % 60;
    return `${h}h ${m}m`;
  }

  /**
   * Rank items (Best first - lowest score)
   */
  private isLegAllowedByPolicy(avail: any): boolean {
    if (!avail || !avail.status) {
      // PHASE_4C728 FIX_2: fail-closed — block splits with missing availability data.
      // Previously returned true (unsafe), allowing unavailable splits to reach the UI.
      return false;
    }

    const status = String(avail.status).toUpperCase().trim();

    // 1. Block explicit unavailable / regret states
    if (
      status.includes('REGRET') ||
      status.includes('NOT AVAILABLE') ||
      status.includes('CLASS NOT AVAILABLE') ||
      status.includes('NO SEATS') ||
      status.includes('FULLY SOLD') ||
      status.includes('TRAIN DEPARTED') ||
      status === 'UNAVAILABLE'
    ) {
      return false;
    }

    // 2. RAC is always allowed
    if (status.includes('RAC')) {
      return true;
    }

    // 3. Allow all Waitlists - AI Prediction will handle the risk presentation
    if (status.includes('WL') || status.includes('WAITLIST') || status.includes('WAIT')) {
      return true;
    }

    return true;
  }

  isSplitAllowedByPolicy(split: SplitJourney): boolean {
    if (!split) return false;
    if (split.leg1 && !this.isLegAllowedByPolicy(split.leg1.availability)) {
      return false;
    }
    if (split.leg2 && !this.isLegAllowedByPolicy(split.leg2.availability)) {
      return false;
    }
    return true;
  }

  /**
  * Rank items deterministically (Best first - lowest score)
  * Uses stable sorting with multiple criteria to ensure consistent ordering
  */
  rankTrains<T extends { score: number }>(items: T[]): T[] {
    if (!items || items.length === 0) return [];

    let filteredItems = items;
    if ('leg1' in items[0] && 'leg2' in items[0]) {
      const beforeCount = items.length;
      filteredItems = items.filter(item => {
        const allowed = this.isSplitAllowedByPolicy(item as unknown as SplitJourney);
        if (!allowed) {
          winstonLogger.info(`[WAITLIST_POLICY_FILTER] Filtered split via ${(item as any).hub} due to waitlist policy. Leg1: ${(item as any).leg1?.trainNo} (${(item as any).leg1?.availability?.status}), Leg2: ${(item as any).leg2?.trainNo} (${(item as any).leg2?.availability?.status})`);
        }
        return allowed;
      });
      const filteredCount = beforeCount - filteredItems.length;
      if (filteredCount > 0) {
        winstonLogger.info(`[WAITLIST_POLICY_SUMMARY] Filtered ${filteredCount} splits out of ${beforeCount} total splits`);
      }
    }

    return [...filteredItems].sort((a, b) => {
      // Primary sort by score (Descending - Highest is best)
      const scoreDiff = b.score - a.score;
      if (scoreDiff !== 0) return scoreDiff;

      // Secondary sort by stringified JSON for deterministic tie-breaking
      // This ensures identical items always sort in the same order
      const aStr = JSON.stringify(a);
      const bStr = JSON.stringify(b);
      return aStr.localeCompare(bStr);
    });
  }

  prepareForRanking(item: any): any {
    return item; // Already well structured
  }

  /**
   * Calculates the confidence-aware Smart Score incorporating Train Reliability
   */
  calculateSmartScore(
    item: Leg | SplitJourney,
    reliabilityMap?: Map<string, TrainReliabilityResult>
  ): SmartScoreResult {
    const baseScore = this.calculateScore(item);

    if ('leg1' in item && 'leg2' in item) {
      const split = item as SplitJourney;
      const t1 = split.leg1?.trainNo ? String(split.leg1.trainNo).trim() : '';
      const t2 = split.leg2?.trainNo ? String(split.leg2.trainNo).trim() : '';

      const rel1 = t1 && reliabilityMap ? reliabilityMap.get(t1) : null;
      const rel2 = t2 && reliabilityMap ? reliabilityMap.get(t2) : null;

      let compositeReliability = 70.0;
      let compositeConfidence = 0;
      let minSample = 0;
      let classification = 'UNKNOWN';

      if (rel1 && rel2) {
        const c1 = rel1.confidenceScore || 0;
        const c2 = rel2.confidenceScore || 0;
        if (c1 + c2 > 0) {
          compositeReliability = Math.round((rel1.reliabilityScore * c1 + rel2.reliabilityScore * c2) / (c1 + c2));
        } else {
          compositeReliability = Math.round((rel1.reliabilityScore + rel2.reliabilityScore) / 2);
        }
        compositeConfidence = Math.min(c1, c2);
        minSample = Math.min(rel1.sampleSize || 0, rel2.sampleSize || 0);
        classification = compositeConfidence >= 50 ? (compositeReliability >= 75 ? 'GOOD' : 'MODERATE') : 'UNKNOWN';
      } else if (rel1 || rel2) {
        const activeRel = rel1 || rel2!;
        compositeReliability = activeRel.reliabilityScore || 70.0;
        compositeConfidence = Math.round((activeRel.confidenceScore || 0) * 0.5); // Attenuate for missing second leg
        minSample = activeRel.sampleSize || 0;
        classification = activeRel.classification || 'UNKNOWN';
      }

      // Reliability Bonus (bounded: max ±4.5 points on base score)
      const delta = compositeReliability - 70.0;
      const confidenceFactor = compositeConfidence / 100;
      const reliabilityBonus = Math.round(delta * confidenceFactor * 0.15 * 10) / 10;
      const finalSmartScore = Math.max(0, Math.min(100, Math.round(baseScore + reliabilityBonus)));

      const rankingReason = this.generateSmartSplitReason(baseScore, split, rel1, rel2);

      return {
        baseScore,
        reliabilityScore: compositeReliability,
        reliabilityConfidence: compositeConfidence,
        sampleSize: minSample,
        reliabilityBonus,
        finalSmartScore,
        rankingReason,
        classification
      };
    } else {
      const leg = item as Leg;
      const trainNo = leg.trainNo ? String(leg.trainNo).trim() : '';
      const rel = trainNo && reliabilityMap ? reliabilityMap.get(trainNo) : null;

      let reliabilityScore = 70.0;
      let reliabilityConfidence = 0;
      let sampleSize = 0;
      let classification = 'UNKNOWN';

      if (rel && rel.sampleSize > 0) {
        reliabilityScore = rel.reliabilityScore;
        reliabilityConfidence = rel.confidenceScore;
        sampleSize = rel.sampleSize;
        classification = rel.classification;
      }

      // Reliability Bonus: bounded ±4.5 points
      const delta = reliabilityScore - 70.0;
      const confidenceFactor = reliabilityConfidence / 100;
      const reliabilityBonus = Math.round(delta * confidenceFactor * 0.15 * 10) / 10;
      const finalSmartScore = Math.max(0, Math.min(100, Math.round(baseScore + reliabilityBonus)));

      const rankingReason = this.generateSmartDirectReason(baseScore, rel, leg);

      return {
        baseScore,
        reliabilityScore,
        reliabilityConfidence,
        sampleSize,
        reliabilityBonus,
        finalSmartScore,
        rankingReason,
        classification
      };
    }
  }

  private generateSmartDirectReason(baseScore: number, rel: TrainReliabilityResult | null | undefined, leg: Leg): string {
    const isAvail = baseScore >= 80;
    const isWL = baseScore < 80 && baseScore >= 40;

    if (rel && (rel.confidenceScore >= 50 || (rel.feedbackSignal?.feedbackConfidence || 0) >= 50)) {
      const fb = rel.feedbackSignal;
      const feedbackClause = fb && fb.feedbackConfidence >= 50 && fb.averageRating
        ? ` • User satisfaction: ${fb.averageRating}/5`
        : '';

      if (rel.reliabilityScore >= 85) {
        return isAvail
          ? `Strong seat confirmation backed by exceptional historical punctuality (${rel.averageDelayMinutes}m avg delay)${feedbackClause}`
          : `High historical on-time performance (${Math.round(rel.onTimeRate * 100)}% on-time rate)${feedbackClause}`;
      } else if (rel.reliabilityScore <= 45) {
        return isAvail
          ? `Confirmed seat availability; historical arrival delay averages ${rel.averageDelayMinutes}m${feedbackClause}`
          : `Frequent historical delay risk (${rel.averageDelayMinutes}m avg delay)${feedbackClause}`;
      } else {
        return isAvail
          ? `Confirmed seat availability with consistent schedule reliability${feedbackClause}`
          : `Moderate historical punctuality with ${Math.round(rel.onTimeRate * 100)}% on-time rate${feedbackClause}`;
      }
    }

    if (isAvail) return 'Confirmed seat availability on primary schedule';
    if (isWL) return 'Moderate confirmation chance based on waitlist trends';
    return 'Standard schedule availability';
  }

  private generateSmartSplitReason(
    baseScore: number,
    split: SplitJourney,
    rel1: TrainReliabilityResult | null | undefined,
    rel2: TrainReliabilityResult | null | undefined
  ): string {
    if (split.isSameTrain) {
      return 'Seamless same-train journey (no platform switch) with reliable schedule performance';
    }

    const avgConf = Math.min(rel1?.confidenceScore || 0, rel2?.confidenceScore || 0);
    const avgRel = Math.round(((rel1?.reliabilityScore || 70) + (rel2?.reliabilityScore || 70)) / 2);

    if (avgConf >= 40) {
      if (avgRel >= 80) {
        return `High-confidence connection via ${split.hub} with strong punctuality across both legs`;
      } else if (avgRel <= 45) {
        return `Connection via ${split.hub} carries moderate historical delay risk on connecting leg`;
      }
    }

    if (split.bufferMinutes >= 60 && split.bufferMinutes <= 150) {
      return `Comfortable connection buffer (${split.bufferMinutes}m) via ${split.hub}`;
    }
    return `Smart split route via ${split.hub}`;
  }

  /**
   * Ranks items deterministically by Smart Score (Highest Smart Score first)
   */
  rankSmartJourneys<T extends (Leg | SplitJourney)>(
    items: T[],
    reliabilityMap?: Map<string, TrainReliabilityResult>
  ): SmartRankedItem<T>[] {
    if (!items || items.length === 0) return [];

    const scored = items.map(item => ({
      item,
      smartScore: this.calculateSmartScore(item, reliabilityMap)
    }));

    return scored.sort((a, b) => {
      const diff = b.smartScore.finalSmartScore - a.smartScore.finalSmartScore;
      if (diff !== 0) return diff;

      // Tie breaker 1: Base score
      const baseDiff = b.smartScore.baseScore - a.smartScore.baseScore;
      if (baseDiff !== 0) return baseDiff;

      // Tie breaker 2: Reliability confidence
      const confDiff = b.smartScore.reliabilityConfidence - a.smartScore.reliabilityConfidence;
      if (confDiff !== 0) return confDiff;

      // Tie breaker 3: Deterministic string comparison
      return JSON.stringify(a.item).localeCompare(JSON.stringify(b.item));
    });
  }

  /**
   * Batch enriches items by pre-fetching train reliability in one batch lookup
   */
  async batchEnrichSmartRanking<T extends (Leg | SplitJourney)>(items: T[]): Promise<SmartRankedItem<T>[]> {
    if (!items || items.length === 0) return [];

    const trainNumbers: string[] = [];
    items.forEach(item => {
      if ('leg1' in item && 'leg2' in item) {
        const split = item as SplitJourney;
        if (split.leg1?.trainNo) trainNumbers.push(split.leg1.trainNo);
        if (split.leg2?.trainNo) trainNumbers.push(split.leg2.trainNo);
      } else {
        const leg = item as Leg;
        if (leg.trainNo) trainNumbers.push(leg.trainNo);
      }
    });

    const reliabilityMap = await trainReliabilityService.batchGetReliability(trainNumbers);
    return this.rankSmartJourneys(items, reliabilityMap);
  }
}

export const rankingService = new RankingService();