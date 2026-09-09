import { authService } from './authService';
import fs from 'fs';
import path from 'path';

export type EntitlementStatus =
  | 'ALLOW_PAID'
  | 'ALLOW_FREE_RESCUE'
  | 'ALLOW_FREE_SPLIT'
  | 'SHOW_PAYWALL_RESCUE'
  | 'SHOW_PAYWALL_SPLIT'
  | 'REQUIRE_LOGIN';

export interface UserDailyQuota {
  rescueUsedOn?: string; // YYYY-MM-DD
  splitUsedOn?: string;  // YYYY-MM-DD
}

const LEDGER_PATH = path.join(process.cwd(), 'data', 'free_quota_ledger.json');
const LEGACY_LEDGER_PATH = path.join(process.cwd(), 'data', 'free_rescue_ledger.json');

function getTodayDateString(): string {
  // Use Indian Standard Time (UTC+5:30) for daily calendar reset alignment
  const now = new Date();
  const istOffset = 5.5 * 60 * 60 * 1000;
  const istDate = new Date(now.getTime() + istOffset);
  return istDate.toISOString().split('T')[0];
}

function getLedger(): Record<string, UserDailyQuota> {
  try {
    if (fs.existsSync(LEDGER_PATH)) {
      return JSON.parse(fs.readFileSync(LEDGER_PATH, 'utf8'));
    }
  } catch {}

  // Fallback to legacy single-entry ledger
  try {
    if (fs.existsSync(LEGACY_LEDGER_PATH)) {
      const legacy = JSON.parse(fs.readFileSync(LEGACY_LEDGER_PATH, 'utf8'));
      const upgraded: Record<string, UserDailyQuota> = {};
      for (const [uid, val] of Object.entries(legacy)) {
        if (typeof val === 'string') {
          upgraded[uid] = { rescueUsedOn: val.split('T')[0] };
        } else if (typeof val === 'object' && val !== null) {
          upgraded[uid] = val as UserDailyQuota;
        }
      }
      return upgraded;
    }
  } catch {}

  return {};
}

function saveLedger(ledger: Record<string, UserDailyQuota>) {
  try {
    const dir = path.dirname(LEDGER_PATH);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(LEDGER_PATH, JSON.stringify(ledger, null, 2));
  } catch {}
}

export class EntitlementService {
  public async checkRescueOrSplitEntitlement(
    userId: string | null,
    actionType?: 'rescue' | 'split'
  ): Promise<{
    status: EntitlementStatus;
    hasSplitAccess: boolean;
    rescueCreditRemaining: boolean;
    splitCreditRemaining: boolean;
    freeCreditRemaining: boolean;
    planType: string;
    splitMinutesLeft: number;
  }> {
    if (!userId) {
      return {
        status: 'REQUIRE_LOGIN',
        hasSplitAccess: false,
        rescueCreditRemaining: true,
        splitCreditRemaining: true,
        freeCreditRemaining: true,
        planType: 'guest',
        splitMinutesLeft: 0
      };
    }

    const user = await authService.getUserById(userId);
    if (!user || user.isBlocked) {
      return {
        status: 'REQUIRE_LOGIN',
        hasSplitAccess: false,
        rescueCreditRemaining: false,
        splitCreditRemaining: false,
        freeCreditRemaining: false,
        planType: 'none',
        splitMinutesLeft: 0
      };
    }

    // 1. Paid users (Pro, Blitz, 24h Pass, Yearly, Admin) are NEVER blocked
    const hasSplitAccess = await authService.canUseSplit(userId);
    let splitMinutesLeft = 0;
    if (hasSplitAccess && user.splitAccessUntil) {
      splitMinutesLeft = Math.max(0, Math.floor((new Date(user.splitAccessUntil).getTime() - Date.now()) / 60000));
    } else if (hasSplitAccess) {
      splitMinutesLeft = 99999;
    }

    if (hasSplitAccess) {
      return {
        status: 'ALLOW_PAID',
        hasSplitAccess: true,
        rescueCreditRemaining: true,
        splitCreditRemaining: true,
        freeCreditRemaining: true,
        planType: user.planType || 'pro',
        splitMinutesLeft
      };
    }

    // 2. Separate Daily Free Quotas: 1 Rescue + 1 Split per calendar day
    const today = getTodayDateString();
    const ledger = getLedger();
    const userQuota = ledger[userId] || {};

    const rescueUsedToday = Boolean(userQuota.rescueUsedOn && userQuota.rescueUsedOn === today);
    const splitUsedToday = Boolean(userQuota.splitUsedOn && userQuota.splitUsedOn === today);

    const rescueCreditRemaining = !rescueUsedToday;
    const splitCreditRemaining = !splitUsedToday;

    let status: EntitlementStatus;
    if (actionType === 'rescue') {
      status = rescueCreditRemaining ? 'ALLOW_FREE_RESCUE' : 'SHOW_PAYWALL_RESCUE';
    } else if (actionType === 'split') {
      status = splitCreditRemaining ? 'ALLOW_FREE_SPLIT' : 'SHOW_PAYWALL_SPLIT';
    } else {
      // General check: if either is free, allow free; else show paywall
      if (rescueCreditRemaining) {
        status = 'ALLOW_FREE_RESCUE';
      } else if (splitCreditRemaining) {
        status = 'ALLOW_FREE_SPLIT';
      } else {
        status = 'SHOW_PAYWALL_RESCUE';
      }
    }

    return {
      status,
      hasSplitAccess: false,
      rescueCreditRemaining,
      splitCreditRemaining,
      freeCreditRemaining: rescueCreditRemaining || splitCreditRemaining,
      planType: user.planType || 'free',
      splitMinutesLeft: 0
    };
  }

  public async consumeFreeCredit(
    userId: string,
    actionType: 'rescue' | 'split' = 'rescue'
  ): Promise<{ success: boolean; message: string; actionType: 'rescue' | 'split' }> {
    const user = await authService.getUserById(userId);
    if (!user) {
      return { success: false, message: 'User not found', actionType };
    }

    const today = getTodayDateString();
    const ledger = getLedger();
    if (!ledger[userId]) {
      ledger[userId] = {};
    }

    if (actionType === 'split') {
      ledger[userId].splitUsedOn = today;
    } else {
      ledger[userId].rescueUsedOn = today;
    }
    saveLedger(ledger);

    return {
      success: true,
      message: `Free ${actionType} credit consumed successfully`,
      actionType
    };
  }

  // Backward-compatible wrapper
  public async consumeFreeRescueCredit(userId: string): Promise<{ success: boolean; message: string }> {
    return this.consumeFreeCredit(userId, 'rescue');
  }
}

export const entitlementService = new EntitlementService();
