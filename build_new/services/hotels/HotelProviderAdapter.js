"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.hotelService = exports.HotelService = exports.MockHotelProvider = void 0;
const logger_1 = require("../../middleware/logger");
const cacheService_1 = require("../cacheService");
// ── Deterministic Mock Sandbox Provider ──
class MockHotelProvider {
    async searchHotels(payload) {
        const amenitiesList = ['Free WiFi', 'Pool', 'Breakfast Included', 'Fitness Center', 'Air Conditioning', 'Room Service'];
        const results = [];
        const seed = (payload.destination.charCodeAt(0) + (payload.guests * 10)) % 7;
        const hotels = [
            { name: 'Hotel Grand Palace', image: 'https://images.unsplash.com/photo-1566073771259-6a8506099945?w=256' },
            { name: 'Station View Residency', image: 'https://images.unsplash.com/photo-1520250497591-112f2f40a3f4?w=256' },
            { name: 'Metro Executive Inn', image: 'https://images.unsplash.com/photo-1542314831-068cd1dbfeeb?w=256' }
        ];
        const count = 2 + (seed % 2);
        for (let i = 0; i < count; i++) {
            const hotel = hotels[i % hotels.length];
            const rating = 3.8 + (i * 0.2) + (seed * 0.05);
            const reviewsCount = 45 + (i * 120) + (seed * 12);
            const pricePerNight = 1800 + i * 950 + (seed * 100);
            const amenities = [
                amenitiesList[0],
                amenitiesList[2],
                amenitiesList[4]
            ];
            if (i % 2 === 0)
                amenities.push(amenitiesList[1]);
            results.push({
                id: `mock_ht_${payload.destination.toLowerCase().replace(/\s+/g, '_')}_${i}_${seed}`,
                name: hotel.name,
                thumbnailUrl: hotel.image,
                rating: Math.min(5.0, Number(rating.toFixed(1))),
                reviewsCount,
                pricePerNight,
                currency: 'INR',
                address: `Near Main Terminal, ${payload.destination}`,
                amenities
            });
        }
        return results;
    }
    async getHotelDetails(hotelId) {
        const parts = hotelId.split('_');
        if (parts[0] !== 'mock' || parts[1] !== 'ht')
            return null;
        const destination = parts[2];
        const index = Number(parts[3]);
        const seed = Number(parts[4]);
        const hotels = await this.searchHotels({ destination, checkInDate: '', checkOutDate: '', guests: 1 });
        return hotels[index] || null;
    }
}
exports.MockHotelProvider = MockHotelProvider;
// ── Hotel Service Coordinator with Cache & Timeout Protection ──
class HotelService {
    constructor() {
        // Mandatory Governance Feature Flags (Default: FALSE)
        this.hotels_provider_enabled = false;
        this.sandbox_mode_enabled = true; // Forces mock sandbox only
        this.activeProvider = new MockHotelProvider();
    }
    async search(payload) {
        // 1. Feature Flag Isolation Gating
        if (!this.hotels_provider_enabled) {
            logger_1.winstonLogger.warn(`[HOTEL_SERVICE] Search attempted but 'hotels_provider_enabled' is FALSE. Gated.`);
            return [];
        }
        // 2. Strict Caching Namespace Verification (Guarantees zero collision with train registry cache keys)
        // Key uses 'hotels:search' prefix. Train keys in cacheService use 'search:', 'split:', 'pnr:', 'live:'.
        const cacheKey = `hotels:search:${payload.destination.toLowerCase().trim()}:${payload.guests}:${payload.checkInDate}`;
        try {
            const cached = cacheService_1.cacheService.get(cacheKey);
            if (cached) {
                logger_1.winstonLogger.info('[TELEMETRY] cache_hit');
                return cached;
            }
            logger_1.winstonLogger.info('[TELEMETRY] cache_miss');
        }
        catch (err) {
            logger_1.winstonLogger.warn(`[HOTEL_CACHE_ERROR] Failed reading cache: ${err.message}`);
        }
        // 3. Cache Miss: Execute Provider Search with 4s Timeout Promise
        try {
            let hotelTimer;
            const timeoutPromise = new Promise((_, reject) => {
                hotelTimer = setTimeout(() => reject(new Error('PROVIDER_TIMEOUT')), 4000);
            });
            const searchPromise = this.activeProvider.searchHotels(payload);
            const results = await Promise.race([searchPromise, timeoutPromise]).finally(() => {
                if (hotelTimer)
                    clearTimeout(hotelTimer);
            });
            if (this.sandbox_mode_enabled) {
                logger_1.winstonLogger.info('[TELEMETRY] sandbox_mode_served');
            }
            // 4. Update NodeCache (TTL: 10 minutes / 600 seconds)
            try {
                cacheService_1.cacheService.set(cacheKey, results, 600);
            }
            catch (err) {
                logger_1.winstonLogger.warn(`[HOTEL_CACHE_SET_ERROR] Failed setting cache: ${err.message}`);
            }
            return results;
        }
        catch (err) {
            if (err.message === 'PROVIDER_TIMEOUT') {
                logger_1.winstonLogger.error('[TELEMETRY] provider_search_timeout');
                logger_1.winstonLogger.error('[TELEMETRY] degraded_mode_entered');
            }
            logger_1.winstonLogger.error(`[HOTEL_SERVICE_ERROR] Hotel search execution failed: ${err.message}`);
            throw err;
        }
    }
    async getDetails(hotelId) {
        if (!this.hotels_provider_enabled)
            return null;
        try {
            return await this.activeProvider.getHotelDetails(hotelId);
        }
        catch (err) {
            logger_1.winstonLogger.error(`[HOTEL_SERVICE_ERROR] Hotel detail fetch failed: ${err.message}`);
            return null;
        }
    }
    // Temporary helper to dynamically toggle feature flags under controlled staging tests
    setFeatureFlags(providerEnabled, sandboxEnabled) {
        this.hotels_provider_enabled = providerEnabled;
        this.sandbox_mode_enabled = sandboxEnabled;
    }
}
exports.HotelService = HotelService;
exports.hotelService = new HotelService();
