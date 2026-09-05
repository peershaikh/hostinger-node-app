import axios from 'axios';
import * as fs from 'fs';
import * as path from 'path';
import { winstonLogger } from '../middleware/logger';
import { cacheService } from './cacheService';
import { providerConfigService } from './providerConfigService';

const BASE_URL = "https://api.railradar.in/v1";
const MONTHLY_QUOTA_LIMIT = 900; // 900 calls/month (100 reserve preserved out of 1000 free quota)
const REQUEST_TIMEOUT_MS = 5000; // 5 second maximum request timeout

export interface RailRadarQuotaUsage {
  used: number;
  limit: number;
  remaining: number;
  month: string;
}

export class RailRadarService {
  private readonly QUOTA_FILE = path.join(__dirname, '../../data/railradar_quota.json');
  private quotaCount: number = 0;
  private currentMonthKey: string = '';

  // Circuit & Rate Limiting state
  private unavailableUntil: number = 0;
  private isAuthUnhealthy: boolean = false;
  private lastError: string | null = null;

  // Singleflight: In-flight request coalescing
  private inFlightRequests: Map<string, Promise<any>> = new Map();

  constructor() {
    this.currentMonthKey = this.getIstCurrentMonth();
    this.loadQuotaState();
  }

  /**
   * Returns current IST calendar month in "YYYY-MM" format.
   */
  private getIstCurrentMonth(): string {
    return new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Kolkata' }).slice(0, 7);
  }

  /**
   * Loads quota tracking state from disk.
   */
  private loadQuotaState(): void {
    try {
      if (fs.existsSync(this.QUOTA_FILE)) {
        const raw = fs.readFileSync(this.QUOTA_FILE, 'utf8');
        const parsed = JSON.parse(raw);
        const thisMonth = this.getIstCurrentMonth();

        if (parsed.month === thisMonth && typeof parsed.used === 'number') {
          this.quotaCount = parsed.used;
          this.currentMonthKey = thisMonth;
        } else {
          // Month changed: auto-reset counter
          this.quotaCount = 0;
          this.currentMonthKey = thisMonth;
          this.persistQuotaState();
        }
      } else {
        this.quotaCount = 0;
        this.currentMonthKey = this.getIstCurrentMonth();
        this.persistQuotaState();
      }
    } catch {
      this.quotaCount = 0;
      this.currentMonthKey = this.getIstCurrentMonth();
    }
  }

  /**
   * Persists quota tracking state to disk.
   */
  private persistQuotaState(): void {
    try {
      const data = {
        month: this.currentMonthKey,
        used: this.quotaCount,
        limit: MONTHLY_QUOTA_LIMIT,
        lastUpdated: new Date().toISOString()
      };
      const dir = path.dirname(this.QUOTA_FILE);
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
      }
      fs.writeFileSync(this.QUOTA_FILE, JSON.stringify(data, null, 2), 'utf8');
    } catch (e: any) {
      winstonLogger.warn(`[RAILRADAR_QUOTA] Failed to persist quota state: ${e.message}`);
    }
  }

  /**
   * Checks if an outbound call is permitted under the 900 calls/month quota guard.
   * Increments the quota count atomically if allowed.
   */
  public checkAndIncrementQuota(): boolean {
    const thisMonth = this.getIstCurrentMonth();
    if (thisMonth !== this.currentMonthKey) {
      // Month rollover: reset counter
      this.currentMonthKey = thisMonth;
      this.quotaCount = 0;
      this.persistQuotaState();
    }

    if (this.quotaCount >= MONTHLY_QUOTA_LIMIT) {
      winstonLogger.info(
        `[RAILRADAR_QUOTA_EXHAUSTED] Quota guard active: ${this.quotaCount}/${MONTHLY_QUOTA_LIMIT} calls reached for ${this.currentMonthKey}. ` +
        `Preserving 100-call reserve. Skipping outbound request.`
      );
      return false;
    }

    this.quotaCount++;
    this.persistQuotaState();
    return true;
  }

  /**
   * Returns current quota usage metrics for the Admin Panel.
   */
  public getQuotaUsage(): RailRadarQuotaUsage {
    const thisMonth = this.getIstCurrentMonth();
    if (thisMonth !== this.currentMonthKey) {
      this.currentMonthKey = thisMonth;
      this.quotaCount = 0;
      this.persistQuotaState();
    }

    return {
      used: this.quotaCount,
      limit: MONTHLY_QUOTA_LIMIT,
      remaining: Math.max(0, MONTHLY_QUOTA_LIMIT - this.quotaCount),
      month: this.currentMonthKey
    };
  }

  /**
   * Reset quota count (useful for testing).
   */
  public resetQuotaForTest(used: number = 0): void {
    this.quotaCount = used;
    this.currentMonthKey = this.getIstCurrentMonth();
    this.persistQuotaState();
  }

  /**
   * Reset health status when API key is updated or admin re-enables provider.
   */
  public resetHealth(): void {
    this.isAuthUnhealthy = false;
    this.unavailableUntil = 0;
    this.lastError = null;
  }

  public getHealthStatus(): { status: string; message?: string } {
    if (this.isAuthUnhealthy) {
      return { status: 'UNHEALTHY', message: 'API key authentication failed (401)' };
    }
    if (Date.now() < this.unavailableUntil) {
      return { status: 'DEGRADED', message: 'Temporarily rate limited (429)' };
    }
    if (this.quotaCount >= MONTHLY_QUOTA_LIMIT) {
      return { status: 'QUOTA_EXHAUSTED', message: `Monthly quota limit reached (${this.quotaCount}/${MONTHLY_QUOTA_LIMIT})` };
    }
    return { status: 'READY', message: 'Operational' };
  }

  /**
   * Coalesce identical concurrent outbound requests (singleflight).
   */
  private async coalesce<T>(key: string, fn: () => Promise<T>): Promise<T> {
    if (this.inFlightRequests.has(key)) {
      winstonLogger.info(`[RAILRADAR_COALESCED] In-flight request joined for: ${key}`);
      return this.inFlightRequests.get(key) as Promise<T>;
    }

    const promise = (async () => {
      try {
        return await fn();
      } finally {
        this.inFlightRequests.delete(key);
      }
    })();

    this.inFlightRequests.set(key, promise);
    return promise;
  }

  /**
   * Real PNR Status fetch: GET /pnr/{pnr}
   * Cache: 60s
   */
  async getPNRStatus(pnr: string): Promise<any | null> {
    if (!pnr || pnr.length !== 10) return null;

    const cacheKey = `railradar_pnr_${pnr}`;
    const cached = cacheService.get(cacheKey);
    if (cached) {
      winstonLogger.info(`[RAILRADAR_CACHE_HIT] PNR ${pnr}`);
      return cached;
    }

    if (this.isAuthUnhealthy || Date.now() < this.unavailableUntil) {
      winstonLogger.warn(`[RAILRADAR_SKIPPED] Provider currently unhealthy or backed off.`);
      return null;
    }

    const keys = await providerConfigService.getKeysFor('RAILRADAR');
    if (keys.length === 0) {
      winstonLogger.warn(`[RAILRADAR_NO_KEY] No active API key found for RailRadar.`);
      return null;
    }

    const apiKey = keys[0];
    if (!apiKey || apiKey.startsWith('********') || apiKey === 'mock_encrypted_railradar_key') {
      return null;
    }

    return this.coalesce(`pnr_${pnr}`, async () => {
      // Check quota before outbound request
      if (!this.checkAndIncrementQuota()) {
        return null;
      }

      try {
        winstonLogger.info(`[RAILRADAR_CALL] Fetching PNR status for ${pnr}`);
        const url = `${BASE_URL}/pnr/${pnr}`;

        const response = await axios.get(url, {
          headers: {
            "Authorization": `Bearer ${apiKey}`,
            "Accept": "application/json"
          },
          timeout: REQUEST_TIMEOUT_MS
        });

        if (!response.data) {
          throw new Error("Empty response from RailRadar");
        }

        const rawData = response.data.data || response.data;
        const mapped = this.mapRailRadarPnr(rawData, pnr);

        if (mapped) {
          // 60-second cache for successful PNR response
          cacheService.set(cacheKey, mapped, 60);
          winstonLogger.info(`[RAILRADAR_SUCCESS] PNR ${pnr} resolved successfully.`);
          return mapped;
        }

        return null;
      } catch (err: any) {
        return this.handleFailure('PNR', pnr, err);
      }
    });
  }

  /**
   * Real Live Train Status fetch: GET /trains/{number}/live
   * Cache: 90s
   */
  async getTrainStatus(trainNo: string): Promise<any | null> {
    if (!trainNo) return null;

    const cacheKey = `railradar_live_${trainNo}`;
    const cached = cacheService.get(cacheKey);
    if (cached) {
      winstonLogger.info(`[RAILRADAR_CACHE_HIT] Train ${trainNo}`);
      return cached;
    }

    if (this.isAuthUnhealthy || Date.now() < this.unavailableUntil) {
      winstonLogger.warn(`[RAILRADAR_SKIPPED] Provider currently unhealthy or backed off.`);
      return null;
    }

    const keys = await providerConfigService.getKeysFor('RAILRADAR');
    if (keys.length === 0) {
      return null;
    }

    const apiKey = keys[0];
    if (!apiKey || apiKey.startsWith('********') || apiKey === 'mock_encrypted_railradar_key') {
      return null;
    }

    return this.coalesce(`live_${trainNo}`, async () => {
      // Check quota before outbound request
      if (!this.checkAndIncrementQuota()) {
        return null;
      }

      try {
        winstonLogger.info(`[RAILRADAR_CALL] Fetching live status for ${trainNo}`);
        const url = `${BASE_URL}/trains/${trainNo}/live`;

        const response = await axios.get(url, {
          headers: {
            "Authorization": `Bearer ${apiKey}`,
            "Accept": "application/json"
          },
          timeout: REQUEST_TIMEOUT_MS
        });

        if (!response.data) {
          throw new Error("Empty response from RailRadar");
        }

        const rawData = response.data.data || response.data;
        const mapped = this.mapRailRadarLive(rawData, trainNo);

        if (mapped) {
          // 90-second cache for successful live status response
          cacheService.set(cacheKey, mapped, 90);
          winstonLogger.info(`[RAILRADAR_SUCCESS] Train ${trainNo} status: ${mapped.status}`);
          return mapped;
        }

        return null;
      } catch (err: any) {
        return this.handleFailure('LIVE', trainNo, err);
      }
    });
  }

  /**
   * Failure classification engine conforming strictly to Part 4 requirements.
   */
  private handleFailure(feature: string, target: string, err: any): null {
    const status = err.response?.status;
    this.lastError = err.message || `HTTP ${status}`;

    if (status === 401) {
      // 401: Configuration/auth failure -> mark unhealthy, no retry loop
      this.isAuthUnhealthy = true;
      winstonLogger.error(`[RAILRADAR_AUTH_FAILURE] 401 Unauthorized for RailRadar ${feature} (${target}). Marking provider unhealthy.`);
      return null;
    }

    if (status === 404) {
      // 404: Valid provider response meaning data not found -> return null, continue fallback chain, no retry loop
      winstonLogger.info(`[RAILRADAR_NOT_FOUND] 404 Not Found for ${feature} (${target}). Continuing fallback chain.`);
      return null;
    }

    if (status === 429) {
      // 429: Rate limit/quota -> mark temporarily unavailable (1 hour backoff), do not retry loop
      this.unavailableUntil = Date.now() + (3600 * 1000);
      winstonLogger.warn(`[RAILRADAR_RATE_LIMIT] 429 Too Many Requests for ${feature} (${target}). Backing off for 1 hour.`);
      return null;
    }

    if (err.code === 'ECONNABORTED' || (err.message && err.message.toLowerCase().includes('timeout'))) {
      winstonLogger.warn(`[RAILRADAR_TIMEOUT] 5000ms timeout expired for ${feature} (${target}). Safe fallback.`);
      return null;
    }

    // 5xx / Network error: treat as provider unavailable, fall through
    winstonLogger.warn(`[RAILRADAR_FAIL] ${feature} (${target}): ${err.message}. Safe fallback.`);
    return null;
  }

  /**
   * Normalizes RailRadar PNR response to Trayago internal shape.
   */
  private mapRailRadarPnr(data: any, originalPnr: string): any {
    if (!data) return null;

    const pnr = String(data.pnr || data.pnr_number || originalPnr);
    const trainNumber = String(data.train_number || data.trainNumber || data.train_no || '');
    const trainName = data.train_name || data.trainName || '';
    const journeyDate = data.date_of_journey || data.journey_date || data.journeyDate || data.doj || '';
    const source = data.source || data.source_station || data.from || '';
    const destination = data.destination || data.destination_station || data.to || '';
    const boardingPoint = data.boarding_point || data.board_station || source;
    const reservationUpto = data.reservation_upto || data.dest_station || destination;
    const journeyClass = data.class || data.classType || data.journey_class || '';
    const chartPrepared = Boolean(data.chart_prepared ?? data.chartPrepared ?? false);

    const rawPassengers = Array.isArray(data.passengers) ? data.passengers :
                          Array.isArray(data.passenger_status) ? data.passenger_status : [];

    const passengers = rawPassengers.map((p: any, idx: number) => ({
      passenger_number: p.passenger_number || p.number || idx + 1,
      booking_status: p.booking_status || p.bookingStatus || 'Unknown',
      current_status: p.current_status || p.currentStatus || p.booking_status || 'Unknown',
      coach: p.coach || p.coach_position || p.coachPosition || '',
      berth: p.berth || p.berth_number || p.berthNumber || '',
      quota: p.quota || data.quota || 'GN'
    }));

    const primaryPassenger = passengers[0];
    const currentStatus = data.current_status || primaryPassenger?.current_status || (chartPrepared ? 'CHART PREPARED' : 'CONFIRMED');

    return {
      pnr,
      pnr_number: pnr,
      train_number: trainNumber,
      train_name: trainName,
      journey_date: journeyDate,
      source_station: source,
      destination_station: destination,
      boarding_point: boardingPoint,
      reservation_upto: reservationUpto,
      class: journeyClass,
      chart_prepared: chartPrepared,
      chart_status: chartPrepared ? "CHART PREPARED" : "CHART NOT PREPARED",
      current_status: currentStatus,
      passengers,
      source: "RAILRADAR"
    };
  }

  /**
   * Normalizes RailRadar Live Train response to Trayago internal shape.
   */
  private mapRailRadarLive(data: any, trainNo: string): any {
    if (!data) return null;

    const stations = data.stations || data.route || data.journey || [];
    const delay = typeof data.delay_minutes === 'number' ? data.delay_minutes :
                  typeof data.delay === 'number' ? data.delay : 0;

    return {
      train_number: String(data.train_number || data.trainNumber || trainNo),
      train_name: data.train_name || data.trainName || '',
      current_station: data.current_station || data.currentStation || data.station_name || '',
      next_station: data.next_station || data.nextStation || '',
      delay,
      delay_minutes: delay,
      status: data.status || data.current_status || (delay > 0 ? `Late by ${delay} min` : 'On Time'),
      stations,
      journey_timeline: stations,
      last_updated: data.last_updated || new Date().toISOString(),
      source: "RAILRADAR"
    };
  }

  /**
   * Explicit stub: RailRadar does NOT support station search.
   * Strictly never called by searchAdvanced.
   */
  async search(from: string, to: string, date: string): Promise<null> {
    winstonLogger.warn(
      `[PROVIDER_STUB_INACTIVE] RailRadar.search(${from}→${to}) is not supported. Returning null.`
    );
    return null;
  }

  /**
   * Status information for registry and admin telemetry.
   */
  getStatus() {
    const quota = this.getQuotaUsage();
    const health = this.getHealthStatus();
    return {
      service: "RailRadar",
      role: "BACKUP",
      baseUrl: BASE_URL,
      quota,
      health,
      lastError: this.lastError
    };
  }
}

export const railRadarService = new RailRadarService();