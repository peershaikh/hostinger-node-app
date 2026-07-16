/**
 * PHASE_4C828 / PHASE_4C830 / PHASE_4C832 — Pan India Rescue Intelligence Layer
 * Rescue Intelligence Service (Optimized for Accuracy & Precision)
 *
 * Sits above the existing Same Train Rescue Engine.
 * Does not call any external provider APIs. Pure evaluation.
 */

import { JourneyContext } from '../journey/journeyTypes';
import { rescueLearning } from './rescueLearning';
import { SplitJourney } from '../services/rankingService';

export interface RescueIntelligenceResult {
  readonly enhancedConfidence: number;
  readonly suggestedHubs: string[];
  readonly alternativeCorridors: string[];
  readonly priorityRegions: string[];
  readonly riskScore: number; // 0 (low risk) to 100 (high risk)
}

export class RescueIntelligenceService {
  private static instance: RescueIntelligenceService;

  private constructor() {}

  public static getInstance(): RescueIntelligenceService {
    if (!RescueIntelligenceService.instance) {
      RescueIntelligenceService.instance = new RescueIntelligenceService();
    }
    return RescueIntelligenceService.instance;
  }

  public evaluateRescue(context: JourneyContext): RescueIntelligenceResult {
    const rescueOptions = context.rescueResult || [];
    const hubs = this.analyzeHubs(rescueOptions);
    const corridors = this.suggestAlternativeCorridors(context);
    const risk = this.calculateRisk(context, hubs);
    const confidence = this.calculateConfidenceScore(context, risk, hubs);
    const regions = [this.getRegionFromCode(context.source)];

    return {
      enhancedConfidence: confidence,
      suggestedHubs: hubs,
      alternativeCorridors: corridors,
      priorityRegions: regions,
      riskScore: risk
    };
  }

  private analyzeHubs(rescues: SplitJourney[]): string[] {
    const uniqueHubs = Array.from(new Set(rescues.map(r => r.hub)));
    
    return uniqueHubs.sort((a, b) => {
      const probA = rescueLearning.getHubSuccessProbability(a);
      const probB = rescueLearning.getHubSuccessProbability(b);
      return probB - probA; // Highest probability first
    });
  }

  private suggestAlternativeCorridors(context: JourneyContext): string[] {
    const corridors: string[] = [];
    
    if (context.liveResult && context.liveResult.delay_minutes > 90) {
      if (context.source === 'NDLS' && context.destination === 'BCT') {
        corridors.push('WESTERN_CORRIDOR_VIA_ADI');
      } else if (context.source === 'HWH' && context.destination === 'NDLS') {
        corridors.push('NORTHERN_CORRIDOR_VIA_LKO');
      } else {
        corridors.push('GENERIC_HIGH_SPEED_CORRIDOR');
      }
    }
    return corridors;
  }

  private calculateRisk(context: JourneyContext, hubs: string[]): number {
    let risk = 20; // Base risk

    // 1. Step-Function Delay Penalty (Calibrated to Ground Truth)
    if (context.liveResult) {
      const delay = context.liveResult.delay_minutes;
      if (delay > 90) {
        risk += 40; // Heavy penalty for late trains
      } else if (delay > 45) {
        risk += 15; // Moderate penalty
      }
      // No penalty for delay <= 45
    }

    // 2. PNR Confidence Penalty / Reward
    if (context.pnrPrediction) {
      const label = context.pnrPrediction.confidence_label;
      if (label === 'Low') {
        risk += 30;
      } else if (label === 'High' || label === 'Confirmed') {
        risk -= 10; // Reward highly stable bookings
      }
    }

    // 3. Seasonal Congestion Risk (Read from metadata or date)
    const metadata = context.metadata || {};
    const season = metadata.season || 'NORMAL';
    if (season === 'FESTIVAL') {
      risk += 10;
    } else if (season === 'PEAK') {
      risk += 5;
    }

    // 4. Hub historical failure penalty
    if (hubs.length > 0) {
      const topHub = hubs[0];
      const successProb = rescueLearning.getHubSuccessProbability(topHub);
      if (successProb < 0.5) {
        risk += 20;
      }
    }

    return Math.max(0, Math.min(100, risk));
  }

  private calculateConfidenceScore(context: JourneyContext, riskScore: number, hubs: string[]): number {
    // Scale risk to 0-1 confidence
    let baseConfidence = (100 - riskScore) / 100;

    // 50/50 Blend: 50% risk-based confidence, 50% historical learning success
    if (hubs.length > 0) {
      const topHubProb = rescueLearning.getHubSuccessProbability(hubs[0]);
      baseConfidence = (baseConfidence * 0.5) + (topHubProb * 0.5);
    }

    return Math.max(0, Math.min(1, baseConfidence));
  }

  private getRegionFromCode(code: string): string {
    const northern = ['NDLS', 'CNB', 'LKO', 'CDG'];
    const western = ['BCT', 'ADI', 'BRC', 'ST'];
    const southern = ['MAS', 'SBC', 'ERS', 'TVC'];
    const eastern = ['HWH', 'PNBE', 'BBS', 'GHY'];

    if (northern.includes(code)) return 'NORTHERN_ZONE';
    if (western.includes(code)) return 'WESTERN_ZONE';
    if (southern.includes(code)) return 'SOUTHERN_ZONE';
    if (eastern.includes(code)) return 'EASTERN_ZONE';
    
    return 'CENTRAL_ZONE';
  }
}

export const rescueIntelligence = RescueIntelligenceService.getInstance();
