"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const cookie_parser_1 = __importDefault(require("cookie-parser"));
const cors_1 = __importDefault(require("cors"));
const dotenv_1 = __importDefault(require("dotenv"));
const express_1 = __importDefault(require("express"));
const helmet_1 = __importDefault(require("helmet"));
const express_mongo_sanitize_1 = __importDefault(require("express-mongo-sanitize"));
const express_rate_limit_1 = __importDefault(require("express-rate-limit"));
const xss_clean_1 = __importDefault(require("xss-clean"));
const http_1 = require("http");
const path_1 = __importDefault(require("path"));
const supabase_1 = require("./config/supabase");
const errorHandler_1 = require("./middleware/errorHandler");
const logger_1 = require("./middleware/logger");
const requestTiming_1 = require("./middleware/requestTiming");
const universalInstrumentation_1 = require("./middleware/universalInstrumentation");
const sentryService_1 = require("./services/sentryService");
const csrfProtection_1 = require("./middleware/csrfProtection");
const admin_1 = __importDefault(require("./routes/admin"));
const ai_1 = __importDefault(require("./routes/ai"));
const alarms_1 = __importDefault(require("./routes/alarms"));
const analytics_1 = __importDefault(require("./routes/analytics"));
const auth_1 = __importDefault(require("./routes/auth"));
const beta_1 = __importDefault(require("./routes/beta"));
const contentRoutes_1 = __importDefault(require("./routes/contentRoutes"));
const feedback_1 = __importDefault(require("./routes/feedback"));
const news_1 = __importDefault(require("./routes/news"));
const notifications_1 = __importDefault(require("./routes/notifications"));
const payment_1 = __importDefault(require("./routes/payment"));
const pnr_1 = __importDefault(require("./routes/pnr"));
const referrals_1 = __importDefault(require("./routes/referrals"));
const stations_1 = __importDefault(require("./routes/stations"));
const trains_1 = __importDefault(require("./routes/trains"));
const trainController_1 = require("./controllers/trainController");
const rateLimiter_1 = require("./middleware/rateLimiter");
const usageMiddleware_1 = require("./middleware/usageMiddleware");
const metricsService_1 = require("./services/metricsService");
const pnrWorker_1 = require("./services/pnrWorker");
const socketService_1 = require("./services/socketService");
const alarmWorker_1 = require("./workers/alarmWorker");
const eventQueueWorker_1 = require("./services/eventQueueWorker");
const eventMetrics_1 = require("./services/eventMetrics");
const featureFlags_1 = require("./config/featureFlags");
const corsOrigin_1 = require("./config/corsOrigin");
// Initialize Sentry BEFORE anything else so it captures boot errors
(0, sentryService_1.initSentry)();
// Initialize Firebase Admin for Push Notifications
const firebaseService_1 = require("./services/firebaseService");
(0, firebaseService_1.initFirebaseAdmin)();
dotenv_1.default.config();
const app = (0, express_1.default)();
app.set('trust proxy', 1); // PHASE_8.2: Trust 1 hop (Hostinger Nginx ingress proxy) to preserve client IP & prevent spoofing
const PORT = process.env.PORT || 5000;
// ====================== MIDDLEWARE ======================
app.use((0, helmet_1.default)({
    crossOriginResourcePolicy: { policy: "cross-origin" },
    referrerPolicy: { policy: "strict-origin-when-cross-origin" },
    hsts: { maxAge: 31536000, includeSubDomains: true, preload: true },
    contentSecurityPolicy: {
        directives: {
            defaultSrc: ["'self'"],
            scriptSrc: ["'self'", "'unsafe-inline'", "https://sdk.cashfree.com", "https://www.gstatic.com"],
            connectSrc: ["'self'", "https://api.trayago.in", "https://*.supabase.co", "https://*.cashfree.com"],
            imgSrc: ["'self'", "data:", "https:", "http:"],
            styleSrc: ["'self'", "'unsafe-inline'"],
            fontSrc: ["'self'", "https:", "data:"]
        }
    }
})); // Security headers
app.use((0, cors_1.default)({
    origin: corsOrigin_1.corsOriginValidator, // PHASE_4C849: strict per-request whitelist
    credentials: true
}));
// Cashfree Webhook needs exact raw string for HMAC signature verification
app.use('/api/payments/webhook', express_1.default.raw({ type: 'application/json' }));
app.use(express_1.default.json({ limit: '10mb' }));
app.use(express_1.default.urlencoded({ extended: true }));
app.use((0, cookie_parser_1.default)());
app.use((0, express_mongo_sanitize_1.default)()); // Prevent NoSQL injection attacks
app.use((0, xss_clean_1.default)()); // Prevent XSS attacks
// Global Fallback Rate Limiter for unmatched routes
const globalLimiter = (0, express_rate_limit_1.default)({
    windowMs: 15 * 60 * 1000,
    max: 300,
    standardHeaders: true,
    legacyHeaders: false,
    validate: false, // PHASE_8.5B: Suppress express-rate-limit v8 validation warnings for custom skip logic
    skip: (req) => ['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(req.ip || ''),
    message: { success: false, error: 'Too many requests from this IP, please try again after 15 minutes' },
});
app.use('/api', globalLimiter);
// CSRF Protection - PHASE_4C759 Fix #2 (P1-SEC-003)
app.use(csrfProtection_1.conditionalCsrf);
app.use(csrfProtection_1.attachCsrfToken);
app.use('/uploads', express_1.default.static(path_1.default.join(__dirname, '../public/uploads')));
const authMiddleware_1 = require("./middleware/authMiddleware");
app.use(authMiddleware_1.authMiddleware);
app.use(universalInstrumentation_1.universalInstrumentationMiddleware);
app.use(requestTiming_1.requestTimingMiddleware); // Lightweight structured timing
global.SYSTEM_MODE = 'MODE_C';
// ====================== DEPLOYMENT VALIDATION ======================
const requiredEnvs = ['RAPIDAPI_KEY', 'JWT_SECRET', 'REFRESH_TOKEN_SECRET', 'SUPABASE_URL', 'SUPABASE_SERVICE_ROLE_KEY'];
if (process.env.USE_DB_PROVIDERS === 'true') {
    requiredEnvs.push('ENCRYPTION_KEY');
}
for (const env of requiredEnvs) {
    const val = process.env[env];
    if (!val || val.toLowerCase().includes('your_') || val.toLowerCase().includes('placeholder')) {
        logger_1.winstonLogger.error(`[FATAL] Missing or invalid required environment variable: ${env}. Boot failed.`);
        process.exit(1);
    }
}
// ====================== HEALTH CHECKS ======================
app.get('/', (req, res) => {
    res.status(200).send('Trayago Backend is running');
});
app.get('/favicon.ico', (req, res) => res.status(204).end());
app.get(['/health', '/api/health'], async (req, res) => {
    try {
        const dbStatus = await (0, supabase_1.validateConnection)();
        const response = {
            success: true,
            server: "online",
            database: dbStatus ? "connected" : "warning",
            uptime: process.uptime(),
            memory: process.memoryUsage(),
            timestamp: new Date().toISOString()
        };
        // PHASE_4C823 â€” expose event pipeline metrics only when the stream is enabled
        if (featureFlags_1.featureFlags.eventStream) {
            response.event_pipeline = eventMetrics_1.eventMetrics.snapshot();
        }
        res.status(200).json(response);
    }
    catch (err) {
        res.status(200).json({ success: false, server: "degraded", database: "error" });
    }
});
// ====================== ROUTES ======================
// Primary routes (with /api/ prefix — used by internal callers)
app.use('/api/auth', auth_1.default);
app.use('/api/trains', trains_1.default);
app.use('/api/pnr', pnr_1.default);
app.use('/api/analytics', analytics_1.default);
app.use('/api/stations', stations_1.default);
app.use('/api/admin', admin_1.default);
app.use('/api/referrals', referrals_1.default);
app.use('/api/news', news_1.default);
app.use('/api/feedback', feedback_1.default);
app.use('/api/payments', payment_1.default);
app.use('/api/notifications', notifications_1.default);
app.use('/api/content', contentRoutes_1.default);
app.use('/api/beta', beta_1.default);
app.use('/api/alarms', alarms_1.default);
app.use('/api/ai', ai_1.default);
// PHASE_4C971 PROXY FIX: Mirror all routes WITHOUT /api/ prefix.
// Next.js rewrite: source=/api/:path* → destination=https://api.trayago.in/:path*
// The proxy STRIPS /api/ — Express never sees it. Both path forms now work.
app.use('/auth', auth_1.default);
app.use('/trains', trains_1.default);
app.use('/pnr', pnr_1.default);
app.use('/analytics', analytics_1.default);
app.use('/stations', stations_1.default);
app.use('/admin', admin_1.default);
app.use('/referrals', referrals_1.default);
app.use('/news', news_1.default);
app.use('/feedback', feedback_1.default);
app.use('/payments', payment_1.default);
app.use('/notifications', notifications_1.default);
app.use('/content', contentRoutes_1.default);
app.use('/beta', beta_1.default);
app.use('/alarms', alarms_1.default);
app.use('/ai', ai_1.default);
// Live train endpoint — both prefixed and un-prefixed
app.get('/api/live-train/:trainNo', rateLimiter_1.liveLimiter, (0, usageMiddleware_1.usageMiddleware)('live'), trainController_1.trainController.getLiveStatus);
app.get('/live-train/:trainNo', rateLimiter_1.liveLimiter, (0, usageMiddleware_1.usageMiddleware)('live'), trainController_1.trainController.getLiveStatus);
// ====================== ERROR HANDLING ======================
app.use(errorHandler_1.notFoundHandler);
app.use(csrfProtection_1.csrfErrorHandler); // PHASE_4C759 Fix #2 - CSRF violations (EBADCSRFTOKEN)
app.use(errorHandler_1.errorHandler);
// ====================== START SERVER ======================
const startServer = async () => {
    try {
        logger_1.winstonLogger.info(`ðŸš€ Starting Trayago Backend on port ${PORT}...`);
        // PHASE_4C971 HOSTINGER FIX: Call listen() FIRST before any async init.
        // Hostinger kills the process if listen() is not called within 3 seconds.
        // Previously: validateConnection â†’ jobs â†’ IRCTC warmup â†’ listen() â€” exceeded 3s limit.
        // Now: createServer â†’ listen() immediately â†’ all async init in setImmediate background.
        const httpServer = (0, http_1.createServer)(app);
        socketService_1.socketService.initialize(httpServer);
        httpServer.listen(PORT, () => {
            logger_1.winstonLogger.info(`âœ… Trayago Backend running on http://localhost:${PORT}`);
            logger_1.winstonLogger.info(`ðŸ“Š Health check: http://localhost:${PORT}/health`);
            // Non-blocking startup webhook
            const webhookUrl = process.env.ADMIN_WEBHOOK_URL;
            if (webhookUrl) {
                const mem = process.memoryUsage();
                fetch(webhookUrl, {
                    method: 'POST', headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                        event: 'SERVER_BOOT', timestamp: new Date().toISOString(),
                        environment: process.env.NODE_ENV || 'development',
                        node_version: process.version, process_id: process.pid,
                        uptime: process.uptime(),
                        memory: { rss_mb: Math.round(mem.rss / 1024 / 1024), heap_used_mb: Math.round(mem.heapUsed / 1024 / 1024) }
                    })
                }).catch((e) => logger_1.winstonLogger.warn(`[STARTUP_ALERT_FAIL] ${e.message}`));
            }
        });
        // â”€â”€ All async init runs AFTER port is already bound â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
        setImmediate(async () => {
            try {
                // Validate Supabase connection
                const dbConnected = await (0, supabase_1.validateConnection)();
                if (!dbConnected) {
                    logger_1.winstonLogger.warn('âš ï¸ Supabase connection warning - some features may be degraded');
                    global.SYSTEM_MODE = 'MODE_A';
                }
                else {
                    logger_1.winstonLogger.info('âœ… Supabase connection successful');
                    global.SYSTEM_MODE = 'MODE_C';
                }
                logger_1.winstonLogger.info('[STARTUP] Provider init in progress. DB fallback: ACTIVE');
                logger_1.winstonLogger.info(`[STARTUP] RapidAPI key: ${process.env.RAPIDAPI_KEY ? 'LOADED' : 'MISSING â€” live fallback disabled'}`);
                if (!process.env.RAPIDAPI_KEY) {
                    logger_1.winstonLogger.warn('[STARTUP] RAPIDAPI_KEY not set. RapidAPI fallback will be skipped.');
                }
                if (process.env.USE_DB_PROVIDERS === 'true') {
                    logger_1.winstonLogger.info('[STARTUP] Preloading ProviderConfigService cache...');
                    const { providerConfigService } = require('./services/providerConfigService');
                    await Promise.all([
                        providerConfigService.getKeysFor('IRCTC'),
                        providerConfigService.getKeysFor('RAPIDAPI'),
                        providerConfigService.getKeysFor('RAILRADAR')
                    ]);
                }
                // Start background services
                pnrWorker_1.pnrWorker.start();
                metricsService_1.metricsService.startSnapshotScheduler();
                alarmWorker_1.alarmWorker.start();
                (0, eventQueueWorker_1.startEventQueueWorker)();
                const { alertDispatcher } = require('./workers/alertDispatcher');
                alertDispatcher.start();
                const { dailyHealthReportJob } = require('./jobs/dailyHealthReport');
                dailyHealthReportJob.start();
                // PHASE_4C750: News refresh job
                const { newsRefreshJob } = require('./jobs/newsRefreshJob');
                await newsRefreshJob.start();
                // PHASE_4C871: Knowledge hub catalog job (no-op when flags OFF)
                const { hubCatalogRefreshJob } = require('./jobs/hubCatalogRefreshJob');
                await hubCatalogRefreshJob.start();
                // â”€â”€â”€ Alarm Lifecycle Crons â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
                const scheduleAlarmExpiryCron = () => {
                    const MS_1_HOUR = 60 * 60 * 1000;
                    setTimeout(async () => {
                        try {
                            const { supabase: sb } = require('./config/supabase');
                            const { error } = await sb
                                .from('user_station_alarms')
                                .update({ enabled: false, updated_at: new Date().toISOString() })
                                .eq('enabled', true)
                                .lt('expires_at', new Date().toISOString());
                            if (error && error.code !== '42P01') {
                                logger_1.winstonLogger.warn(`[ALARM_CRON_EXPIRY] Failed to disable expired alarms: ${error.message}`);
                            }
                            else if (!error) {
                                logger_1.winstonLogger.info('[ALARM_CRON_EXPIRY] Expired alarm cleanup completed');
                            }
                        }
                        catch (err) {
                            logger_1.winstonLogger.warn(`[ALARM_CRON_EXPIRY] Exception during expiry cron: ${err.message}`);
                        }
                        finally {
                            scheduleAlarmExpiryCron();
                        }
                    }, MS_1_HOUR);
                };
                scheduleAlarmExpiryCron();
                const scheduleAlarmHardDelete = () => {
                    const MS_24_HOURS = 24 * 60 * 60 * 1000;
                    setTimeout(async () => {
                        try {
                            const { supabase: sb } = require('./config/supabase');
                            const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();
                            const { error } = await sb
                                .from('user_station_alarms')
                                .delete()
                                .lt('created_at', sevenDaysAgo);
                            if (error && error.code !== '42P01') {
                                logger_1.winstonLogger.warn(`[ALARM_CRON_PURGE] Failed to purge old alarm records: ${error.message}`);
                            }
                            else if (!error) {
                                logger_1.winstonLogger.info('[ALARM_CRON_PURGE] Old alarm record purge completed (>7 days)');
                            }
                        }
                        catch (err) {
                            logger_1.winstonLogger.warn(`[ALARM_CRON_PURGE] Exception during hard delete cron: ${err.message}`);
                        }
                        finally {
                            scheduleAlarmHardDelete();
                        }
                    }, MS_24_HOURS);
                };
                scheduleAlarmHardDelete();
                // Native daily limits reset scheduler (runs daily at midnight)
                const scheduleMidnightReset = () => {
                    const now = new Date();
                    const nextMidnight = new Date();
                    nextMidnight.setHours(24, 0, 0, 0);
                    const msUntilMidnight = nextMidnight.getTime() - now.getTime();
                    setTimeout(() => {
                        const resetDbLimits = async () => {
                            try {
                                const { validateConnection: vc2, supabase } = require('./config/supabase');
                                const conn = await vc2();
                                if (conn) {
                                    const { error } = await supabase
                                        .from('users')
                                        .update({ daily_search_count: 0, daily_pnr_count: 0, daily_live_count: 0, ads_watched_today: 0 })
                                        .or('daily_search_count.gt.0,daily_pnr_count.gt.0,daily_live_count.gt.0,ads_watched_today.gt.0');
                                    if (error) {
                                        logger_1.winstonLogger.error(`[CRON_DATABASE_RESET_ERROR] Failed to reset daily database quotas: ${error.message}`);
                                    }
                                    else {
                                        logger_1.winstonLogger.info('[CRON] Automated daily limits reset executed successfully on database');
                                        try {
                                            const { userCache } = require('./cache/userCache');
                                            await userCache.clear();
                                            logger_1.winstonLogger.info('[CRON] User cache successfully cleared and PubSub broadcasted post-reset');
                                        }
                                        catch (cacheErr) {
                                            logger_1.winstonLogger.error(`[CRON_CACHE_RESET_ERROR] Failed to clear user cache: ${cacheErr.message}`);
                                        }
                                    }
                                }
                            }
                            catch (err) {
                                logger_1.winstonLogger.error(`[CRON_EXCEPTION] Database reset task failed: ${err.message}`);
                            }
                        };
                        resetDbLimits();
                        scheduleMidnightReset();
                    }, msUntilMidnight);
                };
                scheduleMidnightReset();
                // PHASE_4C814 (now runs in background, no longer blocks listen())
                const irctcInitStart = Date.now();
                logger_1.winstonLogger.info('[STARTUP] IRCTC SDK warmup starting in background...');
                const { irctcService } = require('./services/irctcService');
                await irctcService.warmup();
                const irctcInitMs = Date.now() - irctcInitStart;
                logger_1.winstonLogger.info(`[STARTUP] IRCTC SDK ready. INIT_MS=${irctcInitMs} initialized=${irctcService.getStatus().initialized}`);
            }
            catch (bgErr) {
                logger_1.winstonLogger.error(`âŒ Background startup init failed: ${bgErr.message}`);
            }
        }); // end setImmediate
    }
    catch (err) {
        logger_1.winstonLogger.error(`âŒ Failed to start server: ${err.message}`);
        process.exit(1);
    }
};
// Graceful shutdown
process.on('SIGTERM', () => {
    logger_1.winstonLogger.info('ðŸ›‘ SIGTERM received. Shutting down gracefully...');
    pnrWorker_1.pnrWorker.stop?.(); // if you added stop method
    alarmWorker_1.alarmWorker.stop();
    (0, eventQueueWorker_1.stopEventQueueWorker)(); // PHASE_4C823
    process.exit(0);
});
process.on('SIGINT', () => {
    logger_1.winstonLogger.info('ðŸ›‘ SIGINT received. Shutting down...');
    pnrWorker_1.pnrWorker.stop?.();
    alarmWorker_1.alarmWorker.stop();
    (0, eventQueueWorker_1.stopEventQueueWorker)(); // PHASE_4C823
    process.exit(0);
});
// Start the application
startServer();
