import { AsyncLocalStorage } from 'async_hooks';
import { Request, Response, NextFunction } from 'express';

export interface RequestContextData {
  userId: string | null;
  callerFeature: string | null;
}

const asyncLocalStorage = new AsyncLocalStorage<RequestContextData>();

/**
 * Returns current async request context or undefined if outside request scope.
 */
export function getRequestContext(): RequestContextData | undefined {
  return asyncLocalStorage.getStore();
}

/**
 * Returns current authenticated or guest user ID (UUID format or null).
 */
export function getContextUserId(): string | null {
  return asyncLocalStorage.getStore()?.userId ?? null;
}

/**
 * Returns current active caller feature tag (e.g. 'trainSearch', 'splitJourney', 'pnr', etc.).
 */
export function getContextCallerFeature(): string | null {
  return asyncLocalStorage.getStore()?.callerFeature ?? null;
}

/**
 * Run a callback within an explicit context scope (e.g. background job, worker, or test).
 */
export function runWithContext<T>(context: RequestContextData, fn: () => T): T {
  return asyncLocalStorage.run(context, fn);
}

/**
 * Express middleware to bind request context for the duration of the request lifecycle.
 * Placed after authMiddleware so req.headers['x-user-id'] is already authenticated and verified.
 */
export const requestContextMiddleware = (req: Request, _res: Response, next: NextFunction): void => {
  const userId = (req.headers['x-user-id'] as string) || (req as any).user?.id || null;

  let callerFeature = 'api';
  const urlPath = req.path || req.originalUrl || '';
  if (urlPath.includes('/trains/search')) {
    callerFeature = 'trainSearch';
  } else if (urlPath.includes('/trains/split') || urlPath.includes('/split')) {
    callerFeature = 'splitJourney';
  } else if (urlPath.includes('/pnr')) {
    callerFeature = 'pnr';
  } else if (urlPath.includes('/live')) {
    callerFeature = 'liveTracking';
  } else if (urlPath.includes('/ai')) {
    callerFeature = 'ai';
  }

  asyncLocalStorage.run({ userId: userId ? String(userId).trim() : null, callerFeature }, () => {
    next();
  });
};
