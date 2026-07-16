/**
 * PHASE_4C825 — Booking Decision Engine Types
 *
 * Defines the structural contracts for the decision engine.
 * Types ONLY — no implementation, no routing, no booking.
 *
 * The decision engine is a SCORER.
 * It takes context, scores every eligible provider, and returns a recommendation.
 * It does NOT redirect. It does NOT book. It does NOT call external APIs.
 *
 * All outputs are advisory. The caller decides whether to act on them.
 */

import { BookingIntent, ProviderId } from './interfaces';

// ─── Journey Mode ─────────────────────────────────────────────────────────────

/**
 * High-level transport mode for this booking attempt.
 * Derived from the intent's journey segment + context.
 */
export type JourneyMode = 'RAIL' | 'BUS' | 'FLIGHT' | 'HOTEL';

// ─── Decision Reason ──────────────────────────────────────────────────────────

/**
 * A single human-readable reason that contributed to or reduced a provider's score.
 * Each scored factor appends one or more reasons.
 */
export interface DecisionReason {
  readonly factor:    string;    // machine-readable factor name e.g. "PROVIDER_PRIORITY"
  readonly label:     string;    // human-readable e.g. "IRCTC is the official rail authority"
  readonly impact:    number;    // positive = boosted score, negative = penalised
  readonly fatal:     boolean;   // true = this reason caused provider to be excluded entirely
}

// ─── Decision Score ───────────────────────────────────────────────────────────

/**
 * Full scoring result for one provider in one decision run.
 */
export interface DecisionScore {
  readonly providerId:  ProviderId;
  readonly totalScore:  number;         // sum of all factor impacts
  readonly eligible:    boolean;        // false if any fatal reason was triggered
  readonly reasons:     DecisionReason[];
}

// ─── Decision Context ─────────────────────────────────────────────────────────

/**
 * Everything the decision engine needs to evaluate providers.
 * Immutable after creation — caller builds it from the request, intent, and flags.
 *
 * PHASE_4C825: no controller or route creates this yet.
 * It is only consumed by the decision service's evaluate() method.
 */
export interface DecisionContext {
  readonly intent:          BookingIntent;
  readonly journeyMode:     JourneyMode;

  // ── Derived flow flags ─────────────────────────────────────────────────────
  readonly isRescueFlow:    boolean;   // true when intent.rescueId is set
  readonly isSplitFlow:     boolean;   // true when intent.splitId is set
  readonly isPnrReBook:     boolean;   // true when intent.pnrId is set

  // ── Mode flags ─────────────────────────────────────────────────────────────
  readonly isAdMode:        boolean;   // true when intent.adVariant is set
  readonly isPremiumMode:   boolean;   // true when featureFlags.directBooking=true + user has premium
  readonly isPartnerRouter: boolean;   // true when featureFlags.partnerRouter=true

  // ── Partner context ────────────────────────────────────────────────────────
  readonly hasAffiliate:    boolean;   // true when intent.affiliateId is set
  readonly hasCampaign:     boolean;   // true when intent.campaignId is set

  // ── Hint (optional caller override) ───────────────────────────────────────
  readonly preferredProvider?: ProviderId; // caller hint — engine may honour or override
}

// ─── Decision Result ──────────────────────────────────────────────────────────

/**
 * Output of the booking decision engine for one evaluation run.
 *
 * Returns:
 *   - recommendedProvider: the highest-scoring eligible provider
 *   - score:               the winning score
 *   - reasons[]:           all reasons for the recommendation (not just the winner's)
 *   - allScores[]:         full scoring breakdown for every evaluated provider
 *   - eligible[]:          only providers that passed all hard gates
 *
 * PHASE_4C825: this is advisory only.
 * No redirect is issued. No booking is made.
 */
export interface DecisionResult {
  readonly recommendedProvider: ProviderId | null;  // null if no eligible provider found
  readonly score:               number;
  readonly reasons:             DecisionReason[];   // reasons for the recommendation
  readonly allScores:           DecisionScore[];    // full per-provider breakdown
  readonly eligible:            ProviderId[];       // providers that passed hard gates
  readonly evaluatedAt:         string;             // ISO-8601
  readonly contextSummary:      string;             // one-line summary for logging
}
