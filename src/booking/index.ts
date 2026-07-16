/**
 * PHASE_4C824 / PHASE_4C825 — Booking Gateway Foundation + Decision Engine — barrel export
 *
 * Consumers import from here:
 *   import { createBookingIntent, bookingProviderRegistry, generateAttribution,
 *            bookingDecisionService } from '../booking';
 */
export * from './interfaces';
export * from './bookingIntent';
export * from './decisionTypes';
export { bookingProviderRegistry } from './providerRegistry';
export { generateAttribution, attributionToQueryString } from './partnerAttribution';
export { bookingDecisionService } from './bookingDecisionService';
