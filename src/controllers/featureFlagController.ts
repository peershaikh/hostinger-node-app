import { Request, Response } from 'express';
import { featureFlagService, FeatureFlagKey, FeatureFlagState } from '../services/featureFlagService';
import { winstonLogger } from '../middleware/logger';

export class FeatureFlagController {
  /**
   * List all canonical feature flags.
   */
  public getFeatureFlags = async (req: Request, res: Response): Promise<void> => {
    try {
      const flags = featureFlagService.getAllFlags();
      
      const stats = {
        total: flags.length,
        enabled: flags.filter(f => f.state === 'ENABLED').length,
        disabled: flags.filter(f => f.state === 'DISABLED').length,
        emergencyOff: flags.filter(f => f.state === 'EMERGENCY_OFF').length,
        highRisk: flags.filter(f => f.riskLevel === 'HIGH').length
      };

      res.json({
        success: true,
        data: {
          flags,
          stats
        }
      });
    } catch (err: any) {
      winstonLogger.error(`[FEATURE_FLAG_CONTROLLER] Failed to list flags: ${err.message}`);
      res.status(500).json({ success: false, error: 'Internal Server Error' });
    }
  };

  /**
   * Get single feature flag details and history.
   */
  public getFeatureFlag = async (req: Request, res: Response): Promise<void> => {
    try {
      const key = req.params.key as FeatureFlagKey;
      const flag = featureFlagService.getFlag(key);

      if (!flag) {
        res.status(404).json({ success: false, error: `Feature flag '${key}' not found` });
        return;
      }

      const allHistory = featureFlagService.getAuditHistory();
      const flagHistory = allHistory.filter(h => h.key === key);

      res.json({
        success: true,
        data: {
          flag,
          history: flagHistory
        }
      });
    } catch (err: any) {
      winstonLogger.error(`[FEATURE_FLAG_CONTROLLER] Failed to get flag: ${err.message}`);
      res.status(500).json({ success: false, error: 'Internal Server Error' });
    }
  };

  /**
   * Generate impact preview for state update or kill-switch.
   */
  public previewFeatureFlag = async (req: Request, res: Response): Promise<void> => {
    try {
      const { key, targetState, isKillSwitch = false } = req.body;

      if (!key || !targetState) {
        res.status(400).json({ success: false, error: 'Missing required parameters: key and targetState' });
        return;
      }

      const validStates: FeatureFlagState[] = ['ENABLED', 'DISABLED', 'EMERGENCY_OFF'];
      if (!validStates.includes(targetState)) {
        res.status(400).json({ success: false, error: `Invalid targetState: ${targetState}` });
        return;
      }

      const preview = featureFlagService.generatePreview(key as FeatureFlagKey, targetState, Boolean(isKillSwitch));

      res.json({
        success: true,
        data: preview
      });
    } catch (err: any) {
      winstonLogger.warn(`[FEATURE_FLAG_CONTROLLER] Preview error: ${err.message}`);
      res.status(400).json({ success: false, error: err.message });
    }
  };

  /**
   * Standard state change (ENABLED / DISABLED).
   */
  public updateFeatureFlag = async (req: Request, res: Response): Promise<void> => {
    try {
      const key = req.params.key as FeatureFlagKey;
      const { newState, reason } = req.body;

      const adminUser = (req as any).user;
      const adminId = adminUser?.id || 'admin-sys';
      const adminEmail = adminUser?.email || 'admin@trayago.in';

      if (!newState) {
        res.status(400).json({ success: false, error: 'Missing required parameter: newState' });
        return;
      }

      const validStates: FeatureFlagState[] = ['ENABLED', 'DISABLED', 'EMERGENCY_OFF'];
      if (!validStates.includes(newState)) {
        res.status(400).json({ success: false, error: `Invalid newState: ${newState}` });
        return;
      }

      const result = await featureFlagService.updateFlagState(
        key,
        newState,
        adminId,
        adminEmail,
        reason
      );

      res.json({
        success: true,
        message: result.message,
        data: result.flag
      });
    } catch (err: any) {
      winstonLogger.warn(`[FEATURE_FLAG_CONTROLLER] Update error: ${err.message}`);
      res.status(400).json({ success: false, error: err.message });
    }
  };

  /**
   * Emergency Kill Switch with confirmation code.
   */
  public killSwitchFeatureFlag = async (req: Request, res: Response): Promise<void> => {
    try {
      const key = req.params.key as FeatureFlagKey;
      const { confirmationCode, reason } = req.body;

      const adminUser = (req as any).user;
      const adminId = adminUser?.id || 'admin-sys';
      const adminEmail = adminUser?.email || 'admin@trayago.in';

      if (!confirmationCode) {
        res.status(400).json({
          success: false,
          error: `Explicit confirmation code required. Expected: 'KILL-SWITCH-${key}'`
        });
        return;
      }

      if (!reason || !reason.trim()) {
        res.status(400).json({
          success: false,
          error: 'An emergency reason is mandatory to engage kill switch.'
        });
        return;
      }

      const result = await featureFlagService.triggerKillSwitch(
        key,
        confirmationCode,
        adminId,
        adminEmail,
        reason
      );

      res.json({
        success: true,
        message: result.message,
        data: result.flag
      });
    } catch (err: any) {
      winstonLogger.warn(`[FEATURE_FLAG_CONTROLLER] Kill switch error: ${err.message}`);
      res.status(400).json({ success: false, error: err.message });
    }
  };

  /**
   * Rollback feature flag to previous snapshot.
   */
  public rollbackFeatureFlag = async (req: Request, res: Response): Promise<void> => {
    try {
      const key = req.params.key as FeatureFlagKey;
      const { confirmation = true } = req.body;

      const adminUser = (req as any).user;
      const adminId = adminUser?.id || 'admin-sys';
      const adminEmail = adminUser?.email || 'admin@trayago.in';

      const result = await featureFlagService.rollbackFlag(
        key,
        adminId,
        adminEmail,
        Boolean(confirmation)
      );

      res.json({
        success: true,
        message: result.message,
        data: result.flag
      });
    } catch (err: any) {
      winstonLogger.warn(`[FEATURE_FLAG_CONTROLLER] Rollback error: ${err.message}`);
      res.status(400).json({ success: false, error: err.message });
    }
  };

  /**
   * Audit logs of all feature flag operations.
   */
  public getAuditLogs = async (req: Request, res: Response): Promise<void> => {
    try {
      const logs = featureFlagService.getAuditHistory();
      res.json({
        success: true,
        data: logs
      });
    } catch (err: any) {
      winstonLogger.error(`[FEATURE_FLAG_CONTROLLER] Failed to get audit logs: ${err.message}`);
      res.status(500).json({ success: false, error: 'Internal Server Error' });
    }
  };

  /**
   * Public lightweight feature flag health (client accessible, safe subset).
   */
  public getPublicFlags = async (req: Request, res: Response): Promise<void> => {
    try {
      const flags = featureFlagService.getAllFlags();
      const publicSubset = flags.map(f => ({
        key: f.key,
        name: f.name,
        category: f.category,
        enabled: f.state === 'ENABLED',
        state: f.state
      }));

      res.json({
        success: true,
        data: publicSubset
      });
    } catch (err: any) {
      res.status(500).json({ success: false, error: 'Internal Server Error' });
    }
  };
}

export const featureFlagController = new FeatureFlagController();
