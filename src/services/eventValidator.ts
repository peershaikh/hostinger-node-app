/**
 * PHASE_4C823 — Universal Event Validator
 *
 * Validates incoming event payloads before they enter the queue.
 * Rejects malformed events early so the queue only holds valid rows.
 *
 * Required fields (per implementation contract):
 *   eventId      — auto-generated; not caller-supplied, but event_name must be set
 *   sessionId    — at least one of: requestId | searchId | guestId | userId
 *   userId       — optional
 *   timestamp    — auto-generated; not validated here
 *   eventType    — eventName, must be a known value in UNIVERSAL_EVENT_NAME_SET
 *   entityType   — mode field must be present and non-empty
 *   metadata     — must be an object (not array, not null)
 */

import { UNIVERSAL_EVENT_NAME_SET } from '../constants/eventTaxonomy';
import { winstonLogger } from '../middleware/logger';
import { UniversalEventPayload } from './universalEventEmitter';

export interface ValidationResult {
  valid: boolean;
  reason?: string;
}

export function validateEventPayload(payload: UniversalEventPayload): ValidationResult {
  // eventType: eventName must be a known event
  if (!payload.eventName || !UNIVERSAL_EVENT_NAME_SET.has(payload.eventName)) {
    return { valid: false, reason: `Unknown eventType: "${payload.eventName}"` };
  }

  // sessionId: at least one identity anchor must be present
  const hasSession =
    Boolean(payload.requestId?.trim()) ||
    Boolean(payload.searchId?.trim())  ||
    Boolean(payload.guestId?.trim())   ||
    Boolean(payload.userId?.trim());

  if (!hasSession) {
    return {
      valid: false,
      reason: `Missing sessionId — at least one of requestId/searchId/guestId/userId required`
    };
  }

  // entityType: mode must be present
  if (!payload.mode || typeof payload.mode !== 'string' || !payload.mode.trim()) {
    return { valid: false, reason: `Missing entityType (mode field required)` };
  }

  // metadata: must be a plain object if provided
  if (payload.metadata !== undefined) {
    if (
      typeof payload.metadata !== 'object' ||
      payload.metadata === null          ||
      Array.isArray(payload.metadata)
    ) {
      return { valid: false, reason: `metadata must be a plain object` };
    }
  }

  return { valid: true };
}

/**
 * Log a validation rejection at WARN level with a structured tag.
 */
export function rejectEvent(payload: UniversalEventPayload, reason: string): void {
  winstonLogger.warn(`[EVENT_VALIDATION_REJECTED] eventName=${payload.eventName} reason="${reason}"`);
}
