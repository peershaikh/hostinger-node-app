/**
 * PHASE 1.6.201 — Mobile Verification & Profile Completion Rollout Configuration
 *
 * Configures the 14-day progressive rollout for mandatory mobile verification
 * and passenger profile completion under Trayago account security and booking policy.
 */

export interface RolloutConfig {
  /** ISO Date string when the 14-day grace period rollout begins */
  rolloutStartDate: string;
  /** Duration of grace period in days */
  gracePeriodDays: number;
  /** ISO Date string when mandatory search gating activates */
  deadlineDate: string;
  /** Maximum snooze duration in hours when user clicks "Remind Me Later" */
  snoozeHours: number;
  /** Campaign identifier for deduplicated in-app notifications */
  campaignId: string;
}

const DEFAULT_ROLLOUT_START = '2026-10-25T00:00:00.000Z';
const DEFAULT_GRACE_PERIOD_DAYS = 14;

// Calculate default deadline: start date + 14 days = 2026-11-08T00:00:00.000Z
const startDateMs = Date.parse(process.env.VERIFICATION_ROLLOUT_START || DEFAULT_ROLLOUT_START);
const graceDays = parseInt(process.env.VERIFICATION_GRACE_PERIOD_DAYS || String(DEFAULT_GRACE_PERIOD_DAYS), 10);
const defaultDeadlineMs = startDateMs + graceDays * 24 * 60 * 60 * 1000;
const calculatedDeadline = new Date(defaultDeadlineMs).toISOString();

export const verificationRolloutConfig: RolloutConfig = {
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
export function isGracePeriodActive(currentTime: Date = new Date()): boolean {
  const nowMs = currentTime.getTime();
  const deadlineMs = Date.parse(verificationRolloutConfig.deadlineDate);
  return nowMs < deadlineMs;
}

/**
 * Returns the number of days remaining until the mandatory verification deadline.
 */
export function getDaysRemaining(currentTime: Date = new Date()): number {
  const nowMs = currentTime.getTime();
  const deadlineMs = Date.parse(verificationRolloutConfig.deadlineDate);
  const diffMs = deadlineMs - nowMs;
  if (diffMs <= 0) return 0;
  return Math.ceil(diffMs / (24 * 60 * 60 * 1000));
}

/**
 * Helper to check if a specific rollout override is active.
 */
export function getRolloutStatus(currentTime: Date = new Date()) {
  const graceActive = isGracePeriodActive(currentTime);
  const daysLeft = getDaysRemaining(currentTime);
  return {
    rolloutStartDate: verificationRolloutConfig.rolloutStartDate,
    deadlineDate: verificationRolloutConfig.deadlineDate,
    gracePeriodDays: verificationRolloutConfig.gracePeriodDays,
    gracePeriodActive: graceActive,
    daysRemaining: daysLeft,
    campaignId: verificationRolloutConfig.campaignId
  };
}
