export interface AiCapabilities {
  predictPnr: boolean;
  analyzeRoute: boolean;
  enrichRoute: boolean;
  categorizeFeedback: boolean;
  generateSchedule: boolean;
  normalizeAvailability: boolean;
  suggestAlternatives: boolean;
  genericPrompt: boolean;
  distillNewsArticle?: boolean;
}

export interface NewsDistillationInput {
  title: string;
  summary: string;
  sourceName: string;
  sourceUrl: string;
  sourceTier: 'TIER_1_OFFICIAL' | 'TIER_2_GOVERNMENT' | 'TIER_3_RECOGNIZED_MEDIA' | string;
  publishedAt: string;
  category: string;
  candidateTrains?: string[];
  candidateStations?: string[];
}

export interface NewsKeyTakeaways {
  what_happened: string;
  who_is_affected: string;
  what_passengers_should_do: string;
}

export interface NewsFaqItem {
  question: string;
  answer: string;
}

export interface NewsDistillationOutput {
  title: string;
  summary: string;
  key_takeaways: NewsKeyTakeaways;
  affected_trains: string[];
  affected_stations: string[];
  seo_title: string;
  meta_description: string;
  slug: string;
  faqs: NewsFaqItem[];
  confidence: 'HIGH' | 'MEDIUM' | 'LOW' | 'REJECTED';
  model?: string;
}

export type AiErrorCode =
  | 'PROVIDER_UNAVAILABLE'
  | 'TIMEOUT'
  | 'RATE_LIMITED'
  | 'INVALID_RESPONSE'
  | 'UNSUPPORTED_CAPABILITY'
  | 'CONFIGURATION_ERROR';

export class AiError extends Error {
  public readonly code: AiErrorCode;
  public readonly provider: string;
  public readonly status?: number;
  public readonly retryable?: boolean;

  constructor(params: { code: AiErrorCode; message: string; provider: string; status?: number; retryable?: boolean }) {
    super(params.message);
    this.name = 'AiError';
    this.code = params.code;
    this.provider = params.provider;
    this.status = params.status;
    this.retryable = params.retryable;
  }
}

export interface PnrPredictionInput {
  pnr: string;
  train_number?: string;
  wl_type?: string;
  wl_position?: number | string;
  booking_status?: string;
  current_status?: string;
  class_type?: string;
  from_station?: string;
  to_station?: string;
  date?: string;
  enrichmentContext?: any;
}

export interface PnrPredictionOutput {
  probability: string;
  prediction: string;
  explanation: string;
  advice: string;
  disclaimer: string;
  riskLevel?: string;
  providerId?: string;
}

export interface RouteAnalysisInput {
  source: string;
  destination: string;
  trains?: any[];
  isSplit?: boolean;
  hub?: string;
}

export interface RouteAnalysisOutput {
  insight: string;
  recommendation_reason: string;
  risk_level: string;
}

export interface RouteEnrichmentInput {
  queryId?: string;
  source: string;
  destination: string;
}

export interface RouteEnrichmentOutput {
  candidateRoute: string;
  candidateHub: string;
  trainNos: string[];
  stationAlias?: string;
  trainAlias?: string;
  confidence: 'HIGH' | 'MEDIUM' | 'LOW' | string;
  reason: string;
}

export interface FeedbackCategorizationInput {
  feedbackText: string;
  metadata?: {
    feature?: string;
    severity?: string;
    device?: string;
  };
}

export interface FeedbackCategorizationOutput {
  category: string;
  confidence: 'HIGH' | 'MEDIUM' | 'LOW' | string;
  priority: 'CRITICAL' | 'HIGH' | 'MEDIUM' | 'LOW' | string;
  summary: string;
  suggestedAction: string;
}

export interface ScheduleStationOutput {
  sn: number;
  station_code: string;
  station_name: string;
  arrival_time: string;
  departure_time: string;
  day: number;
}

export interface ScheduleGenerationOutput {
  train_number: string;
  train_name: string;
  stations: ScheduleStationOutput[];
}

export interface AvailabilityItemOutput {
  class: string;
  status: string;
  count: number;
}

export interface AiProvider {
  readonly providerId: string;
  readonly displayName: string;
  readonly capabilities: AiCapabilities;

  predictPnr?(input: PnrPredictionInput): Promise<PnrPredictionOutput>;
  analyzeRoute?(input: RouteAnalysisInput): Promise<RouteAnalysisOutput>;
  enrichRoute?(input: RouteEnrichmentInput): Promise<RouteEnrichmentOutput>;
  categorizeFeedback?(input: FeedbackCategorizationInput): Promise<FeedbackCategorizationOutput>;
  generateSchedule?(trainNo: string): Promise<ScheduleGenerationOutput | null>;
  normalizeAvailability?(rawAvailString: string): Promise<AvailabilityItemOutput[]>;
  suggestAlternatives?(source: string, destination: string): Promise<any[]>;
  distillNewsArticle?(input: NewsDistillationInput): Promise<NewsDistillationOutput | null>;
  generateText?(prompt: string, options?: { json?: boolean; temperature?: number; timeoutMs?: number }): Promise<any>;
  healthCheck?(): Promise<{ status: 'HEALTHY' | 'DEGRADED' | 'UNHEALTHY'; latencyMs: number; message: string }>;
}
