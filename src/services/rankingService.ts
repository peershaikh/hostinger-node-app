import { winstonLogger } from '../middleware/logger';

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

      // 2. Connection Safety (25%)
      const isSameTrain = split.leg1.trainNo === split.leg2.trainNo;
      split.isSameTrain = isSameTrain;
      if (isSameTrain) {
        if (!split.badges) split.badges = [];
        if (!split.badges.includes('Same Train Rescue')) split.badges.push('Same Train Rescue');
        score += 25; // Perfect connection
      } else {
        const buffer = split.bufferMinutes;
        if (buffer >= 30 && buffer <= 120) score += 25;       // Optimal wait
        else if (buffer > 120 && buffer <= 180) score += 15;  // Good wait
        else if (buffer > 180 && buffer <= 240) score += 5;   // Acceptable
        else if (buffer < 30) score -= 20;                    // Dangerous connection (penalty)
        else score -= 10;                                     // >240 penalty
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

      // 5. Platform Change (5%)
      if (isSameTrain) {
        score += 5;
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
}

export const rankingService = new RankingService();