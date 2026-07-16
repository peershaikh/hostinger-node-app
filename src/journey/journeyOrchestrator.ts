/**
 * PHASE_4C826 — Journey Intelligence Orchestrator
 *
 * A read-only orchestration layer that combines outputs from six engines:
 *   - Search Engine
 *   - Split Journey Engine
 *   - Same Train Rescue Engine
 *   - PNR Engine
 *   - Live Train Engine
 *   - Booking Decision Engine
 *
 * CONSTRAINTS (strictly enforced):
 *   ❌ No booking
 *   ❌ No redirects
 *   ❌ No controller modifications
 *   ❌ No business logic changes
 *   ❌ No external API calls
 *   ❌ No engine modifications
 *   ✅ Pure normalization, merging, and ranking
 *   ✅ Advisory only — caller decides what to do
 *   ✅ Gated by featureFlags.journeyOrchestrator
 *
 * The orchestrator NEVER calls engines directly. All engine outputs are
 * passed in via JourneyContext. This keeps the orchestrator testable and
 * side-effect-free.
 */

import { featureFlags } from '../config/featureFlags';
import {
  CombinedSearchResponse,
  LiveTrainStatus
} from '../types';
import { SplitJourney } from '../services/rankingService';
import { SplitEngineResult } from '../services/splitJourneyEngine';
import { NormalizedPnrResponse } from '../utils/pnrNormalizer';
import { DecisionResult } from '../booking/decisionTypes';
import {
  JourneyCandidate,
  JourneyContext,
  JourneyHealth,
  JourneyRecommendation,
  JourneySignal,
  JourneySummary,
  JourneyType,
  PnrPredictionSnapshot,
  ScoreComponent
} from './journeyTypes';
import { rescueIntelligence } from '../rescue/rescueIntelligence';

// ─── Constants ────────────────────────────────────────────────────────────────

const ORCHESTRATOR_VERSION = '4C826.1.0';

// Score normalization constants
const LOWER_BETTER_SCALE = 100;   // divisor for lower-is-better normalization
const HIGHER_BETTER_MAX = 200;    // max expected score for higher-is-better
const RESCUE_SCORE_MAX = 100;     // rescue scores are 60–90, max 100

// Weights for unified confidence calculation
const WEIGHTS = {
  DIRECT_AVAILABILITY: 0.30,
  SPLIT_AVAILABILITY:  0.25,
  RESCUE_AVAILABILITY: 0.20,
  PNR_CONFIRMATION:    0.15,
  LIVE_DELAY:          0.05,
  LIVE_RUNNING:        0.03,
  BOOKING_PROVIDER:    0.02
} as const;

// ─── Score Normalization Helpers ──────────────────────────────────────────────

/**
 * Normalize a lower-is-better score to 0–1 (higher = better).
 * Uses reciprocal scaling: confidence = 1 / (1 + score / scale)
 *   score=0   → confidence=1.0 (perfect)
 *   score=100 → confidence=0.5 (moderate)
 *   score=200 → confidence=0.33 (poor)
 */
function normalizeLowerBetter(score: number, scale: number = LOWER_BETTER_SCALE): number {
  if (score <= 0) return 1.0;
  return 1 / (1 + score / scale);
}

/**
 * Normalize a higher-is-better score to 0–1.
 * Uses linear clamping: confidence = min(1, score / max)
 */
function normalizeHigherBetter(score: number, max: number): number {
  if (max <= 0) return 0;
  return Math.min(1, Math.max(0, score / max));
}

/**
 * Parse an availability status string and return a 0–1 confidence.
 * AVAILABLE/CNF → 1.0, RAC → 0.6, WL → 0.3, else → 0.1
 */
function availabilityToConfidence(status: string | undefined): number {
  if (!status) return 0.1;
  const s = status.toUpperCase().trim();
  if (s.includes('AVAILABLE') || s.includes('AVL') || s.includes('CNF') || s.includes('CONFIRMED')) {
    return 1.0;
  }
  if (s.includes('RAC')) {
    return 0.6;
  }
  if (s.includes('WL') || s.includes('WAITLIST') || s.includes('WAIT')) {
    // WL with low position is better — extract position if available
    const posMatch = s.match(/(\d+)/);
    if (posMatch) {
      const pos = parseInt(posMatch[1], 10);
      if (pos <= 10) return 0.4;
      if (pos <= 30) return 0.25;
      return 0.15;
    }
    return 0.3;
  }
  if (s.includes('REGRET') || s.includes('NOT AVAILABLE') || s.includes('FULLY SOLD')) {
    return 0.0;
  }
  return 0.1;
}

/**
 * Parse a PNR probability string ("85%", "85", etc.) to 0–1.
 */
function parseProbability(prob: string | undefined): number {
  if (!prob) return 0.5;
  const num = parseInt(prob.replace('%', '').trim(), 10);
  if (isNaN(num)) return 0.5;
  return Math.max(0, Math.min(1, num / 100));
}

// ─── Signal Extraction ────────────────────────────────────────────────────────

function extractSearchSignals(search: CombinedSearchResponse | null | undefined): JourneySignal[] {
  if (!search) return [];
  const signals: JourneySignal[] = [];

  const directTrains = search.direct || [];
  if (directTrains.length > 0) {
    // Best direct availability
    let bestConf = 0;
    for (const train of directTrains) {
      const avail = train?.availability?.status || train?.availability;
      const conf = availabilityToConfidence(typeof avail === 'string' ? avail : avail?.status);
      if (conf > bestConf) bestConf = conf;
    }
    signals.push({
      source: 'SEARCH',
      type: 'DIRECT_AVAILABILITY',
      value: bestConf,
      raw: { count: directTrains.length },
      message: `${directTrains.length} direct train(s) found, best availability confidence: ${bestConf.toFixed(2)}`
    });
  }

  return signals;
}

function extractSplitSignals(split: SplitEngineResult | null | undefined): JourneySignal[] {
  if (!split) return [];
  const signals: JourneySignal[] = [];

  const splits = split.split || split.splits || split.smart_routes || [];
  // Only count non-rescue splits
  const pureSplits = splits.filter(s => !s.isSameTrain);

  if (pureSplits.length > 0) {
    // Best split by lower-is-better score
    let bestScore = Infinity;
    for (const s of pureSplits) {
      if (s.score < bestScore) bestScore = s.score;
    }
    const conf = normalizeLowerBetter(bestScore);
    signals.push({
      source: 'SPLIT',
      type: 'SPLIT_AVAILABILITY',
      value: conf,
      raw: { count: pureSplits.length, bestScore },
      message: `${pureSplits.length} split route(s) found, best score: ${bestScore} → confidence: ${conf.toFixed(2)}`
    });
  }

  return signals;
}

function extractRescueSignals(rescue: SplitJourney[] | null | undefined): JourneySignal[] {
  if (!rescue || rescue.length === 0) return [];
  const signals: JourneySignal[] = [];

  // Best rescue by higher-is-better score (90=confirmed, 60=partial RAC)
  let bestScore = 0;
  for (const r of rescue) {
    if (r.score > bestScore) bestScore = r.score;
  }
  const conf = normalizeHigherBetter(bestScore, RESCUE_SCORE_MAX);
  signals.push({
    source: 'RESCUE',
    type: 'RESCUE_AVAILABILITY',
    value: conf,
    raw: { count: rescue.length, bestScore },
    message: `${rescue.length} rescue option(s) found, best score: ${bestScore} → confidence: ${conf.toFixed(2)}`
  });

  return signals;
}

function extractPnrSignals(
  pnr: NormalizedPnrResponse | null | undefined,
  prediction: PnrPredictionSnapshot | null | undefined
): JourneySignal[] {
  if (!pnr) return [];
  const signals: JourneySignal[] = [];

  // Determine PNR status
  const passengers = pnr.passengers || [];
  const allStatuses = passengers.map(p => (p.current_status || '').toUpperCase());

  let pnrConf: number;
  if (prediction?.probability) {
    pnrConf = parseProbability(prediction.probability);
  } else {
    // Infer from passenger statuses
    const hasCNF = allStatuses.some(s => s.includes('CNF') || s.includes('CONFIRMED'));
    const hasRAC = allStatuses.some(s => s.includes('RAC'));
    const hasWL = allStatuses.some(s => s.includes('WL') || s.includes('WAIT'));

    if (hasCNF && !hasWL) pnrConf = 1.0;
    else if (hasRAC && !hasWL) pnrConf = 0.6;
    else if (hasWL) pnrConf = 0.3;
    else pnrConf = 0.5;
  }

  signals.push({
    source: 'PNR',
    type: 'PNR_CONFIRMATION',
    value: pnrConf,
    raw: { pnr: pnr.pnr, chartStatus: pnr.chart_status },
    message: `PNR ${pnr.pnr}: confirmation confidence ${pnrConf.toFixed(2)}`
  });

  return signals;
}

function extractLiveSignals(live: LiveTrainStatus | null | undefined): JourneySignal[] {
  if (!live) return [];
  const signals: JourneySignal[] = [];

  // Delay signal: 0 min delay = 1.0, 60+ min = 0.0
  const delayConf = Math.max(0, 1 - (live.delay_minutes / 60));
  signals.push({
    source: 'LIVE',
    type: 'LIVE_DELAY',
    value: delayConf,
    raw: { delayMinutes: live.delay_minutes },
    message: `Delay: ${live.delay_minutes} min → confidence: ${delayConf.toFixed(2)}`
  });

  // Running status signal
  signals.push({
    source: 'LIVE',
    type: 'LIVE_RUNNING',
    value: live.is_running ? 1.0 : 0.0,
    raw: { isRunning: live.is_running, currentStation: live.current_station },
    message: live.is_running
      ? `Train running, currently at ${live.current_station}`
      : 'Train not running'
  });

  return signals;
}

function extractBookingSignals(decision: DecisionResult | null | undefined): JourneySignal[] {
  if (!decision) return [];
  const signals: JourneySignal[] = [];

  if (decision.recommendedProvider) {
    const conf = normalizeHigherBetter(decision.score, HIGHER_BETTER_MAX);
    signals.push({
      source: 'BOOKING_DECISION',
      type: 'BOOKING_PROVIDER',
      value: conf,
      raw: { provider: decision.recommendedProvider, score: decision.score },
      message: `Recommended provider: ${decision.recommendedProvider} (score: ${decision.score})`
    });
  }

  return signals;
}

// ─── Candidate Normalization ──────────────────────────────────────────────────

function makeCandidateId(type: JourneyType, trainNo: string, hub?: string): string {
  return `${type}:${trainNo}${hub ? `:${hub}` : ''}`;
}

function normalizeDirectCandidates(
  search: CombinedSearchResponse | null | undefined,
  split: SplitEngineResult | null | undefined,
  ctx: JourneyContext
): JourneyCandidate[] {
  const candidates: JourneyCandidate[] = [];

  // From search result
  const searchDirect = search?.direct || [];
  for (const train of searchDirect) {
    const trainNo = train?.number || train?.trainNo || '';
    if (!trainNo) continue;

    const availStatus = train?.availability?.status || (typeof train?.availability === 'string' ? train.availability : undefined);
    const availConf = availabilityToConfidence(availStatus);
    const rawScore = train?.score ?? 0;
    const scoreDirection = 'LOWER_BETTER' as const;

    const normalizedScore = normalizeLowerBetter(rawScore);
    const combinedConf = (availConf * 0.6) + (normalizedScore * 0.4);

    const components: ScoreComponent[] = [
      {
        source: 'SEARCH_AVAILABILITY',
        weight: WEIGHTS.DIRECT_AVAILABILITY,
        rawValue: combinedConf,
        weightedValue: combinedConf * WEIGHTS.DIRECT_AVAILABILITY
      },
      {
        source: 'SEARCH_SCORE',
        weight: 0.10,
        rawValue: normalizedScore,
        weightedValue: normalizedScore * 0.10
      }
    ];

    const confidence = components.reduce((sum, c) => sum + c.weightedValue, 0);

    candidates.push({
      id: makeCandidateId('DIRECT', trainNo),
      type: 'DIRECT',
      trainNo,
      trainName: train?.name || train?.trainName,
      source: ctx.source,
      destination: ctx.destination,
      legs: [train],
      totalDuration: train?.duration_mins,
      travelDate: ctx.date,
      badges: train?.type ? [train.type] : [],
      rawScore,
      rawScoreDirection: scoreDirection,
      score: { confidence, components },
      availability: { leg1: availStatus },
      metadata: { fromSearch: true }
    });
  }

  // From split result (if direct trains are included)
  const splitDirect = split?.direct || [];
  for (const leg of splitDirect) {
    const trainNo = leg?.trainNo || '';
    if (!trainNo) continue;
    // Skip if already added from search
    if (candidates.some(c => c.trainNo === trainNo)) continue;

    const availStatus = leg?.availability?.status;
    const availConf = availabilityToConfidence(availStatus);
    const rawScore = (leg as any)?.score ?? 0;

    const normalizedScore = normalizeLowerBetter(rawScore);
    const combinedConf = (availConf * 0.6) + (normalizedScore * 0.4);

    const components: ScoreComponent[] = [
      {
        source: 'SPLIT_DIRECT_AVAILABILITY',
        weight: WEIGHTS.DIRECT_AVAILABILITY,
        rawValue: combinedConf,
        weightedValue: combinedConf * WEIGHTS.DIRECT_AVAILABILITY
      },
      {
        source: 'SPLIT_DIRECT_SCORE',
        weight: 0.10,
        rawValue: normalizedScore,
        weightedValue: normalizedScore * 0.10
      }
    ];

    const confidence = components.reduce((sum, c) => sum + c.weightedValue, 0);

    candidates.push({
      id: makeCandidateId('DIRECT', trainNo),
      type: 'DIRECT',
      trainNo,
      trainName: leg?.trainName || leg?.name,
      source: ctx.source,
      destination: ctx.destination,
      legs: [leg],
      totalDuration: (leg as any)?.durationMins || (leg as any)?.duration_mins,
      travelDate: ctx.date,
      rawScore,
      rawScoreDirection: 'LOWER_BETTER',
      score: { confidence, components },
      availability: { leg1: availStatus },
      metadata: { fromSplit: true }
    });
  }

  return candidates;
}

function normalizeSplitCandidates(
  split: SplitEngineResult | null | undefined,
  ctx: JourneyContext
): JourneyCandidate[] {
  if (!split) return [];
  const candidates: JourneyCandidate[] = [];

  const splits = split.split || split.splits || split.smart_routes || [];
  // Only pure splits (not same-train rescues)
  const pureSplits = splits.filter(s => !s.isSameTrain);

  for (const s of pureSplits) {
    const trainNo = s.leg1?.trainNo || '';
    const hub = s.hub || '';
    if (!trainNo) continue;

    const leg1Avail = s.leg1?.availability?.status;
    const leg2Avail = s.leg2?.availability?.status;
    const leg1Conf = availabilityToConfidence(leg1Avail);
    const leg2Conf = availabilityToConfidence(leg2Avail);
    const avgAvailConf = (leg1Conf + leg2Conf) / 2;

    // Normalize the raw score (lower = better)
    const normalizedScore = normalizeLowerBetter(s.score);
    // Blend availability confidence with score confidence
    const combinedConf = (avgAvailConf * 0.6) + (normalizedScore * 0.4);

    const components: ScoreComponent[] = [
      {
        source: 'SPLIT_AVAILABILITY',
        weight: WEIGHTS.SPLIT_AVAILABILITY,
        rawValue: combinedConf,
        weightedValue: combinedConf * WEIGHTS.SPLIT_AVAILABILITY
      },
      {
        source: 'SPLIT_SCORE',
        weight: 0.10,
        rawValue: normalizedScore,
        weightedValue: normalizedScore * 0.10
      }
    ];

    const confidence = components.reduce((sum, c) => sum + c.weightedValue, 0);

    candidates.push({
      id: makeCandidateId('SPLIT', trainNo, hub),
      type: 'SPLIT',
      trainNo,
      trainName: s.leg1?.trainName || s.leg1?.name,
      source: ctx.source,
      destination: ctx.destination,
      hub,
      legs: [s.leg1, s.leg2].filter(Boolean),
      totalDuration: s.totalDuration,
      bufferMinutes: s.bufferMinutes,
      travelDate: s.travelDate || ctx.date,
      badges: s.badges || [],
      rawScore: s.score,
      rawScoreDirection: 'LOWER_BETTER',
      score: { confidence, components },
      availability: { leg1: leg1Avail, leg2: leg2Avail },
      metadata: {
        rollover: s.rollover,
        aiStrategy: s.ai_strategy,
        aiInsight: s.ai_insight,
        delayRisk: s.delayRisk
      }
    });
  }

  return candidates;
}

function normalizeRescueCandidates(
  rescue: SplitJourney[] | null | undefined,
  split: SplitEngineResult | null | undefined,
  ctx: JourneyContext
): JourneyCandidate[] {
  const candidates: JourneyCandidate[] = [];

  // From explicit rescue result
  const rescueOptions = rescue || [];

  // Also check split result for same-train options
  const splitRescues = (split?.split || split?.splits || split?.smart_routes || [])
    .filter(s => s.isSameTrain);

  const allRescues = [...rescueOptions, ...splitRescues];

  // Deduplicate by trainNo + hub
  const seen = new Set<string>();
  const uniqueRescues = allRescues.filter(r => {
    const key = `${r.leg1?.trainNo || ''}:${r.hub || ''}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });

  for (const r of uniqueRescues) {
    const trainNo = r.leg1?.trainNo || '';
    const hub = r.hub || '';
    if (!trainNo) continue;

    const leg1Avail = r.leg1?.availability?.status;
    const leg2Avail = r.leg2?.availability?.status;
    const leg1Conf = availabilityToConfidence(leg1Avail);
    const leg2Conf = availabilityToConfidence(leg2Avail);
    const avgAvailConf = (leg1Conf + leg2Conf) / 2;

    // Rescue scores are higher-is-better (90=confirmed, 60=partial RAC)
    // But findSegmentSplits uses lower-is-better via rankingService
    // Detect direction: if score > 50 and isSameTrain, assume higher-is-better
    const isHigherBetter = r.isSameTrain && r.score >= 50 && r.score <= 100;
    const normalizedScore = isHigherBetter
      ? normalizeHigherBetter(r.score, RESCUE_SCORE_MAX)
      : normalizeLowerBetter(r.score);

    const combinedConf = (avgAvailConf * 0.5) + (normalizedScore * 0.5);

    const components: ScoreComponent[] = [
      {
        source: 'RESCUE_AVAILABILITY',
        weight: WEIGHTS.RESCUE_AVAILABILITY,
        rawValue: combinedConf,
        weightedValue: combinedConf * WEIGHTS.RESCUE_AVAILABILITY
      },
      {
        source: 'RESCUE_SCORE',
        weight: 0.10,
        rawValue: normalizedScore,
        weightedValue: normalizedScore * 0.10
      }
    ];

    const confidence = components.reduce((sum, c) => sum + c.weightedValue, 0);

    candidates.push({
      id: makeCandidateId('RESCUE', trainNo, hub),
      type: 'RESCUE',
      trainNo,
      trainName: r.leg1?.trainName || r.leg1?.name,
      source: ctx.source,
      destination: ctx.destination,
      hub,
      legs: [r.leg1, r.leg2].filter(Boolean),
      isSameTrain: r.isSameTrain,
      rescueType: r.rescueType,
      totalDuration: r.totalDuration,
      bufferMinutes: r.bufferMinutes,
      travelDate: r.travelDate || ctx.date,
      badges: r.badges || [],
      rawScore: r.score,
      rawScoreDirection: isHigherBetter ? 'HIGHER_BETTER' : 'LOWER_BETTER',
      score: { confidence, components },
      availability: { leg1: leg1Avail, leg2: leg2Avail },
      warning: r.warning,
      metadata: {
        steps: r.steps,
        confidence: r.confidence
      }
    });
  }

  return candidates;
}

// ─── Health Assessment ────────────────────────────────────────────────────────

function assessHealth(
  live: LiveTrainStatus | null | undefined,
  pnr: NormalizedPnrResponse | null | undefined,
  prediction: PnrPredictionSnapshot | null | undefined
): JourneyHealth {
  const signals: string[] = [];
  let delayMinutes = 0;
  let isRunning: boolean = false;
  let status: JourneyHealth['status'] = 'UNKNOWN';
  let pnrStatus: JourneyHealth['pnrStatus'] = 'UNKNOWN';
  let pnrProbability: number | undefined;

  // Live health
  if (live) {
    delayMinutes = live.delay_minutes || 0;
    isRunning = !!live.is_running;

    if (delayMinutes === 0) {
      status = 'HEALTHY';
      signals.push(`On time at ${live.current_station}`);
    } else if (delayMinutes <= 15) {
      status = 'HEALTHY';
      signals.push(`Minor delay: ${delayMinutes} min at ${live.current_station}`);
    } else if (delayMinutes <= 60) {
      status = 'DELAYED';
      signals.push(`Delayed by ${delayMinutes} min at ${live.current_station}`);
    } else {
      status = 'AT_RISK';
      signals.push(`Major delay: ${delayMinutes} min at ${live.current_station}`);
    }

    if (!isRunning) {
      status = 'UNKNOWN';
      signals.push('Train not currently running');
    }
  } else {
    signals.push('No live tracking data available');
  }

  // PNR health
  if (pnr) {
    const passengers = pnr.passengers || [];
    const allStatuses = passengers.map(p => (p.current_status || '').toUpperCase());
    const hasCNF = allStatuses.some(s => s.includes('CNF') || s.includes('CONFIRMED'));
    const hasRAC = allStatuses.some(s => s.includes('RAC'));
    const hasWL = allStatuses.some(s => s.includes('WL') || s.includes('WAIT'));

    if (prediction?.probability) {
      pnrProbability = parseInt(prediction.probability.replace('%', '').trim(), 10);
      if (isNaN(pnrProbability)) pnrProbability = undefined;
    }

    if (hasCNF && !hasWL) {
      pnrStatus = 'CONFIRMED';
      signals.push(`PNR confirmed (${passengers.length} passengers)`);
    } else if (hasRAC && !hasWL) {
      pnrStatus = 'RAC';
      signals.push(`PNR RAC status`);
    } else if (hasWL) {
      pnrStatus = 'WAITLIST';
      signals.push(`PNR waitlist status${pnrProbability ? ` — ${pnrProbability}% confirmation chance` : ''}`);
    }

    if (pnr.chart_status) {
      signals.push(`Chart: ${pnr.chart_status}`);
    }
  }

  return {
    status,
    delayMinutes,
    isRunning,
    currentStation: live?.current_station,
    nextStation: live?.next_station,
    lastUpdated: live?.last_updated,
    pnrStatus,
    pnrProbability,
    signals
  };
}

// ─── Summary Builder ──────────────────────────────────────────────────────────

function buildSummary(
  candidates: JourneyCandidate[],
  ctx: JourneyContext
): JourneySummary {
  const directCount = candidates.filter(c => c.type === 'DIRECT').length;
  const splitCount = candidates.filter(c => c.type === 'SPLIT').length;
  const rescueCount = candidates.filter(c => c.type === 'RESCUE').length;

  const hasConfirmedSeats = candidates.some(c => {
    const leg1 = c.availability?.leg1?.toUpperCase() || '';
    const leg2 = c.availability?.leg2?.toUpperCase() || '';
    return leg1.includes('AVAILABLE') || leg1.includes('CNF') ||
           leg2.includes('AVAILABLE') || leg2.includes('CNF');
  });

  const hasRescueOption = rescueCount > 0;

  // Determine best journey type
  let journeyType: JourneyType = 'NONE';
  if (candidates.length > 0) {
    const best = candidates[0]; // already sorted by confidence
    journeyType = best.type;
  }

  // Split recommended if best candidate is a split or rescue
  const splitRecommended = journeyType === 'SPLIT' || journeyType === 'RESCUE';

  let message: string;
  if (candidates.length === 0) {
    message = 'No journey options found for this route.';
  } else if (journeyType === 'DIRECT') {
    message = `${directCount} direct train(s) available${hasConfirmedSeats ? ' with confirmed seats' : ''}.`;
  } else if (journeyType === 'SPLIT') {
    message = `${splitCount} split route(s) recommended over ${directCount} direct train(s).`;
  } else if (journeyType === 'RESCUE') {
    message = `${rescueCount} same-train rescue option(s) available${hasConfirmedSeats ? ' with confirmed segments' : ''}.`;
  } else {
    message = `${candidates.length} journey option(s) found.`;
  }

  return {
    journeyType,
    totalCandidates: candidates.length,
    directCount,
    splitCount,
    rescueCount,
    hasConfirmedSeats,
    hasRescueOption,
    splitRecommended,
    message
  };
}

// ─── Orchestrator ─────────────────────────────────────────────────────────────

class JourneyOrchestrator {
  /**
   * Orchestrate all engine outputs into a single JourneyRecommendation.
   *
   * @param context  JourneyContext with all available engine outputs.
   * @returns JourneyRecommendation — advisory only, never triggers side effects.
   *
   * If featureFlags.journeyOrchestrator=false: returns a safe "disabled" result.
   */
  orchestrate(context: JourneyContext): JourneyRecommendation {
    const evaluatedAt = new Date().toISOString();

    // Feature flag gate
    if (!featureFlags.journeyOrchestrator) {
      return this.disabledResult(context, evaluatedAt);
    }

    try {
      // 1. Extract signals from all engines
      const signals: JourneySignal[] = [
        ...extractSearchSignals(context.searchResult ?? null),
        ...extractSplitSignals(context.splitResult ?? null),
        ...extractRescueSignals(context.rescueResult ?? null),
        ...extractPnrSignals(context.pnrResult ?? null, context.pnrPrediction ?? null),
        ...extractLiveSignals(context.liveResult ?? null),
        ...extractBookingSignals(context.decisionResult ?? null)
      ];

      // 2. Normalize candidates from all engines
      const directCandidates = normalizeDirectCandidates(
        context.searchResult ?? null,
        context.splitResult ?? null,
        context
      );
      const splitCandidates = normalizeSplitCandidates(
        context.splitResult ?? null,
        context
      );
      const rescueCandidates = normalizeRescueCandidates(
        context.rescueResult ?? null,
        context.splitResult ?? null,
        context
      );

      // 3. Merge and rank candidates (best-first by confidence)
      const allCandidates = [...directCandidates, ...splitCandidates, ...rescueCandidates];
      allCandidates.sort((a, b) => b.score.confidence - a.score.confidence);

      // 4. Assess journey health
      const health = assessHealth(
        context.liveResult ?? null,
        context.pnrResult ?? null,
        context.pnrPrediction ?? null
      );

      // 5. Build summary
      const summary = buildSummary(allCandidates, context);

      // 6. Pan India Rescue Intelligence Layer (PHASE_4C828)
      let intelligenceResult = null;
      if (featureFlags.panIndiaRescue) {
        intelligenceResult = rescueIntelligence.evaluateRescue(context);
        
        // If intelligence finds high confidence, boost the best candidate's confidence if it's a rescue
        if (intelligenceResult.enhancedConfidence > 0.8 && allCandidates.length > 0 && allCandidates[0].type === 'RESCUE') {
          // In a real scenario we'd mutate or clone the candidate to reflect the intelligence boost.
          // For now, the intelligenceResult is strictly advisory.
        }
      }

      // 7. Build final recommendation
      return {
        context,
        summary,
        candidates: allCandidates,
        bestCandidate: allCandidates[0] || null,
        health,
        signals,
        bookingDecision: context.decisionResult ?? null,
        rescueIntelligence: intelligenceResult,
        evaluatedAt,
        orchestratorVersion: ORCHESTRATOR_VERSION
      };
    } catch (err: any) {
      // Never crash the caller — return safe error result
      return this.errorResult(context, evaluatedAt, err?.message ?? 'unknown error');
    }
  }

  private disabledResult(context: JourneyContext, evaluatedAt: string): JourneyRecommendation {
    return {
      context,
      summary: {
        journeyType: 'NONE',
        totalCandidates: 0,
        directCount: 0,
        splitCount: 0,
        rescueCount: 0,
        hasConfirmedSeats: false,
        hasRescueOption: false,
        splitRecommended: false,
        message: 'Journey orchestrator is disabled (feature flag OFF).'
      },
      candidates: [],
      bestCandidate: null,
      health: {
        status: 'UNKNOWN',
        delayMinutes: 0,
        isRunning: false,
        signals: ['Orchestrator disabled — no health assessment performed.']
      },
      signals: [],
      bookingDecision: null,
      evaluatedAt,
      orchestratorVersion: ORCHESTRATOR_VERSION
    };
  }

  private errorResult(context: JourneyContext, evaluatedAt: string, errorMsg: string): JourneyRecommendation {
    return {
      context,
      summary: {
        journeyType: 'NONE',
        totalCandidates: 0,
        directCount: 0,
        splitCount: 0,
        rescueCount: 0,
        hasConfirmedSeats: false,
        hasRescueOption: false,
        splitRecommended: false,
        message: `Orchestrator error: ${errorMsg}`
      },
      candidates: [],
      bestCandidate: null,
      health: {
        status: 'UNKNOWN',
        delayMinutes: 0,
        isRunning: false,
        signals: [`Orchestrator error: ${errorMsg}`]
      },
      signals: [],
      bookingDecision: null,
      evaluatedAt,
      orchestratorVersion: ORCHESTRATOR_VERSION
    };
  }
}

// ─── Export ───────────────────────────────────────────────────────────────────

export const journeyOrchestrator = new JourneyOrchestrator();
export { JourneyOrchestrator };