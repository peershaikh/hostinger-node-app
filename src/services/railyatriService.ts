import axios from 'axios';
import { winstonLogger } from '../middleware/logger';
import { cacheService } from './cacheService';
import { providerConfigService } from './providerConfigService';

const BASE_URL = "https://railyatri-live-status.p.rapidapi.com";
const HOST = "railyatri-live-status.p.rapidapi.com";

export class RailyatriService {
  async getTrainStatus(trainNo: string, date?: string) {
    const cacheKey = `railyatri_${trainNo}_${date || 'default'}`;
    const cached = cacheService.get(cacheKey);
    if (cached) {
      winstonLogger.info(`[RAILYATRI_CACHE_HIT] ${trainNo}`);
      return cached;
    }

    try {
      winstonLogger.info(`[API_FALLBACK_1] RailYatri → Fetching live status for ${trainNo}`);

      const keys = await providerConfigService.getKeysFor('RAILYATRI');
      if (keys.length === 0) {
        winstonLogger.warn(`[PROVIDER_MISSING_KEY] RailYatri: No API key found in configuration.`);
        return null;
      }
      const apiKey = keys[0];

      const url = `${BASE_URL}/api/v1/live-train-status?trainNo=${trainNo}`;
      const response = await axios.get(url, {
        headers: { 
          "X-RapidAPI-Key": apiKey,
          "X-RapidAPI-Host": HOST
        },
        timeout: 8000
      });

      if (!response.data) {
        throw new Error("Empty response from RailYatri");
      }

      const data = response.data.data || response.data;

      // Normalise response to match what is parsed downstream in liveTrackingService
      const rawStations = data.stations || data.route || data.journey || [];
      const normalizedStations = Array.isArray(rawStations) ? rawStations.map((s: any) => ({
        ...s,
        station_code: s.station_code || s.stationCode || s.code || '',
        station_name: s.station_name || s.stationName || s.name || '',
        arrival_time: s.arrival_time || s.arrivalTime || s.scheduled_arrival || s.arrival || '',
        departure_time: s.departure_time || s.departureTime || s.scheduled_departure || s.departure || '',
        delay_minutes: typeof s.delay_minutes === 'number' ? s.delay_minutes : 
                       typeof s.delay === 'number' ? s.delay :
                       parseInt(s.delay_minutes || s.delay_arrival || s.delay || '0', 10)
      })) : [];

      const normalized = {
        ...data,
        train_number: trainNo,
        train_name: data.train_name || data.trainName || `Train ${trainNo}`,
        current_station: data.current_station_name || data.current_station || data.currentStation || '',
        current_station_code: data.current_station_code || data.currentStationCode || '',
        delay_minutes: typeof data.delay === 'number' ? data.delay : parseInt(data.delay || '0', 10),
        status_as_of: data.status_as_of || data.last_updated || data.lastUpdated || new Date().toLocaleTimeString('en-IN'),
        stations: normalizedStations
      };

      cacheService.set(cacheKey, normalized, 90); // 90 seconds cache
      winstonLogger.info(`[RAILYATRI_SUCCESS] ${trainNo} @ ${normalized.current_station || 'Moving'}`);
      return normalized;

    } catch (err: any) {
      const isUnauthorized = err.response?.status === 401 || err.response?.status === 403;
      if (isUnauthorized) {
        winstonLogger.warn(`[PROVIDER_INVALID_KEY] RailYatri: Request failed with status code ${err.response?.status}`);
      } else {
        winstonLogger.warn(`[RAILYATRI_FAIL] ${trainNo}: ${err.message}`);
      }
      return null;
    }
  }

  getStatus() {
    return {
      service: "RailYatri",
      role: "FALLBACK_2",
      hasApiKey: false,
      baseUrl: BASE_URL
    };
  }
}

export const railyatriService = new RailyatriService();
