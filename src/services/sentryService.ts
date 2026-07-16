import * as Sentry from '@sentry/node';
import { winstonLogger } from '../middleware/logger';

/**
 * Initialize Sentry for the Node.js backend.
 * Production-safe: no sensitive payloads, secrets, or raw API responses are logged.
 */
export function initSentry() {
  const dsn = process.env.SENTRY_DSN;

  if (!dsn) {
    winstonLogger.warn('[SENTRY] SENTRY_DSN not set — error tracking disabled.');
    return;
  }

  if (process.env.NODE_ENV !== 'production') {
    winstonLogger.info('[SENTRY] Non-production environment — Sentry disabled.');
    return;
  }

  Sentry.init({
    dsn,
    environment: process.env.NODE_ENV,
    // Capture 10% of traces — sufficient for latency monitoring
    tracesSampleRate: 0.1,

    // Strip sensitive data before sending to Sentry
    beforeSend(event) {
      if (event.request) {
        delete event.request.data;
        delete event.request.cookies;
        // Redact Authorization header
        if (event.request.headers) {
          delete (event.request.headers as any)['authorization'];
          delete (event.request.headers as any)['x-rapidapi-key'];
        }
      }
      return event;
    },
  });

  winstonLogger.info('[SENTRY] Initialized for production error tracking.');
}

/**
 * Capture a backend exception safely.
 * Attaches context tags without exposing raw payloads.
 */
export function captureError(error: Error, context?: Record<string, string>) {
  if (process.env.NODE_ENV !== 'production') return;
  Sentry.captureException(error, { tags: context });
}
