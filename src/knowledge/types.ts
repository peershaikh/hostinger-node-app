/**
 * PHASE_4C871 — Knowledge Layer domain types.
 */

export type MappingReason = 'EXACT' | 'ALIAS' | 'CLUSTER' | 'TERMINAL_CORRECT';

export interface TrainStationMappingRow {
  id?: string;
  train_no: string;
  user_station: string;
  schedule_stop: string;
  irctc_api_code: string;
  stop_sn?: number | null;
  mapping_reason: MappingReason;
  confidence: number;
  source: string;
  verified_at?: string | null;
  is_active: boolean;
}

export interface RescueHubCatalogRow {
  id?: string;
  train_no: string;
  source: string;
  destination: string;
  hub_station: string;
  hub_sn: number;
  src_sn: number;
  dest_sn: number;
  leg1_day_offset: number;
  buffer_minutes?: number | null;
  is_major_hub: boolean;
  rank_score: number;
  computed_at?: string;
  schedule_version?: string | null;
}

export type RescueOutcomeEventType =
  | 'SHOWN'
  | 'EXPANDED'
  | 'AVAIL_CHECK'
  | 'IRCTC_CLICK'
  | 'FEEDBACK';

export interface RescueOutcomeEventRow {
  event_type: RescueOutcomeEventType;
  train_no: string;
  source: string;
  destination: string;
  hub_station?: string | null;
  journey_date?: string | null;
  class_code?: string | null;
  leg1_status?: string | null;
  leg2_status?: string | null;
  rescue_tier?: string | null;
  user_id?: string | null;
  device_id?: string | null;
  recommendation_id?: string | null;
}

export interface RescueHubStatsRow {
  train_no: string;
  source: string;
  destination: string;
  hub_station: string;
  sample_count: number;
  show_count: number;
  expand_count: number;
  avail_check_count: number;
  irctc_click_count: number;
  confirmed_pair_count: number;
  partial_rac_count: number;
  avg_buffer_minutes?: number | null;
  preferred_boarding?: string | null;
  preferred_alighting?: string | null;
  confidence_score: number;
  last_success_at?: string | null;
}

export interface HubCatalogEntry {
  hub_station: string;
  hub_sn: number;
  src_sn: number;
  dest_sn: number;
  rank_score: number;
  buffer_minutes?: number | null;
  is_major_hub: boolean;
}

export interface RankedHub extends HubCatalogEntry {
  confidence_score: number;
  composite_score: number;
}

export interface ShadowCompareResult {
  train_no: string;
  source: string;
  destination: string;
  runtime_hubs: string[];
  catalog_hubs: string[];
  match: boolean;
  match_rate: number;
}

/** Full schedule row for hub hydration (matches train_schedule SELECT in segment engine). */
export interface ScheduleStopFull {
  Station_Code: string;
  SN: number;
  Station_Name?: string;
  Arrival_time?: string;
  Departure_Time?: string;
}

/**
 * PHASE_4C877 — Runtime hub shape returned by getMidpointHubs / _buildHubsFromStops.
 */
export interface HydratedHubEntry {
  hub: string;
  stop: ScheduleStopFull;
  srcStop: ScheduleStopFull;
  destStop: ScheduleStopFull;
  stops: ScheduleStopFull[];
}

export interface CatalogHydrationResult {
  success: boolean;
  hubs: HydratedHubEntry[];
  failureReason?: string;
}

/** PHASE_4C877 — B1 dual-read telemetry payload (no API exposure). */
export interface B1DualReadResult {
  train_no: string;
  source: string;
  destination: string;
  catalog_hit: boolean;
  catalog_miss: boolean;
  hydration_success: boolean;
  hydration_failure: boolean;
  runtime_hubs: string[];
  catalog_hubs: string[];
  catalog_runtime_match: boolean;
  catalog_runtime_diff: {
    runtime_only: string[];
    catalog_only: string[];
  };
  match_rate: number;
  hydration_latency_ms: number;
}