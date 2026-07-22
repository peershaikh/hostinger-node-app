import { Request, Response, NextFunction } from 'express';
import { ZodSchema } from 'zod';
import { winstonLogger } from './logger';

export const validateBody = (schema: ZodSchema) => {
    return (req: Request, res: Response, next: NextFunction) => {
        const result = schema.safeParse(req.body);
        if (!result.success) {
            winstonLogger.warn(`[VALIDATION_FAIL] Body validation failed for route ${req.originalUrl} IP=${req.ip}: ${JSON.stringify(result.error.issues)}`);
            return res.status(400).json({
                success: false,
                error: 'Invalid request payload or unauthorized parameters.'
            });
        }
        req.body = result.data;
        next();
    };
};

export const validateQuery = (schema: ZodSchema) => {
    return (req: Request, res: Response, next: NextFunction) => {
        const result = schema.safeParse(req.query);
        if (!result.success) {
            winstonLogger.warn(`[VALIDATION_FAIL] Query validation failed for route ${req.originalUrl} IP=${req.ip}: ${JSON.stringify(result.error.issues)}`);
            return res.status(400).json({
                success: false,
                error: 'Invalid query parameters.'
            });
        }
        next();
    };
};

export const validateParams = (schema: ZodSchema) => {
    return (req: Request, res: Response, next: NextFunction) => {
        const result = schema.safeParse(req.params);
        if (!result.success) {
            winstonLogger.warn(`[VALIDATION_FAIL] Params validation failed for route ${req.originalUrl} IP=${req.ip}: ${JSON.stringify(result.error.issues)}`);
            return res.status(400).json({
                success: false,
                error: 'Invalid URL parameters.'
            });
        }
        next();
    };
};
