"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.flightService = exports.FlightService = exports.MockFlightProvider = void 0;
const logger_1 = require("../../middleware/logger");
// ── Deterministic Mock Sandbox Provider ──
class MockFlightProvider {
    async searchFlights(payload) {
        // Generate highly realistic, deterministic flight listings based on city character codes
        const airlines = [
            { name: 'Air India', code: 'AI', logo: 'https://images.unsplash.com/photo-1544620347-c4fd4a3d5957?w=128' },
            { name: 'IndiGo', code: '6E', logo: 'https://images.unsplash.com/photo-1436491865332-7a61a109cc05?w=128' },
            { name: 'Vistara', code: 'UK', logo: 'https://images.unsplash.com/photo-1570710891163-6d3b5c47248b?w=128' }
        ];
        const results = [];
        const seed = (payload.from.charCodeAt(0) + payload.to.charCodeAt(0)) % 10;
        // Deterministically generate 3-5 flight options
        const count = 3 + (seed % 3);
        for (let i = 0; i < count; i++) {
            const airline = airlines[i % airlines.length];
            const flightNumber = `${airline.code}-${100 + i * 15 + seed}`;
            const price = 4500 + i * 1200 + (seed * 150);
            const stops = i === 0 ? 0 : 1;
            const durationMins = 120 + i * 45 + (seed * 5);
            const depHour = 6 + i * 4 + (seed % 3);
            const depTime = `${payload.date}T${String(depHour).padStart(2, '0')}:15:00.000Z`;
            const arrTimeDate = new Date(new Date(depTime).getTime() + durationMins * 60 * 1000);
            const arrTime = arrTimeDate.toISOString();
            results.push({
                id: `mock_fl_${payload.from.toLowerCase()}_${payload.to.toLowerCase()}_${i}_${seed}`,
                airline: airline.name,
                airlineLogoUrl: airline.logo,
                flightNumber,
                departureAirport: payload.from.toUpperCase(),
                arrivalAirport: payload.to.toUpperCase(),
                departureTime: depTime,
                arrivalTime: arrTime,
                price,
                currency: 'INR',
                durationMins,
                stops,
                cabinClass: payload.cabinClass || 'economy'
            });
        }
        return results;
    }
    async getFlightDetails(flightId) {
        const parts = flightId.split('_');
        if (parts[0] !== 'mock' || parts[1] !== 'fl')
            return null;
        const from = parts[2];
        const to = parts[3];
        const index = Number(parts[4]);
        const seed = Number(parts[5]);
        const flights = await this.searchFlights({ from, to, date: new Date().toISOString().split('T')[0] });
        return flights[index] || null;
    }
}
exports.MockFlightProvider = MockFlightProvider;
// ── Flight Service Coordinator with 4s Timeout Budget ──
class FlightService {
    constructor() {
        // Mandatory Governance Feature Flags (Default: FALSE)
        this.flights_provider_enabled = false;
        this.sandbox_mode_enabled = true; // Forces deterministic mock sandbox mode
        this.activeProvider = new MockFlightProvider();
    }
    async search(payload) {
        // 1. Feature Flag Isolation Gating
        if (!this.flights_provider_enabled) {
            logger_1.winstonLogger.warn(`[FLIGHT_SERVICE] Search attempted but 'flights_provider_enabled' is FALSE. Gated.`);
            return [];
        }
        logger_1.winstonLogger.info(`[FLIGHT_SERVICE] Executing search query | Sandbox=${this.sandbox_mode_enabled}`);
        try {
            // 2. Promise.race Timeout Wrapper (4000ms Budget)
            let flightTimer;
            const timeoutPromise = new Promise((_, reject) => {
                flightTimer = setTimeout(() => reject(new Error('PROVIDER_TIMEOUT')), 4000);
            });
            const searchPromise = this.activeProvider.searchFlights(payload);
            const results = await Promise.race([searchPromise, timeoutPromise]).finally(() => {
                if (flightTimer)
                    clearTimeout(flightTimer);
            });
            logger_1.winstonLogger.info(`[FLIGHT_SERVICE_SUCCESS] Search completed successfully.`);
            if (this.sandbox_mode_enabled) {
                logger_1.winstonLogger.info('[TELEMETRY] sandbox_mode_served');
            }
            return results;
        }
        catch (err) {
            if (err.message === 'PROVIDER_TIMEOUT') {
                logger_1.winstonLogger.error('[TELEMETRY] provider_search_timeout');
                logger_1.winstonLogger.error('[TELEMETRY] degraded_mode_entered');
            }
            logger_1.winstonLogger.error(`[FLIGHT_SERVICE_ERROR] Search execution failed: ${err.message}`);
            throw err;
        }
    }
    async getDetails(flightId) {
        if (!this.flights_provider_enabled)
            return null;
        try {
            return await this.activeProvider.getFlightDetails(flightId);
        }
        catch (err) {
            logger_1.winstonLogger.error(`[FLIGHT_SERVICE_ERROR] Detail fetch failed: ${err.message}`);
            return null;
        }
    }
    // Temporary helper to dynamically toggle feature flags under controlled staging tests
    setFeatureFlags(providerEnabled, sandboxEnabled) {
        this.flights_provider_enabled = providerEnabled;
        this.sandbox_mode_enabled = sandboxEnabled;
    }
}
exports.FlightService = FlightService;
exports.flightService = new FlightService();
