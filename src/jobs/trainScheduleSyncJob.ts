/**
 * PHASE_5B030 — Nightly Train Schedule Sync Job
 *
 * Refreshes train_schedule from the live IRCTC provider every night at 02:00 IST (20:30 UTC).
 * Default: DISABLED. Set ENABLE_TRAIN_SCHEDULE_SYNC=true in .env to activate.
 *
 * Strategy: Option B (UPSERT + Guarded DELETE)
 *   - UPSERT all stops from live IRCTC response (idempotent)
 *   - DELETE orphan rows (SN > maxLiveSN) only when all safety guards pass
 *   - Invalidate per-train NodeCache keys immediately after write
 *
 * Safety guards applied per train before any write:
 *   V0 — null/empty IRCTC response -> SKIP
 *   V1 — live stop count < 3 for an established train -> SKIP
 *   V2 — live stop count < 70% of existing DB stops -> SKIP (regression protection)
 *   V3 — first station code changed unexpectedly -> SKIP (origin stability)
 *   V4 — last station code is empty -> SKIP (corrupt terminus)
 *   V5 — duplicate SN values in live response -> SKIP (malformed data)
 *   V6 — filter rows with empty station codes (< 2 chars) before write
 *
 * Production safety:
 *   isRunning guard  — prevents duplicate execution on server restart during cron window
 *   MAX_RUNTIME_MS   — 3-hour hard cutoff; remainder deferred to next night (idempotent)
 *   Dry-run mode     — when ENABLE_TRAIN_SCHEDULE_SYNC != true, validates but performs no writes
 *
 * Cache invalidation (per train, after write):
 *   Clears train_schedule_resolved_{num}, sched_ctx_v4_{num}, traininfo_{num} from NodeCache.
 *   Hub keys (hubs_{num}_*) expire naturally via 24h TTL (known limitation - see cache_audit.md S5).
 *
 * Rollback:
 *   Set ENABLE_TRAIN_SCHEDULE_SYNC=false -> restart -> sync stops immediately.
 *   No schema changes. No data migrations.
 */

import cron from 'node-cron';
import * as fs from 'fs';
import * as path from 'path';
import { winstonLogger } from '../middleware/logger';
import { featureFlags } from '../config/featureFlags';
import { cacheService } from '../services/cacheService';
import { irctcService } from '../services/irctcService';
import { supabase } from '../config/supabase';

/** Resolved path to the optional train registry JSON bundled with the server. */
const REGISTRY_PATH = path.join(__dirname, '..', 'data', 'train_registry.json');
const FIVE_DIGIT_RE = /^\d{5}$/

export class TrainScheduleSyncJob {
  /** Prevents double-registration if start() is called twice (mirrors hubCatalogRefreshJob pattern) */
  private started = false;

  /** Required Change 1: prevents concurrent execution on server restart during cron window */
  private isRunning = false;

  /** Required Change 2: 3-hour hard cutoff to prevent overlap with morning peak traffic */
  private readonly MAX_RUNTIME_MS = 3 * 60 * 60 * 1000;

  private readonly INTER_CALL_DELAY_MS = 200;
  private readonly UPSERT_BATCH_SIZE = 100;

  /** Stop count regression threshold: live must be >= 70% of existing DB stop count */
  private readonly MIN_STOP_REGRESSION_RATIO = 0.7;

  /** Minimum live stop count — below this, the IRCTC response is considered unreliable */
  private readonly MIN_STUB_STOPS = 3;

  // Side-effect fields populated by getAllTrainNumbers() — used by getPriorityBatch().
  // Populated fresh on every run; never used across runs (isRunning guard prevents overlap).
  private _registryNos: Set<string>  = new Set(); // trains from train_registry.json
  private _dbScheduleNos: Set<string> = new Set(); // trains already in train_schedule SN=1

  // ---------------------------------------------------------------------------
  // Public API
  // ---------------------------------------------------------------------------

  async start(): Promise<void> {
    if (this.started) return;
    this.started = true;

    const dryRun = !featureFlags.trainScheduleSync;
    winstonLogger.info(
      `[SCHEDULE_SYNC] Scheduler registered — nightly 20:30 UTC (02:00 IST). dryRun=${dryRun} (set ENABLE_TRAIN_SCHEDULE_SYNC=true to activate writes)`
    );

    // Nightly at 02:00 IST = 20:30 UTC
    cron.schedule('30 20 * * *', async () => {
      await this.runScheduled('nightly cron');
    });
  }

  /** Entry point — also callable manually for testing/backfill */
  async runScheduled(reason: string): Promise<void> {
    // isRunning guard (Required Change 1)
    if (this.isRunning) {
      winstonLogger.warn(`[SCHEDULE_SYNC] SKIPPED reason=ALREADY_RUNNING trigger=${reason}`);
      return;
    }

    this.isRunning = true;
    const jobStart = Date.now();

    try {
      winstonLogger.info(
        `[SCHEDULE_SYNC] RUN_STARTED reason=${reason} dryRun=${!featureFlags.trainScheduleSync} maxRuntimeMs=${this.MAX_RUNTIME_MS}`
      );
      const stats = await this.syncAllTrains(jobStart);
      const durationMs = Date.now() - jobStart;
      winstonLogger.info(
        `[SCHEDULE_SYNC] RUN_COMPLETE total=${stats.total} updated=${stats.updated} skipped=${stats.skipped} failed=${stats.failed} aborted=${stats.aborted} durationMs=${durationMs}`
      );
    } catch (err: any) {
      winstonLogger.error(`[SCHEDULE_SYNC] RUN_ERROR error=${err.message}`);
    } finally {
      this.isRunning = false;
    }
  }

  // ---------------------------------------------------------------------------
  // Private: Main sync loop
  // ---------------------------------------------------------------------------

  private async syncAllTrains(
    jobStart: number
  ): Promise<{ total: number; updated: number; skipped: number; failed: number; aborted: number }> {
    // Step 1: build the full union (registry + DB) — populates _registryNos, _dbScheduleNos
    const allNos = await this.getAllTrainNumbers();
    winstonLogger.info(`[SCHEDULE_SYNC] Union source loaded: ${allNos.length} distinct trains total`);

    // Step 2: compute tonight's incremental batch using P0–P4 priority tiers
    const { batch, p0Count, p1Count, p2Count, p3Count, p4Count } =
      await this.getPriorityBatch(allNos);

    winstonLogger.info(
      `[SCHEDULE_SYNC] RUN_BATCH P0=${p0Count} P1=${p1Count} P2=${p2Count} P3=${p3Count} P4=${p4Count} TOTAL_BATCH=${batch.length} expected_api_calls=${batch.length}`
    );

    // Step 3: sync the batch (all validation/UPSERT/DELETE logic unchanged)
    let updated = 0;
    let skipped = 0;
    let failed  = 0;
    let aborted = 0;

    for (let i = 0; i < batch.length; i++) {
      // MAX_RUNTIME cutoff (Required Change 2)
      if (Date.now() - jobStart > this.MAX_RUNTIME_MS) {
        const remaining = batch.length - i;
        winstonLogger.warn(
          `[SCHEDULE_SYNC] SYNC_ABORTED reason=MAX_RUNTIME_EXCEEDED processed=${i} remaining=${remaining} maxRuntimeMs=${this.MAX_RUNTIME_MS}`
        );
        aborted = remaining;
        break;
      }

      const trainNo = batch[i];
      try {
        const result = await this.syncOneTrain(trainNo);
        if (result === 'updated')      updated++;
        else if (result === 'skipped') skipped++;
        else                           failed++;
      } catch (err: any) {
        winstonLogger.warn(`[SCHEDULE_SYNC] TRAIN_FAILED trainNo=${trainNo} error=${err.message}`);
        failed++;
      }

      // Courtesy delay between IRCTC calls
      if (i < batch.length - 1) {
        await this.sleep(this.INTER_CALL_DELAY_MS);
      }
    }

    return { total: batch.length, updated, skipped, failed, aborted };
  }

  // ---------------------------------------------------------------------------
  // Private: Enumerate all distinct Train_No values
  // ---------------------------------------------------------------------------

  /**
   * Returns a deduplicated, sorted array of train numbers to sync.
   *
   * Source order (union strategy):
   *   1. train_registry.json  — recent IRCTC-verified registry (10,632 trains, all valid 5-digit)
   *   2. train_schedule DB    — SN=1 paginator catches trains not yet in the registry
   *
   * If train_registry.json is missing, falls back to DB-only (original behaviour).
   * All non-5-digit numbers are filtered out before returning.
   */
  private async getAllTrainNumbers(): Promise<string[]> {
    const combined = new Set<string>();

    // ── Source 1: train_registry.json ──────────────────────────────────────────
    let registryCount = 0;
    this._registryNos = new Set<string>(); // reset for this run
    if (fs.existsSync(REGISTRY_PATH)) {
      try {
        const raw      = fs.readFileSync(REGISTRY_PATH, 'utf8');
        const registry = JSON.parse(raw) as { trains: Array<{ trainNo: string }> };
        for (const entry of registry.trains ?? []) {
          const no = String(entry.trainNo ?? '').trim();
          if (FIVE_DIGIT_RE.test(no)) {
            combined.add(no);
            this._registryNos.add(no); // side-effect: available to getPriorityBatch()
            registryCount++;
          }
        }
        winstonLogger.info(`[SCHEDULE_SYNC] Registry trains loaded: ${registryCount} (from train_registry.json)`);
      } catch (err: any) {
        winstonLogger.warn(`[SCHEDULE_SYNC] Failed to parse train_registry.json — falling back to DB only. error=${err.message}`);
      }
    } else {
      winstonLogger.warn('[SCHEDULE_SYNC] train_registry.json not found — using DB-only enumeration');
    }

    const beforeDb = combined.size;

    // ── Source 2: train_schedule DB (SN=1 paginator) ───────────────────────────
    // Catches trains present in the routing DB but not yet in the registry.
    // Side-effect: populates _dbScheduleNos for getPriorityBatch() P4 classification.
    this._dbScheduleNos = new Set<string>(); // reset for this run
    let page = 0;
    let done = false;
    while (!done) {
      const { data, error } = await supabase
        .from('train_schedule')
        .select('Train_No')
        .eq('SN', 1)
        .range(page * 1000, page * 1000 + 999);

      if (error) {
        winstonLogger.error(
          `[SCHEDULE_SYNC] Failed to fetch train list page=${page} error=${error.message}`
        );
        break;
      }

      if (!data || data.length === 0) { done = true; break; }

      for (const r of data) {
        const no = String(r.Train_No ?? '').trim();
        if (FIVE_DIGIT_RE.test(no)) {
          combined.add(no);
          this._dbScheduleNos.add(no); // side-effect: available to getPriorityBatch()
        }
      }
      if (data.length < 1000) done = true;
      else page++;
    }

    const dbCount  = combined.size - beforeDb; // net new trains added from DB
    const finalNos = [...combined].sort();

    winstonLogger.info(`[SCHEDULE_SYNC] DB trains loaded: ${dbCount} additional (not already in registry)`);
    winstonLogger.info(`[SCHEDULE_SYNC] Registry-only: ${registryCount} | DB-only: ${dbCount} | Final unique trains: ${finalNos.length}`);

    return finalNos;
  }

  // ---------------------------------------------------------------------------
  // Private: Incremental priority batch (Option B)
  // ---------------------------------------------------------------------------

  /**
   * Returns the nightly sync batch using a 5-tier incremental strategy.
   * Called after getAllTrainNumbers() — depends on _registryNos and _dbScheduleNos.
   *
   * Tier | Criteria                              | Rotation   | ~Calls/night
   * ---- | ------------------------------------- | ---------- | ------------
   *  P0  | Trains searched last 7 days           | Nightly    | 0–800
   *  P1  | Long-distance (10000–49999)           | 7-day RR   | ~570
   *  P2  | MEMU / Passenger (50000–59999)        | 30-day RR  | ~42
   *  P3  | Suburban / DEMU (60000–99999)         | 30-day RR  | ~90
   *  P4  | Registry-only (not yet in DB)         | 14-day RR  | ~338
   */
  private async getPriorityBatch(allNos: string[]): Promise<{
    batch:   string[];
    p0Count: number;
    p1Count: number;
    p2Count: number;
    p3Count: number;
    p4Count: number;
  }> {
    // Stable daily epoch (UTC midnight) — same value for the entire nightly run.
    const cycleDay = Math.floor(Date.now() / 86_400_000);

    // P0 — hot trains from search_history.clicked_train_no (last 7 days), fallback = empty
    const p0Set = await this.getHotTrains();

    // P4 pool — registry trains not yet in train_schedule (need initial hydration)
    // Computed FIRST so P1–P3 can exclude these trains and ensure mutual exclusivity.
    const p4Pool = allNos.filter(n =>
      this._registryNos.has(n) &&
      !this._dbScheduleNos.has(n) &&
      !p0Set.has(n)
    );
    const p4Set = new Set(p4Pool); // O(1) lookup for P1–P3 exclusion

    // P1–P3 pools — DB-tracked trains by number range, minus P0 and minus P4.
    // Excluding P4 ensures each train belongs to exactly one tier.
    const p1Pool = allNos.filter(n => n >= '10000' && n <= '49999' && !p0Set.has(n) && !p4Set.has(n));
    const p2Pool = allNos.filter(n => n >= '50000' && n <= '59999' && !p0Set.has(n) && !p4Set.has(n));
    const p3Pool = allNos.filter(n => n >= '60000' && n <= '99999' && !p0Set.has(n) && !p4Set.has(n));

    // Round-robin slices — deterministic for any given UTC day
    const p0Batch = allNos.filter(n => p0Set.has(n));                              // every night
    const p1Batch = p1Pool.filter((_, i) => i % 7  === cycleDay % 7);             // 1 in 7  nights
    const p2Batch = p2Pool.filter((_, i) => i % 30 === cycleDay % 30);            // 1 in 30 nights
    const p3Batch = p3Pool.filter((_, i) => i % 30 === cycleDay % 30);            // 1 in 30 nights
    const p4Batch = p4Pool.filter((_, i) => i % 14 === cycleDay % 14);            // 1 in 14 nights

    // Merge and de-duplicate (Set handles any P0 overlap with P1–P4)
    const batch = [
      ...new Set([...p0Batch, ...p1Batch, ...p2Batch, ...p3Batch, ...p4Batch])
    ].sort();

    return {
      batch,
      p0Count: p0Batch.length,
      p1Count: p1Batch.length,
      p2Count: p2Batch.length,
      p3Count: p3Batch.length,
      p4Count: p4Batch.length,
    };
  }

  /**
   * Returns train numbers that were actively searched in the last 7 days (P0 tier).
   *
   * Source: search_history.clicked_train_no — written by trainController on every
   * user search where the user clicked a specific train result. Validated at RLS
   * (service_role only). Column: clicked_train_no VARCHAR, searched_at TIMESTAMPTZ.
   *
   * Falls back to an empty set if:
   *   - No rows with non-null clicked_train_no exist in the last 7 days
   *   - The query fails for any reason (network, RLS, schema change)
   *
   * In either case P0 count = 0 and P1–P4 tiers cover all trains normally.
   */
  private async getHotTrains(): Promise<Set<string>> {
    try {
      const sevenDaysAgo = new Date(Date.now() - 7 * 86_400_000).toISOString();
      const { data, error } = await supabase
        .from('search_history')
        .select('clicked_train_no')
        .gte('searched_at', sevenDaysAgo)
        .not('clicked_train_no', 'is', null);

      if (error) {
        winstonLogger.warn(`[SCHEDULE_SYNC] P0: search_history query failed — P0 batch = 0 trains. error=${error.message}`);
        return new Set<string>();
      }

      const hotSet = new Set(
        (data ?? [])
          .map(r => String(r.clicked_train_no ?? '').trim())
          .filter(n => FIVE_DIGIT_RE.test(n))
      );

      winstonLogger.info(`[SCHEDULE_SYNC] P0: ${hotSet.size} hot trains from search_history (last 7 days)`);
      return hotSet;
    } catch (err: any) {
      winstonLogger.warn(`[SCHEDULE_SYNC] P0: unexpected error — P0 batch = 0 trains. error=${err.message}`);
      return new Set<string>();
    }
  }

  // ---------------------------------------------------------------------------
  // Private: Sync one train — validate, upsert, delete orphans, invalidate cache
  // ---------------------------------------------------------------------------

  private async syncOneTrain(trainNo: string): Promise<'updated' | 'skipped' | 'failed'> {
    // Step 1: Read existing schedule from DB
    const { data: existing, error: existingErr } = await supabase
      .from('train_schedule')
      .select('SN, Station_Code')
      .eq('Train_No', trainNo)
      .order('SN', { ascending: true });

    if (existingErr) {
      winstonLogger.warn(
        `[SCHEDULE_SYNC] TRAIN_FAILED trainNo=${trainNo} reason=DB_READ_ERROR error=${existingErr.message}`
      );
      return 'failed';
    }

    const existingRows: Array<{ SN: number; Station_Code: string }> = existing || [];
    const existingStops     = existingRows.length;
    const existingFirstCode = (existingRows[0]?.Station_Code || '').toUpperCase().trim();
    const existingMaxSN     = existingRows.length > 0
      ? Math.max(...existingRows.map(r => Number(r.SN)))
      : 0;

    // Step 2: Fetch live IRCTC data
    const liveInfo = await irctcService.getTrainInfo(trainNo);

    // Extract station array — same field priority as _injectScheduleFromIRCTC
    const stations: any[] = (
      liveInfo?.route          ??
      liveInfo?.stations       ??
      liveInfo?.data?.route    ??
      liveInfo?.data?.stations ??
      []
    );

    const liveStops = stations.length;

    // Step 3: Validation rules

    // V0: null or empty IRCTC response
    if (!liveInfo || liveStops === 0) {
      winstonLogger.info(
        `[SCHEDULE_SYNC] TRAIN_SKIPPED trainNo=${trainNo} reason=NULL_RESPONSE liveStops=0 dbStops=${existingStops}`
      );
      return 'skipped';
    }

    // V1: minimum stop count (only guard established trains)
    if (liveStops < this.MIN_STUB_STOPS && existingStops > 2) {
      winstonLogger.info(
        `[SCHEDULE_SYNC] TRAIN_SKIPPED trainNo=${trainNo} reason=INSUFFICIENT_STOPS liveStops=${liveStops} dbStops=${existingStops}`
      );
      return 'skipped';
    }

    // V2: stop count regression guard
    const regressionThreshold = Math.floor(existingStops * this.MIN_STOP_REGRESSION_RATIO);
    if (existingStops > 2 && liveStops < regressionThreshold) {
      winstonLogger.info(
        `[SCHEDULE_SYNC] TRAIN_SKIPPED trainNo=${trainNo} reason=STOP_REGRESSION liveStops=${liveStops} dbStops=${existingStops} threshold=${regressionThreshold}`
      );
      return 'skipped';
    }

    // V3: first station stability guard
    const liveFirstCode = (
      stations[0]?.stnCode     ||
      stations[0]?.stationCode ||
      stations[0]?.code        ||
      ''
    ).toUpperCase().trim();

    if (existingStops > 2 && existingFirstCode && liveFirstCode && liveFirstCode !== existingFirstCode) {
      winstonLogger.info(
        `[SCHEDULE_SYNC] TRAIN_SKIPPED trainNo=${trainNo} reason=ORIGIN_CHANGED liveFirstCode=${liveFirstCode} dbFirstCode=${existingFirstCode} dbStops=${existingStops}`
      );
      return 'skipped';
    }

    // V4: empty terminus guard
    const lastStation  = stations[stations.length - 1];
    const liveLastCode = (
      lastStation?.stnCode     ||
      lastStation?.stationCode ||
      lastStation?.code        ||
      ''
    ).toUpperCase().trim();

    if (!liveLastCode || liveLastCode.length < 2) {
      winstonLogger.info(
        `[SCHEDULE_SYNC] TRAIN_SKIPPED trainNo=${trainNo} reason=EMPTY_TERMINUS liveStops=${liveStops}`
      );
      return 'skipped';
    }

    // V5: duplicate SN values guard
    const snValues = stations.map((s: any, idx: number) =>
      Number(s.serialNo ?? s.sn ?? (idx + 1))
    );
    if (new Set(snValues).size !== snValues.length) {
      winstonLogger.info(
        `[SCHEDULE_SYNC] TRAIN_SKIPPED trainNo=${trainNo} reason=DUPLICATE_SN liveStops=${liveStops}`
      );
      return 'skipped';
    }

    // Dry-run exit: all validations passed but writes are disabled
    if (!featureFlags.trainScheduleSync) {
      winstonLogger.info(
        `[SCHEDULE_SYNC] TRAIN_SKIPPED trainNo=${trainNo} reason=DRY_RUN liveStops=${liveStops} dbStops=${existingStops}`
      );
      return 'skipped';
    }

    // Step 4: Map stations to DB row shape
    const rows = stations
      .map((s: any, idx: number) => ({
        Train_No:       trainNo,
        Station_Code:   (s.stnCode || s.stationCode || s.code || '').toUpperCase().trim(),
        Station_Name:   (s.stnName || s.stationName || s.name || ''),
        SN:             Number(s.serialNo ?? s.sn ?? (idx + 1)),
        Arrival_time:   (s.arrival    || s.arrivalTime   || '--:--'),
        Departure_Time: (s.departure  || s.departureTime || '--:--'),
      }))
      .filter((r: any) => r.Station_Code.length >= 2); // V6: skip rows with empty/short station codes

    if (rows.length === 0) {
      winstonLogger.info(
        `[SCHEDULE_SYNC] TRAIN_SKIPPED trainNo=${trainNo} reason=NO_VALID_STATION_CODES liveStops=${liveStops}`
      );
      return 'skipped';
    }

    // PHASE_5B091 — Central Deterministic Integrity Gate
    const { trainScheduleIntegrityService } = require('../services/trainScheduleIntegrityService');
    const integrity = trainScheduleIntegrityService.validateScheduleRows(trainNo, rows);
    if (integrity.status === 'INVALID') {
      winstonLogger.warn(
        `[SCHEDULE_SYNC] TRAIN_REJECTED trainNo=${trainNo} reason=INTEGRITY_FAILED msg=${integrity.message}`
      );
      return 'failed';
    }

    const maxLiveSN = Math.max(...rows.map(r => r.SN));

    // Step 5: UPSERT in batches of 100 rows
    let upsertedRows = 0;
    for (let i = 0; i < rows.length; i += this.UPSERT_BATCH_SIZE) {
      const batch = rows.slice(i, i + this.UPSERT_BATCH_SIZE);
      const { error: upsertErr } = await supabase
        .from('train_schedule')
        .upsert(batch, { onConflict: 'Train_No,SN' });

      if (upsertErr) {
        winstonLogger.warn(
          `[SCHEDULE_SYNC] TRAIN_FAILED trainNo=${trainNo} reason=UPSERT_ERROR batchStart=${i} error=${upsertErr.message}`
        );
        return 'failed';
      }
      upsertedRows += batch.length;
    }

    // Step 6: DELETE orphan rows (guarded)
    // Only fires when the existing route was longer AND all safety thresholds still hold.
    // The guard re-checks V2 condition to avoid deleting from a train we nearly skipped.
    let deletedOrphanRows = 0;
    if (
      existingMaxSN > maxLiveSN &&
      liveStops >= this.MIN_STUB_STOPS &&
      liveStops >= regressionThreshold
    ) {
      const { error: delErr, count } = await supabase
        .from('train_schedule')
        .delete({ count: 'exact' })
        .eq('Train_No', trainNo)
        .gt('SN', maxLiveSN);

      if (delErr) {
        // Non-fatal: UPSERT already completed. Orphans will be cleaned on next nightly run.
        winstonLogger.warn(
          `[SCHEDULE_SYNC] DELETE_ORPHANS_FAILED trainNo=${trainNo} error=${delErr.message}`
        );
      } else {
        deletedOrphanRows = count ?? 0;
      }
    }

    // Step 7: Cache invalidation
    // Clears the 3 per-train NodeCache keys derived from train_schedule.
    // Hub keys (hubs_{trainNo}_*) cannot be swept without cacheService.keys() —
    // they expire naturally via their 24h TTL. See cache_audit.md section 5.
    try {
      cacheService.del(`train_schedule_resolved_${trainNo}`); // C1 — splitJourneyEngine (2h TTL)
      cacheService.del(`sched_ctx_v4_${trainNo}`);            // C3 — trainStationResolver (2h TTL, key version bumped in PHASE_5B161)
      cacheService.del(`traininfo_${trainNo}`);               // C4 — irctcService (2h TTL)
    } catch (cacheErr: any) {
      // Non-fatal: cache will expire via TTL
      winstonLogger.warn(
        `[SCHEDULE_SYNC] CACHE_INVALIDATION_FAILED trainNo=${trainNo} error=${cacheErr.message}`
      );
    }

    winstonLogger.info(
      `[SCHEDULE_SYNC] TRAIN_UPDATED trainNo=${trainNo} liveStops=${liveStops} dbStops=${existingStops} upsertedRows=${upsertedRows} deletedOrphanRows=${deletedOrphanRows}`
    );
    return 'updated';
  }

  // ---------------------------------------------------------------------------
  // Utilities
  // ---------------------------------------------------------------------------

  private sleep(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
  }
}

export const trainScheduleSyncJob = new TrainScheduleSyncJob();
