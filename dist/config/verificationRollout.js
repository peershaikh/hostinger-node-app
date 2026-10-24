"use strict";
/**
 * PHASE 1.6.201 — Mobile Verification & Profile Completion Rollout Configuration
 *
 * Configures the 14-day progressive rollout for mandatory mobile verification
 * and passenger profile completion under Trayago account security and booking policy.
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.verificationRolloutConfig = void 0;
exports.isGracePeriodActive = isGracePeriodActive;
exports.getDaysRemaining = getDaysRemaining;
exports.getRolloutStatus = getRolloutStatus;
const DEFAULT_ROLLOUT_START = '2026-10-25T00:00:00.000Z';
const DEFAULT_GRACE_PERIOD_DAYS = 14;
// Calculate default deadline: start date + 14 days = 2026-11-08T00:00:00.000Z
const startDateMs = Date.parse(process.env.VERIFICATION_ROLLOUT_START || DEFAULT_ROLLOUT_START);
const graceDays = parseInt(process.env.VERIFICATION_GRACE_PERIOD_DAYS || String(DEFAULT_GRACE_PERIOD_DAYS), 10);
const defaultDeadlineMs = startDateMs + graceDays * 24 * 60 * 60 * 1000;
const calculatedDeadline = new Date(defaultDeadlineMs).toISOString();
exports.verificationRolloutConfig = {
    rolloutStartDate: process.env.VERIFICATION_ROLLOUT_START || DEFAULT_ROLLOUT_START,
    gracePeriodDays: graceDays,
    deadlineDate: process.env.VERIFICATION_DEADLINE || calculatedDeadline,
    snoozeHours: 24,
    campaignId: 'MOBILE_VERIFY_V1'
};
/**
 * Checks whether the current time is within the active grace period.
 * During the grace period, reminders are displayed but train search access is NOT gated.
 */
function isGracePeriodActive(currentTime = new Date()) {
    const nowMs = currentTime.getTime();
    const deadlineMs = Date.parse(exports.verificationRolloutConfig.deadlineDate);
    return nowMs < deadlineMs;
}
/**
 * Returns the number of days remaining until the mandatory verification deadline.
 */
function getDaysRemaining(currentTime = new Date()) {
    const nowMs = currentTime.getTime();
    const deadlineMs = Date.parse(exports.verificationRolloutConfig.deadlineDate);
    const diffMs = deadlineMs - nowMs;
    if (diffMs <= 0)
        return 0;
    return Math.ceil(diffMs / (24 * 60 * 60 * 1000));
}
/**
 * Helper to check if a specific rollout override is active.
 */
function getRolloutStatus(currentTime = new Date()) {
    const graceActive = isGracePeriodActive(currentTime);
    const daysLeft = getDaysRemaining(currentTime);
    return {
        rolloutStartDate: exports.verificationRolloutConfig.rolloutStartDate,
        deadlineDate: exports.verificationRolloutConfig.deadlineDate,
        gracePeriodDays: exports.verificationRolloutConfig.gracePeriodDays,
        gracePeriodActive: graceActive,
        daysRemaining: daysLeft,
        campaignId: exports.verificationRolloutConfig.campaignId
    };
}
