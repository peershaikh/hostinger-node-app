import axios from 'axios';
import { winstonLogger } from '../middleware/logger';
import { providerConfigService } from './providerConfigService';
import {
  mapProviderErrorToReason,
  resolveSegmentForAvailability,
} from './trainStationResolver';

export class AvailabilityProvider {

  private currentKeyIndex = 0;
  private readonly HOST = process.env.RAPIDAPI_HOST || 'irctc-train-api.p.rapidapi.com';

  private async getNextApiKey(): Promise<string> {
    const keys = await providerConfigService.getKeysFor('RAPIDAPI');
    if (keys.length === 0) {
      throw new Error("No RapidAPI key configured");
    }
    const key = keys[this.currentKeyIndex % keys.length];
    this.currentKeyIndex = (this.currentKeyIndex + 1) % keys.length;
    return key;
  }

  private async getHeaders() {
    return {
      "X-RapidAPI-Key": await this.getNextApiKey(),
      "X-RapidAPI-Host": this.HOST
    };
  }

  /**
   * PHASE_4C870 — Provider fetch only (no cache). Called by SmartAvailabilityService.
   */
  async fetchFromProvider(params: {
    trainNo: string;
    from: string;
    to: string;
    date: string;
    classType: string;
    quota: string;
  }): Promise<{
    success: boolean;
    data?: unknown;
    reason?: string;
    message?: string;
  }> {
    // PHASE_4C862 — train-aware station resolution + pre-IRCTC validation
    const resolution = await resolveSegmentForAvailability(
      params.trainNo,
      params.from,
      params.to,
      params.date
    );

    if (!resolution.success) {
      winstonLogger.info(
        `[AVAIL_PROVIDER_PRECHECK_FAIL] train=${params.trainNo} reason=${resolution.reason} msg=${resolution.message}`
      );
      return {
        success: false,
        reason: resolution.reason,
        message: resolution.message,
      };
    }

    const fromNorm = resolution.apiFrom;
    const toNorm = resolution.apiTo;

    winstonLogger.info(`[AVAIL_PROVIDER_START] train=${params.trainNo} from=${fromNorm} to=${toNorm}`);
    winstonLogger.info(`[AVAIL_PROVIDER_PARAMS] train=${params.trainNo} from=${fromNorm} to=${toNorm} date=${params.date} class=${params.classType} quota=${params.quota}`);
    
    let irctcData: any = null;
    let irctcHandledError: any = null;

    const irctcGuard = await providerConfigService.isProviderEnabled('IRCTC');
    if (irctcGuard.enabled) {
      try {
        const { irctcService } = require('./irctcService');
        
        irctcData = await irctcService.getAvailability(
          params.trainNo,
          params.date,
          fromNorm,
          toNorm,
          params.classType,
          params.quota,
          { bypassCache: true }
        );

        if (irctcData && typeof irctcData === 'object') {
          if (irctcData.success === false) {
            const providerReason = mapProviderErrorToReason(irctcData.error || '');
            winstonLogger.info(`[AVAIL_PROVIDER_HANDLED_ERROR] train=${params.trainNo} error=${irctcData.error} reason=${providerReason}`);
            irctcHandledError = {
              success: false,
              reason: providerReason,
              message: irctcData.error || "Class not available in selected quota/class"
            };
          } else {
            const returnedClasses = Array.isArray(irctcData)
              ? ['ARRAY']
              : (typeof irctcData === 'object' ? Object.keys(irctcData) : []);
            winstonLogger.info(`[AVAIL_PROVIDER_CLASSES_RETURNED] train=${params.trainNo} requestedClass=${params.classType} returnedClasses=${returnedClasses.join(',') || 'NONE'} source=IRCTC`);
            winstonLogger.info(`[AVAIL_PROVIDER_SUCCESS] train=${params.trainNo} source=IRCTC`);
            return { success: true, data: irctcData };
          }
        } else {
          throw new Error(`IRCTC Provider returned empty or failed: ${JSON.stringify(irctcData)}`);
        }
      } catch (err: any) {
        winstonLogger.warn(`[AVAIL_PROVIDER_FAIL] train=${params.trainNo} error=${err.message} - Trying RailRadar`);
      }
    } else {
      const skipLabel = (irctcGuard.reason === 'PROVIDER_UNHEALTHY' || irctcGuard.reason === 'CIRCUIT_BREAKER_BLOCKED')
        ? '[PROVIDER_SKIPPED_UNHEALTHY]'
        : '[PROVIDER_SKIPPED_DISABLED]';
      winstonLogger.info(`${skipLabel} IRCTC | Reason: ${irctcGuard.reason}`);
    }

    const rrGuard = await providerConfigService.isProviderEnabled('RAILRADAR');
    if (rrGuard.enabled) {
      try {
        const { railRadarService } = require('./railRadarService');
        const rrData = await railRadarService.getAvailability(
          params.trainNo,
          fromNorm,
          toNorm,
          params.date,
          params.classType,
          params.quota
        );
        if (rrData) {
          const source = irctcHandledError ? 'RAILRADAR (IRCTC_FALLBACK)' : 'RAILRADAR';
          winstonLogger.info(`[AVAIL_PROVIDER_SUCCESS] train=${params.trainNo} source=${source}`);
          return { success: true, data: rrData };
        }
      } catch (rrErr: any) {
        winstonLogger.warn(`[AVAIL_PROVIDER_RAILRADAR_FAIL] train=${params.trainNo} error=${rrErr.message}`);
      }
    } else {
      const skipLabel = (rrGuard.reason === 'PROVIDER_UNHEALTHY' || rrGuard.reason === 'CIRCUIT_BREAKER_BLOCKED')
        ? '[PROVIDER_SKIPPED_UNHEALTHY]'
        : '[PROVIDER_SKIPPED_DISABLED]';
      winstonLogger.info(`${skipLabel} RAILRADAR | Reason: ${rrGuard.reason}`);
    }

    if (irctcHandledError) {
      return irctcHandledError;
    }

    winstonLogger.error(`[AVAIL_PROVIDER_FAIL] train=${params.trainNo} - No further availability fallbacks available`);
    return { success: false, reason: 'PROVIDER_UNAVAILABLE', message: 'The railway booking system is currently unresponsive. Please try again later.' };
  }

  /**
   * PHASE_4C870 — All availability traffic routes through SmartAvailabilityService.
   */
  async getAvailability(params: {
    trainNo: string;
    from: string;
    to: string;
    date: string;
    classType: string;
    quota: string;
    forceRefresh?: boolean;
  }) {
    const { smartAvailabilityService } = require('./smartAvailabilityService');
    return smartAvailabilityService.getAvailability(params);
  }
}

export const availabilityProvider = new AvailabilityProvider();