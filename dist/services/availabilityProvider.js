"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.availabilityProvider = exports.AvailabilityProvider = void 0;
const logger_1 = require("../middleware/logger");
const providerConfigService_1 = require("./providerConfigService");
const trainStationResolver_1 = require("./trainStationResolver");
class AvailabilityProvider {
    constructor() {
        this.currentKeyIndex = 0;
        this.HOST = process.env.RAPIDAPI_HOST || 'irctc-train-api.p.rapidapi.com';
    }
    async getNextApiKey() {
        let keys = await providerConfigService_1.providerConfigService.getKeysFor('IRCTC');
        if (!keys || keys.length === 0) {
            keys = await providerConfigService_1.providerConfigService.getKeysFor('RAILKIT');
        }
        if (!keys || keys.length === 0) {
            keys = await providerConfigService_1.providerConfigService.getKeysFor('RAPIDAPI');
        }
        if (!keys || keys.length === 0) {
            const fallback = process.env.IRCTC_CONNECT_API_KEY || process.env.IRCTC_API_KEY || process.env.RAILKIT_API_KEY;
            if (fallback)
                return fallback;
            throw new Error("No IRCTC / RailKit API key configured");
        }
        const key = keys[this.currentKeyIndex % keys.length];
        this.currentKeyIndex = (this.currentKeyIndex + 1) % keys.length;
        return key;
    }
    async getHeaders() {
        return {
            "X-RapidAPI-Key": await this.getNextApiKey(),
            "X-RapidAPI-Host": this.HOST
        };
    }
    /**
     * PHASE_4C870 — Provider fetch only (no cache). Called by SmartAvailabilityService.
     */
    async fetchFromProvider(params) {
        // PHASE_4C862 — train-aware station resolution + pre-IRCTC validation
        const resolution = await (0, trainStationResolver_1.resolveSegmentForAvailability)(params.trainNo, params.from, params.to, params.date);
        if (!resolution.success) {
            logger_1.winstonLogger.info(`[AVAIL_PROVIDER_PRECHECK_FAIL] train=${params.trainNo} reason=${resolution.reason} msg=${resolution.message}`);
            return {
                success: false,
                reason: resolution.reason,
                message: resolution.message,
            };
        }
        const fromNorm = resolution.apiFrom;
        const toNorm = resolution.apiTo;
        logger_1.winstonLogger.info(`[AVAIL_PROVIDER_START] train=${params.trainNo} from=${fromNorm} to=${toNorm}`);
        logger_1.winstonLogger.info(`[AVAIL_PROVIDER_PARAMS] train=${params.trainNo} from=${fromNorm} to=${toNorm} date=${params.date} class=${params.classType} quota=${params.quota}`);
        let irctcData = null;
        let irctcHandledError = null;
        const irctcGuard = await providerConfigService_1.providerConfigService.isProviderEnabled('IRCTC');
        if (irctcGuard.enabled) {
            try {
                const { irctcService } = require('./irctcService');
                const dateToPass = params.date;
                irctcData = await irctcService.getAvailability(params.trainNo, dateToPass, fromNorm, toNorm, params.classType, params.quota, { bypassCache: true });
                if (irctcData && typeof irctcData === 'object') {
                    if (irctcData.success === false) {
                        let isDateNonRunning = false;
                        try {
                            const { trainOperatesOnDate } = require('../utils/dayUtils');
                            const runningVerdict = trainOperatesOnDate(params.date, resolution.runningDays, {
                                dayOffset: resolution.dayOffset || 0
                            });
                            if (runningVerdict === 'NO')
                                isDateNonRunning = true;
                        }
                        catch { /* non-fatal */ }
                        const providerReason = (0, trainStationResolver_1.mapProviderErrorToReason)(irctcData.error || '', isDateNonRunning);
                        logger_1.winstonLogger.info(`[AVAIL_PROVIDER_HANDLED_ERROR] train=${params.trainNo} error=${irctcData.error} reason=${providerReason}`);
                        const message = providerReason === 'TRAIN_NOT_RUNNING'
                            ? `Train ${params.trainNo} does not run on this date`
                            : providerReason === 'PROVIDER_REQUEST_REJECTED'
                                ? 'Railway servers rejected availability check for this date/class'
                                : (irctcData.error || 'Class not available in selected quota/class');
                        irctcHandledError = {
                            success: false,
                            reason: providerReason,
                            message
                        };
                    }
                    else {
                        const returnedClasses = Array.isArray(irctcData)
                            ? ['ARRAY']
                            : (typeof irctcData === 'object' ? Object.keys(irctcData) : []);
                        logger_1.winstonLogger.info(`[AVAIL_PROVIDER_CLASSES_RETURNED] train=${params.trainNo} requestedClass=${params.classType} returnedClasses=${returnedClasses.join(',') || 'NONE'} source=IRCTC`);
                        logger_1.winstonLogger.info(`[AVAIL_PROVIDER_SUCCESS] train=${params.trainNo} source=IRCTC`);
                        return { success: true, data: irctcData };
                    }
                }
                else {
                    throw new Error(`IRCTC Provider returned empty or failed: ${JSON.stringify(irctcData)}`);
                }
            }
            catch (err) {
                logger_1.winstonLogger.warn(`[AVAIL_PROVIDER_FAIL] train=${params.trainNo} error=${err.message} - Trying RailRadar`);
            }
        }
        else {
            const skipLabel = (irctcGuard.reason === 'PROVIDER_UNHEALTHY' || irctcGuard.reason === 'CIRCUIT_BREAKER_BLOCKED')
                ? '[PROVIDER_SKIPPED_UNHEALTHY]'
                : '[PROVIDER_SKIPPED_DISABLED]';
            logger_1.winstonLogger.info(`${skipLabel} IRCTC | Reason: ${irctcGuard.reason}`);
        }
        const rrGuard = await providerConfigService_1.providerConfigService.isProviderEnabled('RAILRADAR');
        if (rrGuard.enabled) {
            try {
                const { railRadarService } = require('./railRadarService');
                const rrData = await railRadarService.getAvailability(params.trainNo, fromNorm, toNorm, params.date, params.classType, params.quota);
                if (rrData) {
                    const source = irctcHandledError ? 'RAILRADAR (IRCTC_FALLBACK)' : 'RAILRADAR';
                    logger_1.winstonLogger.info(`[AVAIL_PROVIDER_SUCCESS] train=${params.trainNo} source=${source}`);
                    return { success: true, data: rrData };
                }
            }
            catch (rrErr) {
                logger_1.winstonLogger.warn(`[AVAIL_PROVIDER_RAILRADAR_FAIL] train=${params.trainNo} error=${rrErr.message}`);
            }
        }
        else {
            const skipLabel = (rrGuard.reason === 'PROVIDER_UNHEALTHY' || rrGuard.reason === 'CIRCUIT_BREAKER_BLOCKED')
                ? '[PROVIDER_SKIPPED_UNHEALTHY]'
                : '[PROVIDER_SKIPPED_DISABLED]';
            logger_1.winstonLogger.info(`${skipLabel} RAILRADAR | Reason: ${rrGuard.reason}`);
        }
        if (irctcHandledError) {
            logger_1.winstonLogger.warn({
                message: '[AVAIL_FAILURE]',
                availabilityRequest: true,
                trainNo: params.trainNo,
                from: fromNorm,
                to: toNorm,
                date: params.date,
                classType: params.classType,
                quota: params.quota,
                providerStatus: irctcData?.error || 'REJECTED',
                normalizedReason: irctcHandledError.reason,
            });
            return irctcHandledError;
        }
        logger_1.winstonLogger.error(`[AVAIL_PROVIDER_FAIL] train=${params.trainNo} - No further availability fallbacks available`);
        logger_1.winstonLogger.warn({
            message: '[AVAIL_FAILURE]',
            availabilityRequest: true,
            trainNo: params.trainNo,
            from: fromNorm,
            to: toNorm,
            date: params.date,
            classType: params.classType,
            quota: params.quota,
            providerStatus: 'EXHAUSTED',
            normalizedReason: 'PROVIDER_UNAVAILABLE',
        });
        return { success: false, reason: 'PROVIDER_UNAVAILABLE', message: 'The railway booking system is currently unresponsive. Please try again later.' };
    }
    /**
     * PHASE_4C870 — All availability traffic routes through SmartAvailabilityService.
     */
    async getAvailability(params) {
        const { smartAvailabilityService } = require('./smartAvailabilityService');
        return smartAvailabilityService.getAvailability(params);
    }
}
exports.AvailabilityProvider = AvailabilityProvider;
exports.availabilityProvider = new AvailabilityProvider();
