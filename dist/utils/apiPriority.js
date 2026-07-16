"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.fetchWithPriority = fetchWithPriority;
const logger_1 = require("../middleware/logger");
const metricsService_1 = require("../services/metricsService");
const isMeaningfulResult = (result) => {
    if (!result)
        return false;
    if (Array.isArray(result))
        return result.length > 0;
    if (typeof result === 'object')
        return Object.keys(result).length > 0;
    return true;
};
async function fetchWithPriority(ops) {
    logger_1.winstonLogger.info("[API_PRIORITY_START] IRCTC → RailRadar → RailYatri → ConfirmTkt → RapidAPI → DB");
    // 1. IRCTC - ALWAYS FIRST (PRIMARY)
    const irctcFn = ops.irctc || ops.primary;
    if (irctcFn) {
        const startTime = Date.now();
        try {
            logger_1.winstonLogger.info("[API_PRIMARY_ACTIVE] IRCTC");
            const result = await irctcFn();
            const duration = Date.now() - startTime;
            const isOk = isMeaningfulResult(result);
            metricsService_1.metricsService.recordProviderRequest('IRCTC', duration, isOk);
            if (isOk) {
                logger_1.winstonLogger.info("[API_PRIMARY_SUCCESS] IRCTC returned valid data");
                return result;
            }
        }
        catch (err) {
            const duration = Date.now() - startTime;
            metricsService_1.metricsService.recordProviderRequest('IRCTC', duration, false);
            logger_1.winstonLogger.warn(`[API_PRIMARY_FAILED] IRCTC: ${err.message}`);
        }
    }
    // 2. RailRadar - SECOND
    const railradarFn = ops.railradar;
    if (railradarFn) {
        const startTime = Date.now();
        try {
            logger_1.winstonLogger.info("[API_FALLBACK_RAILRADAR] RailRadar");
            const result = await railradarFn();
            const duration = Date.now() - startTime;
            const isOk = isMeaningfulResult(result);
            metricsService_1.metricsService.recordProviderRequest('RailRadar', duration, isOk);
            if (isOk) {
                logger_1.winstonLogger.info("[API_FALLBACK_RAILRADAR_SUCCESS] RailRadar returned valid data");
                return result;
            }
        }
        catch (err) {
            const duration = Date.now() - startTime;
            metricsService_1.metricsService.recordProviderRequest('RailRadar', duration, false);
            logger_1.winstonLogger.warn(`[API_FALLBACK_RAILRADAR_FAILED] RailRadar: ${err.message}`);
        }
    }
    // 3. RailYatri - THIRD
    const railyatriFn = ops.railyatri;
    if (railyatriFn) {
        const startTime = Date.now();
        try {
            logger_1.winstonLogger.info("[API_FALLBACK_RAILYATRI] RailYatri");
            const result = await railyatriFn();
            const duration = Date.now() - startTime;
            const isOk = isMeaningfulResult(result);
            metricsService_1.metricsService.recordProviderRequest('RailYatri', duration, isOk);
            if (isOk) {
                logger_1.winstonLogger.info("[API_FALLBACK_RAILYATRI_SUCCESS] RailYatri returned valid data");
                return result;
            }
        }
        catch (err) {
            const duration = Date.now() - startTime;
            metricsService_1.metricsService.recordProviderRequest('RailYatri', duration, false);
            logger_1.winstonLogger.warn(`[API_FALLBACK_RAILYATRI_FAILED] RailYatri: ${err.message}`);
        }
    }
    // 4. ConfirmTkt - FOURTH (FALLBACK_1)
    const confirmtktFn = ops.confirmtkt || ops.fallback1;
    if (confirmtktFn) {
        const startTime = Date.now();
        try {
            logger_1.winstonLogger.info("[API_FALLBACK_1] ConfirmTkt");
            const result = await confirmtktFn();
            const duration = Date.now() - startTime;
            const isOk = isMeaningfulResult(result);
            metricsService_1.metricsService.recordProviderRequest('ConfirmTkt', duration, isOk);
            if (isOk) {
                logger_1.winstonLogger.info("[API_FALLBACK_1_SUCCESS] ConfirmTkt returned valid data");
                return result;
            }
        }
        catch (err) {
            const duration = Date.now() - startTime;
            metricsService_1.metricsService.recordProviderRequest('ConfirmTkt', duration, false);
            logger_1.winstonLogger.warn(`[API_FALLBACK_1_FAILED] ConfirmTkt: ${err.message}`);
        }
    }
    // 5. RapidAPI - DISABLED AS PER REQUEST
    // (RapidAPI fallback removed)
    // 6. Database - LAST RESORT
    const dbFn = ops.db || ops.dbFallback;
    if (dbFn) {
        try {
            logger_1.winstonLogger.info("[DB_FALLBACK_USED] All live APIs failed → Using Database");
            const result = await dbFn();
            if (isMeaningfulResult(result)) {
                logger_1.winstonLogger.info("[DB_FALLBACK_SUCCESS] Database returned data");
                return result;
            }
        }
        catch (err) {
            logger_1.winstonLogger.error(`[DB_FALLBACK_FAILED] ${err.message}`);
        }
    }
    logger_1.winstonLogger.warn("[API_ALL_FAILED] No data from any source");
    return null;
}
