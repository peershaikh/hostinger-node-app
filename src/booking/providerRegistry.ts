/**
 * PHASE_4C824 — Universal Booking Gateway Provider Registry
 *
 * Declares all known booking provider descriptors.
 * PHASE_4C824: every provider has enabled=false.
 *
 * This is a registry of INTENTIONS, not implementations.
 * Real provider implementations are a future phase.
 *
 * DO NOT: implement booking, call external APIs, redirect users.
 * DO:     enumerate providers, expose priority + capability manifest.
 */

import { BookingCapabilities, BookingIntent, BookingProvider, PartnerAttribution, ProviderId, ProviderHealth } from './interfaces';

// ─── Null Health (used by stub providers) ────────────────────────────────────
function unknownHealth(id: ProviderId): ProviderHealth {
  return {
    providerId:  id,
    status:      'UNKNOWN',
    lastChecked: new Date().toISOString()
  };
}

// ─── Stub base — satisfies BookingProvider interface ─────────────────────────
// All real implementations will replace buildBookingUrl + getHealth.
abstract class StubProvider implements BookingProvider {
  abstract readonly id:           ProviderId;
  abstract readonly priority:     number;
  abstract readonly capabilities: BookingCapabilities;
  readonly enabled = false; // ALWAYS false in PHASE_4C824

  buildBookingUrl(_intent: BookingIntent, _attribution: PartnerAttribution): string {
    throw new Error(`[BOOKING_GATEWAY] Provider ${this.id} is not yet implemented (enabled=false)`);
  }

  async getHealth(): Promise<ProviderHealth> {
    return unknownHealth(this.id);
  }
}

// ─── Provider Descriptors ─────────────────────────────────────────────────────

class IRCTCProvider extends StubProvider {
  readonly id       = 'IRCTC'           as const;
  readonly priority = 1;                // Highest priority — official rail authority
  readonly capabilities: BookingCapabilities = {
    supportsRail:          true,
    supportsBus:           false,
    supportsFlight:        false,
    supportsHotel:         false,
    supportsAffiliate:     true,   // affiliate redirect to IRCTC
    supportsDirectBooking: false,  // agent login NOT implemented
    supportsPartnerAttrib: true
  };
}

class ConfirmTktProvider extends StubProvider {
  readonly id       = 'CONFIRMTKT'      as const;
  readonly priority = 2;
  readonly capabilities: BookingCapabilities = {
    supportsRail:          true,
    supportsBus:           false,
    supportsFlight:        false,
    supportsHotel:         false,
    supportsAffiliate:     true,
    supportsDirectBooking: false,
    supportsPartnerAttrib: true
  };
}

class IxigoProvider extends StubProvider {
  readonly id       = 'IXIGO'           as const;
  readonly priority = 3;
  readonly capabilities: BookingCapabilities = {
    supportsRail:          true,
    supportsBus:           true,   // ixigo supports bus
    supportsFlight:        true,   // ixigo supports flights
    supportsHotel:         false,
    supportsAffiliate:     true,
    supportsDirectBooking: false,
    supportsPartnerAttrib: true
  };
}

class RailYatriProvider extends StubProvider {
  readonly id       = 'RAILYATRI'       as const;
  readonly priority = 4;
  readonly capabilities: BookingCapabilities = {
    supportsRail:          true,
    supportsBus:           true,
    supportsFlight:        false,
    supportsHotel:         false,
    supportsAffiliate:     true,
    supportsDirectBooking: false,
    supportsPartnerAttrib: true
  };
}

class OfficialAgentProvider extends StubProvider {
  readonly id       = 'OFFICIAL_AGENT'  as const;
  readonly priority = 5;
  readonly capabilities: BookingCapabilities = {
    supportsRail:          true,
    supportsBus:           false,
    supportsFlight:        false,
    supportsHotel:         false,
    supportsAffiliate:     false,
    supportsDirectBooking: true,   // FUTURE: direct booking with IRCTC agent credentials
    supportsPartnerAttrib: false
  };
}

class FutureBusProvider extends StubProvider {
  readonly id       = 'FUTURE_BUS'      as const;
  readonly priority = 10;
  readonly capabilities: BookingCapabilities = {
    supportsRail:          false,
    supportsBus:           true,
    supportsFlight:        false,
    supportsHotel:         false,
    supportsAffiliate:     true,
    supportsDirectBooking: false,
    supportsPartnerAttrib: true
  };
}

class FutureFlightProvider extends StubProvider {
  readonly id       = 'FUTURE_FLIGHT'   as const;
  readonly priority = 10;
  readonly capabilities: BookingCapabilities = {
    supportsRail:          false,
    supportsBus:           false,
    supportsFlight:        true,
    supportsHotel:         false,
    supportsAffiliate:     true,
    supportsDirectBooking: false,
    supportsPartnerAttrib: true
  };
}

class FutureHotelProvider extends StubProvider {
  readonly id       = 'FUTURE_HOTEL'    as const;
  readonly priority = 10;
  readonly capabilities: BookingCapabilities = {
    supportsRail:          false,
    supportsBus:           false,
    supportsFlight:        false,
    supportsHotel:         true,
    supportsAffiliate:     true,
    supportsDirectBooking: false,
    supportsPartnerAttrib: true
  };
}

// ─── Registry ─────────────────────────────────────────────────────────────────

class BookingProviderRegistry {
  private readonly providers: ReadonlyArray<BookingProvider> = [
    new IRCTCProvider(),
    new ConfirmTktProvider(),
    new IxigoProvider(),
    new RailYatriProvider(),
    new OfficialAgentProvider(),
    new FutureBusProvider(),
    new FutureFlightProvider(),
    new FutureHotelProvider()
  ];

  /**
   * Return all registered providers (enabled or not).
   * Sorted by priority ascending (lowest number = first).
   */
  getAll(): ReadonlyArray<BookingProvider> {
    return [...this.providers].sort((a, b) => a.priority - b.priority);
  }

  /**
   * Return only enabled providers.
   * In PHASE_4C824: always returns empty array (all enabled=false).
   */
  getEnabled(): BookingProvider[] {
    return this.providers.filter(p => p.enabled);
  }

  /**
   * Look up a specific provider by ID.
   */
  find(id: ProviderId): BookingProvider | undefined {
    return this.providers.find(p => p.id === id);
  }

  /**
   * Return the manifest of all providers (id, priority, enabled, capabilities).
   * Safe to expose in health/admin endpoints — no secrets.
   */
  manifest() {
    return this.getAll().map(p => ({
      id:           p.id,
      priority:     p.priority,
      enabled:      p.enabled,
      capabilities: p.capabilities
    }));
  }
}

export const bookingProviderRegistry = new BookingProviderRegistry();
