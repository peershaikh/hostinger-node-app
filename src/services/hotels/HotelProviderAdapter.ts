import { winstonLogger } from '../../middleware/logger';
import { cacheService } from '../cacheService';

export interface HotelSearchResult {
  id: string;
  name: string;
  thumbnailUrl?: string;
  rating: number;
  reviewsCount: number;
  pricePerNight: number;
  currency: string;
  address: string;
  amenities: string[];
}

export interface HotelSearchPayload {
  destination: string; // City name or station proximity
  checkInDate: string; // YYYY-MM-DD
  checkOutDate: string; // YYYY-MM-DD
  guests: number;
}

export interface HotelProvider {
  searchHotels(payload: HotelSearchPayload): Promise<HotelSearchResult[]>;
  getHotelDetails(hotelId: string): Promise<HotelSearchResult | null>;
}

// ── Deterministic Mock Sandbox Provider ──
export class MockHotelProvider implements HotelProvider {
  async searchHotels(payload: HotelSearchPayload): Promise<HotelSearchResult[]> {
    const amenitiesList = ['Free WiFi', 'Pool', 'Breakfast Included', 'Fitness Center', 'Air Conditioning', 'Room Service'];
    
    const results: HotelSearchResult[] = [];
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
      if (i % 2 === 0) amenities.push(amenitiesList[1]);

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

  async getHotelDetails(hotelId: string): Promise<HotelSearchResult | null> {
    const parts = hotelId.split('_');
    if (parts[0] !== 'mock' || parts[1] !== 'ht') return null;

    const destination = parts[2];
    const index = Number(parts[3]);
    const seed = Number(parts[4]);

    const hotels = await this.searchHotels({ destination, checkInDate: '', checkOutDate: '', guests: 1 });
    return hotels[index] || null;
  }
}

// ── Hotel Service Coordinator with Cache & Timeout Protection ──
export class HotelService {
  private activeProvider: HotelProvider;

  // Mandatory Governance Feature Flags (Default: FALSE)
  private hotels_provider_enabled = false;
  private sandbox_mode_enabled = true; // Forces mock sandbox only

  constructor() {
    this.activeProvider = new MockHotelProvider();
  }

  async search(payload: HotelSearchPayload): Promise<HotelSearchResult[]> {
    // 1. Feature Flag Isolation Gating
    if (!this.hotels_provider_enabled) {
      winstonLogger.warn(`[HOTEL_SERVICE] Search attempted but 'hotels_provider_enabled' is FALSE. Gated.`);
      return [];
    }

    // 2. Strict Caching Namespace Verification (Guarantees zero collision with train registry cache keys)
    // Key uses 'hotels:search' prefix. Train keys in cacheService use 'search:', 'split:', 'pnr:', 'live:'.
    const cacheKey = `hotels:search:${payload.destination.toLowerCase().trim()}:${payload.guests}:${payload.checkInDate}`;

    try {
      const cached = cacheService.get<HotelSearchResult[]>(cacheKey);
      if (cached) {
        winstonLogger.info('[TELEMETRY] cache_hit');
        return cached;
      }
      winstonLogger.info('[TELEMETRY] cache_miss');
    } catch (err: any) {
      winstonLogger.warn(`[HOTEL_CACHE_ERROR] Failed reading cache: ${err.message}`);
    }

    // 3. Cache Miss: Execute Provider Search with 4s Timeout Promise
    try {
      let hotelTimer: NodeJS.Timeout | undefined;
      const timeoutPromise = new Promise<never>((_, reject) => {
        hotelTimer = setTimeout(() => reject(new Error('PROVIDER_TIMEOUT')), 4000);
      });

      const searchPromise = this.activeProvider.searchHotels(payload);

      const results = await Promise.race([searchPromise, timeoutPromise]).finally(() => {
        if (hotelTimer) clearTimeout(hotelTimer);
      });

      if (this.sandbox_mode_enabled) {
        winstonLogger.info('[TELEMETRY] sandbox_mode_served');
      }

      // 4. Update NodeCache (TTL: 10 minutes / 600 seconds)
      try {
        cacheService.set(cacheKey, results, 600);
      } catch (err: any) {
        winstonLogger.warn(`[HOTEL_CACHE_SET_ERROR] Failed setting cache: ${err.message}`);
      }

      return results;
    } catch (err: any) {
      if (err.message === 'PROVIDER_TIMEOUT') {
        winstonLogger.error('[TELEMETRY] provider_search_timeout');
        winstonLogger.error('[TELEMETRY] degraded_mode_entered');
      }
      winstonLogger.error(`[HOTEL_SERVICE_ERROR] Hotel search execution failed: ${err.message}`);
      throw err;
    }
  }

  async getDetails(hotelId: string): Promise<HotelSearchResult | null> {
    if (!this.hotels_provider_enabled) return null;

    try {
      return await this.activeProvider.getHotelDetails(hotelId);
    } catch (err: any) {
      winstonLogger.error(`[HOTEL_SERVICE_ERROR] Hotel detail fetch failed: ${err.message}`);
      return null;
    }
  }

  // Temporary helper to dynamically toggle feature flags under controlled staging tests
  setFeatureFlags(providerEnabled: boolean, sandboxEnabled: boolean) {
    this.hotels_provider_enabled = providerEnabled;
    this.sandbox_mode_enabled = sandboxEnabled;
  }
}

export const hotelService = new HotelService();
