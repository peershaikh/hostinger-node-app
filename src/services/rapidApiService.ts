// DEPRECATED / UNUSED: This service is no longer used in production runtime paths for Phase B.
import axios from 'axios';
import { winstonLogger } from '../middleware/logger';
import { cacheService } from './cacheService';
import { providerConfigService } from './providerConfigService';

export class RapidApiService {
  // keys fetched dynamically per request

  private currentKeyIndex = 0;
  private readonly HOST = process.env.RAPIDAPI_HOST || 'irctc-train-api.p.rapidapi.com';
  private lastCallTime = 0;

  private async getNextApiKey(): Promise<string> {
    try {
      const keys = await providerConfigService.getKeysFor('RAPIDAPI');
      if (keys.length === 0) {
        winstonLogger.warn(`[PROVIDER_MISSING_KEY] RapidAPI: No API key found in configuration.`);
        throw new Error("REAL API FAILED - No RapidAPI key configured");
      }
      const key = keys[this.currentKeyIndex % keys.length];
      this.currentKeyIndex = (this.currentKeyIndex + 1) % keys.length;
      return key;
    } catch (err: any) {
      if (err.message && !err.message.includes("No RapidAPI key configured")) {
        winstonLogger.warn(`[PROVIDER_MISSING_KEY] RapidAPI: Key retrieval failed: ${err.message}`);
      }
      throw new Error("REAL API FAILED - No RapidAPI key configured");
    }
  }

  private async getHeaders() {
    const key = await this.getNextApiKey();
    return {
      "X-RapidAPI-Key": key,
      "X-RapidAPI-Host": this.HOST
    };
  }

  private async stagger() {
    const now = Date.now();
    const elapsed = now - this.lastCallTime;
    const MIN_INTERVAL = 800;

    if (elapsed < MIN_INTERVAL) {
      await new Promise(r => setTimeout(r, MIN_INTERVAL - elapsed));
    }
    this.lastCallTime = Date.now();
  }

  // ====================== FIX_7 COMPATIBLE METHODS ======================

  async getPNRStatus(pnr: string) {
    winstonLogger.info(`[RAPIDAPI_DISABLED] RapidAPI is disabled by user.`);
    return null;
  }

  async getLiveStatus(trainNo: string, date?: string) {
    winstonLogger.info(`[RAPIDAPI_DISABLED] RapidAPI is disabled by user.`);
    return null;
  }

  async getTrainSchedule(trainNo: string) {
    winstonLogger.info(`[RAPIDAPI_DISABLED] RapidAPI is disabled by user.`);
    return null;
  }

  async searchTrainsBetweenStations(from: string, to: string, date: string) {
    winstonLogger.info(`[RAPIDAPI_DISABLED] RapidAPI is disabled by user.`);
    return [];
  }

  async getSeatAvailability(params: any) {
    winstonLogger.info(`[RAPIDAPI_DISABLED] RapidAPI is disabled by user.`);
    return null;
  }

  // ====================== HELPERS ======================

  async search(from: string, to: string, date: string) {
    return this.searchTrainsBetweenStations(from, to, date);
  }

  private async saveToLearningDatabase(from: string, to: string, trains: any[]) {
    // Optional learning logic (kept as-is)
    try {
      const validTrains = trains.filter((t: any) => t.train_number && t.train_name);
      // ... (your existing upsert logic)
    } catch { }
  }

  getStatus() {
    return {
      service: "RapidAPI",
      role: "FALLBACK_2",
      keysConfigured: process.env.USE_DB_PROVIDERS === 'true' ? 'DB_CONFIG' : 'ENV_CONFIG',
      host: this.HOST
    };
  }
}

export const rapidApiService = new RapidApiService();
