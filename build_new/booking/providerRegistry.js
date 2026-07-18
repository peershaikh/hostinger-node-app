"use strict";
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
Object.defineProperty(exports, "__esModule", { value: true });
exports.bookingProviderRegistry = void 0;
// ─── Null Health (used by stub providers) ────────────────────────────────────
function unknownHealth(id) {
    return {
        providerId: id,
        status: 'UNKNOWN',
        lastChecked: new Date().toISOString()
    };
}
// ─── Stub base — satisfies BookingProvider interface ─────────────────────────
// All real implementations will replace buildBookingUrl + getHealth.
class StubProvider {
    constructor() {
        this.enabled = false; // ALWAYS false in PHASE_4C824
    }
    buildBookingUrl(_intent, _attribution) {
        throw new Error(`[BOOKING_GATEWAY] Provider ${this.id} is not yet implemented (enabled=false)`);
    }
    async getHealth() {
        return unknownHealth(this.id);
    }
}
// ─── Provider Descriptors ─────────────────────────────────────────────────────
class IRCTCProvider extends StubProvider {
    constructor() {
        super(...arguments);
        this.id = 'IRCTC';
        this.priority = 1; // Highest priority — official rail authority
        this.capabilities = {
            supportsRail: true,
            supportsBus: false,
            supportsFlight: false,
            supportsHotel: false,
            supportsAffiliate: true, // affiliate redirect to IRCTC
            supportsDirectBooking: false, // agent login NOT implemented
            supportsPartnerAttrib: true
        };
    }
}
class ConfirmTktProvider extends StubProvider {
    constructor() {
        super(...arguments);
        this.id = 'CONFIRMTKT';
        this.priority = 2;
        this.capabilities = {
            supportsRail: true,
            supportsBus: false,
            supportsFlight: false,
            supportsHotel: false,
            supportsAffiliate: true,
            supportsDirectBooking: false,
            supportsPartnerAttrib: true
        };
    }
}
class IxigoProvider extends StubProvider {
    constructor() {
        super(...arguments);
        this.id = 'IXIGO';
        this.priority = 3;
        this.capabilities = {
            supportsRail: true,
            supportsBus: true, // ixigo supports bus
            supportsFlight: true, // ixigo supports flights
            supportsHotel: false,
            supportsAffiliate: true,
            supportsDirectBooking: false,
            supportsPartnerAttrib: true
        };
    }
}
class RailYatriProvider extends StubProvider {
    constructor() {
        super(...arguments);
        this.id = 'RAILYATRI';
        this.priority = 4;
        this.capabilities = {
            supportsRail: true,
            supportsBus: true,
            supportsFlight: false,
            supportsHotel: false,
            supportsAffiliate: true,
            supportsDirectBooking: false,
            supportsPartnerAttrib: true
        };
    }
}
class OfficialAgentProvider extends StubProvider {
    constructor() {
        super(...arguments);
        this.id = 'OFFICIAL_AGENT';
        this.priority = 5;
        this.capabilities = {
            supportsRail: true,
            supportsBus: false,
            supportsFlight: false,
            supportsHotel: false,
            supportsAffiliate: false,
            supportsDirectBooking: true, // FUTURE: direct booking with IRCTC agent credentials
            supportsPartnerAttrib: false
        };
    }
}
class FutureBusProvider extends StubProvider {
    constructor() {
        super(...arguments);
        this.id = 'FUTURE_BUS';
        this.priority = 10;
        this.capabilities = {
            supportsRail: false,
            supportsBus: true,
            supportsFlight: false,
            supportsHotel: false,
            supportsAffiliate: true,
            supportsDirectBooking: false,
            supportsPartnerAttrib: true
        };
    }
}
class FutureFlightProvider extends StubProvider {
    constructor() {
        super(...arguments);
        this.id = 'FUTURE_FLIGHT';
        this.priority = 10;
        this.capabilities = {
            supportsRail: false,
            supportsBus: false,
            supportsFlight: true,
            supportsHotel: false,
            supportsAffiliate: true,
            supportsDirectBooking: false,
            supportsPartnerAttrib: true
        };
    }
}
class FutureHotelProvider extends StubProvider {
    constructor() {
        super(...arguments);
        this.id = 'FUTURE_HOTEL';
        this.priority = 10;
        this.capabilities = {
            supportsRail: false,
            supportsBus: false,
            supportsFlight: false,
            supportsHotel: true,
            supportsAffiliate: true,
            supportsDirectBooking: false,
            supportsPartnerAttrib: true
        };
    }
}
// ─── Registry ─────────────────────────────────────────────────────────────────
class BookingProviderRegistry {
    constructor() {
        this.providers = [
            new IRCTCProvider(),
            new ConfirmTktProvider(),
            new IxigoProvider(),
            new RailYatriProvider(),
            new OfficialAgentProvider(),
            new FutureBusProvider(),
            new FutureFlightProvider(),
            new FutureHotelProvider()
        ];
    }
    /**
     * Return all registered providers (enabled or not).
     * Sorted by priority ascending (lowest number = first).
     */
    getAll() {
        return [...this.providers].sort((a, b) => a.priority - b.priority);
    }
    /**
     * Return only enabled providers.
     * In PHASE_4C824: always returns empty array (all enabled=false).
     */
    getEnabled() {
        return this.providers.filter(p => p.enabled);
    }
    /**
     * Look up a specific provider by ID.
     */
    find(id) {
        return this.providers.find(p => p.id === id);
    }
    /**
     * Return the manifest of all providers (id, priority, enabled, capabilities).
     * Safe to expose in health/admin endpoints — no secrets.
     */
    manifest() {
        return this.getAll().map(p => ({
            id: p.id,
            priority: p.priority,
            enabled: p.enabled,
            capabilities: p.capabilities
        }));
    }
}
exports.bookingProviderRegistry = new BookingProviderRegistry();
