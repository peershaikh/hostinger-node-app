import { winstonLogger } from '../middleware/logger';
import { featureFlags } from '../config/featureFlags';
import { cacheService } from './cacheService';
import { providerConfigService } from './providerConfigService';

// ── PHASE_087N49 — Sync-specific classified result type ───────────────────────
// Used ONLY by getTrainInfoForSync(). All existing public methods are unchanged.
// This type lives here so the sync job can import it without a separate file.

export type TrainInfoResultKind =
  | 'VALID_SCHEDULE'
  | 'EXPECTED_NO_DATA'
  | 'RATE_LIMITED_429'
  | 'AUTH_FAILURE'
  | 'TIMEOUT'
  | 'NETWORK_FAILURE'
  | 'PROVIDER_5XX'
  | 'MALFORMED_RESPONSE';

export interface TrainInfoResult {
  kind: TrainInfoResultKind;
  /** Populated only when kind === 'VALID_SCHEDULE'. */
  data?: any;
  /** Retry-After seconds parsed from provider header, if available. */
  retryAfterSeconds?: number;
}

// PHASE_4C862 — codes passed here are already resolved by trainStationResolver in availabilityProvider.
function sanitizeStationCode(code: string): string {
  return (code || '').toUpperCase().trim();
}


// Module-level handle — populated by the async init on first use.
let irctc: any = null;

export class IrctcService {
  private initialized = false;
  private initPromise: Promise<void> | null = null;
  private apiKey: string = '';

  // PHASE_4C931 TASK 4: retry state
  private _initRetryCount = 0;
  private _initRetryTimer: ReturnType<typeof setTimeout> | null = null;
  private static readonly INIT_MAX_RETRIES = 3;
  private static readonly INIT_RETRY_INTERVAL_MS = 10_000;  // 10s for first 3 retries
  private static readonly INIT_BACKOFF_INTERVAL_MS = 60_000; // 60s perpetual after that

  constructor() {
    // Kick off async init immediately so the first real request
    // doesn't bear the full init latency.
    this.initPromise = this._init();
  }

  // ── Async initializer ─────────────────────────────────────────────────────
  // Uses dynamic import() which works across the ESM / CJS boundary.
  // The server compiles to CommonJS (tsconfig: "module": "commonjs") but
  // irctc-connect v3 ships as a pure ESM package ("type": "module").
  // require() cannot load ESM; await import() can.
  private async _init(): Promise<void> {
    try {
      const keys = await providerConfigService.getKeysFor('IRCTC');
      if (keys.length > 0) {
        this.apiKey = keys[0];
      }
    } catch (err: any) {
      winstonLogger.error(`[IRCTC] Failed to load keys from provider config: ${err.message}`);
    }

    if (!this.apiKey) {
      // PHASE_4C931 TASK 4: schedule retry instead of giving up permanently
      winstonLogger.warn('[IRCTC_INIT_FAIL] No API key found — scheduling retry.');
      this._scheduleInitRetry();
      return;
    }

    try {
      // Dynamic import — handles ESM packages from a CJS host.
      const mod = await import('irctc-connect');

      // ESM default export may be wrapped: prefer .default, fall back to mod itself.
      const lib = (mod as any).default ?? mod;

      if (typeof lib.configure !== 'function') {
        winstonLogger.error('[IRCTC_INIT_FAIL] irctc-connect loaded but configure() not found — package API may have changed.');
        this._scheduleInitRetry();
        return;
      }

      lib.configure(this.apiKey);
      irctc = lib;
      this.initialized = true;
      this._initRetryCount = 0; // reset on success
      winstonLogger.info('[IRCTC_INIT_SUCCESS] irctc-connect initialized successfully. Availability and PNR features active.');
    } catch (e: any) {
      winstonLogger.error(`[IRCTC_INIT_FAIL] Dynamic import of irctc-connect failed: ${e.message}`);
      this._scheduleInitRetry();
    }
  }

  // PHASE_4C931 TASK 4: Retry initializer — never stays permanently broken.
  // First 3 failures: retry every 10s.
  // After that: retry every 60s indefinitely.
  private _scheduleInitRetry(): void {
    if (this.initialized) return; // already succeeded — no-op
    if (this._initRetryTimer) return; // already scheduled — no double-schedule

    this._initRetryCount++;
    const delayMs = this._initRetryCount <= IrctcService.INIT_MAX_RETRIES
      ? IrctcService.INIT_RETRY_INTERVAL_MS
      : IrctcService.INIT_BACKOFF_INTERVAL_MS;

    winstonLogger.warn(
      `[IRCTC_INIT_RETRY] Attempt ${this._initRetryCount} scheduled in ${delayMs / 1000}s.` +
      (this._initRetryCount > IrctcService.INIT_MAX_RETRIES ? ' (backoff mode)' : '')
    );

    this._initRetryTimer = setTimeout(async () => {
      this._initRetryTimer = null;
      this.apiKey = ''; // reset so getKeysFor() is re-queried fresh
      this.initPromise = this._init();
      await this.initPromise;
      if (!this.initialized) {
        winstonLogger.warn(`[IRCTC_INIT_RETRY] Attempt ${this._initRetryCount} failed — will retry.`);
      } else {
        winstonLogger.info(`[IRCTC_INIT_SUCCESS] Initialized on retry attempt ${this._initRetryCount}.`);
      }
    }, delayMs);
  }

  // ── Startup warmup ────────────────────────────────────────────────────────
  // P0 (PHASE_4C814): Called from startServer() in index.ts BEFORE httpServer.listen().
  // Awaiting this guarantees irctc-connect is fully loaded and configured before
  // Render routes any traffic to the instance. The first user request will NEVER
  // block on initPromise or the ESM cold parse of irctc-connect.
  //
  // After the first call resolves, subsequent awaits return instantly (~0ms).
  public async warmup(): Promise<void> {
    if (this.initPromise) await this.initPromise;
  }

  // ── Lazy init guard ───────────────────────────────────────────────────────
  // Internal guard: every public method awaits this before proceeding.
  // Post-warmup this is a synchronous no-op (initPromise already resolved).
  private async ensureInit(): Promise<void> {
    if (this.initPromise) await this.initPromise;
  }

  private isReady(): boolean {
    if (!this.initialized || !irctc) {
      winstonLogger.warn('[IRCTC] Service not initialized. Availability unavailable.');
      return false;
    }
    return true;
  }

  // ====================== CORE METHODS ======================

  /** Check PNR Status */
  async checkPNRStatus(pnr: string) {
    await this.ensureInit();
    if (!this.isReady() || !pnr) return null;

    const cacheKey = `pnr_${pnr}`;
    const cached = cacheService.get(cacheKey);
    if (cached) return cached;

    try {
      winstonLogger.info(`[IRCTC_PNR] Fetching PNR ${pnr}`);
      const data = await irctc.checkPNRStatus(pnr.trim());

      if (data && (data.success === false || data.error)) {
        const errStr = data.error || 'API reported failure';
        if (errStr.toLowerCase().includes('api key') || errStr.toLowerCase().includes('invalid key')) {
          winstonLogger.error(`[PROVIDER_INVALID_KEY] IRCTC: ${errStr}`);
        }
        winstonLogger.error(`[IRCTC_PNR_FAILED] ${pnr}: ${errStr}`);
        return null;
      }

      cacheService.set(cacheKey, data, 300); // 5 min
      winstonLogger.info(`[IRCTC_PNR_SUCCESS] ${pnr}`);
      return data;
    } catch (e: any) {
      const errStr = e.message || '';
      if (errStr.toLowerCase().includes('api key') || errStr.toLowerCase().includes('invalid key')) {
        winstonLogger.error(`[PROVIDER_INVALID_KEY] IRCTC: ${errStr}`);
      }
      winstonLogger.error(`[IRCTC_PNR_FAILED] ${pnr}: ${errStr}`);
      return null;
    }
  }

  /** Get Train Live Info (static schedule/route — no delay data) */
  async getTrainInfo(trainNo: string) {
    await this.ensureInit();
    if (!this.isReady() || !trainNo) return null;

    const cacheKey = `traininfo_${trainNo}`;
    const cached = cacheService.get(cacheKey);
    if (cached) return cached;

    try {
      winstonLogger.info(`[IRCTC_LIVE] Fetching train ${trainNo}`);
      // P0.2 (PHASE_4C811): 8s timeout guard — mirrors the pattern in getAvailability().
      // Without this guard, a slow IRCTC getTrainInfo() blocks the entire rescue budget.
      const infoPromise = irctc.getTrainInfo(trainNo.trim());
      let infoTimer: NodeJS.Timeout | undefined;
      const infoTimeout = new Promise((_, reject) => {
        infoTimer = setTimeout(() => reject(new Error('getTrainInfo timeout (18s)')), 18000);
      });
      const data = await Promise.race([infoPromise, infoTimeout]).finally(() => {
        if (infoTimer) clearTimeout(infoTimer);
      }) as any;

      const result = data?.data || data;
      if (result) {
        if (result.success === false || result.error) {
          const errStr = result.error || 'API reported failure';
          if (errStr.toLowerCase().includes('api key') || errStr.toLowerCase().includes('invalid key')) {
            winstonLogger.error(`[PROVIDER_INVALID_KEY] IRCTC: ${errStr}`);
          }
          winstonLogger.error(`[IRCTC_LIVE_FAILED] ${trainNo}: ${errStr}`);
          return null;
        }
        cacheService.set(cacheKey, result, 7200); // 2 hours
        winstonLogger.info(`[IRCTC_LIVE_SUCCESS] ${trainNo}`);
        return result;
      }
      return null;
    } catch (e: any) {
      const errStr = e.message || '';
      if (errStr.toLowerCase().includes('api key') || errStr.toLowerCase().includes('invalid key')) {
        winstonLogger.error(`[PROVIDER_INVALID_KEY] IRCTC: ${errStr}`);
      }
      winstonLogger.error(`[IRCTC_LIVE_FAILED] ${trainNo}: ${errStr}`);
      return null;
    }
  }

  /**
   * Get real-time live running status with station-wise delays.
   * Uses trackTrain() — the correct SDK function for live data.
   * Returns: { trainNo, trainName, statusNote, lastUpdate, stations: [...] }
   * where stations[n].departure.delay = "On Time" | "15 Min Late" | ""
   */
  async getLiveStatus(trainNo: string, date?: string) {
    await this.ensureInit();
    if (!this.isReady() || !trainNo) return null;

    let dateStr = '';
    if (date && typeof date === 'string' && date.includes('-')) {
      const parts = date.split('-');
      if (parts[0].length === 4) {
        dateStr = `${parts[2]}-${parts[1]}-${parts[0]}`;
      } else {
        dateStr = date;
      }
    } else {
      const now = new Date();
      const utcMs = now.getTime() + now.getTimezoneOffset() * 60000;
      const istNow = new Date(utcMs + 5.5 * 3600000);
      const dd   = String(istNow.getDate()).padStart(2, '0');
      const mm   = String(istNow.getMonth() + 1).padStart(2, '0');
      const yyyy = istNow.getFullYear();
      dateStr = `${dd}-${mm}-${yyyy}`;
    }

    const cacheKey = `live_track_${trainNo}_${dateStr}`;
    const cached = cacheService.get(cacheKey);
    if (cached) return cached;

    try {
      winstonLogger.info(`[IRCTC_TRACK] Fetching live status for ${trainNo} on date ${dateStr}`);

      const data = await irctc.trackTrain(trainNo.trim(), dateStr);
      const result = data?.data || data;

      if (result) {
        if (result.success === false || result.error) {
          const errStr = result.error || 'API reported failure';
          if (errStr.toLowerCase().includes('api key') || errStr.toLowerCase().includes('invalid key')) {
            winstonLogger.error(`[PROVIDER_INVALID_KEY] IRCTC: ${errStr}`);
          }
          winstonLogger.error(`[IRCTC_TRACK_FAILED] ${trainNo}: ${errStr}`);
          return null;
        }
        cacheService.set(cacheKey, result, 60); // 60s — live data, short TTL
        winstonLogger.info(`[IRCTC_TRACK_SUCCESS] ${trainNo}`);
        return result;
      }
      return null;
    } catch (e: any) {
      const errStr = e.message || '';
      if (errStr.toLowerCase().includes('api key') || errStr.toLowerCase().includes('invalid key')) {
        winstonLogger.error(`[PROVIDER_INVALID_KEY] IRCTC: ${errStr}`);
      }
      winstonLogger.error(`[IRCTC_TRACK_FAILED] ${trainNo}: ${errStr}`);
      return null;
    }
  }

  /** Search Trains Between Stations (Most Important) */
  async search(from: string, to: string, date: string) {
    await this.ensureInit();
    if (!this.isReady() || !from || !to || !date) return [];

    const cacheKey = `search_${from}_${to}_${date}`;
    const cached = cacheService.get<any>(cacheKey);
    // PHASE_4C931 TASK 1: Guard — do NOT serve a cached empty array.
    // If cached is a non-empty array, serve it. If empty array, treat as cache miss.
    if (Array.isArray(cached) && cached.length > 0) return cached;
    // (null or empty array from cache → fall through to live call)

    try {
      winstonLogger.info(`[API_PRIMARY_ACTIVE] IRCTC Search: ${from} → ${to} | ${date}`);

      // Format date as DD-MM-YYYY (IRCTC requirement)
      let formattedDate = date.trim();
      if (formattedDate.includes('-') && formattedDate.split('-')[0].length === 4) {
        const [y, m, d] = formattedDate.split('-');
        formattedDate = `${d}-${m}-${y}`;
      }

      const data = await irctc.searchTrainBetweenStations(
        from.toUpperCase().trim(),
        to.toUpperCase().trim(),
        formattedDate
      );

      const results = data?.data || data?.trains || data || [];
      const finalResults = Array.isArray(results) ? results : (results.trains || results.data || []);

      // PHASE_4C931 TASK 1: Never cache empty arrays for 30 minutes.
      // An empty response means IRCTC returned nothing for this query right now —
      // it may succeed on the next request (rate-limit reset, transient error, etc.).
      // We use a 45s negative-cache TTL to prevent hammering while still allowing
      // rapid retry — within the 30–60s spec from PHASE_4C931 requirements.
      if (finalResults.length > 0) {
        cacheService.set(cacheKey, finalResults, 1800); // 30 min — only for real results
        winstonLogger.info(`[IRCTC_SUCCESS] Found ${finalResults.length} trains ${from}→${to}`);
      } else {
        cacheService.set(cacheKey, finalResults, 45); // 45s negative-cache
        winstonLogger.warn(
          `[IRCTC_EMPTY_RESULT] ${from}→${to} on ${date} returned 0 trains from IRCTC. ` +
          `Negative-cached for 45s. Next live call in ~45s.`
        );
      }

      return finalResults;
    } catch (e: any) {
      winstonLogger.error(`[IRCTC_SEARCH_FAILED] ${from}→${to}: ${e.message}`);
      return [];
    }
  }

  async getAvailability(
    trainNo: string,
    date: string,
    from: string,
    to: string,
    classType: string = '3A',
    quota: string = 'GN',
    options?: { bypassCache?: boolean }
  ) {
    await this.ensureInit();
    if (!this.isReady()) {
      winstonLogger.error(`[IRCTC_AVAIL_DEAD] Service not initialized — cannot fetch availability for train ${trainNo}`);
      return null;
    }

    const fromNorm = sanitizeStationCode(from);
    const toNorm = sanitizeStationCode(to);
    const quotaNorm = (quota || 'GN').toUpperCase().trim();
    const classNorm = (classType || '3A').toUpperCase().trim();

    const skipCache = options?.bypassCache === true || featureFlags.smartAvailCache;
    if (!skipCache) {
      const cached = cacheService.lookupAvailabilityCache(
        trainNo, fromNorm, toNorm, date, quotaNorm, classNorm
      );
      if (cached) return cached;
    }

    try {
      winstonLogger.info(`[IRCTC_AVAIL_INPUT] train=${trainNo} from=${fromNorm} to=${toNorm} date=${date} cls=${classType} quota=${quota}`);

      // IRCTC requires date in DD-MM-YYYY format
      let formattedDate = date.trim();
      if (formattedDate.includes('-') && formattedDate.split('-')[0].length === 4) {
        const [y, m, d] = formattedDate.split('-');
        formattedDate = `${d}-${m}-${y}`;
      }

      const irctcPromise = irctc.getAvailability(
        trainNo.trim(),
        fromNorm,
        toNorm,
        formattedDate,
        classType.toUpperCase(),
        quota.toUpperCase()
      );

      let availTimer: NodeJS.Timeout | undefined;
      const timeoutPromise = new Promise((_, reject) => {
        availTimer = setTimeout(() => reject(new Error('API Timeout (18s)')), 18000);
      });

      const data = await Promise.race([irctcPromise, timeoutPromise]).finally(() => {
        if (availTimer) clearTimeout(availTimer);
      }) as any;

      // FIX-4: log which classes the SDK actually returned vs what was requested
      if (data && typeof data === 'object') {
        const returnedKeys = Array.isArray(data) ? 'ARRAY' : Object.keys(data).join(',');
        winstonLogger.info(`[IRCTC_AVAIL_RESPONSE] train=${trainNo} requestedClass=${classType} returnedKeys=${returnedKeys}`);
      }

      // PHASE_4C870 — cache writes only when not routed through SmartAvailabilityService
      if (
        !skipCache &&
        data &&
        typeof data === 'object' &&
        data.success !== false
      ) {
        cacheService.storeAvailabilityCache(
          trainNo, fromNorm, toNorm, date, quotaNorm, classNorm, data, 300
        );
      }

      return data;
    } catch (e: any) {
      const errMsg = (e.message || '').toLowerCase();
      winstonLogger.warn(`[IRCTC_AVAIL_FAIL] ${trainNo}: ${e.message}`);

      // Propagate known semantic errors as structured objects
      // so downstream can classify them
      if (errMsg.includes('class does not exist') ||
          errMsg.includes('not available') ||
          errMsg.includes('invalid') ||
          errMsg.includes('does not run') ||
          errMsg.includes('unable to process your request') ||
          errMsg.includes('bad request') ||
          errMsg.includes('not found')) {
        return { success: false, error: e.message };
      }

      return null;
    }
  }

  /** Get Fare Breakdown */
  async fareLookup(
    trainNo: string,
    from: string,
    to: string,
    date: string,
    classType: string,
    quota: string = 'GN'
  ) {
    await this.ensureInit();
    if (!this.isReady() || !trainNo) return null;

    const cacheKey = `fare_${trainNo}_${from}_${to}_${date}_${classType}_${quota}`;
    const cached = cacheService.get(cacheKey);
    if (cached) return cached;

    try {
      winstonLogger.info(`[IRCTC_FARE] Fetching fare for train=${trainNo} class=${classType} quota=${quota}`);
      
      // IRCTC requires date in DD-MM-YYYY format
      let formattedDate = date.trim();
      if (formattedDate.includes('-') && formattedDate.split('-')[0].length === 4) {
        const [y, m, d] = formattedDate.split('-');
        formattedDate = `${d}-${m}-${y}`;
      }

      const data = await irctc.fareLookup(
        trainNo.trim(),
        from.toUpperCase().trim(),
        to.toUpperCase().trim(),
        formattedDate,
        classType.toUpperCase(),
        quota.toUpperCase()
      );

      if (data && typeof data === 'object' && data.success !== false) {
        cacheService.set(cacheKey, data, 86400); // Cache fare for 24 hours
      }
      return data;
    } catch (err: any) {
      winstonLogger.error(`[IRCTC_FARE_FAILED] train=${trainNo}: ${err.message}`);
      return null;
    }
  }

  getStatus() {
    return {
      service: "IRCTC",
      initialized: this.initialized,
      hasApiKey: !!this.apiKey,
      keySource: process.env.USE_DB_PROVIDERS === 'true' ? 'DB_CONFIG_OR_FALLBACK' : 'ENV_FALLBACK',
      role: "PRIMARY_API"
    };
  }

  // ── PHASE_087N49 — Sync-only classified fetch ────────────────────────────────
  //
  // Returns a TrainInfoResult discriminated union instead of null|data.
  // Used EXCLUSIVELY by trainScheduleSyncJob. Do NOT call from user-facing paths.
  //
  // Classification logic:
  //   VALID_SCHEDULE     — response contains a non-empty station array
  //   EXPECTED_NO_DATA   — provider returned success=false / known "no data" error
  //   RATE_LIMITED_429   — HTTP 429 or rate-limit message in error text
  //   AUTH_FAILURE       — API key rejected (401/403 or "api key" in error)
  //   TIMEOUT            — call exceeded the 18s timeout guard
  //   PROVIDER_5XX       — provider-side server error (5xx)
  //   NETWORK_FAILURE    — connection-level error (ECONNREFUSED, ENOTFOUND, etc.)
  //   MALFORMED_RESPONSE — response present but station array missing or unreadable
  //
  // Retry-After:
  //   When the provider surfaces a Retry-After header or embeds the wait seconds in
  //   the error message we parse it into retryAfterSeconds. The sync job uses this
  //   value when available; otherwise it falls back to its own backoff schedule.
  //   We cap the parsed value to SYNC_RETRY_AFTER_MAX_S = 600s (10 min) to prevent
  //   a misbehaving provider from parking the sync job for an unbounded period.
  //
  // Security: credentials and full HTTP headers are never logged here.
  public async getTrainInfoForSync(trainNo: string): Promise<TrainInfoResult> {
    await this.ensureInit();

    if (!this.initialized || !irctc) {
      // Service not ready — treat as a network-level failure so the sync job can
      // decide whether to skip or retry, rather than misclassifying as no-data.
      return { kind: 'NETWORK_FAILURE' };
    }

    // Re-use the 2h NodeCache used by getTrainInfo() — if user traffic already
    // fetched this train recently the sync job gets a free hit.
    const cacheKey = `traininfo_${trainNo}`;
    const cached = cacheService.get(cacheKey);
    if (cached) {
      // Extract station array from cached payload.
      const stations: any[] = (
        (cached as any)?.route          ??
        (cached as any)?.stations       ??
        (cached as any)?.data?.route    ??
        (cached as any)?.data?.stations ??
        []
      );
      if (stations.length > 0) {
        return { kind: 'VALID_SCHEDULE', data: cached };
      }
      // Cached but no station array — treat as expected no-data (don't hit provider again).
      return { kind: 'EXPECTED_NO_DATA' };
    }

    // ── Provider call ──────────────────────────────────────────────────────────
    try {
      const infoPromise = irctc.getTrainInfo(trainNo.trim());
      let infoTimer: NodeJS.Timeout | undefined;
      const infoTimeout = new Promise<never>((_, reject) => {
        infoTimer = setTimeout(
          () => reject(new Error('[SYNC_TIMEOUT] getTrainInfo timeout (18s)')),
          18000
        );
      });
      const raw = await Promise.race([infoPromise, infoTimeout]).finally(() => {
        if (infoTimer) clearTimeout(infoTimer);
      }) as any;

      const result = raw?.data ?? raw;

      // Provider returned a structured failure.
      if (result && (result.success === false || result.error)) {
        const errStr = String(result.error || '').toLowerCase();
        if (errStr.includes('api key') || errStr.includes('invalid key') ||
            errStr.includes('unauthorized') || errStr.includes('forbidden')) {
          return { kind: 'AUTH_FAILURE' };
        }
        if (errStr.includes('rate') || errStr.includes('429') ||
            errStr.includes('too many') || errStr.includes('quota')) {
          const retryAfterSeconds = IrctcService._parseRetryAfter(result);
          return { kind: 'RATE_LIMITED_429', retryAfterSeconds };
        }
        // Known "no data" signals: train not found, does not run, bad request.
        return { kind: 'EXPECTED_NO_DATA' };
      }

      // Null/undefined response body.
      if (!result) {
        return { kind: 'EXPECTED_NO_DATA' };
      }

      // Extract station array.
      const stations: any[] = (
        result?.route          ??
        result?.stations       ??
        result?.data?.route    ??
        result?.data?.stations ??
        []
      );

      if (stations.length > 0) {
        // Store in shared 2h cache — same as getTrainInfo() — so user-facing paths
        // benefit from the sync job's fetch.
        cacheService.set(cacheKey, result, 7200);
        return { kind: 'VALID_SCHEDULE', data: result };
      }

      // Response arrived but contained no station data.
      return { kind: 'MALFORMED_RESPONSE' };

    } catch (e: any) {
      const msg = String(e?.message || '').toLowerCase();

      // Timeout (thrown by our own guard above).
      if (msg.includes('[sync_timeout]') || msg.includes('timeout')) {
        return { kind: 'TIMEOUT' };
      }

      // 429 / rate-limit surfaced as a thrown error.
      if (msg.includes('429') || msg.includes('rate') ||
          msg.includes('too many') || msg.includes('quota')) {
        const retryAfterSeconds = IrctcService._parseRetryAfter(e);
        return { kind: 'RATE_LIMITED_429', retryAfterSeconds };
      }

      // Auth failure surfaced as a thrown error.
      if (msg.includes('api key') || msg.includes('invalid key') ||
          msg.includes('unauthorized') || msg.includes('401') ||
          msg.includes('403') || msg.includes('forbidden')) {
        return { kind: 'AUTH_FAILURE' };
      }

      // 5xx server errors.
      if (msg.includes('500') || msg.includes('502') || msg.includes('503') ||
          msg.includes('504') || msg.includes('server error') ||
          msg.includes('internal error') || msg.includes('bad gateway')) {
        return { kind: 'PROVIDER_5XX' };
      }

      // Network-level failures.
      if (msg.includes('econnrefused') || msg.includes('enotfound') ||
          msg.includes('econnreset') || msg.includes('network') ||
          msg.includes('socket') || msg.includes('etimedout')) {
        return { kind: 'NETWORK_FAILURE' };
      }

      // Catch-all — treat unrecognised errors as network failures so the
      // sync job retries rather than silently skipping the train.
      return { kind: 'NETWORK_FAILURE' };
    }
  }

  /**
   * PHASE_087N49 — Parse Retry-After from an error object or provider response.
   *
   * Tries, in order:
   *   1. e.response.headers['retry-after']   (axios-style HTTP response)
   *   2. e.retryAfter                         (SDK-level property)
   *   3. Numeric seconds embedded in message  (e.g. "retry after 30 seconds")
   *
   * Returns undefined when nothing parseable is found.
   * Caps the value at SYNC_RETRY_AFTER_MAX_S (600 s) to prevent indefinite parking.
   * Never logs credential-bearing header values.
   */
  private static readonly SYNC_RETRY_AFTER_MAX_S = 600; // 10 minutes hard cap

  private static _parseRetryAfter(e: any): number | undefined {
    const cap = IrctcService.SYNC_RETRY_AFTER_MAX_S;

    // 1. HTTP response header (axios, node-fetch, etc.)
    try {
      const headerVal = e?.response?.headers?.['retry-after'];
      if (headerVal !== undefined && headerVal !== null) {
        const parsed = Number(headerVal);
        if (!Number.isNaN(parsed) && parsed > 0) {
          return Math.min(parsed, cap);
        }
      }
    } catch { /* non-fatal */ }

    // 2. SDK-level retryAfter property.
    try {
      const sdkVal = e?.retryAfter;
      if (sdkVal !== undefined && sdkVal !== null) {
        const parsed = Number(sdkVal);
        if (!Number.isNaN(parsed) && parsed > 0) {
          return Math.min(parsed, cap);
        }
      }
    } catch { /* non-fatal */ }

    // 3. Embedded numeric in message: "retry after 30 seconds", "wait 45s", etc.
    try {
      const msg = String(e?.message || e?.error || '');
      const m = msg.match(/(\d+)\s*s(?:ec(?:ond)?s?)?/i)
             ?? msg.match(/retry[\s-]after[:\s]+(\d+)/i)
             ?? msg.match(/wait[:\s]+(\d+)/i);
      if (m) {
        const parsed = Number(m[1]);
        if (!Number.isNaN(parsed) && parsed > 0) {
          return Math.min(parsed, cap);
        }
      }
    } catch { /* non-fatal */ }

    return undefined;
  }
}

export const irctcService = new IrctcService();