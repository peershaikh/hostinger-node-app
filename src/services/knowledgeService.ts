/**
 * PHASE_4C871 — Knowledge Layer orchestrator (shadow mode — flags default OFF).
 */
import { featureFlags } from '../config/featureFlags';
import { buildHubCandidatesFromStops } from '../knowledge/hubCatalogBuilder';
import {
  B1DualReadResult,
  HubCatalogEntry,
  HydratedHubEntry,
  MappingReason,
  RankedHub,
  RescueOutcomeEventRow,
  RescueOutcomeEventType,
  ScheduleStopFull,
  ShadowCompareResult,
  TrainStationMappingRow,
} from '../knowledge/types';
import {
  computeHubDiff,
  extractHubCodes,
  hydrateCatalogEntries,
} from '../knowledge/hubCatalogHydrator';
import { knowledgeRepository } from '../repositories/knowledgeRepository';
import { computeShadowMatchRate, hubSetsMatch } from '../knowledge/shadowUtils';
import { resolveSegmentForAvailability } from './trainStationResolver';

function logInfo(msg: string): void {
  try {
    const { winstonLogger } = require('../middleware/logger');
    winstonLogger.info(msg);
  } catch {
    // test / minimal environments
  }
}

function logWarn(msg: string): void {
  try {
    const { winstonLogger } = require('../middleware/logger');
    winstonLogger.warn(msg);
  } catch {
    // ignore
  }
}

export class KnowledgeService {
  /**
   * Delegates to trainStationResolver — no behaviour change.
   */
  async resolveStations(trainNo: string, from: string, to: string, date: string) {
    return resolveSegmentForAvailability(trainNo, from, to, date);
  }

  /**
   * Read precomputed hub catalog from DB. Returns [] when flag OFF or table empty.
   */
  async getHubCatalog(
    trainNo: string,
    source: string,
    destination: string
  ): Promise<HubCatalogEntry[]> {
    if (!featureFlags.knowledgeHubs && !featureFlags.knowledgeHubsShadow) {
      return [];
    }
    return knowledgeRepository.getHubCatalog(
      this.padTrainNo(trainNo),
      source,
      destination
    );
  }

  /**
   * Rank hubs: catalog rank_score × stats confidence. Shadow/catalog only — not on hot path when flags OFF.
   */
  async rankHubs(
    trainNo: string,
    source: string,
    destination: string,
    _date?: string
  ): Promise<RankedHub[]> {
    const catalog = await this.getHubCatalog(trainNo, source, destination);
    if (catalog.length === 0) return [];

    const stats = featureFlags.knowledgeStats
      ? await knowledgeRepository.getHubStats(
          this.padTrainNo(trainNo),
          source,
          destination
        )
      : [];

    const statsByHub = new Map(stats.map((s) => [s.hub_station, s]));

    return catalog
      .map((entry) => {
        const stat = statsByHub.get(entry.hub_station);
        const confidence = stat ? Number(stat.confidence_score) : 50;
        const composite = entry.rank_score * 0.6 + confidence * 0.4;
        return {
          ...entry,
          confidence_score: confidence,
          composite_score: Math.round(composite * 100) / 100,
        };
      })
      .sort((a, b) => b.composite_score - a.composite_score);
  }

  /**
   * Append-only outcome telemetry. No-op unless KNOWLEDGE_STATS or shadow logging enabled.
   */
  async recordOutcome(event: RescueOutcomeEventRow): Promise<string | null> {
    if (!featureFlags.knowledgeStats && !featureFlags.knowledgeHubsShadow) {
      return null;
    }
    const normalized = {
      ...event,
      train_no: this.padTrainNo(event.train_no),
      source: event.source.toUpperCase().trim(),
      destination: event.destination.toUpperCase().trim(),
      hub_station: event.hub_station?.toUpperCase().trim() || null,
    };
    const id = await knowledgeRepository.insertOutcomeEvent(normalized);
    if (id) {
      logInfo(`[KNOWLEDGE_OUTCOME] ${event.event_type} train=${event.train_no} hub=${event.hub_station || 'N/A'}`);
      if (featureFlags.knowledgeStats && normalized.hub_station) {
        await this.incrementHubStatsFromEvent(normalized);
      }
    }
    return id;
  }

  private async incrementHubStatsFromEvent(event: RescueOutcomeEventRow): Promise<void> {
    if (!event.hub_station) return;

    const existing = await knowledgeRepository.getHubStats(
      event.train_no,
      event.source,
      event.destination
    );
    const prior = existing.find((s) => s.hub_station === event.hub_station) || null;

    const counters = {
      sample_count: (prior?.sample_count ?? 0) + 1,
      show_count: prior?.show_count ?? 0,
      expand_count: prior?.expand_count ?? 0,
      avail_check_count: prior?.avail_check_count ?? 0,
      irctc_click_count: prior?.irctc_click_count ?? 0,
      confirmed_pair_count: prior?.confirmed_pair_count ?? 0,
      partial_rac_count: prior?.partial_rac_count ?? 0,
    };

    switch (event.event_type) {
      case 'SHOWN':
        counters.show_count += 1;
        break;
      case 'EXPANDED':
        counters.expand_count += 1;
        break;
      case 'AVAIL_CHECK':
        counters.avail_check_count += 1;
        break;
      case 'IRCTC_CLICK':
        counters.irctc_click_count += 1;
        break;
      case 'FEEDBACK':
        break;
    }

    const engagement =
      counters.show_count +
      counters.expand_count +
      counters.avail_check_count +
      counters.irctc_click_count;
    const confidence = Math.min(100, Math.round((engagement / counters.sample_count) * 50));

    await knowledgeRepository.upsertHubStats({
      train_no: event.train_no,
      source: event.source,
      destination: event.destination,
      hub_station: event.hub_station,
      ...counters,
      confidence_score: confidence,
      avg_buffer_minutes: prior?.avg_buffer_minutes ?? null,
      preferred_boarding: prior?.preferred_boarding ?? null,
      preferred_alighting: prior?.preferred_alighting ?? null,
      last_success_at: prior?.last_success_at ?? null,
    });
  }

  /**
   * Persist resolver mapping (async, non-blocking). Does not affect API responses.
   */
  async persistStationMapping(
    trainNo: string,
    userFrom: string,
    userTo: string,
    resolution: {
      scheduleFrom: string;
      scheduleTo: string;
      apiFrom: string;
      apiTo: string;
      fromSn?: number;
      toSn?: number;
    }
  ): Promise<void> {
    if (!this.isKnowledgePersistenceEnabled()) return;
    if (!knowledgeRepository.isConfigured()) return;

    const tNo = this.padTrainNo(trainNo);
    const mappings: TrainStationMappingRow[] = [];

    const fromReason = this.inferMappingReason(userFrom, resolution.scheduleFrom);
    const toReason = this.inferMappingReason(userTo, resolution.scheduleTo);

    mappings.push({
      train_no: tNo,
      user_station: userFrom.toUpperCase().trim(),
      schedule_stop: resolution.scheduleFrom,
      irctc_api_code: resolution.apiFrom,
      stop_sn: resolution.fromSn ?? null,
      mapping_reason: fromReason,
      confidence: fromReason === 'EXACT' ? 100 : 90,
      source: 'SCHEDULE',
      is_active: true,
    });

    mappings.push({
      train_no: tNo,
      user_station: userTo.toUpperCase().trim(),
      schedule_stop: resolution.scheduleTo,
      irctc_api_code: resolution.apiTo,
      stop_sn: resolution.toSn ?? null,
      mapping_reason: toReason,
      confidence: toReason === 'EXACT' ? 100 : 90,
      source: 'SCHEDULE',
      is_active: true,
    });

    for (const row of mappings) {
      const existing = await knowledgeRepository.getStationMappings(tNo, row.user_station);
      const alreadyMapped = existing.some(
        (m) => m.schedule_stop.toUpperCase().trim() === row.schedule_stop.toUpperCase().trim()
      );
      if (alreadyMapped) continue;
      await knowledgeRepository.upsertStationMapping(row);
    }
  }

  /**
   * PHASE_4C877 — Unconditional catalog read for B1 consume telemetry.
   * Bypasses getHubCatalog() flag gate per PHASE_4C876 D3.
   */
  async resolveHubCatalogForConsume(
    trainNo: string,
    source: string,
    destination: string
  ): Promise<HubCatalogEntry[]> {
    if (!knowledgeRepository.isConfigured()) return [];
    return knowledgeRepository.getHubCatalog(
      this.padTrainNo(trainNo),
      source,
      destination
    );
  }

  private shouldRunB1DualRead(): boolean {
    return featureFlags.knowledgeConsumeShadow;
  }

  /**
   * PHASE_4C877 — B1 dual-read: hydrate catalog, compare to runtime, telemetry only.
   * Does not alter hub selection; runtime remains source of truth.
   * Any failure → ignore catalog, never throw.
   */
  async runB1DualReadCompare(
    trainNo: string,
    source: string,
    destination: string,
    runtimeHubs: HydratedHubEntry[] | { hub?: string }[],
    scheduleStops?: ScheduleStopFull[] | null
  ): Promise<B1DualReadResult | null> {
    if (!this.shouldRunB1DualRead()) return null;

    try {
      if (!knowledgeRepository.isConfigured()) return null;

      const tNo = this.padTrainNo(trainNo);
      const src = source.toUpperCase().trim();
      const dest = destination.toUpperCase().trim();
      const runtimeCodes = extractHubCodes(runtimeHubs);

      const catalog = await this.resolveHubCatalogForConsume(trainNo, source, destination);
      const catalogHit = catalog.length > 0;
      const catalogMiss = !catalogHit;

      let hydrationSuccess = false;
      let hydrationFailure = false;
      let catalogHubs: string[] = [];
      let hydrationLatencyMs = 0;

      if (catalogHit) {
        const hydrationStart = Date.now();
        try {
          const stops =
            scheduleStops && scheduleStops.length > 2
              ? scheduleStops
              : await knowledgeRepository.loadTrainScheduleFull(tNo);

          const hydration = hydrateCatalogEntries(catalog, stops, src, dest);
          if (hydration.success && hydration.hubs.length > 0) {
            hydrationSuccess = true;
            catalogHubs = extractHubCodes(hydration.hubs);
          } else {
            hydrationFailure = true;
          }
        } catch {
          hydrationFailure = true;
          catalogHubs = [];
        } finally {
          hydrationLatencyMs = Date.now() - hydrationStart;
        }
      }

      const catalogRuntimeMatch = hubSetsMatch(runtimeCodes, catalogHubs);
      const catalogRuntimeDiff = computeHubDiff(runtimeCodes, catalogHubs);
      const matchRate = computeShadowMatchRate(runtimeCodes, catalogHubs);

      const result: B1DualReadResult = {
        train_no: tNo,
        source: src,
        destination: dest,
        catalog_hit: catalogHit,
        catalog_miss: catalogMiss,
        hydration_success: hydrationSuccess,
        hydration_failure: hydrationFailure,
        runtime_hubs: runtimeCodes,
        catalog_hubs: catalogHubs,
        catalog_runtime_match: catalogRuntimeMatch,
        catalog_runtime_diff: catalogRuntimeDiff,
        match_rate: Math.round(matchRate * 1000) / 1000,
        hydration_latency_ms: hydrationLatencyMs,
      };

      logInfo(
        `[KNOWLEDGE_B1_DUAL_READ] train=${result.train_no} ${result.source}→${result.destination} ` +
        `catalog_hit=${result.catalog_hit} catalog_miss=${result.catalog_miss} ` +
        `hydration_success=${result.hydration_success} hydration_failure=${result.hydration_failure} ` +
        `hydration_latency_ms=${result.hydration_latency_ms} ` +
        `runtime=[${runtimeCodes.join(',')}] catalog=[${catalogHubs.join(',')}] ` +
        `match=${result.catalog_runtime_match} diff_runtime=[${catalogRuntimeDiff.runtime_only.join(',')}] ` +
        `diff_catalog=[${catalogRuntimeDiff.catalog_only.join(',')}] rate=${result.match_rate}`
      );

      try {
        const { knowledgeMetricsService } = require('./knowledgeMetricsService');
        knowledgeMetricsService.recordB1DualRead({
          catalog_hit: result.catalog_hit,
          catalog_miss: result.catalog_miss,
          hydration_success: result.hydration_success,
          hydration_failure: result.hydration_failure,
          catalog_runtime_match: result.catalog_runtime_match,
          catalog_runtime_diff: result.catalog_runtime_diff,
          hydration_latency_ms: result.hydration_latency_ms,
          train_no: result.train_no,
          source: result.source,
          destination: result.destination,
          runtime_hubs: result.runtime_hubs,
          catalog_hubs: result.catalog_hubs,
        });
      } catch {
        // metrics optional — never throw
      }

      return result;
    } catch {
      // Fail-safe: ignore catalog on any error; runtime already returned to caller
      return null;
    }
  }

  /**
   * Shadow compare: runtime hubs vs catalog. Logs only when KNOWLEDGE_HUBS_SHADOW=true.
   */
  async runHubShadowCompare(
    trainNo: string,
    source: string,
    destination: string,
    runtimeHubs: { hub?: string }[]
  ): Promise<ShadowCompareResult | null> {
    if (!featureFlags.knowledgeHubsShadow) return null;

    const runtime = runtimeHubs
      .map((h) => (h.hub || '').toUpperCase().trim())
      .filter(Boolean);

    const catalog = await knowledgeRepository.getHubCatalog(
      this.padTrainNo(trainNo),
      source,
      destination
    );
    const catalogHubs = catalog.map((c) => c.hub_station);

    const match = hubSetsMatch(runtime, catalogHubs);
    const matchRate = computeShadowMatchRate(runtime, catalogHubs);

    const result: ShadowCompareResult = {
      train_no: this.padTrainNo(trainNo),
      source: source.toUpperCase().trim(),
      destination: destination.toUpperCase().trim(),
      runtime_hubs: runtime,
      catalog_hubs: catalogHubs,
      match,
      match_rate: Math.round(matchRate * 1000) / 1000,
    };

    logInfo(
      `[KNOWLEDGE_SHADOW] train=${result.train_no} ${result.source}→${result.destination} ` +
      `runtime=[${runtime.join(',')}] catalog=[${catalogHubs.join(',')}] match=${match} rate=${result.match_rate}`
    );

    if (featureFlags.knowledgeMetrics) {
      try {
        const { knowledgeMetricsService } = require('./knowledgeMetricsService');
        knowledgeMetricsService.recordShadowCompare(match, matchRate);
      } catch {
        // ignore
      }
    }

    return result;
  }

  /**
   * Materialize hub catalog for one route from train_schedule.
   */
  async materializeRouteCatalog(
    trainNo: string,
    source: string,
    destination: string,
    scheduleVersion?: string
  ): Promise<number> {
    const stops = await knowledgeRepository.loadTrainStops(this.padTrainNo(trainNo));
    if (stops.length <= 2) return 0;

    const candidates = await buildHubCandidatesFromStops(stops, source, destination);
    if (candidates.length === 0) return 0;

    const rows = candidates.map((c) => ({
      train_no: this.padTrainNo(trainNo),
      source: source.toUpperCase().trim(),
      destination: destination.toUpperCase().trim(),
      hub_station: c.hub_station,
      hub_sn: c.hub_sn,
      src_sn: c.src_sn,
      dest_sn: c.dest_sn,
      leg1_day_offset: 0,
      buffer_minutes: c.buffer_minutes,
      is_major_hub: c.is_major_hub,
      rank_score: c.rank_score,
      schedule_version: scheduleVersion || null,
    }));

    return knowledgeRepository.upsertHubCatalogRows(rows);
  }

  /**
   * Nightly stats aggregation from outcome events. No-op when KNOWLEDGE_STATS=false.
   */
  async refreshStats(): Promise<number> {
    if (!featureFlags.knowledgeStats) return 0;
    logInfo('[KNOWLEDGE_STATS] refreshStats skipped — batch aggregation deferred to Phase 5');
    return 0;
  }

  /**
   * Batch catalog refresh for known routes.
   */
  async refreshHubCatalog(maxRoutes = 200): Promise<{ routes: number; rows: number }> {
    const routes = await knowledgeRepository.listDistinctTrainRoutes(maxRoutes);
    let totalRows = 0;

    for (const route of routes) {
      const n = await this.materializeRouteCatalog(
        route.train_no,
        route.source,
        route.destination
      );
      totalRows += n;
    }

    logInfo(`[KNOWLEDGE_CATALOG] refresh complete routes=${routes.length} rows=${totalRows}`);
    return { routes: routes.length, rows: totalRows };
  }

  padTrainNo(trainNo: string): string {
    const t = String(trainNo || '').trim();
    if (/^\d+$/.test(t)) return t.padStart(5, '0');
    return t;
  }

  private inferMappingReason(userCode: string, scheduleStop: string): MappingReason {
    const u = userCode.toUpperCase().trim();
    const s = scheduleStop.toUpperCase().trim();
    if (u === s) return 'EXACT';
    return 'ALIAS';
  }

  private isKnowledgePersistenceEnabled(): boolean {
    return (
      featureFlags.knowledgeHubs ||
      featureFlags.knowledgeStats ||
      featureFlags.knowledgeHubsShadow
    );
  }

  /** Fire-and-forget mapping persist after successful resolution */
  scheduleMappingPersist(
    trainNo: string,
    userFrom: string,
    userTo: string,
    resolution: {
      scheduleFrom: string;
      scheduleTo: string;
      apiFrom: string;
      apiTo: string;
    }
  ): void {
    if (!this.isKnowledgePersistenceEnabled()) return;
    if (!knowledgeRepository.isConfigured()) return;
    this.persistStationMapping(trainNo, userFrom, userTo, resolution).catch(() => {});
  }

  /** Convenience for learningService dual-write */
  async recordRescueEvent(
    eventType: RescueOutcomeEventType,
    params: {
      trainNo: string;
      source: string;
      destination: string;
      hubStation?: string;
      journeyDate?: string;
      classCode?: string;
      userId?: string;
      deviceId?: string;
    }
  ): Promise<void> {
    await this.recordOutcome({
      event_type: eventType,
      train_no: params.trainNo,
      source: params.source,
      destination: params.destination,
      hub_station: params.hubStation || null,
      journey_date: params.journeyDate || null,
      class_code: params.classCode || null,
      user_id: params.userId || null,
      device_id: params.deviceId || null,
    });
  }
}

export const knowledgeService = new KnowledgeService();