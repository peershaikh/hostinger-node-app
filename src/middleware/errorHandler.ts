import { NextFunction, Request, Response } from 'express';
import { winstonLogger } from './logger';
import { captureError } from '../services/sentryService';

interface CustomError extends Error {
    status?: number;
    code?: string;
    isOperational?: boolean;
}

/**
 * Global error handler middleware
 * Handles all errors in the application and returns safe JSON responses
 */
export const errorHandler = (
    err: CustomError,
    req: Request,
    res: Response,
    next: NextFunction
) => {
    // Log the error for debugging (but don't expose to client)
    winstonLogger.error(`[GLOBAL_ERROR] ${req.method} ${req.path}: ${err.message}`, {
        stack: err.stack,
        url: req.url,
        method: req.method,
        ip: req.ip,
        userAgent: req.get('User-Agent'),
        timestamp: new Date().toISOString()
    });

    // Report 5xx errors to Sentry (not 4xx client errors)
    if (!err.status || err.status >= 500) {
      captureError(err, { method: req.method, path: req.path });
    }


    // Default error response
    const response = {
        success: false,
        message: 'Something went wrong',
        // Only include error details in development
        ...(process.env.NODE_ENV !== 'production' && { error: err.message })
    };

    // Handle specific error types
    if (err.name === 'ValidationError') {
        return res.status(400).json({
            success: false,
            message: 'Validation Error',
            ...(process.env.NODE_ENV !== 'production' && { error: err.message })
        });
    }

    if (err.name === 'UnauthorizedError') {
        return res.status(401).json({
            success: false,
            message: 'Unauthorized access',
            ...(process.env.NODE_ENV !== 'production' && { error: err.message })
        });
    }

    if (err.name === 'NotFoundError') {
        return res.status(404).json({
            success: false,
            message: 'Resource not found',
            ...(process.env.NODE_ENV !== 'production' && { error: err.message })
        });
    }

    // Handle timeout errors
    if (err.message && err.message.includes('TIMEOUT')) {
        return res.status(408).json({
            success: false,
            message: 'Request timeout',
            ...(process.env.NODE_ENV !== 'production' && { error: err.message })
        });
    }

    // Handle database errors
    if (err.message && (err.message.includes('database') || err.message.includes('connection'))) {
        return res.status(503).json({
            success: false,
            message: 'Service temporarily unavailable',
            ...(process.env.NODE_ENV !== 'production' && { error: err.message })
        });
    }

    // Handle JSON parsing errors
    if (err instanceof SyntaxError && 'body' in err) {
        return res.status(400).json({
            success: false,
            message: 'Invalid JSON format',
            ...(process.env.NODE_ENV !== 'production' && { error: err.message })
        });
    }

    // Return generic error for unknown errors
    res.status(err.status || 500).json(response);
};

/**
 * 404 handler for unknown routes
 */
export const notFoundHandler = (req: Request, res: Response, next: NextFunction) => {
    winstonLogger.warn(`[404] ${req.method} ${req.path} - Route not found`);

    res.status(404).json({
        success: false,
        message: 'Route not found'
    });
};

/**
 * Async wrapper to catch async errors
 */
export const asyncHandler = (fn: Function) => {
    return (req: Request, res: Response, next: NextFunction) => {
        Promise.resolve(fn(req, res, next)).catch(next);
    };
};