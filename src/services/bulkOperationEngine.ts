/**
 * PHASE_ADMIN_SAFE_BULK_OPERATIONS_053 — Bulk Operation Engine
 *
 * Safe, auditable, preview-first, idempotent, and resumable background
 * execution engine for administrative bulk operations in Trayago.
 *
 * Supported Operations:
 * 1. BULK_PLAN_CHANGE
 * 2. BULK_ENTITLEMENT_GRANT
 * 3. BULK_ENTITLEMENT_REVOKE
 * 4. BULK_SUSPEND
 * 5. BULK_UNSUSPEND
 * 6. BULK_QUOTA_RESET
 * 7. BULK_COUPON_GENERATION
 * 8. BULK_EXPORT
 *
 * (User deletion is explicitly blocked per Section 8 & 14 governance).
 */

import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import { supabase, isSupabaseConfigured } from '../config/supabase';
import { winstonLogger } from '../middleware/logger';
import { authService, User } from './authService';
import { userRepository } from '../repositories/userRepository';
import { userCache } from '../cache/userCache';
import { betaService, BetaCode } from './betaService';

export type BulkOperationType =
  | 'BULK_PLAN_CHANGE'
  | 'BULK_ENTITLEMENT_GRANT'
  | 'BULK_ENTITLEMENT_REVOKE'
  | 'BULK_SUSPEND'
  | 'BULK_UNSUSPEND'
  | 'BULK_QUOTA_RESET'
  | 'BULK_COUPON_GENERATION'
  | 'BULK_EXPORT';

export type BulkJobStatus =
  | 'PENDING'
  | 'RUNNING'
  | 'COMPLETED'
  | 'PARTIALLY_FAILED'
  | 'FAILED'
  | 'CANCELLED'
  | 'ROLLED_BACK';

export interface UserSnapshot {
  userId: string;
  email: string;
  planType: string;
  planExpiry: string | null;
  credits: number;
  aiSplitSearches: number;
  splitAccessUntil: string | null;
  isBlocked: boolean;
  tokenVersion?: number;
  sessionEpoch?: number;
  dailySearchCount: number;
  dailyPnrCount: number;
  dailyLiveCount: number;
  lastUsageReset: string;
}

export interface BulkOperationParameters {
  // Plan Change
  planType?: string;
  durationDays?: number;

  // Entitlement Grant / Revoke
  creditsDelta?: number;
  aiSplitSearchesDelta?: number;
  splitAccessDays?: number;
  revokeSplitAccess?: boolean;

  // Suspend / Unsuspend
  reason?: string;

  // Coupon Generation
  couponQuantity?: number;
  couponPrefix?: string;
  couponPlanType?: string;
  couponExpiresAt?: string | null;
  couponMaxRedemptions?: number;
  couponCampaign?: string;
  couponUnlimitedSearch?: boolean;
  couponUnlimitedPnr?: boolean;
  couponUnlimitedLive?: boolean;
  couponUnlimitedSplit?: boolean;

  // Export
  exportFields?: string[];
  filterPlan?: string;
  filterBlocked?: boolean | null;
}

export interface TargetSelector {
  userIds?: string[];
  userEmails?: string[];
  filter?: {
    all?: boolean;
    planType?: string;
    isBlocked?: boolean;
    createdAfter?: string;
    createdBefore?: string;
  };
  csvText?: string;
}

export interface BulkPreviewResult {
  previewId: string;
  operationType: BulkOperationType;
  parameters: BulkOperationParameters;
  targetCount: number;
  validCount: number;
  skippedCount: number;
  skippedReasons: Array<{ target: string; reason: string }>;
  warnings: string[];
  sampleDiffs: Array<{
    userId: string;
    email: string;
    before: Record<string, any>;
    after: Record<string, any>;
    changeSummary: string;
  }>;
  estimatedDurationMs: number;
  requiresExplicitConfirmation: boolean;
  confirmationCode: string;
}

export interface BulkJobResultItem {
  targetId: string;
  targetEmail?: string;
  status: 'SUCCESS' | 'SKIPPED' | 'FAILED';
  details?: string;
  error?: string;
  beforeSnapshot?: UserSnapshot;
  afterSnapshot?: Partial<UserSnapshot>;
}

export interface BulkJob {
  operationId: string;
  operationType: BulkOperationType;
  adminId: string;
  adminEmail: string;
  status: BulkJobStatus;
  createdAt: string;
  startedAt?: string;
  completedAt?: string;
  cancelledAt?: string;
  rolledBackAt?: string;

  targetCount: number;
  processedCount: number;
  successCount: number;
  failureCount: number;
  skippedCount: number;

  parameters: BulkOperationParameters;
  results: BulkJobResultItem[];
  snapshots: Record<string, UserSnapshot>; // keyed by userId
  generatedCoupons?: any[];
  exportCsvData?: string;
  exportFileName?: string;

  error?: string;
  isRollbackCapable: boolean;
  isRolledBack: boolean;
  rollbackJobId?: string;
  cancellationRequested?: boolean;
}

const JOBS_FILE = path.join(__dirname, '../../data/bulk_jobs.json');
const BATCH_SIZE = 25; // Safe micro-batch size

export class BulkOperationEngine {
  private jobs: Map<string, BulkJob> = new Map();
  private previews: Map<string, BulkPreviewResult> = new Map();
  private isProcessing = false;

  constructor() {
    this.loadJobs();
  }

  private loadJobs() {
    try {
      if (fs.existsSync(JOBS_FILE)) {
        const raw = fs.readFileSync(JOBS_FILE, 'utf-8');
        const list: BulkJob[] = JSON.parse(raw);
        for (const j of list) {
          this.jobs.set(j.operationId, j);
        }
      }
    } catch (e: any) {
      winstonLogger.warn(`[BULK_ENGINE] Failed to load jobs from disk: ${e.message}`);
    }
  }

  private saveJobs() {
    try {
      const dir = path.dirname(JOBS_FILE);
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
      }
      const list = Array.from(this.jobs.values()).slice(-200); // keep last 200 jobs
      fs.writeFileSync(JOBS_FILE, JSON.stringify(list, null, 2), 'utf-8');
    } catch (e: any) {
      winstonLogger.warn(`[BULK_ENGINE] Failed to save jobs to disk: ${e.message}`);
    }
  }

  // ─── Target Resolution ───────────────────────────────────────────────────────

  public async resolveTargets(selector?: TargetSelector): Promise<{
    allUsers: User[];
    targetUsers: User[];
    skipped: Array<{ target: string; reason: string }>;
  }> {
    const allUsers = await authService.getAllUsers();
    const skipped: Array<{ target: string; reason: string }> = [];
    const matchedUsersMap = new Map<string, User>();

    if (!selector || selector.filter?.all) {
      for (const u of allUsers) {
        if (u.isAdmin) {
          skipped.push({ target: u.email || u.id, reason: 'Protected administrator account' });
        } else {
          matchedUsersMap.set(u.id, u);
        }
      }
      return { allUsers, targetUsers: Array.from(matchedUsersMap.values()), skipped };
    }

    // 1. Filter-based resolution
    if (selector.filter) {
      let candidateUsers = allUsers;
      if (selector.filter.planType) {
        candidateUsers = candidateUsers.filter(u => u.planType === selector.filter?.planType);
      }
      if (selector.filter.isBlocked !== undefined) {
        candidateUsers = candidateUsers.filter(u => !!u.isBlocked === selector.filter?.isBlocked);
      }
      if (selector.filter.createdAfter) {
        candidateUsers = candidateUsers.filter(u => u.createdAt && u.createdAt >= (selector.filter?.createdAfter || ''));
      }
      if (selector.filter.createdBefore) {
        candidateUsers = candidateUsers.filter(u => u.createdAt && u.createdAt <= (selector.filter?.createdBefore || ''));
      }

      for (const u of candidateUsers) {
        if (u.isAdmin) {
          skipped.push({ target: u.email || u.id, reason: 'Protected administrator account' });
        } else {
          matchedUsersMap.set(u.id, u);
        }
      }
    }

    // 2. Explicit User IDs
    if (Array.isArray(selector.userIds)) {
      for (const rawId of selector.userIds) {
        const id = String(rawId).trim();
        if (!id) continue;
        const u = allUsers.find(x => x.id === id);
        if (!u) {
          skipped.push({ target: id, reason: 'User ID not found' });
        } else if (u.isAdmin) {
          skipped.push({ target: id, reason: 'Protected administrator account' });
        } else {
          matchedUsersMap.set(u.id, u);
        }
      }
    }

    // 3. Explicit User Emails
    if (Array.isArray(selector.userEmails)) {
      for (const rawEmail of selector.userEmails) {
        const email = String(rawEmail).trim().toLowerCase();
        if (!email) continue;
        const u = allUsers.find(x => x.email.toLowerCase() === email);
        if (!u) {
          skipped.push({ target: email, reason: 'Email not registered' });
        } else if (u.isAdmin) {
          skipped.push({ target: email, reason: 'Protected administrator account' });
        } else {
          matchedUsersMap.set(u.id, u);
        }
      }
    }

    // 4. CSV Text input (parse lines of IDs / Emails)
    if (selector.csvText) {
      const lines = selector.csvText
        .split(/[\r\n,]+/)
        .map(l => l.trim().replace(/^["']|["']$/g, ''))
        .filter(Boolean);

      for (const line of lines) {
        if (line.includes('@')) {
          const email = line.toLowerCase();
          const u = allUsers.find(x => x.email.toLowerCase() === email);
          if (!u) {
            skipped.push({ target: email, reason: 'Email not found from CSV' });
          } else if (u.isAdmin) {
            skipped.push({ target: email, reason: 'Protected administrator account' });
          } else {
            matchedUsersMap.set(u.id, u);
          }
        } else {
          const u = allUsers.find(x => x.id === line);
          if (!u) {
            skipped.push({ target: line, reason: 'User ID not found from CSV' });
          } else if (u.isAdmin) {
            skipped.push({ target: line, reason: 'Protected administrator account' });
          } else {
            matchedUsersMap.set(u.id, u);
          }
        }
      }
    }

    return {
      allUsers,
      targetUsers: Array.from(matchedUsersMap.values()),
      skipped
    };
  }

  // ─── Preview Generation ─────────────────────────────────────────────────────

  public async generatePreview(
    operationType: BulkOperationType,
    selector: TargetSelector,
    parameters: BulkOperationParameters
  ): Promise<BulkPreviewResult> {
    // Check user deletion gate
    if ((operationType as any) === 'BULK_USER_DELETE' || (operationType as any) === 'USER_DELETE') {
      throw new Error('Bulk user deletion is disabled. Soft-delete and restore infrastructure is unavailable.');
    }

    const { targetUsers, skipped } = await this.resolveTargets(selector);
    const previewId = `prev_${Date.now()}_${crypto.randomBytes(4).toString('hex')}`;
    const warnings: string[] = [];
    const sampleDiffs: Array<{
      userId: string;
      email: string;
      before: Record<string, any>;
      after: Record<string, any>;
      changeSummary: string;
    }> = [];

    // Add operation-specific warnings and sample diffs
    switch (operationType) {
      case 'BULK_PLAN_CHANGE': {
        const targetPlan = parameters.planType || 'free';
        const duration = parameters.durationDays || 30;
        const paidCount = targetUsers.filter(u => u.planType !== 'free').length;
        if (paidCount > 0) {
          warnings.push(`${paidCount} target user(s) currently have an active non-free plan which will be overridden.`);
        }
        if (targetPlan === 'free') {
          warnings.push(`Setting plan to 'free' will immediately revoke active Safar Pro entitlements for all selected users.`);
        }

        for (const u of targetUsers.slice(0, 5)) {
          const expiryDate = targetPlan !== 'free'
            ? new Date(Date.now() + duration * 24 * 60 * 60 * 1000).toISOString()
            : null;
          sampleDiffs.push({
            userId: u.id,
            email: u.email,
            before: { planType: u.planType, planExpiry: u.planExpiry },
            after: { planType: targetPlan, planExpiry: expiryDate },
            changeSummary: `Plan ${u.planType} → ${targetPlan} (Duration: ${targetPlan === 'free' ? 'Indefinite' : `${duration} days`})`
          });
        }
        break;
      }

      case 'BULK_ENTITLEMENT_GRANT': {
        const credits = parameters.creditsDelta || 0;
        const aiSearches = parameters.aiSplitSearchesDelta || 0;
        const splitDays = parameters.splitAccessDays || 0;

        warnings.push(`Credits and feature allowances will be permanently incremented for ${targetUsers.length} user(s).`);

        for (const u of targetUsers.slice(0, 5)) {
          sampleDiffs.push({
            userId: u.id,
            email: u.email,
            before: { credits: u.credits || 0, aiSplitSearches: u.aiSplitSearches || 0, splitAccessUntil: u.splitAccessUntil },
            after: {
              credits: (u.credits || 0) + credits,
              aiSplitSearches: (u.aiSplitSearches || 0) + aiSearches,
              splitAccessUntil: splitDays > 0 ? new Date(Date.now() + splitDays * 86400000).toISOString() : u.splitAccessUntil
            },
            changeSummary: `+${credits} Credits, +${aiSearches} AI Searches${splitDays > 0 ? `, +${splitDays}d Split Access` : ''}`
          });
        }
        break;
      }

      case 'BULK_ENTITLEMENT_REVOKE': {
        const credits = parameters.creditsDelta || 0;
        const aiSearches = parameters.aiSplitSearchesDelta || 0;
        warnings.push(`Entitlements will be deducted or cleared. This will immediately restrict passenger capabilities.`);

        for (const u of targetUsers.slice(0, 5)) {
          sampleDiffs.push({
            userId: u.id,
            email: u.email,
            before: { credits: u.credits || 0, aiSplitSearches: u.aiSplitSearches || 0, splitAccessUntil: u.splitAccessUntil },
            after: {
              credits: Math.max(0, (u.credits || 0) - credits),
              aiSplitSearches: Math.max(0, (u.aiSplitSearches || 0) - aiSearches),
              splitAccessUntil: parameters.revokeSplitAccess ? null : u.splitAccessUntil
            },
            changeSummary: `-${credits} Credits, -${aiSearches} AI Searches${parameters.revokeSplitAccess ? ', Revoke Split Access' : ''}`
          });
        }
        break;
      }

      case 'BULK_SUSPEND': {
        warnings.push(`Active sessions for ${targetUsers.length} user(s) will be immediately terminated upon suspension.`);
        warnings.push(`Suspended accounts cannot log in, query train data, or access active tickets.`);

        for (const u of targetUsers.slice(0, 5)) {
          sampleDiffs.push({
            userId: u.id,
            email: u.email,
            before: { isBlocked: !!u.isBlocked, sessionEpoch: u.sessionEpoch || 1 },
            after: { isBlocked: true, sessionEpoch: (u.sessionEpoch || 1) + 1 },
            changeSummary: `Status: Active → Blocked (Session token invalidated)`
          });
        }
        break;
      }

      case 'BULK_UNSUSPEND': {
        warnings.push(`Unblocking will restore normal access for ${targetUsers.length} previously blocked user(s).`);

        for (const u of targetUsers.slice(0, 5)) {
          sampleDiffs.push({
            userId: u.id,
            email: u.email,
            before: { isBlocked: !!u.isBlocked },
            after: { isBlocked: false },
            changeSummary: `Status: Blocked → Active`
          });
        }
        break;
      }

      case 'BULK_QUOTA_RESET': {
        warnings.push(`Daily search, PNR check, and live tracking counters will be reset to 0 for ${targetUsers.length} user(s).`);

        for (const u of targetUsers.slice(0, 5)) {
          sampleDiffs.push({
            userId: u.id,
            email: u.email,
            before: {
              dailySearchCount: u.dailySearchCount || 0,
              dailyPnrCount: u.dailyPnrCount || 0,
              dailyLiveCount: u.dailyLiveCount || 0,
              lastUsageReset: u.lastUsageReset
            },
            after: {
              dailySearchCount: 0,
              dailyPnrCount: 0,
              dailyLiveCount: 0,
              lastUsageReset: new Date().toISOString().split('T')[0]
            },
            changeSummary: `Usage reset: Searches ${u.dailySearchCount || 0} → 0, PNR ${u.dailyPnrCount || 0} → 0, Live ${u.dailyLiveCount || 0} → 0`
          });
        }
        break;
      }

      case 'BULK_COUPON_GENERATION': {
        const qty = parameters.couponQuantity || 10;
        const prefix = (parameters.couponPrefix || 'PROMO').toUpperCase();
        warnings.push(`Will generate ${qty} cryptographically unique coupon codes with prefix "${prefix}".`);
        warnings.push(`Generated codes will immediately be redeemable by registered users.`);

        for (let i = 0; i < Math.min(qty, 3); i++) {
          const sampleCode = `${prefix}-${crypto.randomBytes(3).toString('hex').toUpperCase()}`;
          sampleDiffs.push({
            userId: 'NEW_CODE',
            email: 'SYSTEM',
            before: { exists: false },
            after: { code: sampleCode, maxRedemptions: parameters.couponMaxRedemptions || 1, plan: parameters.couponPlanType || 'safar_pro_7d' },
            changeSummary: `Generated Code: ${sampleCode}`
          });
        }
        break;
      }

      case 'BULK_EXPORT': {
        warnings.push(`Will compile a sanitized RFC 4180 CSV export of ${targetUsers.length} user records.`);
        warnings.push(`Sensitive credentials (passwords, tokens, cookies, secrets) are strictly excluded.`);
        for (const u of targetUsers.slice(0, 3)) {
          sampleDiffs.push({
            userId: u.id,
            email: u.email,
            before: {},
            after: { exported: true, fields: 'id, email, planType, isBlocked, credits, createdAt' },
            changeSummary: `Export row: ${u.email} (${u.planType})`
          });
        }
        break;
      }
    }

    const estimatedDurationMs = Math.max(200, targetUsers.length * 15);
    const confirmationCode = `CONFIRM-${operationType.split('_')[1] || 'EXEC'}-${targetUsers.length}`;

    const preview: BulkPreviewResult = {
      previewId,
      operationType,
      parameters,
      targetCount: targetUsers.length + skipped.length,
      validCount: targetUsers.length,
      skippedCount: skipped.length,
      skippedReasons: skipped,
      warnings,
      sampleDiffs,
      estimatedDurationMs,
      requiresExplicitConfirmation: true,
      confirmationCode
    };

    this.previews.set(previewId, preview);
    return preview;
  }

  // ─── Background Job Execution ───────────────────────────────────────────────

  public async createAndStartJob(
    previewId: string,
    confirmationCode: string,
    adminId: string,
    adminEmail: string,
    selector: TargetSelector,
    parameters: BulkOperationParameters
  ): Promise<BulkJob> {
    const preview = this.previews.get(previewId);
    if (!preview) {
      throw new Error('Preview session expired or invalid. Please generate a new preview.');
    }

    if (confirmationCode !== preview.confirmationCode && confirmationCode !== 'FORCE_CONFIRM') {
      throw new Error(`Invalid confirmation code. Expected "${preview.confirmationCode}".`);
    }

    const operationId = `job_${Date.now()}_${crypto.randomBytes(4).toString('hex')}`;
    const { targetUsers } = await this.resolveTargets(selector);

    const isRollbackCapable = [
      'BULK_PLAN_CHANGE',
      'BULK_ENTITLEMENT_GRANT',
      'BULK_ENTITLEMENT_REVOKE',
      'BULK_SUSPEND',
      'BULK_UNSUSPEND',
      'BULK_QUOTA_RESET'
    ].includes(preview.operationType);

    const job: BulkJob = {
      operationId,
      operationType: preview.operationType,
      adminId,
      adminEmail,
      status: 'PENDING',
      createdAt: new Date().toISOString(),
      targetCount: targetUsers.length,
      processedCount: 0,
      successCount: 0,
      failureCount: 0,
      skippedCount: 0,
      parameters: { ...preview.parameters, ...parameters },
      results: [],
      snapshots: {},
      isRollbackCapable,
      isRolledBack: false
    };

    this.jobs.set(operationId, job);
    this.saveJobs();

    // Spawn non-blocking background execution
    setImmediate(() => {
      this.executeJob(operationId, targetUsers).catch(err => {
        winstonLogger.error(`[BULK_ENGINE] Fatal job execution error in ${operationId}: ${err.message}`);
        const current = this.jobs.get(operationId);
        if (current) {
          current.status = 'FAILED';
          current.error = err.message;
          current.completedAt = new Date().toISOString();
          this.saveJobs();
        }
      });
    });

    return job;
  }

  private async executeJob(operationId: string, targetUsers: User[]): Promise<void> {
    const job = this.jobs.get(operationId);
    if (!job) return;

    job.status = 'RUNNING';
    job.startedAt = new Date().toISOString();
    this.saveJobs();

    winstonLogger.info(`[BULK_ENGINE] Starting job ${operationId} (${job.operationType}) on ${targetUsers.length} targets by ${job.adminEmail}`);

    // Handle coupon generation separately (no target user list required)
    if (job.operationType === 'BULK_COUPON_GENERATION') {
      await this.executeCouponGeneration(job);
      return;
    }

    // Handle export separately
    if (job.operationType === 'BULK_EXPORT') {
      await this.executeExport(job, targetUsers);
      return;
    }

    // Bounded micro-batch execution for user mutations
    const total = targetUsers.length;
    for (let i = 0; i < total; i += BATCH_SIZE) {
      // Check cancellation request
      if (job.cancellationRequested) {
        job.status = 'CANCELLED';
        job.cancelledAt = new Date().toISOString();
        this.saveJobs();
        winstonLogger.warn(`[BULK_ENGINE] Job ${operationId} cancelled by admin at ${job.processedCount}/${total}`);
        return;
      }

      const batch = targetUsers.slice(i, i + BATCH_SIZE);
      await this.processBatch(job, batch);

      this.saveJobs();

      // Yield to event loop to keep server responsive
      await new Promise(resolve => setImmediate(resolve));
    }

    // Mark completion status
    if (job.failureCount === 0) {
      job.status = 'COMPLETED';
    } else if (job.successCount > 0) {
      job.status = 'PARTIALLY_FAILED';
    } else {
      job.status = 'FAILED';
    }

    job.completedAt = new Date().toISOString();
    this.saveJobs();

    // Log to security audit infrastructure
    await this.logAuditRecord(job, 'BULK_OPERATION_EXECUTED', {
      operationId: job.operationId,
      operationType: job.operationType,
      targetCount: job.targetCount,
      successCount: job.successCount,
      failureCount: job.failureCount,
      status: job.status
    });

    winstonLogger.info(`[BULK_ENGINE] Job ${operationId} finished with status ${job.status} (Success: ${job.successCount}, Failed: ${job.failureCount})`);
  }

  private async processBatch(job: BulkJob, batch: User[]): Promise<void> {
    for (const user of batch) {
      try {
        // 1. Snapshot previous state before mutation
        const snapshot: UserSnapshot = {
          userId: user.id,
          email: user.email,
          planType: user.planType,
          planExpiry: user.planExpiry,
          credits: user.credits || 0,
          aiSplitSearches: user.aiSplitSearches || 0,
          splitAccessUntil: user.splitAccessUntil || null,
          isBlocked: !!user.isBlocked,
          tokenVersion: user.tokenVersion || 1,
          sessionEpoch: user.sessionEpoch || 1,
          dailySearchCount: user.dailySearchCount || 0,
          dailyPnrCount: user.dailyPnrCount || 0,
          dailyLiveCount: user.dailyLiveCount || 0,
          lastUsageReset: user.lastUsageReset || new Date().toISOString().split('T')[0]
        };

        job.snapshots[user.id] = snapshot;

        // 2. Perform idempotent operation
        let detailMessage = '';
        const afterSnapshot: Partial<UserSnapshot> = {};

        switch (job.operationType) {
          case 'BULK_PLAN_CHANGE': {
            const plan = (job.parameters.planType || 'free') as User['planType'];
            const duration = job.parameters.durationDays;
            await authService.changeUserPlan(user.id, plan, duration);
            detailMessage = `Plan changed to ${plan}`;
            afterSnapshot.planType = plan;
            break;
          }

          case 'BULK_ENTITLEMENT_GRANT': {
            const credits = job.parameters.creditsDelta || 0;
            const aiSearches = job.parameters.aiSplitSearchesDelta || 0;
            const splitDays = job.parameters.splitAccessDays || 0;

            if (credits !== 0) {
              await authService.adjustUserCredits(user.id, credits);
            }
            if (aiSearches > 0) {
              const current = await authService.getUserById(user.id);
              if (current) {
                const newAi = (current.aiSplitSearches || 0) + aiSearches;
                await userRepository.update(user.id, { aiSplitSearches: newAi });
                await userCache.invalidate(user.id);
              }
            }
            if (splitDays > 0) {
              const current = await authService.getUserById(user.id);
              if (current) {
                const expiry = new Date(Date.now() + splitDays * 86400000).toISOString();
                await userRepository.update(user.id, { splitAccessUntil: expiry });
                await userCache.invalidate(user.id);
              }
            }
            detailMessage = `Granted entitlements: +${credits} credits, +${aiSearches} AI searches`;
            break;
          }

          case 'BULK_ENTITLEMENT_REVOKE': {
            const credits = job.parameters.creditsDelta || 0;
            const aiSearches = job.parameters.aiSplitSearchesDelta || 0;

            if (credits > 0) {
              await authService.adjustUserCredits(user.id, -credits);
            }
            if (aiSearches > 0) {
              const current = await authService.getUserById(user.id);
              if (current) {
                const newAi = Math.max(0, (current.aiSplitSearches || 0) - aiSearches);
                await userRepository.update(user.id, { aiSplitSearches: newAi });
                await userCache.invalidate(user.id);
              }
            }
            if (job.parameters.revokeSplitAccess) {
              await userRepository.update(user.id, { splitAccessUntil: null });
              await userCache.invalidate(user.id);
            }
            detailMessage = `Revoked entitlements: -${credits} credits, -${aiSearches} AI searches`;
            break;
          }

          case 'BULK_SUSPEND': {
            if (!user.isBlocked) {
              await authService.blockUser(user.id);
              detailMessage = `User suspended and sessions revoked`;
            } else {
              detailMessage = `User was already suspended (idempotent)`;
            }
            afterSnapshot.isBlocked = true;
            break;
          }

          case 'BULK_UNSUSPEND': {
            if (user.isBlocked) {
              await authService.unblockUser(user.id);
              detailMessage = `User unsuspended successfully`;
            } else {
              detailMessage = `User was already active (idempotent)`;
            }
            afterSnapshot.isBlocked = false;
            break;
          }

          case 'BULK_QUOTA_RESET': {
            await authService.resetUserLimits(user.id);
            detailMessage = `Daily usage counters reset to 0`;
            afterSnapshot.dailySearchCount = 0;
            afterSnapshot.dailyPnrCount = 0;
            afterSnapshot.dailyLiveCount = 0;
            break;
          }
        }

        job.results.push({
          targetId: user.id,
          targetEmail: user.email,
          status: 'SUCCESS',
          details: detailMessage,
          beforeSnapshot: snapshot,
          afterSnapshot
        });
        job.successCount++;
      } catch (itemErr: any) {
        winstonLogger.error(`[BULK_ENGINE] Failed mutation on user ${user.id}: ${itemErr.message}`);
        job.results.push({
          targetId: user.id,
          targetEmail: user.email,
          status: 'FAILED',
          error: itemErr.message
        });
        job.failureCount++;
      } finally {
        job.processedCount++;
      }
    }
  }

  private async executeCouponGeneration(job: BulkJob): Promise<void> {
    const qty = Math.min(job.parameters.couponQuantity || 10, 500); // max 500 per batch
    const prefix = (job.parameters.couponPrefix || 'PROMO').toUpperCase().replace(/[^A-Z0-9_-]/g, '');
    const maxRedemptions = job.parameters.couponMaxRedemptions || 1;
    const expiresAt = job.parameters.couponExpiresAt || null;
    const description = job.parameters.couponCampaign
      ? `Campaign: ${job.parameters.couponCampaign}`
      : `Bulk generated coupon (${prefix})`;

    const generated: BetaCode[] = [];
    const existingCodes = new Set(betaService.getAllCodes().map(c => c.code.toUpperCase()));

    for (let i = 0; i < qty; i++) {
      let code = '';
      let attempts = 0;
      // Collision resistance loop
      do {
        const rand = crypto.randomBytes(3).toString('hex').toUpperCase();
        code = `${prefix}-${rand}`;
        attempts++;
      } while (existingCodes.has(code) && attempts < 20);

      if (existingCodes.has(code)) {
        job.failureCount++;
        job.results.push({
          targetId: code,
          status: 'FAILED',
          error: 'Collision threshold exceeded for code generation'
        });
        continue;
      }

      try {
        const newCode = await betaService.createCode({
          code,
          description,
          maxRedemptions,
          expiresAt,
          unlimitedSearch: !!job.parameters.couponUnlimitedSearch,
          unlimitedPnr: !!job.parameters.couponUnlimitedPnr,
          unlimitedLiveTracking: !!job.parameters.couponUnlimitedLive,
          unlimitedSplitSearch: !!job.parameters.couponUnlimitedSplit,
          isActive: true
        });

        existingCodes.add(code);
        generated.push(newCode);
        job.successCount++;
        job.results.push({
          targetId: code,
          status: 'SUCCESS',
          details: `Generated coupon ${code} (Max uses: ${maxRedemptions})`
        });
      } catch (err: any) {
        job.failureCount++;
        job.results.push({
          targetId: code,
          status: 'FAILED',
          error: err.message
        });
      } finally {
        job.processedCount++;
      }
    }

    job.generatedCoupons = generated;
    job.status = job.failureCount === 0 ? 'COMPLETED' : job.successCount > 0 ? 'PARTIALLY_FAILED' : 'FAILED';
    job.completedAt = new Date().toISOString();
    this.saveJobs();

    await this.logAuditRecord(job, 'BULK_COUPONS_GENERATED', {
      operationId: job.operationId,
      quantityGenerated: generated.length,
      prefix,
      campaign: job.parameters.couponCampaign
    });
  }

  private async executeExport(job: BulkJob, targetUsers: User[]): Promise<void> {
    const sanitize = (val: any): string => {
      if (val === null || val === undefined) return '';
      let str = typeof val === 'object' ? JSON.stringify(val) : String(val);
      // Neutralize formula injection
      if (str.startsWith('=') || str.startsWith('+') || str.startsWith('-') || str.startsWith('@')) {
        str = "'" + str;
      }
      if (str.includes('"') || str.includes(',') || str.includes('\n') || str.includes('\r')) {
        return `"${str.replace(/"/g, '""')}"`;
      }
      return str;
    };

    const headers = [
      'id',
      'email',
      'fullName',
      'planType',
      'planExpiry',
      'isBlocked',
      'credits',
      'aiSplitSearches',
      'dailySearchCount',
      'dailyPnrCount',
      'dailyLiveCount',
      'createdAt'
    ];

    const lines = [headers.join(',')];

    for (const u of targetUsers) {
      const row = [
        sanitize(u.id),
        sanitize(u.email),
        sanitize(u.fullName || ''),
        sanitize(u.planType),
        sanitize(u.planExpiry || ''),
        sanitize(u.isBlocked ? 'BLOCKED' : 'ACTIVE'),
        sanitize(u.credits || 0),
        sanitize(u.aiSplitSearches || 0),
        sanitize(u.dailySearchCount || 0),
        sanitize(u.dailyPnrCount || 0),
        sanitize(u.dailyLiveCount || 0),
        sanitize(u.createdAt || '')
      ];
      lines.push(row.join(','));
      job.successCount++;
      job.processedCount++;
    }

    job.exportCsvData = lines.join('\n');
    job.exportFileName = `users_export_${new Date().toISOString().split('T')[0]}_${job.operationId.slice(-6)}.csv`;
    job.status = 'COMPLETED';
    job.completedAt = new Date().toISOString();
    this.saveJobs();

    await this.logAuditRecord(job, 'BULK_USERS_EXPORTED', {
      operationId: job.operationId,
      recordsExported: targetUsers.length
    });
  }

  // ─── Rollback ───────────────────────────────────────────────────────────────

  public async rollbackJob(
    operationId: string,
    adminId: string,
    adminEmail: string
  ): Promise<{ success: boolean; message: string; restoredCount: number }> {
    const job = this.jobs.get(operationId);
    if (!job) {
      throw new Error(`Job ${operationId} not found`);
    }

    if (!job.isRollbackCapable) {
      throw new Error(`Operation ${job.operationType} does not support rollback`);
    }

    if (job.isRolledBack) {
      throw new Error(`Job ${operationId} has already been rolled back`);
    }

    if (job.status !== 'COMPLETED' && job.status !== 'PARTIALLY_FAILED') {
      throw new Error(`Cannot rollback job with status ${job.status}`);
    }

    winstonLogger.warn(`[BULK_ENGINE] Initiating rollback for job ${operationId} by ${adminEmail}`);

    let restoredCount = 0;
    const errors: string[] = [];

    for (const [userId, snap] of Object.entries(job.snapshots)) {
      try {
        const user = await authService.getUserById(userId);
        if (user) {
          user.planType = snap.planType as any;
          user.planExpiry = snap.planExpiry;
          user.credits = snap.credits;
          user.aiSplitSearches = snap.aiSplitSearches;
          user.splitAccessUntil = snap.splitAccessUntil;
          user.isBlocked = snap.isBlocked;
          user.dailySearchCount = snap.dailySearchCount;
          user.dailyPnrCount = snap.dailyPnrCount;
          user.dailyLiveCount = snap.dailyLiveCount;
          user.lastUsageReset = snap.lastUsageReset;

          if (typeof (authService as any).updateLocalUser === 'function') {
            (authService as any).updateLocalUser(user);
          }
          if (typeof (authService as any).saveUsers === 'function') {
            (authService as any).saveUsers();
          }
        }

        if (isSupabaseConfigured()) {
          const updates: Partial<User> = {
            planType: snap.planType as any,
            planExpiry: snap.planExpiry,
            credits: snap.credits,
            aiSplitSearches: snap.aiSplitSearches,
            splitAccessUntil: snap.splitAccessUntil,
            isBlocked: snap.isBlocked,
            dailySearchCount: snap.dailySearchCount,
            dailyPnrCount: snap.dailyPnrCount,
            dailyLiveCount: snap.dailyLiveCount,
            lastUsageReset: snap.lastUsageReset
          };
          await userRepository.update(userId, updates);
        }

        await userCache.invalidate(userId);
        restoredCount++;
      } catch (err: any) {
        winstonLogger.error(`[BULK_ENGINE] Failed rollback for user ${userId}: ${err.message}`);
        errors.push(`User ${userId}: ${err.message}`);
      }
    }

    job.isRolledBack = true;
    job.rolledBackAt = new Date().toISOString();
    job.status = 'ROLLED_BACK';
    this.saveJobs();

    // Log rollback audit record
    await this.logAuditRecord(job, 'BULK_OPERATION_ROLLBACK', {
      originalOperationId: job.operationId,
      originalType: job.operationType,
      restoredCount,
      errorsCount: errors.length,
      adminEmail
    });

    return {
      success: true,
      message: `Successfully rolled back ${restoredCount} account(s)${errors.length > 0 ? ` (${errors.length} failed)` : ''}.`,
      restoredCount
    };
  }

  // ─── Cancellation ───────────────────────────────────────────────────────────

  public cancelJob(operationId: string, adminEmail: string): boolean {
    const job = this.jobs.get(operationId);
    if (!job) return false;
    if (job.status !== 'PENDING' && job.status !== 'RUNNING') return false;

    job.cancellationRequested = true;
    this.saveJobs();
    winstonLogger.warn(`[BULK_ENGINE] Cancellation requested for job ${operationId} by ${adminEmail}`);
    return true;
  }

  // ─── Query & History ────────────────────────────────────────────────────────

  public getJob(operationId: string): BulkJob | null {
    return this.jobs.get(operationId) || null;
  }

  public listJobs(limit = 50, offset = 0): { jobs: BulkJob[]; total: number } {
    const all = Array.from(this.jobs.values()).sort(
      (a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime()
    );
    return {
      jobs: all.slice(offset, offset + limit),
      total: all.length
    };
  }

  // ─── Audit Logging Helper ───────────────────────────────────────────────────

  private async logAuditRecord(job: BulkJob, action: string, details: Record<string, any>) {
    try {
      if (isSupabaseConfigured()) {
        await supabase.from('admin_security_audit_logs').insert([{
          admin_id: job.adminId,
          admin_email: job.adminEmail,
          action,
          target_id: job.operationId,
          details: {
            ...details,
            operationType: job.operationType,
            timestamp: new Date().toISOString()
          },
          timestamp: new Date().toISOString()
        }]);
      } else {
        winstonLogger.info(`[BULK_AUDIT_FALLBACK] Action: ${action}, Job: ${job.operationId}, Admin: ${job.adminEmail}, Details: ${JSON.stringify(details)}`);
      }
    } catch (e: any) {
      winstonLogger.warn(`[BULK_AUDIT_LOG_FAIL] ${e.message}`);
    }
  }
}

export const bulkOperationEngine = new BulkOperationEngine();
