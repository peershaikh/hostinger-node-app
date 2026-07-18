"use strict";
/**
 * PHASE_4C822 / PHASE_4C823 / PHASE_4C824 / PHASE_4C825 — Feature Flags
 *
 * All flags default to false. No production behavior changes unless
 * the corresponding environment variable is explicitly set to 'true'.
 *
 * PHASE_4C822 / PHASE_4C823 — Universal Event Pipeline
 * universalIds       — enriches API responses with requestId/searchId/guestId
 * eventStream        — enables event emission to the universal_events table
 * partnerAttribution — appends partnerId/campaignId/source/medium to IRCTC redirects
 *
 * PHASE_4C824 — Booking Gateway Foundation (all OFF — foundation only)
 * bookingGateway     — enables the booking gateway router (BOOKING_GATEWAY=true)
 * partnerRouter      — enables multi-provider partner routing (PARTNER_ROUTER=true)
 * directBooking      — enables IRCTC agent direct booking (DIRECT_BOOKING=true)
 * affiliateTracking  — enables affiliate UTM/click_id injection (AFFILIATE_TRACKING=true)
 *
 * PHASE_4C825 — Booking Decision Engine (OFF — advisory only)
 * bookingDecision    — enables the provider scoring engine (BOOKING_DECISION=true)
 *
 * PHASE_4C826 — Journey Intelligence Orchestrator (OFF — advisory only)
 * journeyOrchestrator — enables the journey orchestration layer (JOURNEY_ORCHESTRATOR=true)
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.featureFlags = void 0;
exports.featureFlags = {
    // ── PHASE_4C822 / PHASE_4C823 ──────────────────────────────────────────────
    universalIds: process.env.UNIVERSAL_IDS === 'true',
    eventStream: process.env.EVENT_STREAM === 'true',
    partnerAttribution: process.env.PARTNER_ATTRIBUTION === 'true',
    // ── PHASE_4C824 — Booking Gateway Foundation ───────────────────────────────
    bookingGateway: process.env.BOOKING_GATEWAY === 'true',
    partnerRouter: process.env.PARTNER_ROUTER === 'true',
    directBooking: process.env.DIRECT_BOOKING === 'true',
    affiliateTracking: process.env.AFFILIATE_TRACKING === 'true',
    // ── PHASE_4C825 — Booking Decision Engine ─────────────────────────────────
    bookingDecision: process.env.BOOKING_DECISION === 'true',
    // ── PHASE_4C826 — Journey Intelligence Orchestrator ────────────────────────
    journeyOrchestrator: process.env.JOURNEY_ORCHESTRATOR === 'true',
    // ── PHASE_4C828 — Pan India Rescue Intelligence Layer ──────────────────────
    panIndiaRescue: process.env.PAN_INDIA_RESCUE === 'true',
    // ── PHASE_4C868 — Knowledge Layer Phase 0 (Foundation & Observability) ───
    /** Structured knowledge-pipeline metrics via winston ([KNOWLEDGE_METRICS] logs) */
    knowledgeMetrics: process.env.KNOWLEDGE_METRICS === 'true',
    /** Single canonical availability cache key; legacy avail_* read fallback retained */
    unifiedAvailCacheKeys: process.env.UNIFIED_AVAIL_CACHE_KEYS === 'true',
    // ── PHASE_4C870 — Smart Availability Cache (Redis L2) ─────────────────────
    /** L1 LRU + Redis L2 via SmartAvailabilityService; bypasses irctcService cache */
    smartAvailCache: process.env.SMART_AVAIL_CACHE === 'true',
    // ── PHASE_4C871 — Knowledge Layer (shadow mode — all default OFF) ───────
    /** Serve hub catalog from DB instead of runtime getMidpointHubs */
    knowledgeHubs: process.env.KNOWLEDGE_HUBS === 'true',
    /** Aggregate rescue_outcome_events into rescue_hub_stats */
    knowledgeStats: process.env.KNOWLEDGE_STATS === 'true',
    /** Shadow-compare runtime hubs vs catalog; log only, no response change */
    knowledgeHubsShadow: process.env.KNOWLEDGE_HUBS_SHADOW === 'true',
    /** PHASE_4C877 — B1 dual-read: catalog hydrate + runtime compare; telemetry only */
    knowledgeConsumeShadow: process.env.KNOWLEDGE_CONSUME_SHADOW === 'true',
    // ── PHASE_4C965 — Session Epoch (access-token revocation decoupling) ───────
    /**
     * Stage 2 gate. When true, access-token validation enforces `session_epoch`
     * (E) instead of the refresh-rotation `token_version` (R). Stage 1 keeps this
     * OFF: sessionEpoch is emitted and updated but NOT enforced. Default false.
     */
    authEnforceSessionEpoch: process.env.AUTH_ENFORCE_SESSION_EPOCH === 'true',
    // ── PHASE_5B020C — Offline Station Provider ─────────────────────────────────
    /** Use OfflineStationProvider instead of stationMapper for fallbacks */
    useOfflineProvider: process.env.USE_OFFLINE_PROVIDER === 'true',
};
