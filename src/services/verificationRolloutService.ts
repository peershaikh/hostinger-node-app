/**
 * PHASE 1.6.201 — Verification Rollout & Search Gating Service
 *
 * Implements server-side access evaluation for authenticated train search requests,
 * grace period countdown tracking, profile readiness checks, and deduplicated
 * notification campaign preview.
 */

import { authService, User } from './authService';
import { verificationRolloutConfig, isGracePeriodActive, getDaysRemaining, getRolloutStatus } from '../config/verificationRollout';
import { featureFlags } from '../config/featureFlags';
import { normalizeIndianPhoneNumber } from '../utils/phoneNormalizer';
import { supabase, isSupabaseConfigured } from '../config/supabase';
import { winstonLogger } from '../middleware/logger';
import { MEMORY_NOTIFICATION_HISTORY } from '../controllers/notificationController';

export interface UserSearchAccessEvaluation {
  userId: string;
  isEligible: boolean;
  isGated: boolean;
  gracePeriodActive: boolean;
  daysRemaining: number;
  deadline: string;
  isMobileVerified: boolean;
  isProfileComplete: boolean;
  missingFields: string[];
  errorCode?: 'MOBILE_VERIFICATION_REQUIRED' | 'PROFILE_COMPLETION_REQUIRED';
  requiredAction?: 'VERIFY_MOBILE' | 'COMPLETE_PROFILE';
  message?: string;
  profileUrl: string;
}

export interface CampaignPreviewStats {
  campaignId: string;
  totalUsersChecked: number;
  alreadyVerifiedAndComplete: number;
  eligibleUnverifiedUsers: number;
  alreadyReceivedNotification: number;
  netEligibleRecipients: number;
  dryRun: boolean;
  sampleNotification: {
    title: string;
    body: string;
    category: string;
    metadata: Record<string, any>;
  };
}

export class VerificationRolloutService {

  /**
   * Evaluates whether an authenticated user has search access or is gated.
   *
   * Logic:
   * 1. If feature flag `searchVerificationGate` is OFF -> Never gated.
   * 2. If user has verified mobile and complete profile -> Eligible and never gated.
   * 3. If user is incomplete/unverified:
   *    - During 14-day grace period (now < deadline) -> Eligible (search NOT blocked, reminder returned).
   *    - After deadline (now >= deadline) -> Gated (search BLOCKED with structured 403 response).
   */
  public async evaluateUserSearchAccess(userId: string, currentTime: Date = new Date()): Promise<UserSearchAccessEvaluation> {
    const rollout = getRolloutStatus(currentTime);
    const profileUrl = '/profile';

    const defaultPassing: UserSearchAccessEvaluation = {
      userId,
      isEligible: true,
      isGated: false,
      gracePeriodActive: rollout.gracePeriodActive,
      daysRemaining: rollout.daysRemaining,
      deadline: rollout.deadlineDate,
      isMobileVerified: true,
      isProfileComplete: true,
      missingFields: [],
      profileUrl
    };

    // If master kill-switch is disabled, bypass all gating immediately
    if (!featureFlags.searchVerificationGate) {
      return defaultPassing;
    }

    const user = await authService.getUserById(userId);
    if (!user) {
      // If user cannot be resolved, allow fail-open for search to prevent blocking legitimate guests/users
      return defaultPassing;
    }

    // 1. Mobile Verification Evaluation
    const normalizedMobile = user.mobileNumber ? normalizeIndianPhoneNumber(user.mobileNumber) : null;
    const isMobileVerified = Boolean(user.mobileVerified === true && user.mobileNumber && normalizedMobile);

    // 2. Passenger Profile Completion Evaluation (IRCTC standard passenger fields)
    const hasFullName = Boolean(user.fullName && user.fullName.trim().length >= 2 && /^[a-zA-Z\s]+$/.test(user.fullName.trim()));
    const hasDob = Boolean(user.dob && !isNaN(Date.parse(user.dob)) && new Date(user.dob) < new Date());
    const hasGender = Boolean(user.gender && ['M', 'F', 'T'].includes(user.gender.toUpperCase()));

    const isProfileComplete = hasFullName && hasDob && hasGender;

    const missingFields: string[] = [];
    if (!isMobileVerified) {
      if (!user.mobileNumber) missingFields.push('mobileNumber');
      missingFields.push('mobileVerified');
    }
    if (!hasFullName) missingFields.push('fullName');
    if (!hasDob) missingFields.push('dob');
    if (!hasGender) missingFields.push('gender');

    const isFullyCompliant = isMobileVerified && isProfileComplete;

    // Fully compliant users always pass
    if (isFullyCompliant) {
      return {
        userId,
        isEligible: true,
        isGated: false,
        gracePeriodActive: rollout.gracePeriodActive,
        daysRemaining: rollout.daysRemaining,
        deadline: rollout.deadlineDate,
        isMobileVerified: true,
        isProfileComplete: true,
        missingFields: [],
        profileUrl
      };
    }

    // Determine specific missing requirement category
    const isMissingMobile = !isMobileVerified;
    const errorCode = isMissingMobile ? 'MOBILE_VERIFICATION_REQUIRED' : 'PROFILE_COMPLETION_REQUIRED';
    const requiredAction = isMissingMobile ? 'VERIFY_MOBILE' : 'COMPLETE_PROFILE';
    const message = isMissingMobile
      ? "Mobile number verification is required to continue searching trains under Trayago's account-security and booking policy."
      : "Passenger profile completion (name, date of birth, and gender) is required to continue searching trains under Trayago's account-security and booking policy.";

    // During grace period: search is NOT blocked
    if (rollout.gracePeriodActive) {
      return {
        userId,
        isEligible: true,
        isGated: false,
        gracePeriodActive: true,
        daysRemaining: rollout.daysRemaining,
        deadline: rollout.deadlineDate,
        isMobileVerified,
        isProfileComplete,
        missingFields,
        errorCode,
        requiredAction,
        message,
        profileUrl
      };
    }

    // After deadline has expired: search IS gated
    return {
      userId,
      isEligible: false,
      isGated: true,
      gracePeriodActive: false,
      daysRemaining: 0,
      deadline: rollout.deadlineDate,
      isMobileVerified,
      isProfileComplete,
      missingFields,
      errorCode,
      requiredAction,
      message,
      profileUrl
    };
  }

  /**
   * Previews the deduplicated in-app notification campaign for existing users.
   * Safe, read-only preview by default (dryRun = true).
   */
  public async previewMobileVerifyCampaign(options: { dryRun?: boolean } = { dryRun: true }): Promise<CampaignPreviewStats> {
    const campaignId = verificationRolloutConfig.campaignId;
    const allUsers: User[] = (authService as any).users || [];
    const totalUsersChecked = allUsers.length;

    let alreadyVerifiedAndComplete = 0;
    let eligibleUnverifiedUsers = 0;
    let alreadyReceivedNotification = 0;

    // Check notification history for campaign deduplication
    const notifiedUserIds = new Set<string>();

    if (isSupabaseConfigured()) {
      try {
        const { data, error } = await supabase
          .from('user_notification_history')
          .select('user_id, metadata')
          .not('user_id', 'is', null);

        if (!error && data) {
          data.forEach(item => {
            const meta = item.metadata as any;
            if (meta?.campaign_id === campaignId && item.user_id) {
              notifiedUserIds.add(item.user_id);
            }
          });
        }
      } catch (err: any) {
        winstonLogger.warn(`[NOTIFICATION_CAMPAIGN] Failed to query DB for campaign deduplication: ${err.message}`);
      }
    }

    // Also check memory buffer
    MEMORY_NOTIFICATION_HISTORY.forEach(item => {
      const meta = item.metadata as any;
      if (meta?.campaign_id === campaignId && item.user_id) {
        notifiedUserIds.add(item.user_id);
      }
    });

    for (const user of allUsers) {
      const isMobileVerified = Boolean(user.mobileVerified === true && user.mobileNumber);
      const isComplete = Boolean(
        user.fullName && user.fullName.trim().length >= 2 &&
        user.dob && !isNaN(Date.parse(user.dob)) &&
        user.gender && ['M', 'F', 'T'].includes(user.gender.toUpperCase())
      );

      if (isMobileVerified && isComplete) {
        alreadyVerifiedAndComplete++;
      } else {
        eligibleUnverifiedUsers++;
        if (notifiedUserIds.has(user.id)) {
          alreadyReceivedNotification++;
        }
      }
    }

    const netEligibleRecipients = Math.max(0, eligibleUnverifiedUsers - alreadyReceivedNotification);

    return {
      campaignId,
      totalUsersChecked,
      alreadyVerifiedAndComplete,
      eligibleUnverifiedUsers,
      alreadyReceivedNotification,
      netEligibleRecipients,
      dryRun: options.dryRun !== false,
      sampleNotification: {
        title: "🛡️ Account Security & Booking Verification",
        body: `Please verify your mobile number and complete your profile before the 14-day booking and security policy deadline (${verificationRolloutConfig.deadlineDate.split('T')[0]}) to maintain uninterrupted train search access.`,
        category: "SYSTEM",
        metadata: {
          campaign_id: campaignId,
          action_url: "/profile?action=verify-mobile",
          deadline: verificationRolloutConfig.deadlineDate
        }
      }
    };
  }
}

export const verificationRolloutService = new VerificationRolloutService();
