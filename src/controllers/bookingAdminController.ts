import { Request, Response } from 'express';
import { winstonLogger } from '../middleware/logger';
import { bookingConfigService } from '../services/booking/bookingConfigService';
import { bookingProviderResolver } from '../services/booking/bookingProviderResolver';

export class BookingAdminController {
  public getBookingProviders = async (req: Request, res: Response): Promise<void> => {
    try {
      const config = bookingConfigService.getConfig();
      res.json({
        success: true,
        data: config
      });
    } catch (err: any) {
      winstonLogger.error(`[BOOKING_ADMIN] Failed to get providers: ${err.message}`);
      res.status(500).json({ success: false, error: 'Internal Server Error' });
    }
  };

  public updateBookingProviders = async (req: Request, res: Response): Promise<void> => {
    try {
      const updatedBy = (req as any).user?.email || 'admin@trayago.in';
      const { providers, routing, reason } = req.body;

      if (!providers || !routing) {
        res.status(400).json({ success: false, error: 'Missing providers or routing configuration payload' });
        return;
      }

      const updateRes = await bookingConfigService.updateConfig({ providers, routing }, updatedBy, reason);
      if (!updateRes.success) {
        res.status(400).json({ success: false, error: updateRes.message });
        return;
      }

      res.json({
        success: true,
        message: 'Booking provider configuration updated successfully',
        data: updateRes.config
      });
    } catch (err: any) {
      winstonLogger.error(`[BOOKING_ADMIN] Failed to update providers: ${err.message}`);
      res.status(500).json({ success: false, error: 'Internal Server Error' });
    }
  };

  public testBookingProvider = async (req: Request, res: Response): Promise<void> => {
    const startTime = Date.now();
    try {
      const { providerId, feature = 'SEARCH_BOOKING' } = req.body;

      if (!providerId) {
        res.status(400).json({ success: false, error: 'Provider ID required' });
        return;
      }

      const config = bookingConfigService.getConfig();
      const provConfig = config.providers[providerId.toUpperCase()];

      if (!provConfig) {
        res.status(404).json({ success: false, error: `Provider '${providerId}' not found in registry` });
        return;
      }

      if (feature === 'SPLIT_BOOKING' && !provConfig.capabilities.splitBooking) {
        res.status(400).json({
          success: false,
          error: `Provider '${providerId}' does not support Split Booking capability`
        });
        return;
      }

      // Sample test context (NDLS -> MMCT)
      const sampleContext = {
        fromStation: 'NDLS',
        toStation: 'MMCT',
        trainNo: '12952',
        journeyDate: new Date().toISOString().split('T')[0],
        utmSource: 'trayago_admin_probe',
        utmCampaign: provConfig.campaignId || 'admin_test',
        partnerId: provConfig.partnerId || undefined
      };

      const result = await bookingProviderResolver.generateBookingUrl(sampleContext, providerId);
      const latencyMs = Date.now() - startTime;

      let parsedDomain = 'unknown';
      try {
        const parsed = new URL(result.url);
        parsedDomain = parsed.hostname;
      } catch {
        parsedDomain = 'invalid-url';
      }

      res.json({
        success: true,
        data: {
          providerId: result.providerId,
          displayName: result.displayName,
          testedFeature: feature,
          targetDomain: parsedDomain,
          urlStructureValid: result.url.startsWith('https://'),
          sampleGeneratedUrl: result.url,
          latencyMs,
          status: 'SUCCESS'
        }
      });
    } catch (err: any) {
      const latencyMs = Date.now() - startTime;
      winstonLogger.error(`[BOOKING_ADMIN] Test probe failed: ${err.message}`);
      res.status(500).json({
        success: false,
        error: `Provider test failed: ${err.message}`,
        latencyMs
      });
    }
  };

  public getBookingAuditHistory = async (req: Request, res: Response): Promise<void> => {
    try {
      const history = bookingConfigService.getAuditHistory();
      res.json({
        success: true,
        data: history
      });
    } catch (err: any) {
      winstonLogger.error(`[BOOKING_ADMIN] Failed to get audit history: ${err.message}`);
      res.status(500).json({ success: false, error: 'Internal Server Error' });
    }
  };

  public rollbackBooking = async (req: Request, res: Response): Promise<void> => {
    try {
      const restoredBy = (req as any).user?.email || 'admin@trayago.in';
      const { timestamp } = req.body;

      if (!timestamp) {
        res.status(400).json({ success: false, error: 'Timestamp required for rollback' });
        return;
      }

      const rollbackRes = await bookingConfigService.rollback(timestamp, restoredBy);
      if (!rollbackRes.success) {
        res.status(400).json({ success: false, error: rollbackRes.message });
        return;
      }

      res.json({
        success: true,
        message: 'Successfully rolled back booking provider configuration',
        data: rollbackRes.config
      });
    } catch (err: any) {
      winstonLogger.error(`[BOOKING_ADMIN] Rollback failed: ${err.message}`);
      res.status(500).json({ success: false, error: 'Internal Server Error' });
    }
  };
}

export const bookingAdminController = new BookingAdminController();
