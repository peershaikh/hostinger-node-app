import { winstonLogger } from '../../middleware/logger';

export interface FlightSearchResult {
  id: string;
  airline: string;
  airlineLogoUrl?: string;
  flightNumber: string;
  departureAirport: string;
  arrivalAirport: string;
  departureTime: string;
  arrivalTime: string;
  price: number;
  currency: string;
  durationMins: number;
  stops: number;
  cabinClass: string;
}

export interface FlightSearchPayload {
  from: string; // Airport Code e.g. DEL, BOM
  to: string;   // Airport Code e.g. MAA, BLR
  date: string; // YYYY-MM-DD
  cabinClass?: string; // 'economy' | 'business' | 'first'
}

export interface FlightProvider {
  searchFlights(payload: FlightSearchPayload): Promise<FlightSearchResult[]>;
  getFlightDetails(flightId: string): Promise<FlightSearchResult | null>;
}

// ── Deterministic Mock Sandbox Provider ──
export class MockFlightProvider implements FlightProvider {
  async searchFlights(payload: FlightSearchPayload): Promise<FlightSearchResult[]> {
    // Generate highly realistic, deterministic flight listings based on city character codes
    const airlines = [
      { name: 'Air India', code: 'AI', logo: 'https://images.unsplash.com/photo-1544620347-c4fd4a3d5957?w=128' },
      { name: 'IndiGo', code: '6E', logo: 'https://images.unsplash.com/photo-1436491865332-7a61a109cc05?w=128' },
      { name: 'Vistara', code: 'UK', logo: 'https://images.unsplash.com/photo-1570710891163-6d3b5c47248b?w=128' }
    ];

    const results: FlightSearchResult[] = [];
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

  async getFlightDetails(flightId: string): Promise<FlightSearchResult | null> {
    const parts = flightId.split('_');
    if (parts[0] !== 'mock' || parts[1] !== 'fl') return null;

    const from = parts[2];
    const to = parts[3];
    const index = Number(parts[4]);
    const seed = Number(parts[5]);

    const flights = await this.searchFlights({ from, to, date: new Date().toISOString().split('T')[0] });
    return flights[index] || null;
  }
}

// ── Flight Service Coordinator with 4s Timeout Budget ──
export class FlightService {
  private activeProvider: FlightProvider;
  
  // Mandatory Governance Feature Flags (Default: FALSE)
  private flights_provider_enabled = false;
  private sandbox_mode_enabled = true; // Forces deterministic mock sandbox mode

  constructor() {
    this.activeProvider = new MockFlightProvider();
  }

  async search(payload: FlightSearchPayload): Promise<FlightSearchResult[]> {
    // 1. Feature Flag Isolation Gating
    if (!this.flights_provider_enabled) {
      winstonLogger.warn(`[FLIGHT_SERVICE] Search attempted but 'flights_provider_enabled' is FALSE. Gated.`);
      return [];
    }

    winstonLogger.info(`[FLIGHT_SERVICE] Executing search query | Sandbox=${this.sandbox_mode_enabled}`);

    try {
      // 2. Promise.race Timeout Wrapper (4000ms Budget)
      let flightTimer: NodeJS.Timeout | undefined;
      const timeoutPromise = new Promise<never>((_, reject) => {
        flightTimer = setTimeout(() => reject(new Error('PROVIDER_TIMEOUT')), 4000);
      });

      const searchPromise = this.activeProvider.searchFlights(payload);

      const results = await Promise.race([searchPromise, timeoutPromise]).finally(() => {
        if (flightTimer) clearTimeout(flightTimer);
      });

      winstonLogger.info(`[FLIGHT_SERVICE_SUCCESS] Search completed successfully.`);
      
      if (this.sandbox_mode_enabled) {
        winstonLogger.info('[TELEMETRY] sandbox_mode_served');
      }

      return results;
    } catch (err: any) {
      if (err.message === 'PROVIDER_TIMEOUT') {
        winstonLogger.error('[TELEMETRY] provider_search_timeout');
        winstonLogger.error('[TELEMETRY] degraded_mode_entered');
      }
      winstonLogger.error(`[FLIGHT_SERVICE_ERROR] Search execution failed: ${err.message}`);
      throw err;
    }
  }

  async getDetails(flightId: string): Promise<FlightSearchResult | null> {
    if (!this.flights_provider_enabled) return null;

    try {
      return await this.activeProvider.getFlightDetails(flightId);
    } catch (err: any) {
      winstonLogger.error(`[FLIGHT_SERVICE_ERROR] Detail fetch failed: ${err.message}`);
      return null;
    }
  }

  // Temporary helper to dynamically toggle feature flags under controlled staging tests
  setFeatureFlags(providerEnabled: boolean, sandboxEnabled: boolean) {
    this.flights_provider_enabled = providerEnabled;
    this.sandbox_mode_enabled = sandboxEnabled;
  }
}

export const flightService = new FlightService();
