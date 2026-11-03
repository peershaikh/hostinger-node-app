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

export interface ActiveReservation {
  reservationId: string;
  actionType: 'rescue' | 'split';
  reservedAt: number; // Unix timestamp ms
  expiresAt: number;  // Unix timestamp ms
  committed?: boolean;
  released?: boolean;
}

export interface UserDailyQuota {
  rescueUsedOn?: string; // YYYY-MM-DD (IST)
  splitUsedOn?: string;  // YYYY-MM-DD (IST)
  reservations?: {
    split?: ActiveReservation;
    rescue?: ActiveReservation;
  };
}

export function getTodayDateString(): string {
  // Use Indian Standard Time (UTC+5:30) for daily calendar reset alignment
  const now = new Date();
  const istOffset = 5.5 * 60 * 60 * 1000;
  const istDate = new Date(now.getTime() + istOffset);
  return istDate.toISOString().split('T')[0];
}

export function getLedgerPath(): string {
  if (process.env.FREE_QUOTA_LEDGER_PATH) {
    return process.env.FREE_QUOTA_LEDGER_PATH;
  }
  const cwd = process.cwd();
  if (fs.existsSync(path.join(cwd, 'data', 'free_quota_ledger.json'))) {
    return path.join(cwd, 'data', 'free_quota_ledger.json');
  }
  if (fs.existsSync(path.join(cwd, '..', 'data', 'free_quota_ledger.json'))) {
    return path.join(cwd, '..', 'data', 'free_quota_ledger.json');
  }
  return path.join(cwd, 'data', 'free_quota_ledger.json');
}

export function getBackupPath(ledgerPath: string): string {
  return `${ledgerPath}.bak`;
}

export function getLockDirPath(ledgerPath: string): string {
  return `${ledgerPath}.lock`;
}

export function validateLedgerStructure(data: any): boolean {
  if (!data || typeof data !== 'object' || Array.isArray(data)) {
    return false;
  }
  for (const [, value] of Object.entries(data)) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      return false;
    }
    const val = value as any;
    if (val.rescueUsedOn !== undefined && (typeof val.rescueUsedOn !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(val.rescueUsedOn))) {
      return false;
    }
    if (val.splitUsedOn !== undefined && (typeof val.splitUsedOn !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(val.splitUsedOn))) {
      return false;
    }
    if (val.reservations !== undefined && (typeof val.reservations !== 'object' || Array.isArray(val.reservations))) {
      return false;
    }
  }
  return true;
}

export function saveLedgerAtomic(ledger: Record<string, UserDailyQuota>, ledgerPath: string = getLedgerPath()): void {
  const dir = path.dirname(ledgerPath);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

  const tempPath = path.join(
    dir,
    `.tmp_ledger_${process.pid}_${Date.now()}_${Math.random().toString(36).slice(2, 9)}.tmp`
  );
  const backupPath = getBackupPath(ledgerPath);
  const payload = JSON.stringify(ledger, null, 2);

  // 1. Write full content to temporary file
  fs.writeFileSync(tempPath, payload, 'utf8');

  // 2. Read back from temp file and parse to guarantee file was written cleanly
  const readBack = fs.readFileSync(tempPath, 'utf8');
  const parsed = JSON.parse(readBack);
  if (!validateLedgerStructure(parsed)) {
    try { fs.unlinkSync(tempPath); } catch {}
    throw new Error('Ledger write failed validation check before atomic commit');
  }

  // 3. Update backup snapshot from current valid primary file before replacing
  try {
    if (fs.existsSync(ledgerPath)) {
      const currentPrimary = fs.readFileSync(ledgerPath, 'utf8');
      if (currentPrimary.trim().length > 0) {
        const curParsed = JSON.parse(currentPrimary);
        if (validateLedgerStructure(curParsed)) {
          fs.copyFileSync(ledgerPath, backupPath);
        }
      }
    }
  } catch {}

  // 4. Atomic rename replaces destination file atomically
  fs.renameSync(tempPath, ledgerPath);
}

export function getLedgerSafe(ledgerPath: string = getLedgerPath()): Record<string, UserDailyQuota> {
  const backupPath = getBackupPath(ledgerPath);

  // 1. Try reading primary ledger file
  if (fs.existsSync(ledgerPath)) {
    try {
      const content = fs.readFileSync(ledgerPath, 'utf8');
      if (content.trim().length > 0) {
        const parsed = JSON.parse(content);
        if (validateLedgerStructure(parsed)) {
          return parsed;
        }
        console.warn('[ENTITLEMENT_DURABILITY] Primary ledger failed schema validation. Checking backup...');
      } else {
        console.warn('[ENTITLEMENT_DURABILITY] Primary ledger is 0 bytes (truncated). Checking backup...');
      }
    } catch (primaryErr: any) {
      console.warn(`[ENTITLEMENT_DURABILITY] Primary ledger parse error (${primaryErr.message}). Checking backup...`);
    }
  }

  // 2. Attempt recovery from backup snapshot
  if (fs.existsSync(backupPath)) {
    try {
      const backupContent = fs.readFileSync(backupPath, 'utf8');
      if (backupContent.trim().length > 0) {
        const recovered = JSON.parse(backupContent);
        if (validateLedgerStructure(recovered)) {
          console.info('[ENTITLEMENT_DURABILITY] Successfully recovered valid ledger state from backup snapshot.');
          saveLedgerAtomic(recovered, ledgerPath);
          return recovered;
        }
      }
    } catch (backupErr: any) {
      console.error(`[ENTITLEMENT_DURABILITY] Backup ledger parse error (${backupErr.message}).`);
    }
  }

  // 3. Fallback to legacy single-entry ledger if this is first migration
  const legacyPath = path.join(path.dirname(ledgerPath), 'free_rescue_ledger.json');
  if (fs.existsSync(legacyPath)) {
    try {
      const legacy = JSON.parse(fs.readFileSync(legacyPath, 'utf8'));
      const upgraded: Record<string, UserDailyQuota> = {};
      for (const [uid, val] of Object.entries(legacy)) {
        if (typeof val === 'string') {
          upgraded[uid] = { rescueUsedOn: val.split('T')[0] };
        } else if (typeof val === 'object' && val !== null) {
          upgraded[uid] = val as UserDailyQuota;
        }
      }
      if (validateLedgerStructure(upgraded)) {
        saveLedgerAtomic(upgraded, ledgerPath);
        return upgraded;
      }
    } catch {}
  }

  // 4. If primary file existed with corrupt content and backup failed, preserve corrupt file for forensics
  if (fs.existsSync(ledgerPath)) {
    try {
      const corruptDest = `${ledgerPath}.corrupt.${Date.now()}`;
      fs.copyFileSync(ledgerPath, corruptDest);
      console.error(`[ENTITLEMENT_DURABILITY] Preserved unparseable primary ledger to ${corruptDest}`);
    } catch {}
  }

  return {};
}

export class EntitlementService {
  private inProcessLock: Promise<any> = Promise.resolve();

  private async acquireCrossProcessLock<T>(fn: () => Promise<T>): Promise<T> {
    const previous = this.inProcessLock;
    let releaseInProcess: () => void;
    this.inProcessLock = new Promise<void>(resolve => { releaseInProcess = resolve; });

    await previous;

    const ledgerPath = getLedgerPath();
    const lockDir = getLockDirPath(ledgerPath);
    const timeoutMs = 8000;
    const retryDelayMs = 25;
    const staleLockThresholdMs = 10000;
    const start = Date.now();

    let dirLockAcquired = false;

    try {
      const parentDir = path.dirname(lockDir);
      if (!fs.existsSync(parentDir)) fs.mkdirSync(parentDir, { recursive: true });

      while (!dirLockAcquired) {
        try {
          fs.mkdirSync(lockDir);
          dirLockAcquired = true;
        } catch (err: any) {
          if (err.code !== 'EEXIST') throw err;

          try {
            const stat = fs.statSync(lockDir);
            if (Date.now() - stat.mtimeMs > staleLockThresholdMs) {
              console.warn('[ENTITLEMENT_DURABILITY] Stale directory lock detected. Forcing lock removal.');
              try {
                fs.rmdirSync(lockDir);
              } catch {}
            }
          } catch {}

          if (Date.now() - start > timeoutMs) {
            throw new Error(`Cross-process entitlement lock timeout after ${timeoutMs}ms`);
          }

          const jitter = Math.floor(Math.random() * 20);
          await new Promise(r => setTimeout(r, retryDelayMs + jitter));
        }
      }

      return await fn();

    } finally {
      if (dirLockAcquired) {
        try {
          if (fs.existsSync(lockDir)) {
            fs.rmdirSync(lockDir);
          }
        } catch {}
      }
      releaseInProcess!();
    }
  }

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
    const ledger = getLedgerSafe();
    const userQuota = ledger[userId] || {};

    const rescueUsedToday = Boolean(userQuota.rescueUsedOn && userQuota.rescueUsedOn === today);
    const splitUsedToday = Boolean(userQuota.splitUsedOn && userQuota.splitUsedOn === today);

    // Also check active reservations
    const now = Date.now();
    const rescueReserved = Boolean(userQuota.reservations?.rescue && now < userQuota.reservations.rescue.expiresAt && !userQuota.reservations.rescue.committed);
    const splitReserved = Boolean(userQuota.reservations?.split && now < userQuota.reservations.split.expiresAt && !userQuota.reservations.split.committed);

    const rescueCreditRemaining = !rescueUsedToday && !rescueReserved;
    const splitCreditRemaining = !splitUsedToday && !splitReserved;

    let status: EntitlementStatus;
    if (actionType === 'rescue') {
      status = rescueCreditRemaining ? 'ALLOW_FREE_RESCUE' : 'SHOW_PAYWALL_RESCUE';
    } else if (actionType === 'split') {
      status = splitCreditRemaining ? 'ALLOW_FREE_SPLIT' : 'SHOW_PAYWALL_SPLIT';
    } else {
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

  public async reserveFreeCredit(
    userId: string,
    actionType: 'rescue' | 'split',
    leaseMs: number = 120000
  ): Promise<{
    allowed: boolean;
    status: EntitlementStatus;
    planType: string;
    message: string;
    reservationId?: string;
    isPaid?: boolean;
    inProgress?: boolean;
  }> {
    if (!userId) {
      return {
        allowed: false,
        status: 'REQUIRE_LOGIN',
        planType: 'guest',
        message: 'Authentication required'
      };
    }

    // Check account status
    const user = await authService.getUserById(userId);
    if (!user || user.isBlocked) {
      return {
        allowed: false,
        status: 'REQUIRE_LOGIN',
        planType: 'none',
        message: 'Account not found or blocked'
      };
    }

    // Paid users do not consume free quota
    const hasPaidSplit = await authService.canUseSplit(userId);
    if (hasPaidSplit) {
      return {
        allowed: true,
        status: 'ALLOW_PAID',
        planType: user.planType || 'pro',
        message: 'Paid plan entitlement active',
        isPaid: true
      };
    }

    return this.acquireCrossProcessLock(async () => {
      const ledgerPath = getLedgerPath();
      const ledger = getLedgerSafe(ledgerPath);
      const today = getTodayDateString();
      const userQuota = ledger[userId] || {};

      const now = Date.now();

      // Clean expired reservations for this user
      if (userQuota.reservations) {
        for (const act of ['split', 'rescue'] as const) {
          const r = userQuota.reservations[act];
          if (r && now >= r.expiresAt && !r.committed) {
            delete userQuota.reservations[act];
          }
        }
      }

      // Check if already committed for today (IST)
      const alreadyCommitted = actionType === 'split'
        ? (userQuota.splitUsedOn === today)
        : (userQuota.rescueUsedOn === today);

      if (alreadyCommitted) {
        return {
          allowed: false,
          status: actionType === 'rescue' ? 'SHOW_PAYWALL_RESCUE' : 'SHOW_PAYWALL_SPLIT',
          planType: user.planType || 'free',
          message: `Daily free ${actionType === 'rescue' ? 'Same-Train Rescue' : 'Split Journey'} limit reached. Upgrade to Pro for unlimited access.`
        };
      }

      // Check for active non-expired reservation
      const existingRes = userQuota.reservations?.[actionType];
      if (existingRes && now < existingRes.expiresAt && !existingRes.committed && !existingRes.released) {
        return {
          allowed: false,
          status: actionType === 'rescue' ? 'SHOW_PAYWALL_RESCUE' : 'SHOW_PAYWALL_SPLIT',
          planType: user.planType || 'free',
          inProgress: true,
          message: `A ${actionType === 'rescue' ? 'Same-Train Rescue' : 'Split Journey'} search is currently in progress. Please wait for it to complete.`
        };
      }

      // Create new reservation
      const reservationId = `res_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`;
      if (!ledger[userId]) ledger[userId] = {};
      if (!ledger[userId].reservations) ledger[userId].reservations = {};

      ledger[userId].reservations![actionType] = {
        reservationId,
        actionType,
        reservedAt: now,
        expiresAt: now + leaseMs
      };

      saveLedgerAtomic(ledger, ledgerPath);

      const safeId = userId.slice(0, 8);
      console.info(`[ENTITLEMENT] Reserved free ${actionType} credit for user ${safeId}... (id: ${reservationId}, lease: ${leaseMs}ms)`);

      return {
        allowed: true,
        status: actionType === 'rescue' ? 'ALLOW_FREE_RESCUE' : 'ALLOW_FREE_SPLIT',
        planType: user.planType || 'free',
        reservationId,
        message: `Free ${actionType} credit reserved successfully`
      };
    });
  }

  public async commitFreeCredit(
    userId: string,
    actionType: 'rescue' | 'split',
    reservationId: string
  ): Promise<{ success: boolean; message: string }> {
    if (!userId || !reservationId) {
      return { success: false, message: 'Invalid parameters for entitlement commit' };
    }

    return this.acquireCrossProcessLock(async () => {
      const ledgerPath = getLedgerPath();
      const ledger = getLedgerSafe(ledgerPath);
      const today = getTodayDateString();
      const userQuota = ledger[userId];

      // Idempotency: check if already committed today
      const alreadyCommitted = actionType === 'split'
        ? (userQuota?.splitUsedOn === today)
        : (userQuota?.rescueUsedOn === today);

      if (alreadyCommitted) {
        return { success: true, message: 'Already committed for today (idempotent)' };
      }

      const res = userQuota?.reservations?.[actionType];
      if (!res) {
        return { success: false, message: 'No active reservation found to commit' };
      }

      if (res.reservationId !== reservationId) {
        return { success: false, message: 'Reservation ID mismatch' };
      }

      if (res.released) {
        return { success: false, message: 'Reservation was already released' };
      }

      if (Date.now() > res.expiresAt) {
        const safeId = userId.slice(0, 8);
        console.warn(`[ENTITLEMENT] Commit attempted after lease expiration for user ${safeId}... (reservation: ${reservationId})`);
        delete userQuota!.reservations![actionType];
        saveLedgerAtomic(ledger, ledgerPath);
        return { success: false, message: 'Reservation lease expired before engine finished' };
      }

      if (actionType === 'split') {
        userQuota!.splitUsedOn = today;
      } else {
        userQuota!.rescueUsedOn = today;
      }

      delete userQuota!.reservations![actionType];
      saveLedgerAtomic(ledger, ledgerPath);

      const safeId = userId.slice(0, 8);
      console.info(`[ENTITLEMENT] Committed free ${actionType} credit for user ${safeId}... on ${today}`);

      return { success: true, message: `Free ${actionType} credit committed successfully` };
    });
  }

  public async releaseFreeCredit(
    userId: string,
    actionType: 'rescue' | 'split',
    reservationId: string
  ): Promise<{ success: boolean; message: string }> {
    if (!userId || !reservationId) {
      return { success: false, message: 'Invalid parameters for entitlement release' };
    }

    return this.acquireCrossProcessLock(async () => {
      const ledgerPath = getLedgerPath();
      const ledger = getLedgerSafe(ledgerPath);
      const today = getTodayDateString();
      const userQuota = ledger[userId];

      // If already committed for today, cannot release
      const alreadyCommitted = actionType === 'split'
        ? (userQuota?.splitUsedOn === today)
        : (userQuota?.rescueUsedOn === today);

      if (alreadyCommitted) {
        return { success: false, message: 'Cannot release already committed credit' };
      }

      const res = userQuota?.reservations?.[actionType];
      if (!res) {
        return { success: true, message: 'Reservation already released or not found (idempotent)' };
      }

      if (res.reservationId !== reservationId) {
        return { success: false, message: 'Reservation ID mismatch' };
      }

      if (res.committed) {
        return { success: false, message: 'Cannot release already committed credit' };
      }

      delete userQuota!.reservations![actionType];
      saveLedgerAtomic(ledger, ledgerPath);

      const safeId = userId.slice(0, 8);
      console.info(`[ENTITLEMENT] Released free ${actionType} reservation ${reservationId} for user ${safeId}...`);

      return { success: true, message: `Free ${actionType} reservation released successfully` };
    });
  }

  public async checkAndConsumeFreeCredit(
    userId: string,
    actionType: 'rescue' | 'split'
  ): Promise<{
    allowed: boolean;
    status: EntitlementStatus;
    planType: string;
    message: string;
    reservationId?: string;
  }> {
    const res = await this.reserveFreeCredit(userId, actionType);
    if (!res.allowed) {
      return res;
    }
    if (res.status === 'ALLOW_PAID' || res.isPaid) {
      return res;
    }
    if (res.reservationId) {
      await this.commitFreeCredit(userId, actionType, res.reservationId);
    }
    return res;
  }

  public async consumeFreeCredit(
    userId: string,
    actionType: 'rescue' | 'split' = 'rescue'
  ): Promise<{ success: boolean; message: string; actionType: 'rescue' | 'split' }> {
    const user = await authService.getUserById(userId);
    if (!user) {
      return { success: false, message: 'User not found', actionType };
    }

    return this.acquireCrossProcessLock(async () => {
      const ledgerPath = getLedgerPath();
      const ledger = getLedgerSafe(ledgerPath);
      const today = getTodayDateString();

      if (!ledger[userId]) {
        ledger[userId] = {};
      }

      if (actionType === 'split') {
        ledger[userId].splitUsedOn = today;
      } else {
        ledger[userId].rescueUsedOn = today;
      }

      if (ledger[userId].reservations?.[actionType]) {
        delete ledger[userId].reservations![actionType];
      }

      saveLedgerAtomic(ledger, ledgerPath);

      return {
        success: true,
        message: `Free ${actionType} credit consumed successfully`,
        actionType
      };
    });
  }

  public async consumeFreeRescueCredit(userId: string): Promise<{ success: boolean; message: string }> {
    return this.consumeFreeCredit(userId, 'rescue');
  }
}

export const entitlementService = new EntitlementService();
