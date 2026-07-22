export type IncidentSeverity = 'CRITICAL' | 'HIGH' | 'MEDIUM' | 'LOW' | 'INFO';

export interface TelemetryIncident {
  id: string;
  hash: string;
  title: string;
  category: 'EXPRESS_ERROR' | 'WINSTON_LOG' | 'PM2_TELEMETRY' | 'API_FAILURE' | 'RATE_LIMIT' | 'SUPABASE_ERROR' | 'PAYMENT_FAILURE' | 'SEARCH_FAILURE' | 'PNR_FAILURE' | 'AI_SERVICE_FAILURE';
  severity: IncidentSeverity;
  evidence: string;
  likely_root_cause: string;
  affected_module: string;
  suggested_fix: string;
  confidence_score: number;
  occurrences: number;
  first_seen: string;
  last_seen: string;
  status: 'OPEN' | 'INVESTIGATING' | 'RESOLVED';
}

export interface GeneratedEngineeringTask {
  id: string;
  title: string;
  category: string;
  priority: IncidentSeverity;
  estimated_effort: 'XS' | 'S' | 'M' | 'L' | 'XL';
  risk_level: 'LOW' | 'MEDIUM' | 'HIGH';
  suggested_owner: string;
  associated_incident_id: string;
}

export interface ProductionIncidentReport {
  generated_at: string;
  execution_time_ms: number;
  metrics: {
    total_incidents: number;
    open_incidents: number;
    resolved_incidents: number;
    critical_count: number;
    high_count: number;
    medium_count: number;
    low_count: number;
  };
  incidents: TelemetryIncident[];
  tasks: GeneratedEngineeringTask[];
}
