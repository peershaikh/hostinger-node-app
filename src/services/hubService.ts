import { ALL_HUBS, GLOBAL_HUBS, HUB_REGIONS } from '../constants/hubData';
import { winstonLogger } from '../middleware/logger';

export class HubService {
  /**
   * Selects optimal hubs between source and destination with smart prioritization.
   * Priority Order:
   * 1. Regional hubs from source region
   * 2. Regional hubs from destination region
   * 3. Other regional hubs
   * 4. Global fallback hubs (if requested)
   */
  async selectHubs(
    source: string,
    destination: string,
    useFallback: boolean = false
  ): Promise<string[]> {
    const s = source.toUpperCase().trim();
    const d = destination.toUpperCase().trim();

    winstonLogger.info(`[HUB] Selecting hubs for ${s} → ${d}`);

    // Early return for fallback mode
    if (useFallback) {
      const fallbackHubs = GLOBAL_HUBS.filter(
        (h) => !s.includes(h) && !d.includes(h)
      );
      winstonLogger.info(`[HUB] Using Global Fallback: ${fallbackHubs.join(', ')}`);
      return fallbackHubs;
    }

    // Detect regions
    const sourceRegion = this.detectRegion(s);
    const destRegion = this.detectRegion(d);

    winstonLogger.debug(
      `[HUB] Detected regions → Source: ${sourceRegion || 'Unknown'}, Destination: ${destRegion || 'Unknown'}`
    );

    if (!sourceRegion && !destRegion) {
      winstonLogger.warn(`[HUB] No regions detected for ${s} → ${d}. Falling back to global hubs.`);
      return GLOBAL_HUBS.filter((h) => !s.includes(h) && !d.includes(h));
    }

    // Filter relevant hubs
    let relevantHubs = ALL_HUBS.filter((hub) => {
      const isSourceRegion = hub.region === sourceRegion;
      const isDestRegion = hub.region === destRegion;
      const isCentral = hub.region === 'CENTRAL';
      const isStationItself = s.includes(hub.name) || d.includes(hub.name);

      return (isSourceRegion || isDestRegion || isCentral) && !isStationItself;
    });

    // Smart sorting: Source region first, then destination, then others
    relevantHubs.sort((a, b) => {
      if (a.region === sourceRegion && b.region !== sourceRegion) return -1;
      if (b.region === sourceRegion && a.region !== sourceRegion) return 1;
      if (a.region === destRegion && b.region !== destRegion) return -1;
      if (b.region === destRegion && a.region !== destRegion) return 1;
      return 0;
    });

    // Take top 10 hubs
    const selectedHubs = relevantHubs.slice(0, 10).map((h) => h.name);

    winstonLogger.info(`[HUB] Selected ${selectedHubs.length} hubs: ${selectedHubs.join(', ')}`);

    return selectedHubs;
  }

  /**
   * Returns nearby major hubs for a given station (useful for recommendations).
   */
  getNearbyHubs(stationName: string): string[] {
    const normalized = stationName.toUpperCase().trim();
    const region = this.detectRegion(normalized);

    if (region) {
      const regionalHubs = ALL_HUBS.filter((h) => h.region === region).map((h) => h.name);
      winstonLogger.debug(`[HUB] Found ${regionalHubs.length} nearby hubs for ${stationName} in region ${region}`);
      return regionalHubs;
    }

    // Ultimate fallback
    winstonLogger.debug(`[HUB] No region found for ${stationName}. Using global hubs.`);
    return [...GLOBAL_HUBS];
  }

  /**
   * Detects region based on station name patterns.
   * Returns region code or null if no match.
   */
  detectRegion(stationName: string): string | null {
    if (!stationName) return null;

    const raw = stationName.toUpperCase().trim();
    // 1. Extract bracketed station code if formatted as 'Station Name (CODE)'
    const bracketMatch = raw.match(/\(([A-Za-z0-9]{2,5})\)/);
    const stationCode = bracketMatch ? bracketMatch[1] : (raw.length <= 5 ? raw : null);

    // 2. Strict exact canonical station code match (avoids substring collisions like HWH->HW, SURAT->SUR, GDG->GD)
    if (stationCode) {
      for (const [region, patterns] of Object.entries(HUB_REGIONS)) {
        if (patterns.some((pattern) => pattern.toUpperCase().trim() === stationCode)) {
          return region;
        }
      }
    }

    // 3. Exact city or multi-word station name token match (length > 4 to prevent short-code collisions)
    for (const [region, patterns] of Object.entries(HUB_REGIONS)) {
      if (patterns.some((pattern) => {
        const p = pattern.toUpperCase().trim();
        if (p.length <= 4) return false; // Skip short codes in full-text scan
        return raw === p || raw.startsWith(p + ' ') || raw.endsWith(' ' + p) || raw.includes(' ' + p + ' ');
      })) {
        return region;
      }
    }

    return null;
  }

  /**
   * Validates if a station name belongs to any known region.
   */
  isKnownRegion(stationName: string): boolean {
    return this.detectRegion(stationName.toUpperCase()) !== null;
  }

  /**
   * Get all hubs for a specific region (useful for admin or analytics).
   */
  getHubsByRegion(region: string): string[] {
    return ALL_HUBS.filter((h) => h.region === region).map((h) => h.name);
  }

  /**
   * Get list of all available regions.
   */
  getAllRegions(): string[] {
    return Object.keys(HUB_REGIONS);
  }
}

export const hubService = new HubService();