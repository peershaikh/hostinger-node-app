"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.requestContextMiddleware = void 0;
exports.getRequestContext = getRequestContext;
exports.getContextUserId = getContextUserId;
exports.getContextCallerFeature = getContextCallerFeature;
exports.runWithContext = runWithContext;
const async_hooks_1 = require("async_hooks");
const asyncLocalStorage = new async_hooks_1.AsyncLocalStorage();
/**
 * Returns current async request context or undefined if outside request scope.
 */
function getRequestContext() {
    return asyncLocalStorage.getStore();
}
/**
 * Returns current authenticated or guest user ID (UUID format or null).
 */
function getContextUserId() {
    return asyncLocalStorage.getStore()?.userId ?? null;
}
/**
 * Returns current active caller feature tag (e.g. 'trainSearch', 'splitJourney', 'pnr', etc.).
 */
function getContextCallerFeature() {
    return asyncLocalStorage.getStore()?.callerFeature ?? null;
}
/**
 * Run a callback within an explicit context scope (e.g. background job, worker, or test).
 */
function runWithContext(context, fn) {
    return asyncLocalStorage.run(context, fn);
}
/**
 * Express middleware to bind request context for the duration of the request lifecycle.
 * Placed after authMiddleware so req.headers['x-user-id'] is already authenticated and verified.
 */
const requestContextMiddleware = (req, _res, next) => {
    const userId = req.headers['x-user-id'] || req.user?.id || null;
    let callerFeature = 'api';
    const urlPath = req.path || req.originalUrl || '';
    if (urlPath.includes('/trains/search')) {
        callerFeature = 'trainSearch';
    }
    else if (urlPath.includes('/trains/split') || urlPath.includes('/split')) {
        callerFeature = 'splitJourney';
    }
    else if (urlPath.includes('/pnr')) {
        callerFeature = 'pnr';
    }
    else if (urlPath.includes('/live')) {
        callerFeature = 'liveTracking';
    }
    else if (urlPath.includes('/ai')) {
        callerFeature = 'ai';
    }
    asyncLocalStorage.run({ userId: userId ? String(userId).trim() : null, callerFeature }, () => {
        next();
    });
};
exports.requestContextMiddleware = requestContextMiddleware;
