import axios from 'axios';
import { winstonLogger } from '../middleware/logger';
import { cacheService } from './cacheService';
import { providerConfigService } from './providerConfigService';

const BASE_URL = "https://api.railradar.org/api/v1";

export class RailRadarService {
  async getTrainStatus(trainNo: string) {
    const cacheKey = `railradar_${trainNo}`;
    const cached = cacheService.get(cacheKey);
    if (cached) {
      winstonLogger.info(`[RAILRADAR_CACHE_HIT] ${trainNo}`);
      return cached;
    }

    const keys = await providerConfigService.getKeysFor('RAILRADAR');
    if (keys.length === 0) {
      return null;
    }

    try {
      winstonLogger.info(`[API_FALLBACK_1] RailRadar → Fetching live status for ${trainNo}`);
      const apiKey = keys[0];

      const url = `${BASE_URL}/trains/${trainNo}`;
      const response = await axios.get(url, {
        headers: { "X-API-Key": apiKey },
        timeout: 8000
      });

      if (!response.data) {
        throw new Error("Empty response from RailRadar");
      }

      const data = response.data.data || response.data;

      // Normalize common fields
      const normalized = {
        ...data,
        current_station: data.current_station || data.currentStation,
        latitude: data.latitude || data.lat,
        longitude: data.longitude || data.lng,
        delay: data.delay_minutes || data.delay,
        status: data.status || data.current_status,
        journey: data.journey || data.route || [],
        last_updated: data.last_updated || new Date().toISOString()
      };

      cacheService.set(cacheKey, normalized, 90); // 90 seconds cache

      winstonLogger.info(`[RAILRADAR_SUCCESS] ${trainNo} @ ${normalized.current_station || 'Moving'}`);
      return normalized;

    } catch (err: any) {
      const isUnauthorized = err.response?.status === 401;
      if (isUnauthorized) {
        winstonLogger.warn(`[PROVIDER_INVALID_KEY] RailRadar: Request failed with status code 401`);
      } else {
        winstonLogger.warn(`[RAILRADAR_FAIL] ${trainNo}: ${err.message}`);
      }
      return null;
    }
  }

  /** Optional: Search support (if RailRadar adds this endpoint later) */
  async search(from: string, to: string, date: string) {
    const keys = await providerConfigService.getKeysFor('RAILRADAR');
    if (keys.length === 0) return null;

    // PHASE_4C931 TASK 3: Explicit warn — never silently hide provider failure.
    // RailRadar does not support station-to-station search yet.
    // Logged at warn level so monitoring can see the stub is active.
    winstonLogger.warn(
      `[PROVIDER_STUB_INACTIVE] RailRadar.search(${from}→${to}) called but ` +
      `station-to-station search is NOT implemented. Returning null. ` +
      `trainService will proceed to RapidAPI fallback.`
    );
    return null;
  }

  /** Optional: PNR support (if available) */
  async getPNRStatus(pnr: string) {
    const keys = await providerConfigService.getKeysFor('RAILRADAR');
    if (keys.length === 0) return null;

    winstonLogger.info(`[RAILRADAR_PNR] ${pnr} (Not supported yet)`);
    return null;
  }

  /** Optional: Availability support (if available) */
  async getAvailability(trainNo: string, from: string, to: string, date: string, classType: string, quota: string) {
    const keys = await providerConfigService.getKeysFor('RAILRADAR');
    if (keys.length === 0) return null;

    winstonLogger.info(`[RAILRADAR_AVAIL] ${trainNo} from=${from} to=${to} (Not supported yet)`);
    return null;
  }

  getStatus() {
    return {
      service: "RailRadar",
      role: "FALLBACK_1",
      hasApiKey: !!process.env.RAILRADAR_API_KEY,
      baseUrl: BASE_URL
    };
  }
}

export const railRadarService = new RailRadarService();