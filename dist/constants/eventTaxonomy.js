"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.UNIVERSAL_EVENT_NAME_SET = exports.UniversalEventNames = exports.EVENT_SCHEMA_VERSION = void 0;
exports.EVENT_SCHEMA_VERSION = 1;
exports.UniversalEventNames = {
    // Search Funnel
    SEARCH_STARTED: 'search_started',
    SEARCH_COMPLETED: 'search_completed',
    SEARCH_FAILED: 'search_failed',
    DIRECT_RESULT_SHOWN: 'direct_result_shown',
    SPLIT_RESULT_SHOWN: 'split_result_shown',
    TRAIN_RESULT_CLICKED: 'train_result_clicked',
    // Availability & Timetable Interaction
    AVAILABILITY_CHECKED: 'availability_checked',
    AVAILABILITY_FAILURE: 'availability_failure',
    TIMETABLE_OPENED: 'timetable_opened',
    COACH_CLASS_SELECTED: 'coach_class_selected',
    COACH_SWAP_OPENED: 'coach_swap_opened',
    // Split & Rescue Funnel
    SPLIT_RESULT_CLICKED: 'split_result_clicked',
    SPLIT_RESULT_EXPANDED: 'split_result_expanded',
    SPLIT_EVALUATED: 'split_evaluated',
    SPLIT_VALID: 'split_valid',
    SPLIT_REJECTED: 'split_rejected',
    RESCUE_EVALUATED: 'rescue_evaluated',
    RESCUE_FOUND: 'rescue_found',
    RESCUE_NOT_FOUND: 'rescue_not_found',
    RESCUE_FAILED_REASON: 'rescue_failed_reason',
    // PNR & Live Tracking
    PNR_CHECKED: 'pnr_checked',
    PNR_PREDICTION_FEEDBACK: 'pnr_prediction_feedback',
    LIVE_TRAIN_CHECKED: 'live_train_checked',
    // Conversion & Social
    ROUTE_SHARED: 'route_shared',
    BOOKING_OUTBOUND_CLICK: 'booking_outbound_click',
    BOOKING_PLACEHOLDER: 'booking_placeholder',
    FEEDBACK_SUBMITTED: 'feedback_submitted',
    COMPLAINT_LOGGED: 'complaint_logged',
    NOTIFICATION_SENT: 'notification_sent',
    // Knowledge & Hub Intelligence
    MISSING_ROUTE_DETECTED: 'missing_route_detected',
    MISSING_STATION_DETECTED: 'missing_station_detected',
    ROUTE_ENRICHMENT_REQUESTED: 'route_enrichment_requested',
    ROUTE_ENRICHMENT_COMPLETED: 'route_enrichment_completed',
    KNOWLEDGE_PROMOTED: 'knowledge_promoted',
    KNOWLEDGE_REJECTED: 'knowledge_rejected',
    // Cache & Provider Pipeline
    CACHE_HIT: 'cache_hit',
    CACHE_MISS: 'cache_miss',
    STALE_SERVED: 'stale_served',
    PROVIDER_CALL_STARTED: 'provider_call_started',
    PROVIDER_CALL_COMPLETED: 'provider_call_completed',
    PROVIDER_CALL_FAILED: 'provider_call_failed'
};
exports.UNIVERSAL_EVENT_NAME_SET = new Set(Object.values(exports.UniversalEventNames));
