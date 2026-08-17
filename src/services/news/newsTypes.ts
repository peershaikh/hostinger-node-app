/**
 * Canonical News Types and Ingestion Contracts for Trayago.
 */

export type SourceTier = 'TIER_1_OFFICIAL' | 'TIER_2_GOVERNMENT' | 'TIER_3_RECOGNIZED_MEDIA';

export type IngestionStatus =
  | 'DISCOVERED'
  | 'VALIDATED'
  | 'FILTER_PASSED'
  | 'DEDUPLICATED'
  | 'READY_FOR_AI'
  | 'AI_DRAFTED'
  | 'REVIEW_REQUIRED'
  | 'APPROVED'
  | 'PUBLISHED'
  | 'ARCHIVED'
  | 'REJECTED';

export type HealthStatus = 'HEALTHY' | 'DEGRADED' | 'FAILING' | 'CIRCUIT_BROKEN';

export interface NewsSource {
  id: string;
  name: string;
  url: string;
  tier: SourceTier;
  category: string;
  enabled: boolean;
  pollIntervalMs?: number;
  headers?: Record<string, string>;
  maxItemsPerFetch?: number;
}

export interface SourceHealth {
  sourceId: string;
  name: string;
  tier: SourceTier;
  lastFetchAt: string | null;
  lastSuccessAt: string | null;
  lastErrorAt: string | null;
  lastErrorMessage: string | null;
  httpStatus: number | null;
  latencyMs: number;
  totalRequests: number;
  totalSuccess: number;
  totalFailures: number;
  consecutiveFailures: number;
  nextRetryAt: number;
  status: HealthStatus;
}

export interface CanonicalNewsArticle {
  id: string; // MD5 hex ID
  slug: string | null;
  title: string;
  seo_title: string | null;
  meta_description: string | null;
  summary: string;
  key_takeaways: string[] | null;
  affected_trains: string[];
  affected_stations: string[];
  category: string;
  source_name: string;
  source_url: string;
  source_id: string;
  source_tier: SourceTier;
  source_guid: string | null;
  content_hash: string;
  simhash: string;
  relevance_score: number;
  image_url: string | null;
  status: IngestionStatus;
  ingestion_status: 'PENDING_AI' | 'INGESTION_COMPLETE' | 'REJECTED';
  first_seen_at: string;
  last_seen_at: string;
  published_at: string;
  created_at: string;
  updated_at: string;
}

export interface RelevanceScoreResult {
  isRelevant: boolean;
  score: number;
  positiveScore: number;
  penalty: number;
  rejectionReason?: 'OFF_TOPIC' | 'LOW_RELEVANCE' | 'MALFORMED_SOURCE' | 'DUPLICATE';
}

export interface IngestionResult {
  sourceId: string;
  sourceName: string;
  status: 'SUCCESS' | 'FAILED' | 'SKIPPED';
  totalRaw: number;
  accepted: CanonicalNewsArticle[];
  rejectedCount: number;
  rejectedReasons: Record<string, number>;
  latencyMs: number;
  error?: string;
}
