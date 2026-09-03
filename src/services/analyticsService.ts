import { UniversalEventNames, UNIVERSAL_EVENT_NAME_SET } from '../constants/eventTaxonomy';
import { supabase } from '../config/supabase';
import { winstonLogger } from '../middleware/logger';
import { universalEventEmitter } from './universalEventEmitter';

export interface AnalyticsEvent {
  event_type: string;
  pnr?: string | null;
  metadata: Record<string, unknown>;
  timestamp: string;
}

export class AnalyticsService {
  private readonly SEARCH_RPC = 'increment_search_popularity';
  private readonly HUB_RPC = 'increment_hub_analytics';
  private readonly EVENTS_TABLE = 'analytics_events';

  /**
   * Logs a search query to identify popular routes
   * Uses atomic RPC increment (no race conditions)
   */
  async logSearch(source: string, destination: string): Promise<boolean> {
    if ((global as any).SYSTEM_MODE === 'MODE_A') return false;
    try {
      const s = source.toUpperCase();
      const d = destination.toUpperCase();

      const { error } = await supabase.rpc(this.SEARCH_RPC, {
        p_source: s,
        p_destination: d
      });

      if (error) {
        if (error.code === '42P01' || error.code === '42883' || error.code === 'PGRST202') {
          winstonLogger.debug(`[ANALYTICS] RPC ${this.SEARCH_RPC} or table missing (${error.code}). Skipping.`);
          return false;
        }
        throw error;
      }

      winstonLogger.debug(`[ANALYTICS] Search logged: ${s} → ${d}`);
      return true;
    } catch (err: any) {
      if (err?.code === 'PGRST202' || err?.message?.includes('PGRST202') || err?.message?.includes('schema cache')) {
        winstonLogger.debug(`[ANALYTICS] RPC ${this.SEARCH_RPC} missing in schema cache. Skipping.`);
        return false;
      }
      winstonLogger.error(`[ANALYTICS] logSearch failed (${source}→${destination}): ${err.message}`);
      return false;
    }
  }

  /**
   * Logs successful split-journey hub usage for intelligence layer feedback
   */
  async logHubSuccess(hubName: string): Promise<boolean> {
    if ((global as any).SYSTEM_MODE === 'MODE_A') return false;
    try {
      const hub = hubName.toUpperCase();

      const { error } = await supabase.rpc(this.HUB_RPC, {
        p_hub: hub
      });

      if (error) {
        if (error.code === '42P01' || error.code === '42883' || error.code === 'PGRST202') {
          winstonLogger.debug(`[ANALYTICS] RPC ${this.HUB_RPC} or table missing (${error.code}). Skipping.`);
          return false;
        }
        throw error;
      }

      winstonLogger.debug(`[ANALYTICS] Hub success logged: ${hub}`);
      return true;
    } catch (err: any) {
      if (err?.code === 'PGRST202' || err?.message?.includes('PGRST202') || err?.message?.includes('schema cache')) {
        winstonLogger.debug(`[ANALYTICS] RPC ${this.HUB_RPC} missing in schema cache. Skipping.`);
        return false;
      }
      winstonLogger.error(`[ANALYTICS] logHubSuccess failed (${hubName}): ${err.message}`);
      return false;
    }
  }

  /**
   * Internal telemetry for system health
   * (Failovers, Quota hits, Rewards, Engine events, etc.)
   */
  async trackEvent(
    eventType: string,
    pnr?: string | null,
    metadata: Record<string, unknown> = {}
  ): Promise<boolean> {
    if ((global as any).SYSTEM_MODE === 'MODE_A') return false;
    try {
      const sessionId = (metadata?.session_id || metadata?.sessionId || metadata?.userId || metadata?.user_id || null) as string | null;

      // 1. Dual-emit into canonical universal event stream
      const normalizedName = eventType.toLowerCase().replace(/[\s-]+/g, '_');
      const canonicalName = UNIVERSAL_EVENT_NAME_SET.has(normalizedName)
        ? (normalizedName as any)
        : UniversalEventNames.NOTIFICATION_SENT;

      universalEventEmitter.emit({
        eventName: canonicalName,
        guestId: sessionId || undefined,
        userId: (metadata?.user_id || metadata?.userId || null) as string | null,
        mode: 'rail',
        metadata: {
          ...metadata,
          original_event_type: eventType,
          pnr: pnr || undefined
        }
      });

      // 2. Legacy table write for backward compatibility
      const dbPayload = {
        event_type: eventType,
        session_id: sessionId,
        user_id: (metadata?.user_id || metadata?.userId || null) as string | null,
        event_data: {
          metadata: metadata || {},
          payload: {
            pnr: pnr || null,
            client_timestamp: new Date().toISOString()
          }
        }
      };

      // Non-blocking fire-and-forget DB write
      Promise.resolve(
        supabase
          .from(this.EVENTS_TABLE)
          .insert([dbPayload])
      )
        .then(({ error }) => {
          if (error) {
            if (error.code === '42P01' || error.code === '42703' || error.code === 'PGRST204' || error.message?.includes('schema cache')) {
              winstonLogger.debug(`[ANALYTICS] Table ${this.EVENTS_TABLE} schema note (${error.code}): ${error.message}`);
            } else {
              winstonLogger.debug(`[TELEMETRY_FAIL] ${eventType} DB write note: ${error.message}`);
            }
          } else {
            winstonLogger.debug(`[TELEMETRY] Event tracked successfully: ${eventType}`);
          }
        })
        .catch((err: any) => {
          winstonLogger.debug(`[TELEMETRY_EXCEPTION] ${eventType} background write note: ${err.message}`);
        });

      return true;
    } catch (err: any) {
      winstonLogger.debug(`[TELEMETRY_FAIL] ${eventType}: ${err.message}`);
      return false;
    }
  }
}

export const analyticsService = new AnalyticsService();