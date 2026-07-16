"use strict";
/**
 * PHASE_4C825 — Booking Decision Service
 *
 * The decision engine: scores every registered provider and returns the best match.
 *
 * CONSTRAINTS (strictly enforced):
 *   ❌ No redirects
 *   ❌ No booking calls
 *   ❌ No external API calls
 *   ❌ No payment processing
 *   ❌ No controller changes
 *   ❌ No agent login
 *   ✅ Pure scoring: context → DecisionResult
 *   ✅ Advisory only — caller decides whether to act
 *   ✅ Gated by featureFlags.bookingDecision
 *
 * Scoring model (additive, higher = better):
 *   Hard gates (fatal = true):
 *     • provider.enabled = false           → score = 0, excluded
 *     • capability doesn't match mode      → excluded
 *     • partnerRouter=false + not IRCTC    → excluded (conservative default)
 *
 *   Score factors (additive):
 *     • Priority score:   100 - (priority * 10)   → IRCTC=90, CONFIRMTKT=80, …
 *     • Rescue flow:      +20 to IRCTC            → rescue always prefers official source
 *     • Split flow:       +10 to IRCTC            → multi-leg always prefers official source
 *     • Affiliate:        +15 to affiliate-capable → more revenue potential
 *     • Ad mode:          +10 to affiliate-capable → ad variant = partner context
 *     • Premium/direct:   +30 to OFFICIAL_AGENT   → direct booking highest value
 *     • Partner hint:     +25 to preferred provider
 *     • Campaign:         +5  to any              → attribution hygiene
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.bookingDecisionService = void 0;
const featureFlags_1 = require("../config/featureFlags");
const providerRegistry_1 = require("./providerRegistry");
// ─── Score Constants ──────────────────────────────────────────────────────────
const SCORE = {
    PRIORITY_BASE: 100,
    PRIORITY_STEP: 10, // deducted per priority level
    RESCUE_BOOST_IRCTC: 20,
    SPLIT_BOOST_IRCTC: 10,
    AFFILIATE_BOOST: 15,
    AD_MODE_BOOST: 10,
    PREMIUM_DIRECT_BOOST: 30,
    PARTNER_HINT_BOOST: 25,
    CAMPAIGN_BOOST: 5
};
// ─── Helpers ──────────────────────────────────────────────────────────────────
function capabilityForMode(mode) {
    return mode;
}
const CAPABILITY_MAP = {
    RAIL: (p) => p.capabilities.supportsRail,
    BUS: (p) => p.capabilities.supportsBus,
    FLIGHT: (p) => p.capabilities.supportsFlight,
    HOTEL: (p) => p.capabilities.supportsHotel
};
// ─── Per-Provider Scorer ──────────────────────────────────────────────────────
function scoreProvider(provider, context) {
    const reasons = [];
    let score = 0;
    let eligible = true;
    // ── Hard Gate 1: provider must be enabled ──────────────────────────────────
    if (!provider.enabled) {
        reasons.push({
            factor: 'PROVIDER_ENABLED',
            label: `${provider.id} is disabled (enabled=false) — will not be considered`,
            impact: 0,
            fatal: true
        });
        eligible = false;
        return { providerId: provider.id, totalScore: 0, eligible, reasons };
    }
    // ── Hard Gate 2: capability must match journey mode ────────────────────────
    const capabilityCheck = CAPABILITY_MAP[context.journeyMode];
    if (!capabilityCheck(provider)) {
        reasons.push({
            factor: 'CAPABILITY_MISMATCH',
            label: `${provider.id} does not support ${context.journeyMode} journeys`,
            impact: 0,
            fatal: true
        });
        eligible = false;
        return { providerId: provider.id, totalScore: 0, eligible, reasons };
    }
    // ── Hard Gate 3: partnerRouter=false → only IRCTC (safe default) ──────────
    if (!context.isPartnerRouter && provider.id !== 'IRCTC') {
        reasons.push({
            factor: 'PARTNER_ROUTER_DISABLED',
            label: `partnerRouter=false: only IRCTC eligible until partnerRouter is enabled`,
            impact: 0,
            fatal: true
        });
        eligible = false;
        return { providerId: provider.id, totalScore: 0, eligible, reasons };
    }
    // ── Factor 1: Priority score ───────────────────────────────────────────────
    const priorityScore = Math.max(0, SCORE.PRIORITY_BASE - (provider.priority * SCORE.PRIORITY_STEP));
    score += priorityScore;
    reasons.push({
        factor: 'PROVIDER_PRIORITY',
        label: `Priority ${provider.priority} → base score ${priorityScore}`,
        impact: priorityScore,
        fatal: false
    });
    // ── Factor 2: Rescue flow boost (IRCTC only) ───────────────────────────────
    if (context.isRescueFlow && provider.id === 'IRCTC') {
        score += SCORE.RESCUE_BOOST_IRCTC;
        reasons.push({
            factor: 'RESCUE_FLOW_BOOST',
            label: `Rescue flow: IRCTC preferred as official rail authority (+${SCORE.RESCUE_BOOST_IRCTC})`,
            impact: SCORE.RESCUE_BOOST_IRCTC,
            fatal: false
        });
    }
    // ── Factor 3: Split flow boost (IRCTC only) ────────────────────────────────
    if (context.isSplitFlow && provider.id === 'IRCTC') {
        score += SCORE.SPLIT_BOOST_IRCTC;
        reasons.push({
            factor: 'SPLIT_FLOW_BOOST',
            label: `Split journey: IRCTC preferred for multi-leg booking (+${SCORE.SPLIT_BOOST_IRCTC})`,
            impact: SCORE.SPLIT_BOOST_IRCTC,
            fatal: false
        });
    }
    // ── Factor 4: Affiliate capability boost ──────────────────────────────────
    if (context.hasAffiliate && provider.capabilities.supportsAffiliate) {
        score += SCORE.AFFILIATE_BOOST;
        reasons.push({
            factor: 'AFFILIATE_CAPABLE',
            label: `${provider.id} supports affiliate tracking — partner revenue potential (+${SCORE.AFFILIATE_BOOST})`,
            impact: SCORE.AFFILIATE_BOOST,
            fatal: false
        });
    }
    // ── Factor 5: Ad mode boost ────────────────────────────────────────────────
    if (context.isAdMode && provider.capabilities.supportsAffiliate) {
        score += SCORE.AD_MODE_BOOST;
        reasons.push({
            factor: 'AD_MODE_BOOST',
            label: `Ad variant active: affiliate-capable provider preferred (+${SCORE.AD_MODE_BOOST})`,
            impact: SCORE.AD_MODE_BOOST,
            fatal: false
        });
    }
    // ── Factor 6: Premium/direct booking mode ─────────────────────────────────
    if (context.isPremiumMode && provider.capabilities.supportsDirectBooking) {
        score += SCORE.PREMIUM_DIRECT_BOOST;
        reasons.push({
            factor: 'PREMIUM_DIRECT_BOOKING',
            label: `Premium mode: direct booking provider preferred (+${SCORE.PREMIUM_DIRECT_BOOST})`,
            impact: SCORE.PREMIUM_DIRECT_BOOST,
            fatal: false
        });
    }
    // ── Factor 7: Partner hint override ───────────────────────────────────────
    if (context.preferredProvider && provider.id === context.preferredProvider) {
        score += SCORE.PARTNER_HINT_BOOST;
        reasons.push({
            factor: 'PARTNER_HINT',
            label: `Caller preferred ${provider.id} (+${SCORE.PARTNER_HINT_BOOST})`,
            impact: SCORE.PARTNER_HINT_BOOST,
            fatal: false
        });
    }
    // ── Factor 8: Campaign attribution bonus ──────────────────────────────────
    if (context.hasCampaign) {
        score += SCORE.CAMPAIGN_BOOST;
        reasons.push({
            factor: 'CAMPAIGN_ATTRIBUTION',
            label: `Campaign context present — attribution hygiene bonus (+${SCORE.CAMPAIGN_BOOST})`,
            impact: SCORE.CAMPAIGN_BOOST,
            fatal: false
        });
    }
    return { providerId: provider.id, totalScore: score, eligible: true, reasons };
}
// ─── Decision Service ─────────────────────────────────────────────────────────
class BookingDecisionService {
    /**
     * Evaluate all registered providers and return a scored recommendation.
     *
     * @param context  The DecisionContext describing the booking request.
     * @param _providers  Optional provider list override — for testing only.
     *                    When omitted, uses bookingProviderRegistry.getAll().
     *
     * Returns DecisionResult with:
     *   - recommendedProvider: best eligible provider (null if none)
     *   - score:               winning provider's total score
     *   - reasons:             winning provider's scoring reasons
     *   - allScores:           full per-provider breakdown
     *   - eligible:            list of provider IDs that passed all hard gates
     *
     * ALWAYS returns a result object — never throws.
     * If featureFlags.bookingDecision=false: returns a safe "engine disabled" result.
     */
    evaluate(context, _providers) {
        const evaluatedAt = new Date().toISOString();
        // Feature flag gate: engine disabled
        if (!featureFlags_1.featureFlags.bookingDecision) {
            return {
                recommendedProvider: null,
                score: 0,
                reasons: [{
                        factor: 'ENGINE_DISABLED',
                        label: 'bookingDecision feature flag is OFF — engine not evaluated',
                        impact: 0,
                        fatal: false
                    }],
                allScores: [],
                eligible: [],
                evaluatedAt,
                contextSummary: `[DECISION_ENGINE_DISABLED] flag=bookingDecision mode=${context.journeyMode}`
            };
        }
        try {
            const allProviders = _providers ?? providerRegistry_1.bookingProviderRegistry.getAll();
            const allScores = allProviders.map(p => scoreProvider(p, context));
            const eligibleScores = allScores.filter(s => s.eligible);
            const eligibleIds = eligibleScores.map(s => s.providerId);
            // Sort eligible providers by totalScore descending
            eligibleScores.sort((a, b) => b.totalScore - a.totalScore);
            const winner = eligibleScores[0] || null;
            const contextSummary = [
                `[BOOKING_DECISION]`,
                `mode=${context.journeyMode}`,
                `rescue=${context.isRescueFlow}`,
                `split=${context.isSplitFlow}`,
                `affiliate=${context.hasAffiliate}`,
                `partnerRouter=${context.isPartnerRouter}`,
                `premium=${context.isPremiumMode}`,
                `winner=${winner?.providerId ?? 'NONE'}`,
                `score=${winner?.totalScore ?? 0}`,
                `eligible=[${eligibleIds.join(',')}]`
            ].join(' ');
            return {
                recommendedProvider: winner?.providerId ?? null,
                score: winner?.totalScore ?? 0,
                reasons: winner?.reasons ?? [],
                allScores,
                eligible: eligibleIds,
                evaluatedAt,
                contextSummary
            };
        }
        catch (err) {
            // Never crash the caller — return safe error result
            return {
                recommendedProvider: null,
                score: 0,
                reasons: [{
                        factor: 'ENGINE_ERROR',
                        label: `Decision engine threw: ${err?.message ?? 'unknown error'}`,
                        impact: 0,
                        fatal: false
                    }],
                allScores: [],
                eligible: [],
                evaluatedAt,
                contextSummary: `[BOOKING_DECISION_ERROR] ${err?.message ?? 'unknown'}`
            };
        }
    }
    /**
     * Convenience factory: build a DecisionContext from a BookingIntent + runtime flags.
     *
     * Callers that don't want to construct DecisionContext manually can use this.
     */
    buildContext(intent, journeyMode, opts = {}) {
        return {
            intent,
            journeyMode,
            isRescueFlow: !!intent.rescueId,
            isSplitFlow: !!intent.splitId,
            isPnrReBook: !!intent.pnrId,
            isAdMode: !!intent.adVariant,
            isPremiumMode: opts.isPremiumMode ?? featureFlags_1.featureFlags.directBooking,
            isPartnerRouter: featureFlags_1.featureFlags.partnerRouter,
            hasAffiliate: !!intent.affiliateId,
            hasCampaign: !!intent.campaignId,
            preferredProvider: opts.preferredProvider
        };
    }
}
exports.bookingDecisionService = new BookingDecisionService();
