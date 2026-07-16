"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.asyncHandler = exports.notFoundHandler = exports.errorHandler = void 0;
const logger_1 = require("./logger");
const sentryService_1 = require("../services/sentryService");
/**
 * Global error handler middleware
 * Handles all errors in the application and returns safe JSON responses
 */
const errorHandler = (err, req, res, next) => {
    // Log the error for debugging (but don't expose to client)
    logger_1.winstonLogger.error(`[GLOBAL_ERROR] ${req.method} ${req.path}: ${err.message}`, {
        stack: err.stack,
        url: req.url,
        method: req.method,
        ip: req.ip,
        userAgent: req.get('User-Agent'),
        timestamp: new Date().toISOString()
    });
    // Report 5xx errors to Sentry (not 4xx client errors)
    if (!err.status || err.status >= 500) {
        (0, sentryService_1.captureError)(err, { method: req.method, path: req.path });
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
exports.errorHandler = errorHandler;
/**
 * 404 handler for unknown routes
 */
const notFoundHandler = (req, res, next) => {
    logger_1.winstonLogger.warn(`[404] ${req.method} ${req.path} - Route not found`);
    res.status(404).json({
        success: false,
        message: 'Route not found'
    });
};
exports.notFoundHandler = notFoundHandler;
/**
 * Async wrapper to catch async errors
 */
const asyncHandler = (fn) => {
    return (req, res, next) => {
        Promise.resolve(fn(req, res, next)).catch(next);
    };
};
exports.asyncHandler = asyncHandler;
