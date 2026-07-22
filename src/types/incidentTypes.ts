export type IncidentPriority = 'CRITICAL' | 'HIGH' | 'MEDIUM' | 'LOW';

export interface Incident {
  id: string;
  title: string;
  category: 'LATENCY' | 'ERROR_SPIKE' | 'PAYMENT' | 'PROVIDER' | 'TRAFFIC' | 'MEMORY';
  priority: IncidentPriority;
  confidence_pct: number;
  issue: string;
  possible_root_cause: string;
  evidence: string;
  impact: string;
  recommended_fix: string;
  detected_at: string;
}

export interface EngineeringTask {
  id: string;
  priority: IncidentPriority;
  title: string;
  component: string;
  description: string;
  suggested_action: string;
  estimated_effort: 'XS' | 'S' | 'M' | 'L';
  created_at: string;
}

export interface IncidentReport {
  health_score: number;
  risk_score: number;
  open_incidents_count: number;
  by_priority: {
    critical: number;
    high: number;
    medium: number;
    low: number;
  };
  incidents: Incident[];
  slow_apis: Array<{ endpoint: string; avg_latency_ms: number; threshold: string }>;
  top_errors: Array<{ code: string; count: number; last_seen: string }>;
  provider_statuses: Array<{ provider: string; status: 'ONLINE' | 'DEGRADED' | 'OFFLINE'; latency_ms: number }>;
}
