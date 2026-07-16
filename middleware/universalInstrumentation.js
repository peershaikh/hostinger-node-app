"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.universalInstrumentationMiddleware = void 0;
const featureFlags_1 = require("../config/featureFlags");
const eventTaxonomy_1 = require("../constants/eventTaxonomy");
const universalEventEmitter_1 = require("../services/universalEventEmitter");
const universalIds_1 = require("../utils/universalIds");
const routeKey = (req) => `${req.method.toUpperCase()} ${req.path}`;
const classifyRequest = (req) => {
    const path = req.path;
    if (path.includes('/search'))
        return eventTaxonomy_1.UniversalEventNames.SEARCH_STARTED;
    if (path.includes('/same-train-rescue'))
        return eventTaxonomy_1.UniversalEventNames.RESCUE_EVALUATED;
    if (path.includes('/availability'))
        return eventTaxonomy_1.UniversalEventNames.PROVIDER_CALL_STARTED;
    if (path.includes('/rescue-book'))
        return eventTaxonomy_1.UniversalEventNames.BOOKING_PLACEHOLDER;
    if (path.includes('/pnr/'))
        return eventTaxonomy_1.UniversalEventNames.PNR_CHECKED;
    if (path.includes('/live-train/') || path.includes('/live/'))
        return eventTaxonomy_1.UniversalEventNames.LIVE_TRAIN_CHECKED;
    return null;
};
const completionEvents = (req, res, body) => {
    const path = req.path;
    const failed = res.statusCode >= 400 || body?.success === false;
    if (path.includes('/search')) {
        const events = [
            failed ? eventTaxonomy_1.UniversalEventNames.SEARCH_FAILED : eventTaxonomy_1.UniversalEventNames.SEARCH_COMPLETED
        ];
        const splitCount = Array.isArray(body?.split) ? body.split.length : 0;
        if (path.includes('Advanced') || path.includes('advanced') || body?.split_recommended !== undefined) {
            events.push(eventTaxonomy_1.UniversalEventNames.SPLIT_EVALUATED);
            events.push(splitCount > 0 ? eventTaxonomy_1.UniversalEventNames.SPLIT_VALID : eventTaxonomy_1.UniversalEventNames.SPLIT_REJECTED);
        }
        return events;
    }
    if (path.includes('/same-train-rescue')) {
        const rescueCount = Array.isArray(body?.rescueOptions) ? body.rescueOptions.length : 0;
        return [
            rescueCount > 0 ? eventTaxonomy_1.UniversalEventNames.RESCUE_FOUND : eventTaxonomy_1.UniversalEventNames.RESCUE_NOT_FOUND
        ];
    }
    if (path.includes('/availability')) {
        return [
            failed ? eventTaxonomy_1.UniversalEventNames.PROVIDER_CALL_FAILED : eventTaxonomy_1.UniversalEventNames.PROVIDER_CALL_COMPLETED
        ];
    }
    return [];
};
const getUserId = (req) => {
    const userId = req.headers['x-user-id'];
    return typeof userId === 'string' && userId.trim() ? userId.trim() : null;
};
const getRouteMetadata = (req) => ({
    route: routeKey(req),
    source: (req.body?.source || req.query?.source || req.body?.from || req.query?.from || req.body?.fromStation || req.query?.fromStation || null),
    destination: (req.body?.destination || req.query?.destination || req.body?.to || req.query?.to || req.body?.toStation || req.query?.toStation || null),
    trainNo: (req.body?.trainNo || req.query?.trainNo || req.params?.trainNo || null),
    pnr: (req.params?.pnr || req.body?.pnr || null)
});
const universalInstrumentationMiddleware = (req, res, next) => {
    const reqAny = req;
    reqAny.universalIds = (0, universalIds_1.createUniversalRequestContext)(req);
    const startedAt = Date.now();
    const initialEvent = classifyRequest(req);
    const shouldTreatAsSearch = req.path.includes('/search') || req.path.includes('/same-train-rescue');
    const shouldTreatAsProviderCall = req.path.includes('/availability');
    if (shouldTreatAsSearch) {
        (0, universalIds_1.ensureSearchId)(req);
    }
    if (shouldTreatAsProviderCall) {
        reqAny.providerCallId = (0, universalIds_1.createProviderCallId)();
    }
    if (featureFlags_1.featureFlags.eventStream && initialEvent) {
        const metadata = getRouteMetadata(req);
        universalEventEmitter_1.universalEventEmitter.emit({
            eventName: initialEvent,
            requestId: reqAny.universalIds.requestId,
            searchId: reqAny.universalIds.searchId,
            providerCallId: reqAny.providerCallId,
            guestId: reqAny.universalIds.guestId,
            userId: getUserId(req),
            route: metadata.route,
            source: metadata.source || undefined,
            mode: 'rail',
            metadata
        });
    }
    const originalJson = res.json.bind(res);
    res.json = ((body) => {
        const responseBody = featureFlags_1.featureFlags.universalIds
            ? (0, universalIds_1.enrichResponseWithUniversalIds)(body, reqAny.universalIds)
            : body;
        if (featureFlags_1.featureFlags.eventStream) {
            const metadata = getRouteMetadata(req);
            for (const eventName of completionEvents(req, res, body)) {
                universalEventEmitter_1.universalEventEmitter.emit({
                    eventName,
                    requestId: reqAny.universalIds?.requestId,
                    searchId: reqAny.universalIds?.searchId,
                    providerCallId: reqAny.providerCallId,
                    guestId: reqAny.universalIds?.guestId,
                    userId: getUserId(req),
                    route: metadata.route,
                    source: metadata.source || undefined,
                    mode: 'rail',
                    status: String(res.statusCode),
                    latencyMs: Date.now() - startedAt,
                    metadata
                });
            }
        }
        return originalJson(responseBody);
    });
    next();
};
exports.universalInstrumentationMiddleware = universalInstrumentationMiddleware;
