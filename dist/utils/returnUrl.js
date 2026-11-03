"use strict";
/**
 * Safe Return URL Validation and Context Builder
 * Prevents open redirects, protocol-relative exploits, and redirect loops.
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.getSafeReturnUrl = getSafeReturnUrl;
exports.buildSearchReturnUrl = buildSearchReturnUrl;
function getSafeReturnUrl(rawUrl) {
    if (!rawUrl || typeof rawUrl !== 'string')
        return '/';
    const trimmed = rawUrl.trim();
    if (!trimmed)
        return '/';
    // Must begin with a single forward slash
    if (!trimmed.startsWith('/') || trimmed.startsWith('//') || trimmed.startsWith('/\\') || trimmed.startsWith('\\')) {
        return '/';
    }
    // Reject newlines, carriage returns, tabs, and null bytes
    if (/[\r\n\t\0]/.test(trimmed)) {
        return '/';
    }
    // Reject malicious pseudo-protocols embedded in path
    if (/^\/[a-zA-Z0-9+.-]+:/.test(trimmed) || /javascript:|data:|vbscript:/i.test(trimmed)) {
        return '/';
    }
    try {
        // Parse using dummy base to isolate pathname and query
        const parsed = new URL(trimmed, 'http://localhost');
        const pathOnly = parsed.pathname.toLowerCase().replace(/\/+$/, '');
        // Prevent redirect loops back to authentication endpoints
        if (pathOnly === '/login' || pathOnly === '/signup') {
            return '/';
        }
        // Only preserve pathname, search, and hash
        const safeResult = parsed.pathname + parsed.search + parsed.hash;
        return safeResult || '/';
    }
    catch {
        return '/';
    }
}
function buildSearchReturnUrl(params) {
    const sp = new URLSearchParams();
    if (params.source)
        sp.set('source', params.source.trim().toUpperCase());
    if (params.destination)
        sp.set('destination', params.destination.trim().toUpperCase());
    if (params.date)
        sp.set('date', params.date.trim());
    if (params.train)
        sp.set('train', params.train.trim());
    if (params.classCode)
        sp.set('class', params.classCode.trim());
    if (params.action)
        sp.set('action', params.action.trim());
    const query = sp.toString();
    return query ? `/?${query}` : '/';
}
