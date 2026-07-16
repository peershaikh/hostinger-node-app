"use strict";
/**
 * PHASE_4C824 — Partner Attribution Generator
 *
 * Generates UTM and tracking fields for booking redirects.
 * This is a pure GENERATOR — it creates strings only.
 *
 * NO redirects are issued here.
 * NO external calls are made.
 * NO tracking pixels are loaded.
 * NO cookies are set.
 *
 * All attribution generation is gated by AFFILIATE_TRACKING feature flag.
 * When the flag is OFF, this module returns an empty attribution object.
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.generateAttribution = generateAttribution;
exports.attributionToQueryString = attributionToQueryString;
const featureFlags_1 = require("../config/featureFlags");
// ─── UTM Source Map ───────────────────────────────────────────────────────────
// Maps ProviderId → canonical UTM source string.
// These are advisory defaults; the partner may override via affiliateId config.
const UTM_SOURCE_MAP = {
    IRCTC: 'irctc',
    CONFIRMTKT: 'confirmtkt',
    IXIGO: 'ixigo',
    RAILYATRI: 'railyatri',
    OFFICIAL_AGENT: 'trayago_agent',
    FUTURE_BUS: 'trayago_bus',
    FUTURE_FLIGHT: 'trayago_flight',
    FUTURE_HOTEL: 'trayago_hotel'
};
// ─── Click ID Generation ──────────────────────────────────────────────────────
// click_id is unique per redirect event (not per session).
// Format: ck_{sessionId_prefix}_{timestamp_b36}
// Intentionally short and URL-safe.
function generateClickId(sessionId) {
    const prefix = sessionId.replace(/-/g, '').slice(0, 8);
    const ts = Date.now().toString(36);
    return `ck_${prefix}_${ts}`;
}
// ─── Partner Session ID ───────────────────────────────────────────────────────
// Opaque correlation ID for the partner to track their side.
// Format: ps_{providerId_lower}_{random}
function generatePartnerSessionId(provider) {
    const rand = Math.random().toString(36).slice(2, 10);
    return `ps_${provider.toLowerCase()}_${rand}`;
}
// ─── Main Attribution Generator ───────────────────────────────────────────────
/**
 * Generate PartnerAttribution for a given BookingIntent.
 *
 * When AFFILIATE_TRACKING flag is OFF: returns empty object {}.
 * When AFFILIATE_TRACKING flag is ON:  returns all applicable UTM + tracking fields.
 *
 * The caller is responsible for deciding whether to append these to URLs.
 * This function does NOT modify the intent.
 */
function generateAttribution(intent) {
    // Hard gate: AFFILIATE_TRACKING must be explicitly ON
    if (!featureFlags_1.featureFlags.partnerAttribution) {
        return {};
    }
    const utm_source = UTM_SOURCE_MAP[intent.provider] || 'trayago';
    const utm_medium = 'booking_redirect';
    const utm_campaign = intent.campaignId || intent.affiliateId || 'organic';
    const click_id = generateClickId(intent.sessionId);
    const attribution = {
        utm_source,
        utm_medium,
        utm_campaign,
        click_id,
        booking_session_id: intent.sessionId,
        partner_session_id: generatePartnerSessionId(intent.provider)
    };
    return attribution;
}
/**
 * Serialize a PartnerAttribution to URL query string fragment.
 * Returns empty string when attribution is empty or all values are undefined.
 *
 * Example output: "utm_source=irctc&utm_medium=booking_redirect&..."
 */
function attributionToQueryString(attribution) {
    const params = new URLSearchParams();
    for (const [key, val] of Object.entries(attribution)) {
        if (val !== undefined && val !== null && val !== '') {
            params.append(key, String(val));
        }
    }
    return params.toString();
}
