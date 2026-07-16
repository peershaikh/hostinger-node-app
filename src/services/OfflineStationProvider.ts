import fs from 'fs';
import path from 'path';
import { winstonLogger } from '../middleware/logger';

export interface OfflineStationStats {
  aliasesCount: number;
  citiesCount: number;
}

export interface OfflineStationHealth {
  status: 'healthy' | 'unhealthy';
  error?: string;
}

export class OfflineStationProvider {
  private static aliases: Record<string, string[]> = {};
  private static cityMap: Record<string, string[]> = {};
  private static isInitialized = false;
  private static initError: string | undefined = undefined;

  /**
   * Recursively freezes an object to guarantee immutability.
   */
  private static deepFreeze<T extends object>(obj: T): T {
    const propNames = Reflect.ownKeys(obj);
    for (const name of propNames) {
      const value = (obj as any)[name];
      if (value && typeof value === 'object') {
        this.deepFreeze(value);
      }
    }
    return Object.freeze(obj);
  }

  /**
   * Validates schema: Record<string, string[]>
   */
  private static validateSchema(data: any, fileName: string): Record<string, string[]> {
    if (!data || typeof data !== 'object' || Array.isArray(data)) {
      throw new Error(`Schema validation failed for ${fileName}: Root is not an object.`);
    }

    const sanitized: Record<string, string[]> = {};

    for (const [key, val] of Object.entries(data)) {
      if (typeof key !== 'string') {
        throw new Error(`Schema validation failed for ${fileName}: Key is not a string.`);
      }
      if (!Array.isArray(val)) {
        throw new Error(`Schema validation failed for ${fileName}: Value for key "${key}" is not an array.`);
      }
      for (const item of val) {
        if (typeof item !== 'string') {
          throw new Error(`Schema validation failed for ${fileName}: Array item in key "${key}" is not a string.`);
        }
      }
      sanitized[key.toUpperCase().trim()] = val.map(v => v.toUpperCase().trim());
    }

    return sanitized;
  }

  /**
   * Initializes the provider by pre-loading and freezing alias and city configuration.
   * Designed to be called during application startup (fail-fast lifecycle).
   */
  public static async initialize(): Promise<void> {
    if (this.isInitialized) return;

    try {
      const aliasesPath = path.join(__dirname, '../data/offline_aliases.json');
      const cityPath = path.join(__dirname, '../data/cityStations.json');

      // 1. Load offline_aliases.json
      if (!fs.existsSync(aliasesPath)) {
        throw new Error(`Missing offline_aliases.json at path: ${aliasesPath}`);
      }
      const aliasesRaw = fs.readFileSync(aliasesPath, 'utf8');
      const aliasesParsed = JSON.parse(aliasesRaw);
      const validatedAliases = this.validateSchema(aliasesParsed, 'offline_aliases.json');

      // 2. Load cityStations.json
      if (!fs.existsSync(cityPath)) {
        throw new Error(`Missing cityStations.json at path: ${cityPath}`);
      }
      const cityRaw = fs.readFileSync(cityPath, 'utf8');
      const cityParsed = JSON.parse(cityRaw);
      const validatedCity = this.validateSchema(cityParsed, 'cityStations.json');

      // 3. Freeze configurations in memory
      this.aliases = this.deepFreeze(validatedAliases);
      this.cityMap = this.deepFreeze(validatedCity);
      this.isInitialized = true;
      this.initError = undefined;

      winstonLogger.info(
        `[OFFLINE_STATION] Successfully initialized. Loaded ${
          Object.keys(this.aliases).length
        } aliases and ${Object.keys(this.cityMap).length} cities.`
      );
    } catch (err: any) {
      this.initError = err.message;
      winstonLogger.error(`[OFFLINE_STATION] Initialization failed: ${err.message}`);
      throw err;
    }
  }

  /**
   * Resolves a city name or alias to actual IRCTC station codes offline.
   * Returns [key] if no offline mappings are found.
   */
  public static getStations(input: string): string[] {
    if (!this.isInitialized) {
      // Synchronous fallback warning in case it wasn't called during startup (e.g. unit tests)
      winstonLogger.warn('[OFFLINE_STATION] Provider not pre-initialized. Triggering lazy boot.');
      try {
        // Run sync-init for compatibility
        const aliasesPath = path.join(__dirname, '../data/offline_aliases.json');
        const cityPath = path.join(__dirname, '../data/cityStations.json');

        const aliasesRaw = fs.readFileSync(aliasesPath, 'utf8');
        const validatedAliases = this.validateSchema(JSON.parse(aliasesRaw), 'offline_aliases.json');

        const cityRaw = fs.readFileSync(cityPath, 'utf8');
        const validatedCity = this.validateSchema(JSON.parse(cityRaw), 'cityStations.json');

        this.aliases = this.deepFreeze(validatedAliases);
        this.cityMap = this.deepFreeze(validatedCity);
        this.isInitialized = true;
      } catch (err: any) {
        this.initError = err.message;
        winstonLogger.error(`[OFFLINE_STATION] Lazy initialization failed: ${err.message}`);
        return [input.toUpperCase().trim()];
      }
    }

    if (!input || typeof input !== 'string') return [];

    const match = input.match(/\(([^)]+)\)/);
    const rawKey = match ? match[1] : input;
    const key = rawKey.toUpperCase().trim();

    // 1. Resolve aliases
    if (this.aliases[key]) {
      return this.aliases[key];
    }

    // 2. Resolve city mappings
    if (this.cityMap[key]) {
      return this.cityMap[key];
    }

    // 3. Fallback: treat input as station code itself
    return [key];
  }

  /**
   * Checks if the alias key exists offline.
   */
  public static hasAlias(aliasName: string): boolean {
    if (!aliasName || typeof aliasName !== 'string') return false;
    const key = aliasName.toUpperCase().trim();
    return !!this.aliases[key];
  }

  /**
   * Checks if the city key exists offline.
   */
  public static hasCity(cityName: string): boolean {
    if (!cityName || typeof cityName !== 'string') return false;
    const key = cityName.toUpperCase().trim();
    return !!this.cityMap[key];
  }

  /**
   * Returns current health of the provider.
   */
  public static health(): OfflineStationHealth {
    if (this.initError) {
      return { status: 'unhealthy', error: this.initError };
    }
    return { status: this.isInitialized ? 'healthy' : 'unhealthy' };
  }

  /**
   * Returns provider statistics.
   */
  public static statistics(): OfflineStationStats {
    return {
      aliasesCount: Object.keys(this.aliases).length,
      citiesCount: Object.keys(this.cityMap).length,
    };
  }
}
