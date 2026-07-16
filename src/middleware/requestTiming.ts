import { NextFunction, Request, Response } from 'express';
import { winstonLogger } from './logger';
import { metricsService } from '../services/metricsService';

/**
 * Lightweight request timing middleware.
 * Logs method, path, status, and response time on every request.
 * Never logs request bodies or authorization headers.
 */
export const requestTimingMiddleware = (req: Request, res: Response, next: NextFunction) => {
  const start = Date.now();

  res.on('finish', () => {
    const duration = Date.now() - start;
    
    // 1. Record in-memory metrics dynamically
    metricsService.recordRequest(duration, res.statusCode);

    // 2. Stream structured winston logs
    const level = res.statusCode >= 500 ? 'error' : res.statusCode >= 400 ? 'warn' : 'info';
    winstonLogger[level](`[REQ] ${req.method} ${req.path} → ${res.statusCode} (${duration}ms)`);
  });

  next();
};
