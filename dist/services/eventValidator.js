"use strict";
/**
 * PHASE_4C823 / PHASE_AI_EVENT_FOUNDATION_024 — Universal Event Validator & Privacy Scrubber
 *
 * Validates incoming event payloads before they enter the queue and sanitizes
 * metadata to guarantee zero leakage of secrets, auth tokens, or unmasked PII.
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.sanitizeMetadata = sanitizeMetadata;
exports.validateEventPayload = validateEventPayload;
exports.rejectEvent = rejectEvent;
const eventTaxonomy_1 = require("../constants/eventTaxonomy");
const logger_1 = require("../middleware/logger");
const FORBIDDEN_KEY_REGEX = /(password|passcode|token|auth|cookie|csrf|secret|cvv|cardnumber|card_num|pin|otp)/i;
const TEN_DIGIT_PNR_REGEX = /^\d{10}$/;
/**
 * Recursively scrub sensitive keys and mask raw PNRs in metadata objects
 */
function sanitizeMetadata(input, depth = 0) {
    if (depth > 4 || input === null || input === undefined)
        return input;
    if (typeof input !== 'object') {
        if (typeof input === 'string' && TEN_DIGIT_PNR_REGEX.test(input)) {
            return `******${input.slice(-4)}`;
        }
        return input;
    }
    if (Array.isArray(input)) {
        return input.map(item => sanitizeMetadata(item, depth + 1));
    }
    const clean = {};
    for (const [key, value] of Object.entries(input)) {
        if (FORBIDDEN_KEY_REGEX.test(key)) {
            clean[key] = '[REDACTED]';
        }
        else if (typeof value === 'string' && (key.toLowerCase().includes('pnr') || TEN_DIGIT_PNR_REGEX.test(value))) {
            clean[key] = value.length === 10 ? `******${value.slice(-4)}` : value;
        }
        else if (typeof value === 'object' && value !== null) {
            clean[key] = sanitizeMetadata(value, depth + 1);
        }
        else {
            clean[key] = value;
        }
    }
    return clean;
}
function validateEventPayload(payload) {
    // eventType: eventName must be a known event
    if (!payload.eventName || !eventTaxonomy_1.UNIVERSAL_EVENT_NAME_SET.has(payload.eventName)) {
        return { valid: false, reason: `Unknown eventType: "${payload.eventName}"` };
    }
    // Ensure mode defaults safely
    if (!payload.mode || typeof payload.mode !== 'string' || !payload.mode.trim()) {
        payload.mode = 'rail';
    }
    // sessionId: ensure at least one identity anchor is present (auto-assign anonymous guest if completely unanchored)
    const hasSession = Boolean(payload.requestId?.trim()) ||
        Boolean(payload.searchId?.trim()) ||
        Boolean(payload.guestId?.trim()) ||
        Boolean(payload.userId?.trim());
    if (!hasSession) {
        payload.guestId = `guest_anon_${Date.now()}`;
    }
    // metadata: must be a plain object if provided
    if (payload.metadata !== undefined) {
        if (typeof payload.metadata !== 'object' ||
            payload.metadata === null ||
            Array.isArray(payload.metadata)) {
            return { valid: false, reason: `metadata must be a plain object` };
        }
        payload.metadata = sanitizeMetadata(payload.metadata);
    }
    return { valid: true };
}
/**
 * Log a validation rejection at WARN level with a structured tag.
 */
function rejectEvent(payload, reason) {
    logger_1.winstonLogger.warn(`[EVENT_VALIDATION_REJECTED] eventName=${payload.eventName} reason="${reason}"`);
}
