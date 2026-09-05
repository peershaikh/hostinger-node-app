import crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import { supabase } from '../config/supabase';
import { winstonLogger } from '../middleware/logger';
import { cacheService } from './cacheService';

const ENCRYPTION_ALGORITHM = 'aes-256-gcm';

export class ProviderConfigService {
  private readonly CACHE_TTL = 300; // 5 minutes

  // Circuit Breaker State (Per Provider)
  private consecutiveFailures: Record<string, number> = {};
  private circuitOpenUntil: Record<string, number> = {};

  // Telemetry Counters
  private telemetry = {
    circuit_open_count: 0,
    circuit_half_open_count: 0,
    circuit_recovery_count: 0
  };

  public isCircuitBreakerBlocked(providerName: string): boolean {
    const nameUpper = providerName.toUpperCase();
    const now = Date.now();
    return (this.consecutiveFailures[nameUpper] || 0) >= 3 && now < (this.circuitOpenUntil[nameUpper] || 0);
  }

  /**
   * Checks if a provider is active, healthy, and configured.
   */
  public async isProviderEnabled(providerName: string): Promise<{ enabled: boolean; reason: string }> {
    const nameUpper = providerName.toUpperCase();
    const now = Date.now();

    if (this.isCircuitBreakerBlocked(nameUpper)) {
      if (nameUpper === 'IRCTC') {
        return { enabled: true, reason: 'ENV_FALLBACK' };
      }
      return { enabled: false, reason: 'CIRCUIT_BREAKER_BLOCKED' };
    }

    // 2. P0.3 (PHASE_4C811): Short-TTL result cache — effectively per-request scope.
    // A rescue scan runs all hub/leg checks within <20s; provider config changes on the
    // order of minutes. A 10s TTL reduces up to 8 Supabase DB queries to 1 per provider.
    const enabledCacheKey = `prov_enabled_${nameUpper}`;
    const cachedResult = cacheService.get<{ enabled: boolean; reason: string }>(enabledCacheKey);
    if (cachedResult) return cachedResult;

    const _cache = (r: { enabled: boolean; reason: string }) => {
      cacheService.set(enabledCacheKey, r, 10); // 10s TTL
      return r;
    };

    // 3. Check DB status if USE_DB_PROVIDERS is true
    const useDb = process.env.USE_DB_PROVIDERS === 'true';
    if (useDb) {
      try {
        const { data, error } = await supabase
          .from('api_providers')
          .select('enabled, health_status')
          .eq('provider_name', nameUpper)
          .eq('is_deleted', false)
          .limit(1)
          .maybeSingle();

        if (error) throw error;

        if (!data) {
          // No DB row found -> check env fallback
          const envKeys = this.getEnvFallback(nameUpper);
          return _cache(envKeys.length === 0
            ? { enabled: false, reason: 'PROVIDER_NOT_CONFIGURED' }
            : { enabled: true, reason: 'ACTIVE_ENV_FALLBACK' });
        }

        if (data.enabled !== true) {
          return _cache({ enabled: false, reason: 'PROVIDER_DISABLED' });
        }

        if (data.health_status && data.health_status.toUpperCase() === 'DISABLED') {
          return _cache({ enabled: false, reason: 'PROVIDER_UNHEALTHY' });
        }

        // PHASE_4C981 — Bug 3: DB row exists and is active. Return immediately.
        // Do NOT fall through to the env-key fallback — providers configured in the
        // database do not require environment API keys to be considered enabled.
        return _cache({ enabled: true, reason: 'ACTIVE_DB' });
      } catch (err: any) {
        winstonLogger.warn(`[isProviderEnabled] DB check failed for ${nameUpper}: ${err.message}. Falling back to env.`);
      }
    }

    // 4. Check environment configuration fallback
    const envKeys = this.getEnvFallback(nameUpper);
    return _cache(envKeys.length === 0
      ? { enabled: false, reason: 'PROVIDER_NOT_CONFIGURED' }
      : { enabled: true, reason: 'ACTIVE' });
  }


  /**
   * Retrieves the ENCRYPTION_KEY from environment variables.
   * Required for decrypting the provider API keys securely.
   */
  private getEncryptionKey(): Buffer {
    let keyString = process.env.ENCRYPTION_KEY;
    if (!keyString) {
      // Deterministic 32-byte fallback key for dev/test environments
      keyString = '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';
    }
    // Expected a 32-byte hex string (64 chars) or base64
    if (keyString.length === 64) {
      return Buffer.from(keyString, 'hex');
    }
    // Fallback if someone used a 32 char plain string (not recommended but possible)
    const buf = Buffer.alloc(32);
    buf.write(keyString);
    return buf;
  }

  /**
   * Decrypts an AES-256-GCM encrypted string.
   * Format expected: "ivHex:authTagHex:encryptedHex"
   */
  public decryptKey(encryptedText: string): string {
    try {
      const parts = encryptedText.split(':');
      if (parts.length !== 3) {
        throw new Error('Invalid encrypted string format. Expected iv:tag:content');
      }

      const iv = Buffer.from(parts[0], 'hex');
      const authTag = Buffer.from(parts[1], 'hex');
      const content = Buffer.from(parts[2], 'hex');

      const decipher = crypto.createDecipheriv(ENCRYPTION_ALGORITHM, this.getEncryptionKey(), iv);
      decipher.setAuthTag(authTag);

      let decrypted = decipher.update(content);
      decrypted = Buffer.concat([decrypted, decipher.final()]);

      return decrypted.toString('utf8');
    } catch (error: any) {
      winstonLogger.error(`[ProviderConfigService] Failed to decrypt API key: ${error.message}`);
      throw error;
    }
  }

  private readonly SECURE_KEYS_FILE = path.join(__dirname, '../../data/secure_provider_keys.json');

  public getSecureLocalKey(providerName: string): string | null {
    try {
      if (fs.existsSync(this.SECURE_KEYS_FILE)) {
        const raw = fs.readFileSync(this.SECURE_KEYS_FILE, 'utf8');
        const parsed = JSON.parse(raw);
        const nameUpper = providerName.toUpperCase().trim();
        const enc = parsed[nameUpper];
        if (enc) {
          return this.decryptKey(enc);
        }
      }
    } catch (e: any) {
      winstonLogger.warn(`[ProviderConfigService] Failed to read secure local key for ${providerName}: ${e.message}`);
    }
    return null;
  }

  public saveSecureLocalKey(providerName: string, rawKey: string | null): void {
    try {
      const dir = path.dirname(this.SECURE_KEYS_FILE);
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

      let parsed: Record<string, string> = {};
      if (fs.existsSync(this.SECURE_KEYS_FILE)) {
        try {
          parsed = JSON.parse(fs.readFileSync(this.SECURE_KEYS_FILE, 'utf8'));
        } catch {}
      }

      const nameUpper = providerName.toUpperCase().trim();
      if (rawKey && rawKey.trim().length > 0) {
        parsed[nameUpper] = this.encryptKey(rawKey.trim());
      } else {
        delete parsed[nameUpper];
      }

      fs.writeFileSync(this.SECURE_KEYS_FILE, JSON.stringify(parsed, null, 2), 'utf8');
    } catch (e: any) {
      winstonLogger.warn(`[ProviderConfigService] Failed to persist secure local key: ${e.message}`);
    }
  }

  /**
   * Encrypts a raw string using AES-256-GCM.
   * Used by the Admin API when saving new keys.
   */
  public encryptKey(rawKey: string): string {
    try {
      const iv = crypto.randomBytes(12);
      const cipher = crypto.createCipheriv(ENCRYPTION_ALGORITHM, this.getEncryptionKey(), iv);

      let encrypted = cipher.update(rawKey, 'utf8');
      encrypted = Buffer.concat([encrypted, cipher.final()]);

      const authTag = cipher.getAuthTag();

      return `${iv.toString('hex')}:${authTag.toString('hex')}:${encrypted.toString('hex')}`;
    } catch (error: any) {
      winstonLogger.error(`[ProviderConfigService] Failed to encrypt API key: ${error.message}`);
      throw error;
    }
  }

  /**
   * Fetches active API keys for a given provider from the database.
   * Falls back to .env if the DB fails, the feature flag is off, or the DB returns empty.
   */
  public async getKeysFor(providerName: string): Promise<string[]> {
    const useDb = process.env.USE_DB_PROVIDERS === 'true';
    const now = Date.now();

    if (!useDb) {
      winstonLogger.debug(`[ProviderConfigService] USE_DB_PROVIDERS is false. Using .env fallback for ${providerName}`);
      return this.getEnvFallback(providerName);
    }

    // Circuit Breaker Bypass
    if ((this.consecutiveFailures[providerName] || 0) >= 3) {
      if (now < (this.circuitOpenUntil[providerName] || 0)) {
        return this.getEnvFallback(providerName);
      } else {
        winstonLogger.info(`[CIRCUIT_BREAKER_HALF_OPEN] Probing DB recovery for ${providerName}`);
        this.telemetry.circuit_half_open_count++;
      }
    }

    const cacheKey = `provider_keys_${providerName}`;
    const cachedKeys = cacheService.get<string[]>(cacheKey);

    if (cachedKeys && cachedKeys.length > 0) {
      return cachedKeys;
    }

    try {
      const { data, error } = await supabase
        .from('api_providers')
        .select('api_key, enabled')
        .eq('provider_name', providerName)
        .eq('is_deleted', false)
        .order('priority', { ascending: true });

      if (error) {
        throw error;
      }

      if (!data || data.length === 0) {
        winstonLogger.warn(`[ProviderConfigService] No active DB keys found for ${providerName}. Falling back to .env.`);
        return this.getEnvFallback(providerName);
      }

      const activeRows = data.filter((row: any) => row.enabled === true);
      if (activeRows.length === 0) {
        winstonLogger.info(`[PROVIDER_DISABLED] ${providerName} is explicitly disabled in DB. Skipping fallback.`);
        return [];
      }

      const keys: string[] = [];
      for (const row of activeRows) {
        try {
          // Attempt to decrypt. If a key is unencrypted plain text (legacy), we could catch the format error 
          // and just use it, but for strict security, we enforce AES format.
          if (row.api_key && row.api_key.includes(':')) {
             keys.push(this.decryptKey(row.api_key));
          } else {
             // If they bypassed encryption (e.g. manual DB edit), log a warning but use it to prevent outage
             winstonLogger.warn(`[ProviderConfigService] Found unencrypted plain-text key for ${providerName}. Please rotate immediately!`);
             keys.push(row.api_key);
          }
        } catch (decryptionError) {
          // Logged inside decryptKey
        }
      }

      if (keys.length === 0) {
        winstonLogger.error(`[ProviderConfigService] Decryption failed for all DB keys of ${providerName}. Falling back to .env.`);
        return this.getEnvFallback(providerName);
      }

      winstonLogger.info(`[PROVIDER_DB_OVERRIDE] Loaded active keys from DB for provider: ${providerName}`);

      // Cache the successfully decrypted keys
      cacheService.set(cacheKey, keys, this.CACHE_TTL);
      
      // Reset circuit breaker on success
      if ((this.consecutiveFailures[providerName] || 0) >= 3) {
        winstonLogger.info(`[CIRCUIT_BREAKER_RECOVERED] DB connection restored for ${providerName}`);
        this.telemetry.circuit_recovery_count++;
      }
      this.consecutiveFailures[providerName] = 0;
      
      return keys;

    } catch (error: any) {
      this.consecutiveFailures[providerName] = (this.consecutiveFailures[providerName] || 0) + 1;
      
      if (this.consecutiveFailures[providerName] === 3) {
        this.circuitOpenUntil[providerName] = now + (180 * 1000); // 3 minutes
        this.telemetry.circuit_open_count++;
        winstonLogger.error(`[CIRCUIT_BREAKER_OPEN] DB unavailable. Bypassing for 3 minutes.`);
      }
      
      winstonLogger.error(`[ProviderConfigService] DB fetch failed for ${providerName}: ${error.message}. Falling back to .env.`);
      return this.getEnvFallback(providerName);
    }
  }

  /**
   * Strict `.env` Fallback Logic ensuring byte-for-byte behavioral equivalency
   */
  private getEnvFallback(providerName: string): string[] {
    const keys: string[] = [];
    const nameUpper = providerName.toUpperCase();

    // Check secure encrypted local storage first (admin-managed key override)
    const localKey = this.getSecureLocalKey(nameUpper);
    if (localKey && localKey.trim().length > 0) {
      keys.push(localKey.trim());
      return keys;
    }

    if (nameUpper === 'IRCTC') {
      const k = process.env.IRCTC_CONNECT_API_KEY || process.env.IRCTC_API_KEY || process.env.IRCTC_API_KEY_PRIMARY || '';
      if (k) keys.push(k.trim());
    } else if (nameUpper === 'RAPIDAPI') {
      // RapidAPI is deprecated. Return empty key set to fail fast without external calls.
      return [];
    } else if (nameUpper === 'RAILRADAR') {
      const k = process.env.RAILRADAR_API_KEY || '';
      if (k) keys.push(k.trim());
    } else if (nameUpper === 'RAILYATRI') {
      const k = process.env.RAILYATRI_API_KEY || process.env.RAPIDAPI_KEY || '';
      if (k) keys.push(k.trim());
    } else if (nameUpper === 'CONFIRMTKT') {
      const k = process.env.CONFIRMTKT_API_KEY || process.env.RAPIDAPI_KEY || '';
      if (k) keys.push(k.trim());
    }

    if (keys.length === 0) {
      winstonLogger.warn(`[PROVIDER_MISSING_KEY] No API key found for provider: ${providerName}`);
    }

    return keys;
  }

  /**
   * Feature configuration check for Inter-Station Transfers (Phase 4C).
   * Defaults to false unless process.env.ENABLE_INTER_STATION_TRANSFERS === 'true'.
   */
  public isInterStationTransfersEnabled(): boolean {
    return process.env.ENABLE_INTER_STATION_TRANSFERS === 'true';
  }

  /**
   * Admin utility to clear cache explicitly after updates.
   */
  public flushCache(providerName?: string) {
    cacheService.del('all_provider_configs');
    if (providerName) {
      const nameUpper = providerName.toUpperCase().trim();
      cacheService.del(`provider_keys_${nameUpper}`);
      cacheService.del(`prov_enabled_${nameUpper}`);
    } else {
      cacheService.del('provider_keys_IRCTC');
      cacheService.del('provider_keys_RAPIDAPI');
      cacheService.del('provider_keys_RAILRADAR');
      cacheService.del('provider_keys_RAILYATRI');
      cacheService.del('provider_keys_CONFIRMTKT');
      cacheService.del('prov_enabled_IRCTC');
      cacheService.del('prov_enabled_RAPIDAPI');
      cacheService.del('prov_enabled_RAILRADAR');
      cacheService.del('prov_enabled_RAILYATRI');
      cacheService.del('prov_enabled_CONFIRMTKT');
      cacheService.del('prov_enabled_DATABASE');
    }
  }

  /**
   * Retrieves all provider records from DB (or default fallback) ordered by priority.
   */
  public async getProviderConfigs(): Promise<Array<{ provider_name: string; priority: number; enabled: boolean; health_status: string }>> {
    const cacheKey = 'all_provider_configs';
    const cached = cacheService.get<any[]>(cacheKey);
    if (cached) return cached;

    const useDb = process.env.USE_DB_PROVIDERS === 'true';
    if (useDb) {
      try {
        const { data, error } = await supabase
          .from('api_providers')
          .select('provider_name, priority, enabled, health_status')
          .eq('is_deleted', false)
          .order('priority', { ascending: true });

        if (!error && data && data.length > 0) {
          const hasAnyLiveEnabled = data.some((r: any) => r.enabled === true && (r.provider_name || '').toUpperCase() !== 'DATABASE');
          
          let effectiveData = [...data];
          if (!hasAnyLiveEnabled) {
            // Migration safety: If no live provider is enabled in DB, fallback to enabling IRCTC as primary (via .env key)
            let irctcFound = false;
            effectiveData = effectiveData.map((r: any) => {
              if ((r.provider_name || '').toUpperCase() === 'IRCTC') {
                irctcFound = true;
                return { ...r, enabled: true, priority: r.priority || 1, health_status: 'ACTIVE' };
              }
              return r;
            });
            if (!irctcFound) {
              effectiveData.unshift({ provider_name: 'IRCTC', priority: 1, enabled: true, health_status: 'ACTIVE' });
            }
          }

          const hasDb = effectiveData.some((r: any) => (r.provider_name || '').toUpperCase() === 'DATABASE');
          const finalConfigs = hasDb ? effectiveData : [
            ...effectiveData,
            { provider_name: 'DATABASE', priority: 99, enabled: true, health_status: 'ACTIVE' }
          ];
          cacheService.set(cacheKey, finalConfigs, 10); // 10s TTL
          return finalConfigs;
        }
      } catch (err: any) {
        winstonLogger.warn(`[getProviderConfigs] DB fetch failed: ${err.message}. Falling back to defaults.`);
      }
    }

    // Default fallback configurations
    const defaultConfigs = [
      { provider_name: 'IRCTC', priority: 1, enabled: true, health_status: 'ACTIVE' },
      { provider_name: 'RAILRADAR', priority: 2, enabled: true, health_status: 'ACTIVE' },
      { provider_name: 'CONFIRMTKT', priority: 3, enabled: true, health_status: 'ACTIVE' },
      { provider_name: 'RAILYATRI', priority: 4, enabled: true, health_status: 'ACTIVE' },
      { provider_name: 'RAPIDAPI', priority: 5, enabled: false, health_status: 'DISABLED' },
      { provider_name: 'DATABASE', priority: 99, enabled: true, health_status: 'ACTIVE' },
    ];
    cacheService.set(cacheKey, defaultConfigs, 10);
    return defaultConfigs;
  }
}

export const providerConfigService = new ProviderConfigService();

