export interface OperationsInsightItem {
  id: string;
  category: 'RUNTIME_ERROR' | 'API_FAILURE' | 'SLOW_ENDPOINT' | 'MEMORY' | 'COST' | 'SEARCH_FAILURE' | 'FEEDBACK' | 'CRASH';
  title: string;
  evidence: string;
  source: string;
  timestamp: string;
  affected_module: string;
  severity: 'CRITICAL' | 'HIGH' | 'MEDIUM' | 'LOW';
  count: number;
}

export interface FixQueueItem {
  id: string;
  issue: string;
  evidence: string;
  root_cause: string;
  impact: string;
  suggested_fix: string;
  priority: 'CRITICAL' | 'HIGH' | 'MEDIUM' | 'LOW';
  confidence_score: number;
  owner: string;
  status: 'OPEN' | 'IN_REVIEW' | 'MITIGATED';
}

export interface IntelligenceV2Report {
  generated_at: string;
  execution_time_ms: number;
  insights: OperationsInsightItem[];
  fix_queue: FixQueueItem[];
  report_sections: {
    system_health: { status: string; uptime_s: number; memory_mb: number };
    payments: { total_orders: number; conversion_rate: string };
    search: { total_searches: number; top_route: string };
    pnr: { total_checks: number; prediction_accuracy: string };
    split_engine: { total_splits: number; conversion_rate: string };
    notifications: { active_tokens: number; total_sent: number };
    providers: Array<{ name: string; status: string }>;
    database: { status: string };
    api_costs: { daily_usd: string };
    user_growth: { total_users: number; new_24h: number };
    user_complaints: { total_unresolved: number };
    security_events: { rate_limit_throttles_24h: number };
  };
}
