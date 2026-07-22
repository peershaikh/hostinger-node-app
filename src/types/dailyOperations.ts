export interface DailyAiReport {
  timestamp: string;
  generated_at: string;
  system_health: {
    status: 'OPTIMAL' | 'DEGRADED' | 'CRITICAL';
    uptime_seconds: number;
    memory_usage_mb: number;
    error_rate_pct: number;
  };
  new_errors: Array<{ code: string; message: string; count: number; last_seen: string }>;
  repeated_errors: Array<{ code: string; count: number; frequency: string }>;
  top_failed_apis: Array<{ endpoint: string; failure_count: number; avg_latency_ms: number }>;
  most_searched_routes: Array<{ source: string; destination: string; count: number }>;
  most_delayed_trains: Array<{ train_no: string; delay_mins: number }>;
  provider_health: Array<{ provider: string; status: 'ONLINE' | 'DEGRADED' | 'OFFLINE'; success_rate: string }>;
  payment_summary: {
    total_orders: number;
    successful_orders: number;
    failed_orders: number;
    conversion_rate: string;
    revenue_usd: number;
  };
  security_events: Array<{ event: string; ip: string; count: number; severity: 'LOW' | 'MEDIUM' | 'HIGH' | 'CRITICAL' }>;
  user_feedback_summary: {
    total_feedback: number;
    top_category: string;
    unresolved_count: number;
  };
  ai_suggested_fixes: Array<{ issue: string; recommendation: string; action_item: string; impact: string }>;
  priority_summary: {
    critical_count: number;
    high_count: number;
    medium_count: number;
    low_count: number;
  };
}
