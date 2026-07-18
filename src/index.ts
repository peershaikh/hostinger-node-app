import cookieParser from 'cookie-parser';
import cors from 'cors';
import dotenv from 'dotenv';
import express from 'express';
import helmet from 'helmet';
import mongoSanitize from 'express-mongo-sanitize';
import rateLimit from 'express-rate-limit';
import xss from 'xss-clean';
import { createServer } from 'http';
import path from 'path';

import { validateConnection } from './config/supabase';
import { errorHandler, notFoundHandler } from './middleware/errorHandler';
import { winstonLogger } from './middleware/logger';
import { requestTimingMiddleware } from './middleware/requestTiming';
import { universalInstrumentationMiddleware } from './middleware/universalInstrumentation';
import { initSentry } from './services/sentryService';
import { conditionalCsrf, attachCsrfToken, csrfErrorHandler } from './middleware/csrfProtection';

import adminRoutes from './routes/admin';
import aiRoutes from './routes/ai';
import alarmRoutes from './routes/alarms';
import analyticsRoutes from './routes/analytics';
import authRoutes from './routes/auth';
import betaRoutes from './routes/beta';
import contentRoutes from './routes/contentRoutes';
import feedbackRoutes from './routes/feedback';
import newsRoutes from './routes/news';
import notificationRoutes from './routes/notifications';
import paymentRoutes from './routes/payment';
import pnrRoutes from './routes/pnr';
import referralRoutes from './routes/referrals';
import stationRoutes from './routes/stations';
import trainRoutes from './routes/trains';


import { trainController } from './controllers/trainController';
import { liveLimiter } from './middleware/rateLimiter';
import { usageMiddleware } from './middleware/usageMiddleware';
import { metricsService } from './services/metricsService';
import { pnrWorker } from './services/pnrWorker';
import { socketService } from './services/socketService';
import { alarmWorker } from './workers/alarmWorker';
import { startEventQueueWorker, stopEventQueueWorker } from './services/eventQueueWorker';
import { eventMetrics } from './services/eventMetrics';
import { featureFlags } from './config/featureFlags';
import { corsOriginValidator } from './config/corsOrigin';

// Initialize Sentry BEFORE anything else so it captures boot errors
initSentry();

// Initialize Firebase Admin for Push Notifications
import { initFirebaseAdmin } from './services/firebaseService';
initFirebaseAdmin();

dotenv.config();

const app = express();
app.set('trust proxy', 1); // Trust the first proxy hop (e.g., Render/AWS Load Balancer)
const PORT = process.env.PORT || 5000;

// ====================== MIDDLEWARE ======================
app.use(helmet({
  crossOriginResourcePolicy: { policy: "cross-origin" }
}));                    // Security headers
app.use(cors({
  origin: corsOriginValidator, // PHASE_4C849: strict per-request whitelist
  credentials: true
}));
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true }));
app.use(cookieParser());
app.use(mongoSanitize()); // Prevent NoSQL injection attacks
app.use(xss()); // Prevent XSS attacks

// Global Fallback Rate Limiter for unmatched routes
const globalLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 300,
  standardHeaders: true,
  legacyHeaders: false,
  validate: { ip: false }, // PHASE_4C971: suppress express-rate-limit v8 ValidationError
  skip: (req: any) => ['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(req.ip || ''),
  message: { success: false, error: 'Too many requests from this IP, please try again after 15 minutes' },
});
app.use('/api', globalLimiter);



// CSRF Protection - PHASE_4C759 Fix #2 (P1-SEC-003)
app.use(conditionalCsrf);
app.use(attachCsrfToken);

app.use('/uploads', express.static(path.join(__dirname, '../public/uploads')));

import { authMiddleware } from './middleware/authMiddleware';
app.use(authMiddleware);

app.use(universalInstrumentationMiddleware);

app.use(requestTimingMiddleware);     // Lightweight structured timing

declare global {
  var SYSTEM_MODE: string;
}
global.SYSTEM_MODE = 'MODE_C';

// ====================== DEPLOYMENT VALIDATION ======================
const requiredEnvs = ['RAPIDAPI_KEY', 'JWT_SECRET', 'REFRESH_TOKEN_SECRET', 'SUPABASE_URL', 'SUPABASE_SERVICE_ROLE_KEY'];
if (process.env.USE_DB_PROVIDERS === 'true') {
  requiredEnvs.push('ENCRYPTION_KEY');
}
for (const env of requiredEnvs) {
  const val = process.env[env];
  if (!val || val.toLowerCase().includes('your_') || val.toLowerCase().includes('placeholder')) {
    winstonLogger.error(`[FATAL] Missing or invalid required environment variable: ${env}. Boot failed.`);
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
    const dbStatus = await validateConnection();
    const response: Record<string, any> = {
      success: true,
      server: "online",
      database: dbStatus ? "connected" : "warning",
      uptime: process.uptime(),
      memory: process.memoryUsage(),
      timestamp: new Date().toISOString()
    };
    // PHASE_4C823 â€” expose event pipeline metrics only when the stream is enabled
    if (featureFlags.eventStream) {
      response.event_pipeline = eventMetrics.snapshot();
    }
    res.status(200).json(response);
  } catch (err) {
    res.status(200).json({ success: false, server: "degraded", database: "error" });
  }
});

// ====================== ROUTES ======================
// Primary routes (with /api/ prefix — used by internal callers)
app.use('/api/auth', authRoutes);
app.use('/api/trains', trainRoutes);
app.use('/api/pnr', pnrRoutes);
app.use('/api/analytics', analyticsRoutes);
app.use('/api/stations', stationRoutes);
app.use('/api/admin', adminRoutes);
app.use('/api/referrals', referralRoutes);
app.use('/api/news', newsRoutes);
app.use('/api/feedback', feedbackRoutes);
app.use('/api/payments', paymentRoutes);
app.use('/api/notifications', notificationRoutes);
app.use('/api/content', contentRoutes);
app.use('/api/beta', betaRoutes);
app.use('/api/alarms', alarmRoutes);
app.use('/api/ai', aiRoutes);

// PHASE_4C971 PROXY FIX: Mirror all routes WITHOUT /api/ prefix.
// Next.js rewrite: source=/api/:path* → destination=https://api.trayago.in/:path*
// The proxy STRIPS /api/ — Express never sees it. Both path forms now work.
app.use('/auth', authRoutes);
app.use('/trains', trainRoutes);
app.use('/pnr', pnrRoutes);
app.use('/analytics', analyticsRoutes);
app.use('/stations', stationRoutes);
app.use('/admin', adminRoutes);
app.use('/referrals', referralRoutes);
app.use('/news', newsRoutes);
app.use('/feedback', feedbackRoutes);
app.use('/payments', paymentRoutes);
app.use('/notifications', notificationRoutes);
app.use('/content', contentRoutes);
app.use('/beta', betaRoutes);
app.use('/alarms', alarmRoutes);
app.use('/ai', aiRoutes);

// Live train endpoint — both prefixed and un-prefixed
app.get('/api/live-train/:trainNo', liveLimiter, usageMiddleware('live'), trainController.getLiveStatus);
app.get('/live-train/:trainNo', liveLimiter, usageMiddleware('live'), trainController.getLiveStatus);


// ====================== ERROR HANDLING ======================
app.use(notFoundHandler);
app.use(csrfErrorHandler); // PHASE_4C759 Fix #2 - CSRF violations (EBADCSRFTOKEN)
app.use(errorHandler);

// ====================== START SERVER ======================
const startServer = async () => {
  try {
    winstonLogger.info(`ðŸš€ Starting Trayago Backend on port ${PORT}...`);

    // PHASE_4C971 HOSTINGER FIX: Call listen() FIRST before any async init.
    // Hostinger kills the process if listen() is not called within 3 seconds.
    // Previously: validateConnection â†’ jobs â†’ IRCTC warmup â†’ listen() â€” exceeded 3s limit.
    // Now: createServer â†’ listen() immediately â†’ all async init in setImmediate background.
    const httpServer = createServer(app);
    socketService.initialize(httpServer);

    httpServer.listen(PORT, () => {
      winstonLogger.info(`âœ… Trayago Backend running on http://localhost:${PORT}`);
      winstonLogger.info(`ðŸ“Š Health check: http://localhost:${PORT}/health`);
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
            memory: { rss_mb: Math.round(mem.rss/1024/1024), heap_used_mb: Math.round(mem.heapUsed/1024/1024) }
          })
        }).catch((e: any) => winstonLogger.warn(`[STARTUP_ALERT_FAIL] ${e.message}`));
      }
    });

    // â”€â”€ All async init runs AFTER port is already bound â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
    setImmediate(async () => {
      try {
        // Validate Supabase connection
        const dbConnected = await validateConnection();
        if (!dbConnected) {
          winstonLogger.warn('âš ï¸ Supabase connection warning - some features may be degraded');
          global.SYSTEM_MODE = 'MODE_A';
        } else {
          winstonLogger.info('âœ… Supabase connection successful');
          global.SYSTEM_MODE = 'MODE_C';
        }

        winstonLogger.info('[STARTUP] Provider init in progress. DB fallback: ACTIVE');
        winstonLogger.info(`[STARTUP] RapidAPI key: ${process.env.RAPIDAPI_KEY ? 'LOADED' : 'MISSING â€” live fallback disabled'}`);
        if (!process.env.RAPIDAPI_KEY) {
          winstonLogger.warn('[STARTUP] RAPIDAPI_KEY not set. RapidAPI fallback will be skipped.');
        }

        if (process.env.USE_DB_PROVIDERS === 'true') {
          winstonLogger.info('[STARTUP] Preloading ProviderConfigService cache...');
          const { providerConfigService } = require('./services/providerConfigService');
          await Promise.all([
            providerConfigService.getKeysFor('IRCTC'),
            providerConfigService.getKeysFor('RAPIDAPI'),
            providerConfigService.getKeysFor('RAILRADAR')
          ]);
        }

        // Start background services
        pnrWorker.start();
        metricsService.startSnapshotScheduler();
        alarmWorker.start();
        startEventQueueWorker();

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
                winstonLogger.warn(`[ALARM_CRON_EXPIRY] Failed to disable expired alarms: ${error.message}`);
              } else if (!error) {
                winstonLogger.info('[ALARM_CRON_EXPIRY] Expired alarm cleanup completed');
              }
            } catch (err: any) {
              winstonLogger.warn(`[ALARM_CRON_EXPIRY] Exception during expiry cron: ${err.message}`);
            } finally {
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
                winstonLogger.warn(`[ALARM_CRON_PURGE] Failed to purge old alarm records: ${error.message}`);
              } else if (!error) {
                winstonLogger.info('[ALARM_CRON_PURGE] Old alarm record purge completed (>7 days)');
              }
            } catch (err: any) {
              winstonLogger.warn(`[ALARM_CRON_PURGE] Exception during hard delete cron: ${err.message}`);
            } finally {
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
                    winstonLogger.error(`[CRON_DATABASE_RESET_ERROR] Failed to reset daily database quotas: ${error.message}`);
                  } else {
                    winstonLogger.info('[CRON] Automated daily limits reset executed successfully on database');
                    try {
                      const { userCache } = require('./cache/userCache');
                      await userCache.clear();
                      winstonLogger.info('[CRON] User cache successfully cleared and PubSub broadcasted post-reset');
                    } catch (cacheErr: any) {
                      winstonLogger.error(`[CRON_CACHE_RESET_ERROR] Failed to clear user cache: ${cacheErr.message}`);
                    }
                  }
                }
              } catch (err: any) {
                winstonLogger.error(`[CRON_EXCEPTION] Database reset task failed: ${err.message}`);
              }
            };
            resetDbLimits();
            scheduleMidnightReset();
          }, msUntilMidnight);
        };
        scheduleMidnightReset();

        // PHASE_4C814 (now runs in background, no longer blocks listen())
        const irctcInitStart = Date.now();
        winstonLogger.info('[STARTUP] IRCTC SDK warmup starting in background...');
        const { irctcService } = require('./services/irctcService');
        await irctcService.warmup();
        const irctcInitMs = Date.now() - irctcInitStart;
        winstonLogger.info(`[STARTUP] IRCTC SDK ready. INIT_MS=${irctcInitMs} initialized=${irctcService.getStatus().initialized}`);

      } catch (bgErr: any) {
        winstonLogger.error(`âŒ Background startup init failed: ${bgErr.message}`);
      }
    }); // end setImmediate

  } catch (err: any) {
    winstonLogger.error(`âŒ Failed to start server: ${err.message}`);
    process.exit(1);
  }
};

// Graceful shutdown
process.on('SIGTERM', () => {
  winstonLogger.info('ðŸ›‘ SIGTERM received. Shutting down gracefully...');
  pnrWorker.stop?.(); // if you added stop method
  alarmWorker.stop();
  stopEventQueueWorker(); // PHASE_4C823
  process.exit(0);
});

process.on('SIGINT', () => {
  winstonLogger.info('ðŸ›‘ SIGINT received. Shutting down...');
  pnrWorker.stop?.();
  alarmWorker.stop();
  stopEventQueueWorker(); // PHASE_4C823
  process.exit(0);
});

// Start the application
startServer();
a p p . g e t ( ' / p i n g - i n d e x ' ,   ( r e q ,   r e s )   = >   r e s . s e n d ( ' P O N G - I N D E X ' ) ) ;  
    
 a p p . g e t ( ' / p i n g - l o c a l ' ,   ( r e q ,   r e s )   = >   r e s . s e n d ( ' P O N G - L O C A L ' ) ) ;  
 