"use strict";
/**
 * PHASE 1.6.201 — Server-Side Search Verification Gate Middleware
 *
 * Enforces Trayago account-security and booking policy for train search requests.
 *
 * Rules:
 * 1. If featureFlags.searchVerificationGate is false -> Pass through (emergency rollback).
 * 2. If no userId (guest / public search) -> Pass through (public search stays accessible).
 * 3. If authenticated user:
 *    - In grace period -> Pass through (reminders handled by frontend/headers).
 *    - Post-deadline & unverified -> Return HTTP 403 with structured JSON.
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.searchVerificationGateMiddleware = void 0;
const featureFlags_1 = require("../config/featureFlags");
const verificationRolloutService_1 = require("../services/verificationRolloutService");
const searchVerificationGateMiddleware = async (req, res, next) => {
    // 1. Emergency kill-switch bypass
    if (!featureFlags_1.featureFlags.searchVerificationGate) {
        return next();
    }
    // 2. Public / guest searches are NEVER gated
    const userId = req.headers['x-user-id'] || null;
    if (!userId) {
        return next();
    }
    try {
        const evaluation = await verificationRolloutService_1.verificationRolloutService.evaluateUserSearchAccess(userId);
        // If gated, block search request server-side
        if (evaluation.isGated) {
            return res.status(403).json({
                success: false,
                error: evaluation.errorCode,
                code: evaluation.errorCode,
                message: evaluation.message,
                action: evaluation.requiredAction,
                deadline: evaluation.deadline,
                gracePeriodExpired: true,
                requiredFields: evaluation.missingFields,
                profileUrl: evaluation.profileUrl
            });
        }
        // Attach evaluation to response header for client awareness during grace period
        if (evaluation.errorCode) {
            res.setHeader('x-trayago-verify-action', evaluation.requiredAction || 'VERIFY_MOBILE');
            res.setHeader('x-trayago-verify-days-left', String(evaluation.daysRemaining));
        }
        next();
    }
    catch (err) {
        // Fail-open on unexpected middleware exception to avoid crashing core search
        next();
    }
};
exports.searchVerificationGateMiddleware = searchVerificationGateMiddleware;
