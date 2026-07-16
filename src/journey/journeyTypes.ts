/**
 * PHASE_4C826 — Journey Intelligence Orchestrator
 * Common Types
 *
 * Defines the unified type system for the journey orchestrator.
 * These types are consumed ONLY by journeyOrchestrator.ts.
 * No controller or engine imports these types.
 *
 * All outputs are advisory. No booking. No redirects. No side effects.
 */

import { CombinedSearchResponse, LiveTrainStatus } from '../types';
import { SplitJourney } from '../services/rankingService';
import { SplitEngineResult } from '../services/splitJourneyEngine';
import { NormalizedPnrResponse } from '../utils/pnrNormalizer';
import { DecisionResult } from '../booking/decisionTypes';

// ─── Journey Mode ─────────────────────────────────────────────────────────────

export type JourneyType = 'DIRECT' | 'SPLIT' | 'RESCUE' | 'NONE';

// ─── Journey Context ──────────────────────────────────────────────────────────

/**
 * The full context for a journey orchestration run.
 * Built by the caller from the request — the orchestrator never calls
 * external APIs or engines directly. All engine outputs are passed in.
 */
export interface JourneyContext {
  readonly source: string;
  readonly destination: string;
  readonly date: string;
  readonly classType?: string;
  readonly quota?: string;
  readonly trainNo?: string;
  readonly pnr?: string;

  // ── Engine outputs (all optional — orchestrator handles partial data) ──────
  readonly searchResult?: CombinedSearchResponse | null;
  readonly splitResult?: SplitEngineResult | null;
  readonly rescueResult?: SplitJourney[] | null;
  readonly pnrResult?: NormalizedPnrResponse | null;
  readonly pnrPrediction?: PnrPredictionSnapshot | null;
  readonly liveResult?: LiveTrainStatus | null;
  readonly decisionResult?: DecisionResult | null;
  readonly metadata?: Record<string, any>;
}

/**
 * Snapshot of the PNR prediction sub-object.
 * Extracted from the controller's cleanResponse.data.prediction.
 */
export interface PnrPredictionSnapshot {
  readonly text: string;
  readonly confidence_label: string;
  readonly advice: string;
  readonly explanation?: string;
  readonly worst_pos: number | null;
  readonly probability?: string;
}

// ─── Journey Signal ───────────────────────────────────────────────────────────

/**
 * A single signal extracted from one engine's output.
 * Signals are the atomic units that the orchestrator combines into
 * a unified recommendation.
 */
export interface JourneySignal {
  readonly source: 'SEARCH' | 'SPLIT' | 'RESCUE' | 'PNR' | 'LIVE' | 'BOOKING_DECISION';
  readonly type: SignalType;
  readonly value: number;        // normalized 0–1 (higher = better)
  readonly raw?: unknown;        // original data for debugging
  readonly message?: string;     // human-readable note
}

export type SignalType =
  | 'DIRECT_AVAILABILITY'
  | 'SPLIT_AVAILABILITY'
  | 'RESCUE_AVAILABILITY'
  | 'PNR_CONFIRMATION'
  | 'LIVE_DELAY'
  | 'LIVE_RUNNING'
  | 'BOOKING_PROVIDER';

// ─── Journey Score ────────────────────────────────────────────────────────────

/**
 * Unified score for a journey candidate.
 * All engine scores are normalized to a 0–1 confidence where higher = better.
 */
export interface JourneyScore {
  readonly confidence: number;          // 0–1 unified confidence
  readonly components: ScoreComponent[]; // breakdown by signal source
}

export interface ScoreComponent {
  readonly source: string;
  readonly weight: number;     // weight applied (0–1)
  readonly rawValue: number;   // normalized 0–1
  readonly weightedValue: number; // rawValue * weight
}

// ─── Journey Candidate ────────────────────────────────────────────────────────

/**
 * A single journey option normalized from any engine output.
 * Direct trains, splits, and rescues are all converted to candidates.
 */
export interface JourneyCandidate {
  readonly id: string;                   // unique identifier
  readonly type: JourneyType;            // DIRECT | SPLIT | RESCUE
  readonly trainNo?: string;             // primary train number
  readonly trainName?: string;           // primary train name
  readonly source: string;               // origin station code
  readonly destination: string;          // destination station code
  readonly hub?: string;                 // split/rescue hub
  readonly legs?: any[]; // 1 leg = direct, 2 legs = split/rescue (avoids Leg type conflicts)
  readonly isSameTrain?: boolean;        // true for same-train rescue
  readonly rescueType?: string;          // 'SAME_TRAIN_SEGMENT' | 'PARTIAL_RAC' | etc.
  readonly totalDuration?: number;       // minutes
  readonly bufferMinutes?: number;       // connection buffer
  readonly travelDate?: string;
  readonly badges?: string[];
  readonly rawScore?: number;            // original engine score (direction varies)
  readonly rawScoreDirection?: 'LOWER_BETTER' | 'HIGHER_BETTER';
  readonly score: JourneyScore;          // unified score
  readonly availability?: {
    leg1?: string;
    leg2?: string;
  };
  readonly warning?: string;
  readonly metadata?: Record<string, unknown>;
}

// ─── Journey Health ───────────────────────────────────────────────────────────

/**
 * Real-time health assessment of the journey.
 * Derived from live tracking data and PNR status.
 */
export interface JourneyHealth {
  readonly status: 'HEALTHY' | 'DELAYED' | 'AT_RISK' | 'UNKNOWN';
  readonly delayMinutes: number;
  readonly isRunning: boolean;
  readonly currentStation?: string;
  readonly nextStation?: string;
  readonly lastUpdated?: string;
  readonly pnrStatus?: 'CONFIRMED' | 'RAC' | 'WAITLIST' | 'UNKNOWN';
  readonly pnrProbability?: number;      // 0–100
  readonly signals: string[];            // human-readable health signals
}

// ─── Journey Summary ──────────────────────────────────────────────────────────

/**
 * High-level summary of the orchestration result.
 */
export interface JourneySummary {
  readonly journeyType: JourneyType;     // best journey type
  readonly totalCandidates: number;      // all candidates found
  readonly directCount: number;
  readonly splitCount: number;
  readonly rescueCount: number;
  readonly hasConfirmedSeats: boolean;   // any candidate with confirmed availability
  readonly hasRescueOption: boolean;     // rescue options exist
  readonly splitRecommended: boolean;    // split is better than direct
  readonly message: string;              // user-facing summary
}

// ─── Journey Recommendation ───────────────────────────────────────────────────

/**
 * The final output of the journey orchestrator.
 *
 * This is a PURE ADVISORY object. It does NOT trigger any booking,
 * redirect, or side effect. The caller decides what to do with it.
 */
import { RescueIntelligenceResult } from '../rescue/rescueIntelligence';

export interface JourneyRecommendation {
  readonly context: JourneyContext;
  readonly summary: JourneySummary;
  readonly candidates: JourneyCandidate[];   // ranked best-first
  readonly bestCandidate: JourneyCandidate | null; // top candidate (null if none)
  readonly health: JourneyHealth;
  readonly signals: JourneySignal[];         // all extracted signals
  readonly bookingDecision?: DecisionResult | null; // pass-through from decision engine
  readonly rescueIntelligence?: RescueIntelligenceResult | null; // from PHASE_4C828
  readonly evaluatedAt: string;              // ISO-8601
  readonly orchestratorVersion: string;      // version string for debugging
}