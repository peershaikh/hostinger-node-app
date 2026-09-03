"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.fetchWithPriority = fetchWithPriority;
const logger_1 = require("../middleware/logger");
const metricsService_1 = require("../services/metricsService");
const railProviderResolver_1 = require("../services/railProviderResolver");
const isMeaningfulResult = (result) => {
    if (!result)
        return false;
    if (result.not_running || result.expected_no_data)
        return false;
    if (Array.isArray(result))
        return result.length > 0;
    if (typeof result === 'object')
        return Object.keys(result).length > 0;
    return true;
};
async function fetchWithPriority(ops) {
    // 1. Dynamically resolve live tracking providers based on Admin priority and capabilities
    let chain = [];
    try {
        const resolvedProviders = await railProviderResolver_1.railProviderResolver.resolveProviderChain('liveTracking');
        chain = resolvedProviders.map(p => p.providerId.toUpperCase());
    }
    catch {
        chain = ['IRCTC', 'RAILRADAR', 'CONFIRMTKT', 'RAILYATRI'];
    }
    // Ensure DB fallback is always at the end if not explicitly present
    if (!chain.includes('DATABASE')) {
        chain.push('DATABASE');
    }
    logger_1.winstonLogger.info(`[API_PRIORITY_DYNAMIC] Priority Chain: ${chain.join(' → ')}`);
    const fnMap = {
        IRCTC: ops.irctc || ops.primary,
        RAILRADAR: ops.railradar,
        RAILYATRI: ops.railyatri,
        CONFIRMTKT: ops.confirmtkt || ops.fallback1,
        RAPIDAPI: ops.rapid,
        DATABASE: ops.db || ops.dbFallback,
    };
    for (const providerId of chain) {
        const fn = fnMap[providerId];
        if (!fn)
            continue;
        const startTime = Date.now();
        try {
            logger_1.winstonLogger.info(`[API_DYNAMIC_ACTIVE] Attempting ${providerId}`);
            const result = await fn();
            const duration = Date.now() - startTime;
            const isExpectedNoData = Boolean(result && (result.not_running || result.expected_no_data));
            const isOk = isMeaningfulResult(result);
            if (providerId !== 'DATABASE' && !isExpectedNoData) {
                metricsService_1.metricsService.recordProviderRequest(providerId, duration, isOk);
            }
            if (isOk) {
                logger_1.winstonLogger.info(`[API_DYNAMIC_SUCCESS] ${providerId} returned valid data`);
                return result;
            }
        }
        catch (err) {
            const duration = Date.now() - startTime;
            if (providerId !== 'DATABASE') {
                metricsService_1.metricsService.recordProviderRequest(providerId, duration, false);
            }
            logger_1.winstonLogger.warn(`[API_DYNAMIC_FAILED] ${providerId}: ${err.message}`);
        }
    }
    return null;
}
