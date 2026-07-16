import axios from 'axios';
import { winstonLogger } from '../middleware/logger';
import { cacheService } from './cacheService';
import { providerConfigService } from './providerConfigService';

const BASE_URL = "https://confirmtkt-railway-status.p.rapidapi.com";
const HOST = "confirmtkt-railway-status.p.rapidapi.com";

export class ConfirmtktService {
  async getTrainStatus(trainNo: string, date?: string) {
    const cacheKey = `confirmtkt_${trainNo}_${date || 'default'}`;
    const cached = cacheService.get(cacheKey);
    if (cached) {
      winstonLogger.info(`[CONFIRMTKT_CACHE_HIT] ${trainNo}`);
      return cached;
    }

    try {
      winstonLogger.info(`[API_FALLBACK_1] ConfirmTkt → Fetching live status for ${trainNo}`);

      const keys = await providerConfigService.getKeysFor('CONFIRMTKT');
      if (keys.length === 0) {
        winstonLogger.warn(`[PROVIDER_MISSING_KEY] ConfirmTkt: No API key found in configuration.`);
        return null;
      }
      const apiKey = keys[0];

      let url = `${BASE_URL}/api/v1/trains/${trainNo}/live-status`;
      if (date) {
        // ConfirmTkt expects date format if supplied
        url += `?date=${date}`;
      }

      const response = await axios.get(url, {
        headers: { 
          "X-RapidAPI-Key": apiKey,
          "X-RapidAPI-Host": HOST
        },
        timeout: 8000
      });

      if (!response.data) {
        throw new Error("Empty response from ConfirmTkt");
      }

      const data = response.data.data || response.data;

      // Verify payload is a valid object and not a primitive, null, or array
      if (typeof data !== 'object' || data === null || Array.isArray(data)) {
        throw new Error("Invalid response payload structure: expected JSON object");
      }

      // Verify route/stations payload is present and is a non-empty array
      const rawStations = data.stations || data.route || data.journey;
      if (!Array.isArray(rawStations) || rawStations.length === 0) {
        throw new Error("Invalid response payload structure: expected non-empty stations/route array");
      }

      // Normalise response to match what is parsed downstream in liveTrackingService
      const normalizedStations = rawStations.map((s: any) => ({
        ...s,
        station_code: s.station_code || s.stationCode || s.code || '',
        station_name: s.station_name || s.stationName || s.name || '',
        arrival_time: s.arrival_time || s.arrivalTime || s.scheduled_arrival || s.arrival || '',
        departure_time: s.departure_time || s.departureTime || s.scheduled_departure || s.departure || '',
        delay_minutes: typeof s.delay_minutes === 'number' ? s.delay_minutes : 
                       typeof s.delay === 'number' ? s.delay :
                       parseInt(s.delay_minutes || s.delay_arrival || s.delay || '0', 10)
      }));

      const normalized = {
        ...data,
        train_number: trainNo,
        train_name: data.train_name || data.trainName || `Train ${trainNo}`,
        current_station: data.current_station_name || data.current_station || data.currentStation || '',
        current_station_code: data.current_station_code || data.currentStationCode || '',
        delay: typeof data.delay === 'number' ? data.delay : parseInt(data.delay || '0', 10),
        delay_minutes: typeof data.delay === 'number' ? data.delay : parseInt(data.delay || '0', 10),
        status_as_of: data.status_as_of || data.last_updated || data.lastUpdated || new Date().toLocaleTimeString('en-IN'),
        stations: normalizedStations
      };

      cacheService.set(cacheKey, normalized, 90); // 90 seconds cache
      winstonLogger.info(`[CONFIRMTKT_SUCCESS] ${trainNo} @ ${normalized.current_station || 'Moving'}`);
      return normalized;

    } catch (err: any) {
      const isUnauthorized = err.response?.status === 401 || err.response?.status === 403;
      if (isUnauthorized) {
        winstonLogger.warn(`[PROVIDER_INVALID_KEY] ConfirmTkt: Request failed with status code ${err.response?.status}`);
      } else {
        winstonLogger.warn(`[CONFIRMTKT_FAIL] ${trainNo}: ${err.message}`);
      }
      return null;
    }
  }

  getStatus() {
    return {
      service: "ConfirmTkt",
      role: "FALLBACK_2",
      hasApiKey: false,
      baseUrl: BASE_URL
    };
  }
}

export const confirmtktService = new ConfirmtktService();
