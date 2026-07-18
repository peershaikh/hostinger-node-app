"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
Object.defineProperty(exports, "__esModule", { value: true });
exports.initSentry = initSentry;
exports.captureError = captureError;
const Sentry = __importStar(require("@sentry/node"));
const logger_1 = require("../middleware/logger");
/**
 * Initialize Sentry for the Node.js backend.
 * Production-safe: no sensitive payloads, secrets, or raw API responses are logged.
 */
function initSentry() {
    const dsn = process.env.SENTRY_DSN;
    if (!dsn) {
        logger_1.winstonLogger.warn('[SENTRY] SENTRY_DSN not set — error tracking disabled.');
        return;
    }
    if (process.env.NODE_ENV !== 'production') {
        logger_1.winstonLogger.info('[SENTRY] Non-production environment — Sentry disabled.');
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
                    delete event.request.headers['authorization'];
                    delete event.request.headers['x-rapidapi-key'];
                }
            }
            return event;
        },
    });
    logger_1.winstonLogger.info('[SENTRY] Initialized for production error tracking.');
}
/**
 * Capture a backend exception safely.
 * Attaches context tags without exposing raw payloads.
 */
function captureError(error, context) {
    if (process.env.NODE_ENV !== 'production')
        return;
    Sentry.captureException(error, { tags: context });
}
