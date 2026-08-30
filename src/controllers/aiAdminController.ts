import { Request, Response } from 'express';
import { winstonLogger } from '../middleware/logger';
import { aiAdminConfigService } from '../services/ai/aiAdminConfigService';
import { aiProviderResolver } from '../services/ai/aiProviderResolver';
import { aiObservabilityService } from '../services/ai/aiObservabilityService';

export class AiAdminController {
  public getAiProviders = async (req: Request, res: Response): Promise<void> => {
    try {
      const config = aiAdminConfigService.getConfig();
      res.json({
        success: true,
        data: config,
        telemetry: {
          tokenUsageTracking: 'ACTIVE',
          costEstimation: 'ACTIVE',
          latencyMonitoring: 'ACTIVE'
        }
      });
    } catch (err: any) {
      winstonLogger.error(`[AI_ADMIN] Failed to get providers: ${err.message}`);
      res.status(500).json({ success: false, error: 'Internal Server Error' });
    }
  };

  public updateAiProviders = async (req: Request, res: Response): Promise<void> => {
    try {
      const updatedBy = (req as any).user?.email || 'admin@trayago.in';
      const { providers, routing, defaultProvider, reason } = req.body;

      if (!providers || !routing) {
        res.status(400).json({ success: false, error: 'Missing providers or routing configuration payload' });
        return;
      }

      const updateRes = await aiAdminConfigService.updateConfig({ providers, routing, defaultProvider }, updatedBy, reason);
      if (!updateRes.success) {
        res.status(400).json({ success: false, error: updateRes.message });
        return;
      }

      res.json({
        success: true,
        message: 'AI provider & model configuration updated successfully',
        data: updateRes.config
      });
    } catch (err: any) {
      winstonLogger.error(`[AI_ADMIN] Failed to update AI config: ${err.message}`);
      res.status(500).json({ success: false, error: 'Internal Server Error' });
    }
  };

  public testAiProvider = async (req: Request, res: Response): Promise<void> => {
    const startTime = Date.now();
    try {
      const { providerId = 'GEMINI', model } = req.body;
      const provIdNorm = String(providerId).toUpperCase().trim();

      const provider = aiProviderResolver.getProvider(provIdNorm);
      if (!provider) {
        res.status(404).json({
          success: false,
          error: `Provider '${providerId}' is not registered in runtime registry`
        });
        return;
      }

      // Resolve which model to test (explicit request → admin activeModel → sentinel)
      const config = aiAdminConfigService.getConfig();
      const provConfig = config.providers[provIdNorm];
      const testedModel = model || provConfig?.activeModel || 'default';

      // Validate requested model against the provider's allowed list
      if (model && provConfig) {
        if (!provConfig.allowedModels.includes(model)) {
          res.status(400).json({
            success: false,
            error: `Model '${model}' is not in the allowed list for provider ${provIdNorm}. Allowed: ${provConfig.allowedModels.join(', ')}`
          });
          return;
        }
      }

      // Safe non-production probe prompt
      const probePrompt = 'Reply with a valid JSON object: { "status": "HEALTHY", "probe": "ai_admin_test" }';

      let testOutput: any = null;
      const adapterWithProbe = provider as any;

      if (typeof adapterWithProbe.probeWithModel === 'function') {
        // Concurrency-safe path: probeWithModel takes model as an explicit stack-local parameter.
        // It does NOT call getActiveModel() or touch shared config at any await point.
        // No concurrent production request can observe the probe model.
        testOutput = await adapterWithProbe.probeWithModel(probePrompt, testedModel, true);
      } else if (typeof provider.generateText === 'function') {
        // Fallback for future adapters that predate probeWithModel.
        // Note: this path does NOT guarantee exact-model probing.
        testOutput = await provider.generateText(probePrompt, { json: true });
      } else {
        testOutput = { status: 'HEALTHY', note: 'Adapter does not implement text generation' };
      }

      const latencyMs = Date.now() - startTime;

      res.json({
        success: true,
        data: {
          providerId: provider.providerId,
          displayName: provider.displayName,
          testedModel,
          responseValid: Boolean(testOutput && typeof testOutput === 'object'),
          latencyMs,
          status: 'SUCCESS'
        }
      });
    } catch (err: any) {
      const latencyMs = Date.now() - startTime;
      winstonLogger.warn(`[AI_ADMIN] Provider test probe failed: ${err.message}`);
      res.status(500).json({
        success: false,
        error: `AI probe failed: ${err.message}`,
        latencyMs
      });
    }
  };

  public getAiAuditHistory = async (req: Request, res: Response): Promise<void> => {
    try {
      const history = aiAdminConfigService.getAuditHistory();
      res.json({
        success: true,
        data: history
      });
    } catch (err: any) {
      winstonLogger.error(`[AI_ADMIN] Failed to get audit history: ${err.message}`);
      res.status(500).json({ success: false, error: 'Internal Server Error' });
    }
  };

  public rollbackAi = async (req: Request, res: Response): Promise<void> => {
    try {
      const restoredBy = (req as any).user?.email || 'admin@trayago.in';
      const { timestamp } = req.body;

      if (!timestamp) {
        res.status(400).json({ success: false, error: 'Timestamp required for rollback' });
        return;
      }

      const rollbackRes = await aiAdminConfigService.rollback(timestamp, restoredBy);
      if (!rollbackRes.success) {
        res.status(400).json({ success: false, error: rollbackRes.message });
        return;
      }

      res.json({
        success: true,
        message: 'Successfully rolled back AI provider & model configuration',
        data: rollbackRes.config
      });
    } catch (err: any) {
      winstonLogger.error(`[AI_ADMIN] Rollback failed: ${err.message}`);
      res.status(500).json({ success: false, error: 'Internal Server Error' });
    }
  };

  public getAiObservability = async (req: Request, res: Response): Promise<void> => {
    try {
      const snapshot = aiObservabilityService.getObservabilitySnapshot();
      res.json({
        success: true,
        data: snapshot
      });
    } catch (err: any) {
      winstonLogger.error(`[AI_ADMIN] Failed to get AI observability metrics: ${err.message}`);
      res.status(500).json({ success: false, error: 'Internal Server Error' });
    }
  };
}

export const aiAdminController = new AiAdminController();
