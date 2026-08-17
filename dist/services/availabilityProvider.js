"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.availabilityProvider = exports.AvailabilityProvider = void 0;
const logger_1 = require("../middleware/logger");
const providerConfigService_1 = require("./providerConfigService");
const railProviderResolver_1 = require("./railProviderResolver");
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
        let irctcHandledError = null;
        const availChain = await railProviderResolver_1.railProviderResolver.resolveProviderChain('availability');
        for (const provider of availChain) {
            try {
                const provData = await provider.checkAvailability({
                    trainNo: params.trainNo,
                    from: fromNorm,
                    to: toNorm,
                    date: params.date,
                    classType: params.classType,
                    quota: params.quota
                });
                if (provData && typeof provData === 'object') {
                    if (provData.success === false) {
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
                        const providerReason = (0, trainStationResolver_1.mapProviderErrorToReason)(provData.error || '', isDateNonRunning);
                        logger_1.winstonLogger.info(`[AVAIL_PROVIDER_HANDLED_ERROR] train=${params.trainNo} error=${provData.error} reason=${providerReason}`);
                        const message = providerReason === 'TRAIN_NOT_RUNNING'
                            ? `Train ${params.trainNo} does not run on this date`
                            : providerReason === 'PROVIDER_REQUEST_REJECTED'
                                ? 'Railway servers rejected availability check for this date/class'
                                : (provData.error || 'Class not available in selected quota/class');
                        irctcHandledError = {
                            success: false,
                            reason: providerReason,
                            message
                        };
                    }
                    else {
                        const returnedClasses = Array.isArray(provData)
                            ? ['ARRAY']
                            : (typeof provData === 'object' ? Object.keys(provData) : []);
                        logger_1.winstonLogger.info(`[AVAIL_PROVIDER_CLASSES_RETURNED] train=${params.trainNo} requestedClass=${params.classType} returnedClasses=${returnedClasses.join(',') || 'NONE'} source=${provider.providerId}`);
                        logger_1.winstonLogger.info(`[AVAIL_PROVIDER_SUCCESS] train=${params.trainNo} source=${provider.providerId}`);
                        return { success: true, data: provData };
                    }
                }
            }
            catch (err) {
                logger_1.winstonLogger.warn(`[AVAIL_PROVIDER_FAIL] ${provider.providerId} train=${params.trainNo} error=${err.message}`);
            }
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
                providerStatus: irctcHandledError.message || 'REJECTED',
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
