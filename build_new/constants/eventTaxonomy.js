"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.UNIVERSAL_EVENT_NAME_SET = exports.UniversalEventNames = exports.EVENT_SCHEMA_VERSION = void 0;
exports.EVENT_SCHEMA_VERSION = 1;
exports.UniversalEventNames = {
    SEARCH_STARTED: 'search_started',
    SEARCH_COMPLETED: 'search_completed',
    SEARCH_FAILED: 'search_failed',
    CACHE_HIT: 'cache_hit',
    CACHE_MISS: 'cache_miss',
    STALE_SERVED: 'stale_served',
    PROVIDER_CALL_STARTED: 'provider_call_started',
    PROVIDER_CALL_COMPLETED: 'provider_call_completed',
    PROVIDER_CALL_FAILED: 'provider_call_failed',
    SPLIT_EVALUATED: 'split_evaluated',
    SPLIT_VALID: 'split_valid',
    SPLIT_REJECTED: 'split_rejected',
    RESCUE_EVALUATED: 'rescue_evaluated',
    RESCUE_FOUND: 'rescue_found',
    RESCUE_NOT_FOUND: 'rescue_not_found',
    RESCUE_FAILED_REASON: 'rescue_failed_reason',
    PNR_CHECKED: 'pnr_checked',
    LIVE_TRAIN_CHECKED: 'live_train_checked',
    BOOKING_PLACEHOLDER: 'booking_placeholder',
    NOTIFICATION_SENT: 'notification_sent'
};
exports.UNIVERSAL_EVENT_NAME_SET = new Set(Object.values(exports.UniversalEventNames));
