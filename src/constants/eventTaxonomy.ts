export const EVENT_SCHEMA_VERSION = 1;

export const UniversalEventNames = {
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
} as const;

export type UniversalEventName =
  typeof UniversalEventNames[keyof typeof UniversalEventNames];

export const UNIVERSAL_EVENT_NAME_SET = new Set<string>(
  Object.values(UniversalEventNames)
);

