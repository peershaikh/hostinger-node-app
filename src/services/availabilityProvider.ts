import axios from 'axios';
import { winstonLogger } from '../middleware/logger';
import { providerConfigService } from './providerConfigService';
import { railProviderResolver } from './railProviderResolver';
import {
  mapProviderErrorToReason,
  resolveSegmentForAvailability,
} from './trainStationResolver';

export class AvailabilityProvider {

  private currentKeyIndex = 0;
  private readonly HOST = process.env.RAPIDAPI_HOST || 'irctc-train-api.p.rapidapi.com';

  private async getNextApiKey(): Promise<string> {
    let keys = await providerConfigService.getKeysFor('IRCTC');
    if (!keys || keys.length === 0) {
      keys = await providerConfigService.getKeysFor('RAILKIT');
    }
    if (!keys || keys.length === 0) {
      keys = await providerConfigService.getKeysFor('RAPIDAPI');
    }
    if (!keys || keys.length === 0) {
      const fallback = process.env.IRCTC_CONNECT_API_KEY || process.env.IRCTC_API_KEY || process.env.RAILKIT_API_KEY;
      if (fallback) return fallback;
      throw new Error("No IRCTC / RailKit API key configured");
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
    
    let irctcHandledError: any = null;
    const availChain = await railProviderResolver.resolveProviderChain('availability');

    for (const provider of availChain) {
      try {
        const provData = await provider.checkAvailability({
          trainNo: params.trainNo,
          from: fromNorm,
          to: toNorm,
          date: params.date,
          classType: params.classType,
          quota: params.quota
        });

        if (provData && typeof provData === 'object') {
          if (provData.success === false) {
            let isDateNonRunning = false;
            try {
              const { trainOperatesOnDate } = require('../utils/dayUtils');
              const runningVerdict = trainOperatesOnDate(params.date, (resolution as any).runningDays, {
                dayOffset: (resolution as any).dayOffset || 0
              });
              if (runningVerdict === 'NO') isDateNonRunning = true;
            } catch { /* non-fatal */ }

            const providerReason = mapProviderErrorToReason(provData.error || '', isDateNonRunning);
            winstonLogger.info(`[AVAIL_PROVIDER_HANDLED_ERROR] train=${params.trainNo} error=${provData.error} reason=${providerReason}`);
            
            const message = providerReason === 'TRAIN_NOT_RUNNING'
              ? `Train ${params.trainNo} does not run on this date`
              : providerReason === 'PROVIDER_REQUEST_REJECTED'
                ? 'Railway servers rejected availability check for this date/class'
                : (provData.error || 'Class not available in selected quota/class');

            irctcHandledError = {
              success: false,
              reason: providerReason,
              message
            };
          } else {
            const returnedClasses = Array.isArray(provData)
              ? ['ARRAY']
              : (typeof provData === 'object' ? Object.keys(provData) : []);
            winstonLogger.info(`[AVAIL_PROVIDER_CLASSES_RETURNED] train=${params.trainNo} requestedClass=${params.classType} returnedClasses=${returnedClasses.join(',') || 'NONE'} source=${provider.providerId}`);
            winstonLogger.info(`[AVAIL_PROVIDER_SUCCESS] train=${params.trainNo} source=${provider.providerId}`);
            return { success: true, data: provData };
          }
        }
      } catch (err: any) {
        winstonLogger.warn(`[AVAIL_PROVIDER_FAIL] ${provider.providerId} train=${params.trainNo} error=${err.message}`);
      }
    }

    if (irctcHandledError) {
      winstonLogger.warn({
        message: '[AVAIL_FAILURE]',
        availabilityRequest: true,
        trainNo: params.trainNo,
        from: fromNorm,
        to: toNorm,
        date: params.date,
        classType: params.classType,
        quota: params.quota,
        providerStatus: irctcHandledError.message || 'REJECTED',
        normalizedReason: irctcHandledError.reason,
      });
      return irctcHandledError;
    }

    winstonLogger.error(`[AVAIL_PROVIDER_FAIL] train=${params.trainNo} - No further availability fallbacks available`);
    winstonLogger.warn({
      message: '[AVAIL_FAILURE]',
      availabilityRequest: true,
      trainNo: params.trainNo,
      from: fromNorm,
      to: toNorm,
      date: params.date,
      classType: params.classType,
      quota: params.quota,
      providerStatus: 'EXHAUSTED',
      normalizedReason: 'PROVIDER_UNAVAILABLE',
    });
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