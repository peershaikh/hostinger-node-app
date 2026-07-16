"use strict";
/**
 * PHASE_4C870 — Class-aware availability TTL (PHASE_4C865 §4.3).
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.L1_AVAIL_TTL_SECONDS = void 0;
exports.hoursUntilJourney = hoursUntilJourney;
exports.classifyAvailabilityStatus = classifyAvailabilityStatus;
exports.shouldCacheResult = shouldCacheResult;
exports.computeAvailTtlSeconds = computeAvailTtlSeconds;
const BASE_TTL = {
    CNF: 300,
    RAC: 180,
    WL: 120,
    REGRET: 30,
    ERROR: 30,
    NOT_BOOKABLE: 30,
    NOT_RUNNING: 60,
    PROVIDER_DOWN: 15,
    UNKNOWN: 180,
};
/** L1 micro-cache TTL — fixed burst dedup window (PHASE_4C869 §5.1). */
exports.L1_AVAIL_TTL_SECONDS = 60;
function hoursUntilJourney(journeyDate) {
    const trimmed = (journeyDate || '').trim();
    if (!trimmed)
        return 9999;
    const parts = trimmed.split('-');
    let journeyMs;
    if (parts[0]?.length === 4) {
        journeyMs = Date.parse(`${parts[0]}-${parts[1]}-${parts[2]}T00:00:00Z`);
    }
    else {
        journeyMs = Date.parse(trimmed);
    }
    if (Number.isNaN(journeyMs))
        return 9999;
    return (journeyMs - Date.now()) / (1000 * 60 * 60);
}
function proximityMultiplier(hoursToJourney) {
    if (hoursToJourney < 24)
        return 0.4;
    if (hoursToJourney < 72)
        return 0.7;
    return 1.0;
}
function extractStatusText(data) {
    if (!data || typeof data !== 'object')
        return '';
    const d = data;
    const nested = d.data;
    const candidates = [
        d.status,
        d.current_status,
        d.availabilityText,
        nested?.availabilityText,
        d.booking_status,
    ];
    for (const c of candidates) {
        if (c != null && String(c).trim())
            return String(c).toUpperCase().trim();
    }
    if (Array.isArray(d.availability) && d.availability[0]) {
        const first = d.availability[0];
        return String(first.availabilityText || first.status || '').toUpperCase().trim();
    }
    if (nested && Array.isArray(nested.availability) && nested.availability[0]) {
        const first = nested.availability[0];
        return String(first.availabilityText || first.status || '').toUpperCase().trim();
    }
    return '';
}
function classifyAvailabilityStatus(result) {
    if (!result.success) {
        const reason = (result.reason || '').toUpperCase();
        if (reason.includes('NOT_BOOKABLE') || reason.includes('SEGMENT_NOT'))
            return 'NOT_BOOKABLE';
        if (reason.includes('NOT_RUNNING') || reason.includes('DOES NOT RUN'))
            return 'NOT_RUNNING';
        if (reason.includes('PROVIDER'))
            return 'PROVIDER_DOWN';
        return 'ERROR';
    }
    const text = extractStatusText(result.data);
    if (!text)
        return 'UNKNOWN';
    if (/\b(REGRET|NOT\s*AVAILABLE|NO\s*SEATS)\b/i.test(text))
        return 'REGRET';
    if (/\b(CNF|CONFIRMED|AVAILABLE|AVL)\b/i.test(text))
        return 'CNF';
    if (/\bRAC\b/i.test(text))
        return 'RAC';
    if (/\b(WL|GNWL|RLWL|PQWL|TQWL|WL\d+)\b/i.test(text))
        return 'WL';
    return 'UNKNOWN';
}
/** Never cache auth/key errors surfaced as provider failures. */
function shouldCacheResult(result) {
    const msg = `${result.reason || ''} ${result.message || ''}`.toLowerCase();
    if (msg.includes('api key') || msg.includes('unauthorized') || msg.includes('auth')) {
        return false;
    }
    if (result.reason === 'PROVIDER_DOWN' && msg.includes('key'))
        return false;
    return true;
}
function computeAvailTtlSeconds(status, journeyDate) {
    const hoursToJourney = hoursUntilJourney(journeyDate);
    if (hoursToJourney > 48 && (status === 'CNF' || status === 'UNKNOWN')) {
        return 900;
    }
    const base = BASE_TTL[status] ?? BASE_TTL.UNKNOWN;
    const mult = proximityMultiplier(hoursToJourney);
    return Math.max(30, Math.floor(base * mult));
}
