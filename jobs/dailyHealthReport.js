"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.dailyHealthReportJob = exports.DailyHealthReportJob = void 0;
const node_cron_1 = __importDefault(require("node-cron"));
const supabase_1 = require("../config/supabase");
const logger_1 = require("../middleware/logger");
const emailService_1 = require("../services/emailService");
const metricsService_1 = require("../services/metricsService");
class DailyHealthReportJob {
    start() {
        logger_1.winstonLogger.info('[DAILY_HEALTH_REPORT] Scheduled for 00:00 every day.');
        node_cron_1.default.schedule('0 0 * * *', async () => {
            try {
                await this.generateAndSend();
            }
            catch (err) {
                logger_1.winstonLogger.error(`[DAILY_HEALTH_REPORT] Error generating report: ${err.message}`);
            }
        });
    }
    async generateAndSend() {
        logger_1.winstonLogger.info('[DAILY_HEALTH_REPORT] Generating daily health report...');
        // 1. Fetch system metrics
        const status = await metricsService_1.metricsService.getSystemStatus();
        // 2. Count today's alerts
        const today = new Date().toISOString().split('T')[0];
        const { count: alertsDispatched } = await supabase_1.supabase
            .from('smart_alerts')
            .select('id', { count: 'exact', head: true })
            .eq('status', 'DELIVERED')
            .gte('updated_at', today);
        // 3. Render HTML
        const html = `
      <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto; padding: 20px;">
        <h2 style="color: #6b21a8;">Daily Platform Health Report</h2>
        <p><strong>Date:</strong> ${new Date().toLocaleDateString()}</p>
        
        <table style="width: 100%; border-collapse: collapse; margin-top: 20px;">
          <tr style="background-color: #f3f4f6;">
            <th style="padding: 10px; border: 1px solid #ddd; text-align: left;">Metric</th>
            <th style="padding: 10px; border: 1px solid #ddd; text-align: left;">Value</th>
          </tr>
          <tr>
            <td style="padding: 10px; border: 1px solid #ddd;">Overall Health</td>
            <td style="padding: 10px; border: 1px solid #ddd; color: ${status.system_health === 'OPTIMAL' ? 'green' : 'red'}; font-weight: bold;">
              ${status.system_health}
            </td>
          </tr>
          <tr>
            <td style="padding: 10px; border: 1px solid #ddd;">Avg API Latency</td>
            <td style="padding: 10px; border: 1px solid #ddd;">${status.avg_response_time_ms} ms</td>
          </tr>
          <tr>
            <td style="padding: 10px; border: 1px solid #ddd;">Error Rate</td>
            <td style="padding: 10px; border: 1px solid #ddd;">${status.error_rate_percent}%</td>
          </tr>
          <tr>
            <td style="padding: 10px; border: 1px solid #ddd;">Alerts Dispatched</td>
            <td style="padding: 10px; border: 1px solid #ddd;">${alertsDispatched || 0}</td>
          </tr>
        </table>
        
        <h3 style="margin-top: 30px;">Provider Status</h3>
        <ul style="line-height: 1.6;">
          <li><strong>IRCTC:</strong> ${status.providers.IRCTC.status === 'ONLINE' ? '🟩' : '🟥'} ${status.providers.IRCTC.success_rate_percent}% Success</li>
          <li><strong>RapidAPI:</strong> ${status.providers.RapidAPI.status === 'ONLINE' ? '🟩' : '🟥'} ${status.providers.RapidAPI.success_rate_percent}% Success</li>
          <li><strong>RailRadar:</strong> ${status.providers.RailRadar.status === 'ONLINE' ? '🟩' : '🟥'} ${status.providers.RailRadar.success_rate_percent}% Success</li>
        </ul>
        
        <p style="color: #666; font-size: 12px; margin-top: 40px;">
          Generated automatically by Trayago Monitoring System.
        </p>
      </div>
    `;
        // 4. Dispatch Email
        const adminEmail = process.env.ADMIN_EMAIL || 'admin@trayago.in';
        await emailService_1.emailService.sendHealthReportEmail(adminEmail, `Trayago Daily Health: ${status.system_health}`, html);
        logger_1.winstonLogger.info(`[DAILY_HEALTH_REPORT] Sent report to ${adminEmail}.`);
    }
}
exports.DailyHealthReportJob = DailyHealthReportJob;
exports.dailyHealthReportJob = new DailyHealthReportJob();
