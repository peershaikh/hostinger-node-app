"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.enrichResponseWithUniversalIds = exports.ensureSearchId = exports.createUniversalRequestContext = exports.resolveGuestId = exports.createProviderCallId = exports.createSegmentId = exports.createOptionId = exports.createSearchId = exports.createRequestId = exports.createEventId = void 0;
const crypto_1 = __importDefault(require("crypto"));
const scopedId = (prefix) => `${prefix}_${crypto_1.default.randomUUID()}`;
const hashGuestSource = (value) => crypto_1.default.createHash('sha256').update(value).digest('hex').slice(0, 32);
const createEventId = () => scopedId('evt');
exports.createEventId = createEventId;
const createRequestId = () => scopedId('req');
exports.createRequestId = createRequestId;
const createSearchId = () => scopedId('srch');
exports.createSearchId = createSearchId;
const createOptionId = () => scopedId('opt');
exports.createOptionId = createOptionId;
const createSegmentId = () => scopedId('seg');
exports.createSegmentId = createSegmentId;
const createProviderCallId = () => scopedId('prov');
exports.createProviderCallId = createProviderCallId;
const resolveGuestId = (req) => {
    const userId = req.headers['x-user-id'];
    if (typeof userId === 'string' && userId.trim())
        return undefined;
    const existingGuestId = req.headers['x-guest-id'];
    if (typeof existingGuestId === 'string' && existingGuestId.trim()) {
        return existingGuestId.trim();
    }
    const deviceId = req.headers['x-device-id'];
    const sessionId = req.headers['x-session-id'];
    const userAgent = req.headers['user-agent'] || '';
    const ip = req.ip || req.socket.remoteAddress || '';
    const seed = [deviceId, sessionId, ip, userAgent].filter(Boolean).join('|');
    if (!seed)
        return scopedId('guest');
    return `guest_${hashGuestSource(seed)}`;
};
exports.resolveGuestId = resolveGuestId;
const createUniversalRequestContext = (req) => ({
    requestId: (0, exports.createRequestId)(),
    guestId: (0, exports.resolveGuestId)(req)
});
exports.createUniversalRequestContext = createUniversalRequestContext;
const ensureSearchId = (req) => {
    const reqAny = req;
    if (!reqAny.universalIds) {
        reqAny.universalIds = (0, exports.createUniversalRequestContext)(req);
    }
    if (!reqAny.universalIds.searchId) {
        reqAny.universalIds.searchId = (0, exports.createSearchId)();
    }
    return reqAny.universalIds.searchId;
};
exports.ensureSearchId = ensureSearchId;
const enrichSegment = (segment) => {
    if (!segment || typeof segment !== 'object' || Array.isArray(segment))
        return segment;
    return {
        ...segment,
        universalIds: {
            ...(segment.universalIds || {}),
            segmentId: segment.universalIds?.segmentId || (0, exports.createSegmentId)()
        }
    };
};
const enrichOption = (option) => {
    if (!option || typeof option !== 'object' || Array.isArray(option))
        return option;
    const enriched = {
        ...option,
        universalIds: {
            ...(option.universalIds || {}),
            optionId: option.universalIds?.optionId || (0, exports.createOptionId)()
        }
    };
    if (Array.isArray(option.legs)) {
        enriched.legs = option.legs.map(enrichSegment);
    }
    if (option.leg1) {
        enriched.leg1 = enrichSegment(option.leg1);
    }
    if (option.leg2) {
        enriched.leg2 = enrichSegment(option.leg2);
    }
    return enriched;
};
const OPTION_ARRAY_KEYS = [
    'all',
    'best',
    'direct',
    'split',
    'smart_routes',
    'rescueOptions',
    'partialRescueOptions'
];
const enrichResponseWithUniversalIds = (payload, context) => {
    if (!payload || typeof payload !== 'object' || Array.isArray(payload))
        return payload;
    const enriched = {
        ...payload,
        universalIds: {
            ...(payload.universalIds || {}),
            requestId: context.requestId,
            ...(context.searchId ? { searchId: context.searchId } : {}),
            ...(context.guestId ? { guestId: context.guestId } : {})
        }
    };
    for (const key of OPTION_ARRAY_KEYS) {
        if (Array.isArray(payload[key])) {
            enriched[key] = payload[key].map(enrichOption);
        }
    }
    return enriched;
};
exports.enrichResponseWithUniversalIds = enrichResponseWithUniversalIds;
