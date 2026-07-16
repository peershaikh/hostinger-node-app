/**
 * PHASE_4C824 — Immutable Booking Intent Factory
 *
 * Creates a frozen BookingIntent from raw caller-supplied parameters.
 * The intent object is Object.freeze()'d — it cannot be mutated after creation.
 *
 * NO booking is performed here.
 * NO external calls are made.
 * NO redirects are issued.
 *
 * This file is infrastructure only.
 */

import { BookingIntent, JourneySegment, ProviderId, Quota, TravelClass } from './interfaces';

// ─── ID Generation ────────────────────────────────────────────────────────────
// Intentionally NOT importing universalIds to keep booking module self-contained.
// Uses crypto.randomUUID() which is available in Node 14.17+.
function generateSessionId(): string {
  // crypto.randomUUID is available since Node 14.17
  if (typeof crypto !== 'undefined' && crypto.randomUUID) {
    return crypto.randomUUID();
  }
  // Fallback for older runtimes
  return `bsid_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;
}

// ─── Input DTOs ───────────────────────────────────────────────────────────────

export interface BookingIntentInput {
  userId?:        string | null;
  guestId?:       string;
  fromStation:    string;
  toStation:      string;
  trainNo:        string;
  journeyDate:    string;   // YYYYMMDD
  classType:      string;   // validated to TravelClass
  quota?:         string;   // validated to Quota, defaults to 'GN'
  provider:       ProviderId;
  affiliateId?:   string;
  campaignId?:    string;
  adVariant?:     string;
  rescueId?:      string;
  splitId?:       string;
  pnrId?:         string;
}

// ─── Validation ───────────────────────────────────────────────────────────────

const VALID_CLASSES: ReadonlySet<string> = new Set<TravelClass>([
  '1A', '2A', '3A', 'SL', 'CC', '2S', 'EC', 'FC', '3E'
]);

const VALID_QUOTAS: ReadonlySet<string> = new Set<Quota>([
  'GN', 'TQ', 'SS', 'PH', 'LD', 'YU', 'HP', 'DP', 'HO'
]);

const VALID_PROVIDERS: ReadonlySet<string> = new Set<ProviderId>([
  'IRCTC', 'CONFIRMTKT', 'IXIGO', 'RAILYATRI', 'OFFICIAL_AGENT',
  'FUTURE_BUS', 'FUTURE_FLIGHT', 'FUTURE_HOTEL'
]);

const DATE_RE = /^\d{8}$/; // YYYYMMDD

export class BookingIntentValidationError extends Error {
  constructor(public readonly field: string, message: string) {
    super(`[BOOKING_INTENT] Validation failed on "${field}": ${message}`);
    this.name = 'BookingIntentValidationError';
  }
}

function validateInput(input: BookingIntentInput): void {
  if (!input.fromStation?.trim()) throw new BookingIntentValidationError('fromStation', 'required');
  if (!input.toStation?.trim())   throw new BookingIntentValidationError('toStation', 'required');
  if (!input.trainNo?.trim())     throw new BookingIntentValidationError('trainNo', 'required');

  if (!DATE_RE.test(input.journeyDate)) {
    throw new BookingIntentValidationError('journeyDate', `must be YYYYMMDD, got "${input.journeyDate}"`);
  }

  if (!VALID_CLASSES.has(input.classType)) {
    throw new BookingIntentValidationError('classType', `"${input.classType}" is not a valid class`);
  }

  const quota = input.quota || 'GN';
  if (!VALID_QUOTAS.has(quota)) {
    throw new BookingIntentValidationError('quota', `"${quota}" is not a valid quota`);
  }

  if (!VALID_PROVIDERS.has(input.provider)) {
    throw new BookingIntentValidationError('provider', `"${input.provider}" is not a registered provider`);
  }
}

// ─── Factory ──────────────────────────────────────────────────────────────────

/**
 * Create an immutable BookingIntent from validated input.
 *
 * Throws BookingIntentValidationError if any required field is missing or invalid.
 * The returned object is frozen (Object.freeze) — no mutation possible.
 */
export function createBookingIntent(input: BookingIntentInput): Readonly<BookingIntent> {
  validateInput(input);

  const journey: JourneySegment = Object.freeze({
    fromStation: input.fromStation.trim().toUpperCase(),
    toStation:   input.toStation.trim().toUpperCase(),
    trainNo:     input.trainNo.trim(),
    journeyDate: input.journeyDate,
    classType:   input.classType as TravelClass,
    quota:       (input.quota || 'GN') as Quota
  });

  const intent: BookingIntent = {
    sessionId:     generateSessionId(),
    userId:        input.userId ?? null,
    guestId:       input.guestId,
    journey,
    provider:      input.provider,
    affiliateId:   input.affiliateId,
    campaignId:    input.campaignId,
    adVariant:     input.adVariant,
    rescueId:      input.rescueId,
    splitId:       input.splitId,
    pnrId:         input.pnrId,
    createdAt:     new Date().toISOString(),
    schemaVersion: 1
  };

  return Object.freeze(intent);
}
