"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.validateParams = exports.validateQuery = exports.validateBody = void 0;
const logger_1 = require("./logger");
const validateBody = (schema) => {
    return (req, res, next) => {
        const result = schema.safeParse(req.body);
        if (!result.success) {
            logger_1.winstonLogger.warn(`[VALIDATION_FAIL] Body validation failed for route ${req.originalUrl} IP=${req.ip}: ${JSON.stringify(result.error.issues)}`);
            return res.status(400).json({
                success: false,
                error: 'Invalid request payload or unauthorized parameters.'
            });
        }
        req.body = result.data;
        next();
    };
};
exports.validateBody = validateBody;
const validateQuery = (schema) => {
    return (req, res, next) => {
        const result = schema.safeParse(req.query);
        if (!result.success) {
            logger_1.winstonLogger.warn(`[VALIDATION_FAIL] Query validation failed for route ${req.originalUrl} IP=${req.ip}: ${JSON.stringify(result.error.issues)}`);
            return res.status(400).json({
                success: false,
                error: 'Invalid query parameters.'
            });
        }
        next();
    };
};
exports.validateQuery = validateQuery;
const validateParams = (schema) => {
    return (req, res, next) => {
        const result = schema.safeParse(req.params);
        if (!result.success) {
            logger_1.winstonLogger.warn(`[VALIDATION_FAIL] Params validation failed for route ${req.originalUrl} IP=${req.ip}: ${JSON.stringify(result.error.issues)}`);
            return res.status(400).json({
                success: false,
                error: 'Invalid URL parameters.'
            });
        }
        next();
    };
};
exports.validateParams = validateParams;
