import cron from 'node-cron';
import { supabase } from '../config/supabase';
import { winstonLogger } from '../middleware/logger';
import { emailService } from '../services/emailService';
import { metricsService } from '../services/metricsService';
// ── Phase 10.8.42 additions (T6/T7) ──────────────────────────────────────
import { aiOperationsService } from '../services/aiOperationsService';
import { eventMetrics } from '../services/eventMetrics';
import { userCache } from '../cache/userCache';
import { smartAvailabilityMetrics } from '../services/smartAvailabilityMetrics';

export class DailyHealthReportJob {
  start() {
    winstonLogger.info('[DAILY_HEALTH_REPORT] Scheduled for 08:00 IST (02:30 UTC) every day.');

    cron.schedule('30 2 * * *', async () => {
      try {
        await this.generateAndSend();
      } catch (err: any) {
        winstonLogger.error(`[DAILY_HEALTH_REPORT] Error generating report: ${err.message}`);
      }
    });
  }

  private async generateAndSend() {
    winstonLogger.info('[DAILY_HEALTH_REPORT] Generating daily health report...');

    // ── Step 1: Collect all data (failures are non-fatal) ────────────────────
    const reportDate = new Date().toISOString().split('T')[0]; // YYYY-MM-DD (UTC, close enough at 02:30 UTC)

    const status = await metricsService.getSystemStatus();

    // AI report: non-fatal if service unavailable
    let aiReport: any = null;
    try {
      aiReport = await aiOperationsService.generateDailyReport();
    } catch (aiErr: any) {
      winstonLogger.warn(`[DAILY_HEALTH_REPORT] AI report unavailable: ${aiErr.message}`);
    }

    // In-process snapshots — zero I/O, never throw
    const eventStats  = eventMetrics.snapshot();
    const cacheStats  = userCache.getStats();
    const availStats  = smartAvailabilityMetrics.getSnapshot();

    // Smart-alerts count for the IST business day
    const { count: alertsDispatched } = await supabase
      .from('smart_alerts')
      .select('id', { count: 'exact', head: true })
      .eq('status', 'DELIVERED')
      .gte('updated_at', reportDate);

    // ── Step 2: Build digestPayload (T7) ────────────────────────────
    const digestPayload = {
      system: {
        health:          status.system_health,
        uptime_seconds:  Math.round(process.uptime()),
        heap_mb:         status.heap_usage_mb,
        cpu_load:        status.cpu_load,
        error_rate_pct:  status.error_rate_percent,
      },
      api: {
        avg_latency_ms:  status.avg_response_time_ms,
        p95_latency_ms:  status.p95_response_time_ms,
        rpm:             status.requests_per_minute,
        error_rate_pct:  status.error_rate_percent,
      },
      providers: {
        IRCTC:      status.providers.IRCTC,
        RapidAPI:   status.providers.RapidAPI,
        RailRadar:  status.providers.RailRadar,
        ConfirmTkt: status.providers.ConfirmTkt,
      },
      event_pipeline: {
        events_received: eventStats.events_received,
        events_written:  eventStats.events_written,
        events_failed:   eventStats.events_failed,
        queue_depth:     eventStats.queue_depth,
        retry_count:     eventStats.retry_count,
      },
      cache: {
        user_l1_hits:            cacheStats.l1Hits,
        user_l2_hits:            cacheStats.l2Hits,
        user_misses:             cacheStats.misses,
        user_invalidations:      cacheStats.invalidations,
        user_pubsub_events:      cacheStats.pubSubEvents,
        avail_l1_hits:           availStats['l1_hits'],
        avail_l2_hits:           availStats['l2_hits'],
        avail_provider_calls:    availStats['provider_calls'],
        avail_singleflight_hits: availStats['singleflight_hits'],
        avail_redis_failures:    availStats['redis_failures'],
        avail_latency_avg_ms:    availStats['cache_latency_avg_ms'],
      },
      revenue:          aiReport?.payment_summary  ?? null,
      alerts:           { dispatched_today: alertsDispatched ?? 0 },
      ai_fixes:         aiReport?.ai_suggested_fixes ?? [],
      priority_summary: aiReport?.priority_summary   ?? null,
    };

    // ── Step 3: Render HTML from digestPayload ──────────────────────
    const adminEmail = process.env.ADMIN_EMAIL || 'admin@trayago.in';
    const healthColor = digestPayload.system.health === 'OPTIMAL' ? '#16a34a'
                      : digestPayload.system.health === 'DEGRADED' ? '#d97706'
                      : '#dc2626';
    const criticalCount = digestPayload.priority_summary?.critical_count ?? 0;
    const subject = `[${digestPayload.system.health}] Trayago Morning Ops — ${reportDate} — ${criticalCount} Critical`;

    const aiFixes: string = digestPayload.ai_fixes.slice(0, 5)
      .map((f: { issue: string; recommendation: string }) =>
        `<li><strong>${f.issue}</strong> — ${f.recommendation}</li>`
      ).join('');

    const html = `<!DOCTYPE html><html><head><meta charset="UTF-8"></head><body>
<div style="font-family:Arial,sans-serif;max-width:680px;margin:0 auto;padding:20px;background:#f9fafb;">
  <div style="background:#1e1b4b;color:white;padding:20px;border-radius:8px 8px 0 0;">
    <h2 style="margin:0;">Trayago Morning Operations Digest</h2>
    <p style="margin:4px 0 0;opacity:.8;">Report Date: ${reportDate} | Generated at 08:00 IST</p>
  </div>
  <div style="background:white;padding:20px;border:1px solid #e5e7eb;">

    <h3 style="color:#374151;">1. System Health</h3>
    <table style="width:100%;border-collapse:collapse;margin-bottom:20px;">
      <tr style="background:#f3f4f6;"><th style="padding:8px;border:1px solid #ddd;text-align:left;">Metric</th><th style="padding:8px;border:1px solid #ddd;text-align:left;">Value</th></tr>
      <tr><td style="padding:8px;border:1px solid #ddd;">Overall Health</td><td style="padding:8px;border:1px solid #ddd;color:${healthColor};font-weight:bold;">${digestPayload.system.health}</td></tr>
      <tr><td style="padding:8px;border:1px solid #ddd;">Uptime</td><td style="padding:8px;border:1px solid #ddd;">${Math.round(digestPayload.system.uptime_seconds / 3600)}h</td></tr>
      <tr><td style="padding:8px;border:1px solid #ddd;">Heap Usage</td><td style="padding:8px;border:1px solid #ddd;">${digestPayload.system.heap_mb} MB</td></tr>
      <tr><td style="padding:8px;border:1px solid #ddd;">CPU Load (1m)</td><td style="padding:8px;border:1px solid #ddd;">${digestPayload.system.cpu_load}</td></tr>
      <tr><td style="padding:8px;border:1px solid #ddd;">Error Rate</td><td style="padding:8px;border:1px solid #ddd;">${digestPayload.system.error_rate_pct}%</td></tr>
    </table>

    <h3 style="color:#374151;">2. API Performance</h3>
    <table style="width:100%;border-collapse:collapse;margin-bottom:20px;">
      <tr style="background:#f3f4f6;"><th style="padding:8px;border:1px solid #ddd;text-align:left;">Metric</th><th style="padding:8px;border:1px solid #ddd;text-align:left;">Value</th></tr>
      <tr><td style="padding:8px;border:1px solid #ddd;">Avg Latency</td><td style="padding:8px;border:1px solid #ddd;">${digestPayload.api.avg_latency_ms}ms</td></tr>
      <tr><td style="padding:8px;border:1px solid #ddd;">P95 Latency</td><td style="padding:8px;border:1px solid #ddd;">${digestPayload.api.p95_latency_ms}ms</td></tr>
      <tr><td style="padding:8px;border:1px solid #ddd;">Requests/min</td><td style="padding:8px;border:1px solid #ddd;">${digestPayload.api.rpm}</td></tr>
      <tr><td style="padding:8px;border:1px solid #ddd;">Error Rate</td><td style="padding:8px;border:1px solid #ddd;">${digestPayload.api.error_rate_pct}%</td></tr>
    </table>

    <h3 style="color:#374151;">3. Provider Health</h3>
    <table style="width:100%;border-collapse:collapse;margin-bottom:20px;">
      <tr style="background:#f3f4f6;"><th style="padding:8px;border:1px solid #ddd;text-align:left;">Provider</th><th style="padding:8px;border:1px solid #ddd;text-align:left;">Status</th><th style="padding:8px;border:1px solid #ddd;text-align:left;">Success %</th><th style="padding:8px;border:1px solid #ddd;text-align:left;">Latency</th></tr>
      <tr><td style="padding:8px;border:1px solid #ddd;">IRCTC</td><td style="padding:8px;border:1px solid #ddd;color:${digestPayload.providers.IRCTC.status==='ONLINE'?'green':'red'};font-weight:bold;">${digestPayload.providers.IRCTC.status}</td><td style="padding:8px;border:1px solid #ddd;">${digestPayload.providers.IRCTC.success_rate_percent}%</td><td style="padding:8px;border:1px solid #ddd;">${digestPayload.providers.IRCTC.avg_latency_ms}ms</td></tr>
      <tr><td style="padding:8px;border:1px solid #ddd;">RapidAPI</td><td style="padding:8px;border:1px solid #ddd;color:${digestPayload.providers.RapidAPI.status==='ONLINE'?'green':'red'};font-weight:bold;">${digestPayload.providers.RapidAPI.status}</td><td style="padding:8px;border:1px solid #ddd;">${digestPayload.providers.RapidAPI.success_rate_percent}%</td><td style="padding:8px;border:1px solid #ddd;">${digestPayload.providers.RapidAPI.avg_latency_ms}ms</td></tr>
      <tr><td style="padding:8px;border:1px solid #ddd;">RailRadar</td><td style="padding:8px;border:1px solid #ddd;color:${digestPayload.providers.RailRadar.status==='ONLINE'?'green':'red'};font-weight:bold;">${digestPayload.providers.RailRadar.status}</td><td style="padding:8px;border:1px solid #ddd;">${digestPayload.providers.RailRadar.success_rate_percent}%</td><td style="padding:8px;border:1px solid #ddd;">${digestPayload.providers.RailRadar.avg_latency_ms}ms</td></tr>
      <tr><td style="padding:8px;border:1px solid #ddd;">ConfirmTkt</td><td style="padding:8px;border:1px solid #ddd;color:${digestPayload.providers.ConfirmTkt.status==='ONLINE'?'green':'red'};font-weight:bold;">${digestPayload.providers.ConfirmTkt.status}</td><td style="padding:8px;border:1px solid #ddd;">${digestPayload.providers.ConfirmTkt.success_rate_percent}%</td><td style="padding:8px;border:1px solid #ddd;">${digestPayload.providers.ConfirmTkt.avg_latency_ms}ms</td></tr>
    </table>

    <h3 style="color:#374151;">4. Event Pipeline</h3>
    <table style="width:100%;border-collapse:collapse;margin-bottom:20px;">
      <tr style="background:#f3f4f6;"><th style="padding:8px;border:1px solid #ddd;text-align:left;">Metric</th><th style="padding:8px;border:1px solid #ddd;text-align:left;">Value</th></tr>
      <tr><td style="padding:8px;border:1px solid #ddd;">Events Received</td><td style="padding:8px;border:1px solid #ddd;">${digestPayload.event_pipeline.events_received}</td></tr>
      <tr><td style="padding:8px;border:1px solid #ddd;">Events Written</td><td style="padding:8px;border:1px solid #ddd;">${digestPayload.event_pipeline.events_written}</td></tr>
      <tr><td style="padding:8px;border:1px solid #ddd;">Events Failed</td><td style="padding:8px;border:1px solid #ddd;">${digestPayload.event_pipeline.events_failed}</td></tr>
      <tr><td style="padding:8px;border:1px solid #ddd;">Queue Depth</td><td style="padding:8px;border:1px solid #ddd;">${digestPayload.event_pipeline.queue_depth}</td></tr>
      <tr><td style="padding:8px;border:1px solid #ddd;">Retry Count</td><td style="padding:8px;border:1px solid #ddd;">${digestPayload.event_pipeline.retry_count}</td></tr>
    </table>

    <h3 style="color:#374151;">5. Cache Health</h3>
    <table style="width:100%;border-collapse:collapse;margin-bottom:20px;">
      <tr style="background:#f3f4f6;"><th style="padding:8px;border:1px solid #ddd;text-align:left;">Metric</th><th style="padding:8px;border:1px solid #ddd;text-align:left;">Value</th></tr>
      <tr><td style="padding:8px;border:1px solid #ddd;">User L1 Hits</td><td style="padding:8px;border:1px solid #ddd;">${digestPayload.cache.user_l1_hits}</td></tr>
      <tr><td style="padding:8px;border:1px solid #ddd;">User L2 Hits</td><td style="padding:8px;border:1px solid #ddd;">${digestPayload.cache.user_l2_hits}</td></tr>
      <tr><td style="padding:8px;border:1px solid #ddd;">User Misses</td><td style="padding:8px;border:1px solid #ddd;">${digestPayload.cache.user_misses}</td></tr>
      <tr><td style="padding:8px;border:1px solid #ddd;">Avail L1 Hits</td><td style="padding:8px;border:1px solid #ddd;">${digestPayload.cache.avail_l1_hits}</td></tr>
      <tr><td style="padding:8px;border:1px solid #ddd;">Avail Provider Calls</td><td style="padding:8px;border:1px solid #ddd;">${digestPayload.cache.avail_provider_calls}</td></tr>
      <tr><td style="padding:8px;border:1px solid #ddd;">Cache Latency Avg</td><td style="padding:8px;border:1px solid #ddd;">${digestPayload.cache.avail_latency_avg_ms}ms</td></tr>
    </table>

    ${digestPayload.revenue ? `
    <h3 style="color:#374151;">6. Revenue (24h)</h3>
    <table style="width:100%;border-collapse:collapse;margin-bottom:20px;">
      <tr style="background:#f3f4f6;"><th style="padding:8px;border:1px solid #ddd;text-align:left;">Metric</th><th style="padding:8px;border:1px solid #ddd;text-align:left;">Value</th></tr>
      <tr><td style="padding:8px;border:1px solid #ddd;">Total Orders</td><td style="padding:8px;border:1px solid #ddd;">${digestPayload.revenue.total_orders}</td></tr>
      <tr><td style="padding:8px;border:1px solid #ddd;">Successful</td><td style="padding:8px;border:1px solid #ddd;">${digestPayload.revenue.successful_orders}</td></tr>
      <tr><td style="padding:8px;border:1px solid #ddd;">Failed</td><td style="padding:8px;border:1px solid #ddd;">${digestPayload.revenue.failed_orders}</td></tr>
      <tr><td style="padding:8px;border:1px solid #ddd;">Conversion Rate</td><td style="padding:8px;border:1px solid #ddd;">${digestPayload.revenue.conversion_rate}</td></tr>
    </table>` : ''}

    <h3 style="color:#374151;">7. Alerts Dispatched Today</h3>
    <p style="padding:8px;background:#f3f4f6;border-radius:4px;">${digestPayload.alerts.dispatched_today} smart alert(s) delivered</p>

    ${digestPayload.ai_fixes.length > 0 ? `
    <h3 style="color:#374151;">8. AI Suggested Actions</h3>
    <ul style="line-height:1.8;">${aiFixes}</ul>` : ''}

    <p style="color:#6b7280;font-size:12px;margin-top:30px;border-top:1px solid #e5e7eb;padding-top:10px;">
      Generated automatically by Trayago Ops System · ${new Date().toISOString()}
    </p>
  </div>
</div>
</body></html>`;

    // ── Step 4a: Send email (T6) ──────────────────────────────────
    let digestStatus: 'SENT' | 'FAILED' = 'SENT';
    let failureReason: string | undefined;
    let sentAt: string | undefined;

    try {
      await emailService.sendHealthReportEmail(adminEmail, subject, html);
      sentAt = new Date().toISOString();
      winstonLogger.info(`[DAILY_HEALTH_REPORT] Digest sent to ${adminEmail}.`);
    } catch (emailErr: any) {
      digestStatus = 'FAILED';
      failureReason = emailErr.message;
      winstonLogger.error(`[DAILY_HEALTH_REPORT] Email send failed: ${emailErr.message}`);
    }

    // ── Step 4b: Persist to ops_daily_digest (T6) ──────────────────
    // Uses static supabase import (no dynamic require). Non-fatal: a persist
    // failure must not suppress the email send result logged above.
    try {
      const { error: upsertError } = await supabase
        .from('ops_daily_digest')
        .upsert(
          {
            report_date:    reportDate,
            status:         digestStatus,
            system_health:  digestPayload.system.health,
            error_rate_pct: digestPayload.system.error_rate_pct,
            heap_mb:        digestPayload.system.heap_mb,
            cpu_load:       digestPayload.system.cpu_load,
            report_json:    digestPayload,
            email_to:       adminEmail,
            failure_reason: failureReason ?? null,
            sent_at:        sentAt ?? null,
            generated_at:   new Date().toISOString(),
          },
          { onConflict: 'report_date' }
        );
      if (upsertError) {
        winstonLogger.warn(`[DAILY_HEALTH_REPORT] Persist failed: ${upsertError.message}`);
      } else {
        winstonLogger.info(`[DAILY_HEALTH_REPORT] Digest persisted for ${reportDate}.`);
      }
    } catch (persistErr: any) {
      winstonLogger.warn(`[DAILY_HEALTH_REPORT] Persist exception: ${persistErr.message}`);
    }
  }
}

export const dailyHealthReportJob = new DailyHealthReportJob();
