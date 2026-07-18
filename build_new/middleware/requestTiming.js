"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.requestTimingMiddleware = void 0;
const logger_1 = require("./logger");
const metricsService_1 = require("../services/metricsService");
/**
 * Lightweight request timing middleware.
 * Logs method, path, status, and response time on every request.
 * Never logs request bodies or authorization headers.
 */
const requestTimingMiddleware = (req, res, next) => {
    const start = Date.now();
    res.on('finish', () => {
        const duration = Date.now() - start;
        // 1. Record in-memory metrics dynamically
        metricsService_1.metricsService.recordRequest(duration, res.statusCode);
        // 2. Stream structured winston logs
        const level = res.statusCode >= 500 ? 'error' : res.statusCode >= 400 ? 'warn' : 'info';
        logger_1.winstonLogger[level](`[REQ] ${req.method} ${req.path} → ${res.statusCode} (${duration}ms)`);
    });
    next();
};
exports.requestTimingMiddleware = requestTimingMiddleware;
