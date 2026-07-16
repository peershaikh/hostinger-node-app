"use strict";
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
Object.defineProperty(exports, "__esModule", { value: true });
