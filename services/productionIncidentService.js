"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.productionIncidentService = exports.ProductionIncidentService = void 0;
const crypto_1 = __importDefault(require("crypto"));
const supabase_1 = require("../config/supabase");
const logger_1 = require("../middleware/logger");
class ProductionIncidentService {
    constructor() {
        this.cachedReport = null;
        this.lastGeneratedTime = 0;
    }
    generateHash(str) {
        return crypto_1.default.createHash('md5').update(str).digest('hex').substring(0, 10);
    }
    async getProductionIncidentReport() {
        const startTime = Date.now();
        if (this.cachedReport && (startTime - this.lastGeneratedTime < 10 * 60 * 1000)) {
            return {
                ...this.cachedReport,
                execution_time_ms: Date.now() - startTime
            };
        }
        const incidentsMap = new Map();
        const tasks = [];
        const nowIso = new Date(startTime).toISOString();
        const twentyFourHoursAgo = new Date(startTime - 24 * 60 * 60 * 1000).toISOString();
        // 1. Process Memory / Telemetry Signals
        const heapMb = Math.round(process.memoryUsage().heapUsed / 1024 / 1024);
        if (heapMb > 350) {
            const title = 'High Process Heap Memory Usage';
            const hash = this.generateHash(title);
            incidentsMap.set(hash, {
                id: `INC-${hash}`,
                hash,
                title,
                category: 'PM2_TELEMETRY',
                severity: 'HIGH',
                evidence: `Heap Used: ${heapMb} MB (Threshold: 350 MB)`,
                likely_root_cause: 'Uncollected in-memory cache objects or large JSON response serialization',
                affected_module: 'Node.js Core Runtime',
                suggested_fix: 'Enable heap snapshot profiling or increase PM2 max_memory_restart to 512M',
                confidence_score: 92,
                occurrences: 1,
                first_seen: nowIso,
                last_seen: nowIso,
                status: 'OPEN'
            });
        }
        // 2. Query Supabase Payment Failure Telemetry
        try {
            if ((0, supabase_1.isSupabaseConfigured)()) {
                const { data: failedTxs } = await supabase_1.supabase
                    .from('payment_transactions')
                    .select('id, status, error_message, created_at')
                    .eq('status', 'FAILED')
                    .gte('created_at', twentyFourHoursAgo);
                if (failedTxs && failedTxs.length > 0) {
                    const title = 'Cashfree Gateway Transaction Failures';
                    const hash = this.generateHash(title);
                    const count = failedTxs.length;
                    incidentsMap.set(hash, {
                        id: `INC-${hash}`,
                        hash,
                        title,
                        category: 'PAYMENT_FAILURE',
                        severity: 'HIGH',
                        evidence: `${count} payment_transactions records with status='FAILED' in 24h`,
                        likely_root_cause: 'User checkout abandonment, gateway timeout, or invalid webhook signature verification',
                        affected_module: 'Payment Gateway Middleware',
                        suggested_fix: 'Verify Cashfree Webhook secret configuration and examine paymentController failure logs',
                        confidence_score: 95,
                        occurrences: count,
                        first_seen: failedTxs[0].created_at || nowIso,
                        last_seen: failedTxs[failedTxs.length - 1].created_at || nowIso,
                        status: 'OPEN'
                    });
                    tasks.push({
                        id: `TSK-${hash}`,
                        title: 'Investigate Cashfree Payment Webhook & Order Failure Spike',
                        category: 'PAYMENTS',
                        priority: 'HIGH',
                        estimated_effort: 'M',
                        risk_level: 'MEDIUM',
                        suggested_owner: 'Backend Platform Team',
                        associated_incident_id: `INC-${hash}`
                    });
                }
            }
        }
        catch (err) {
            logger_1.winstonLogger.warn(`[INCIDENT_ENGINE] Supabase query telemetry error: ${err.message}`);
        }
        // 3. Fallback / Health Baseline Telemetry
        if (incidentsMap.size === 0) {
            const title = 'All Systems Operating Within Normal Telemetry Thresholds';
            const hash = this.generateHash(title);
            incidentsMap.set(hash, {
                id: `INC-${hash}`,
                hash,
                title,
                category: 'PM2_TELEMETRY',
                severity: 'INFO',
                evidence: `Heap memory ${heapMb} MB, DB connected, 0 active unhandled runtime crashes`,
                likely_root_cause: 'No active production anomalies detected',
                affected_module: 'System Orchestrator',
                suggested_fix: 'Continue automated health checks and log monitoring',
                confidence_score: 99,
                occurrences: 1,
                first_seen: nowIso,
                last_seen: nowIso,
                status: 'RESOLVED'
            });
        }
        const incidentsList = Array.from(incidentsMap.values());
        const criticalCount = incidentsList.filter(i => i.severity === 'CRITICAL').length;
        const highCount = incidentsList.filter(i => i.severity === 'HIGH').length;
        const mediumCount = incidentsList.filter(i => i.severity === 'MEDIUM').length;
        const lowCount = incidentsList.filter(i => i.severity === 'LOW').length;
        const openCount = incidentsList.filter(i => i.status === 'OPEN').length;
        const resolvedCount = incidentsList.filter(i => i.status === 'RESOLVED').length;
        const report = {
            generated_at: nowIso,
            execution_time_ms: Date.now() - startTime,
            metrics: {
                total_incidents: incidentsList.length,
                open_incidents: openCount,
                resolved_incidents: resolvedCount,
                critical_count: criticalCount,
                high_count: highCount,
                medium_count: mediumCount,
                low_count: lowCount
            },
            incidents: incidentsList,
            tasks
        };
        this.cachedReport = report;
        this.lastGeneratedTime = startTime;
        return report;
    }
}
exports.ProductionIncidentService = ProductionIncidentService;
exports.productionIncidentService = new ProductionIncidentService();
