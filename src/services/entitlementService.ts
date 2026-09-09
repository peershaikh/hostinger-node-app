import { authService } from './authService';
import fs from 'fs';
import path from 'path';

export type EntitlementStatus = 'ALLOW_PAID' | 'ALLOW_FREE' | 'SHOW_PAYWALL' | 'REQUIRE_LOGIN';

const LEDGER_PATH = path.join(process.cwd(), 'data', 'free_rescue_ledger.json');

function getLedger(): Record<string, string> {
  try {
    if (fs.existsSync(LEDGER_PATH)) {
      return JSON.parse(fs.readFileSync(LEDGER_PATH, 'utf8'));
    }
  } catch {}
  return {};
}

function saveLedger(ledger: Record<string, string>) {
  try {
    const dir = path.dirname(LEDGER_PATH);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(LEDGER_PATH, JSON.stringify(ledger, null, 2));
  } catch {}
}

export class EntitlementService {
  public async checkRescueOrSplitEntitlement(userId: string | null): Promise<{
    status: EntitlementStatus;
    hasSplitAccess: boolean;
    freeCreditRemaining: boolean;
    planType: string;
    splitMinutesLeft: number;
  }> {
    if (!userId) {
      return {
        status: 'REQUIRE_LOGIN',
        hasSplitAccess: false,
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
        freeCreditRemaining: false,
        planType: 'none',
        splitMinutesLeft: 0
      };
    }

    // 1. Check if user already has paid split / pro access
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
        freeCreditRemaining: false,
        planType: user.planType || 'pro',
        splitMinutesLeft
      };
    }

    // 2. Check 1 free rescue-or-split check per 24 hours
    const ledger = getLedger();
    const freeUsedAt = ledger[userId];
    const isFreeUsedToday = freeUsedAt && (Date.now() - new Date(freeUsedAt).getTime() < 24 * 60 * 60 * 1000);

    if (!isFreeUsedToday) {
      return {
        status: 'ALLOW_FREE',
        hasSplitAccess: false,
        freeCreditRemaining: true,
        planType: user.planType || 'free',
        splitMinutesLeft: 0
      };
    }

    // 3. Free credit already consumed today -> SHOW_PAYWALL
    return {
      status: 'SHOW_PAYWALL',
      hasSplitAccess: false,
      freeCreditRemaining: false,
      planType: user.planType || 'free',
      splitMinutesLeft: 0
    };
  }

  public async consumeFreeRescueCredit(userId: string): Promise<{ success: boolean; message: string }> {
    const user = await authService.getUserById(userId);
    if (!user) {
      return { success: false, message: 'User not found' };
    }

    const ledger = getLedger();
    ledger[userId] = new Date().toISOString();
    saveLedger(ledger);

    return { success: true, message: 'Free rescue credit consumed successfully' };
  }
}

export const entitlementService = new EntitlementService();
