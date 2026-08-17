/**
 * PHASE_ADMIN_SAFE_BULK_OPERATIONS_053 — Bulk Admin Controller
 *
 * Handles HTTP requests for previewing, executing, monitoring, and rolling back
 * bulk administrative operations.
 */

import { Request, Response } from 'express';
import { bulkOperationEngine, BulkOperationType } from '../services/bulkOperationEngine';
import { authService } from '../services/authService';
import { winstonLogger } from '../middleware/logger';

export class BulkAdminController {
  // ─── Preview Endpoint ───────────────────────────────────────────────────────
  async preview(req: Request, res: Response) {
    try {
      const { operationType, selector, parameters } = req.body;

      if (!operationType) {
        return res.status(400).json({ success: false, error: 'Operation type is required.' });
      }

      // Explicit Governance: Block permanent user deletion
      if (operationType === 'BULK_USER_DELETE' || operationType === 'USER_DELETE') {
        return res.status(400).json({
          success: false,
          error: 'Bulk user deletion is disabled. Soft-delete and restore infrastructure is not available.',
          deleteStatus: 'NOT_READY'
        });
      }

      const validOps: BulkOperationType[] = [
        'BULK_PLAN_CHANGE',
        'BULK_ENTITLEMENT_GRANT',
        'BULK_ENTITLEMENT_REVOKE',
        'BULK_SUSPEND',
        'BULK_UNSUSPEND',
        'BULK_QUOTA_RESET',
        'BULK_COUPON_GENERATION',
        'BULK_EXPORT'
      ];

      if (!validOps.includes(operationType)) {
        return res.status(400).json({ success: false, error: `Unsupported bulk operation type: ${operationType}` });
      }

      const preview = await bulkOperationEngine.generatePreview(
        operationType,
        selector || {},
        parameters || {}
      );

      res.status(200).json({
        success: true,
        data: preview
      });
    } catch (err: any) {
      winstonLogger.error(`[BULK_API_PREVIEW_ERR] ${err.message}`);
      res.status(400).json({ success: false, error: err.message || 'Failed to generate preview.' });
    }
  }

  // ─── Execute Endpoint ───────────────────────────────────────────────────────
  async execute(req: Request, res: Response) {
    try {
      const { previewId, confirmationCode, selector, parameters } = req.body;

      if (!previewId || !confirmationCode) {
        return res.status(400).json({
          success: false,
          error: 'Preview ID and explicit confirmation code are required.'
        });
      }

      const adminId = (req as any).user?.id || req.headers['x-user-id'] as string || 'unknown-admin';
      const adminUser = await authService.getUserById(adminId);
      const adminEmail = adminUser?.email || (req as any).user?.email || 'admin@trayago.in';

      const job = await bulkOperationEngine.createAndStartJob(
        previewId,
        confirmationCode,
        adminId,
        adminEmail,
        selector || {},
        parameters || {}
      );

      res.status(202).json({
        success: true,
        message: 'Bulk operation job created and started in background.',
        data: {
          operationId: job.operationId,
          operationType: job.operationType,
          status: job.status,
          targetCount: job.targetCount,
          createdAt: job.createdAt
        }
      });
    } catch (err: any) {
      winstonLogger.error(`[BULK_API_EXECUTE_ERR] ${err.message}`);
      res.status(400).json({ success: false, error: err.message || 'Failed to start bulk operation job.' });
    }
  }

  // ─── List Jobs Endpoint ─────────────────────────────────────────────────────
  async listJobs(req: Request, res: Response) {
    try {
      const limit = parseInt(req.query.limit as string || '20', 10);
      const offset = parseInt(req.query.offset as string || '0', 10);

      const result = bulkOperationEngine.listJobs(limit, offset);

      const safeJobs = result.jobs.map(j => ({
        operationId: j.operationId,
        operationType: j.operationType,
        adminEmail: j.adminEmail,
        status: j.status,
        createdAt: j.createdAt,
        startedAt: j.startedAt,
        completedAt: j.completedAt,
        targetCount: j.targetCount,
        processedCount: j.processedCount,
        successCount: j.successCount,
        failureCount: j.failureCount,
        skippedCount: j.skippedCount,
        isRollbackCapable: j.isRollbackCapable,
        isRolledBack: j.isRolledBack,
        error: j.error
      }));

      res.status(200).json({
        success: true,
        data: safeJobs,
        pagination: {
          total: result.total,
          limit,
          offset
        }
      });
    } catch (err: any) {
      winstonLogger.error(`[BULK_API_LIST_ERR] ${err.message}`);
      res.status(500).json({ success: false, error: 'Failed to list bulk jobs.' });
    }
  }

  // ─── Get Job Status Endpoint ────────────────────────────────────────────────
  async getJob(req: Request, res: Response) {
    try {
      const { id } = req.params;
      const job = bulkOperationEngine.getJob(id);

      if (!job) {
        return res.status(404).json({ success: false, error: 'Bulk job not found.' });
      }

      res.status(200).json({
        success: true,
        data: {
          operationId: job.operationId,
          operationType: job.operationType,
          adminEmail: job.adminEmail,
          status: job.status,
          createdAt: job.createdAt,
          startedAt: job.startedAt,
          completedAt: job.completedAt,
          cancelledAt: job.cancelledAt,
          rolledBackAt: job.rolledBackAt,
          targetCount: job.targetCount,
          processedCount: job.processedCount,
          successCount: job.successCount,
          failureCount: job.failureCount,
          skippedCount: job.skippedCount,
          parameters: job.parameters,
          results: job.results.slice(0, 100), // return up to 100 result items
          hasExportData: !!job.exportCsvData,
          exportFileName: job.exportFileName,
          generatedCoupons: job.generatedCoupons?.slice(0, 50),
          isRollbackCapable: job.isRollbackCapable,
          isRolledBack: job.isRolledBack,
          error: job.error
        }
      });
    } catch (err: any) {
      winstonLogger.error(`[BULK_API_GET_ERR] ${err.message}`);
      res.status(500).json({ success: false, error: 'Failed to get job details.' });
    }
  }

  // ─── Cancel Job Endpoint ────────────────────────────────────────────────────
  async cancelJob(req: Request, res: Response) {
    try {
      const { id } = req.params;
      const adminEmail = (req as any).user?.email || 'admin@trayago.in';

      const success = bulkOperationEngine.cancelJob(id, adminEmail);
      if (!success) {
        return res.status(400).json({
          success: false,
          error: 'Job could not be cancelled. It may already be completed, cancelled, or does not exist.'
        });
      }

      res.status(200).json({
        success: true,
        message: `Cancellation requested for job ${id}.`
      });
    } catch (err: any) {
      winstonLogger.error(`[BULK_API_CANCEL_ERR] ${err.message}`);
      res.status(500).json({ success: false, error: 'Failed to cancel job.' });
    }
  }

  // ─── Rollback Job Endpoint ──────────────────────────────────────────────────
  async rollbackJob(req: Request, res: Response) {
    try {
      const { id } = req.params;
      const adminId = (req as any).user?.id || req.headers['x-user-id'] as string || 'unknown-admin';
      const adminUser = await authService.getUserById(adminId);
      const adminEmail = adminUser?.email || (req as any).user?.email || 'admin@trayago.in';

      const result = await bulkOperationEngine.rollbackJob(id, adminId, adminEmail);

      res.status(200).json({
        success: true,
        message: result.message,
        data: result
      });
    } catch (err: any) {
      winstonLogger.error(`[BULK_API_ROLLBACK_ERR] ${err.message}`);
      res.status(400).json({ success: false, error: err.message || 'Rollback failed.' });
    }
  }

  // ─── Export Result CSV Endpoint ─────────────────────────────────────────────
  async exportResult(req: Request, res: Response) {
    try {
      const { id } = req.params;
      const job = bulkOperationEngine.getJob(id);

      if (!job) {
        return res.status(404).json({ success: false, error: 'Job not found.' });
      }

      if (job.exportCsvData) {
        res.setHeader('Content-Type', 'text/csv');
        res.setHeader('Content-Disposition', `attachment; filename="${job.exportFileName || `export_${id}.csv`}"`);
        return res.send(job.exportCsvData);
      }

      // Generate results summary CSV for other job types
      const lines = ['targetId,targetEmail,status,details,error'];
      for (const r of job.results) {
        const row = [
          `"${(r.targetId || '').replace(/"/g, '""')}"`,
          `"${(r.targetEmail || '').replace(/"/g, '""')}"`,
          `"${(r.status || '').replace(/"/g, '""')}"`,
          `"${(r.details || '').replace(/"/g, '""')}"`,
          `"${(r.error || '').replace(/"/g, '""')}"`
        ];
        lines.push(row.join(','));
      }

      res.setHeader('Content-Type', 'text/csv');
      res.setHeader('Content-Disposition', `attachment; filename="bulk_job_${id}_results.csv"`);
      res.send(lines.join('\n'));
    } catch (err: any) {
      winstonLogger.error(`[BULK_API_EXPORT_ERR] ${err.message}`);
      res.status(500).json({ success: false, error: 'Failed to export job results.' });
    }
  }
}

export const bulkAdminController = new BulkAdminController();
