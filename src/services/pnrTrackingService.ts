import { supabase } from '../config/supabase';
import { winstonLogger } from '../middleware/logger';
import { fetchWithPriority } from '../utils/apiPriority';
import { irctcService } from './irctcService';
import { providerConfigService } from './providerConfigService';
import { rapidApiService } from './rapidApiService';
import { railRadarService } from './railRadarService';

export interface PnrRecord {
  id?: string;
  pnr_number: string;
  session_id: string;
  current_status: string;
  chart_status?: string;          // last known chart preparation state
  prediction_score?: number;
  journey_date?: string;
  last_updated?: string;
  status_changed?: boolean;
}

export class PnrTrackingService {
  private readonly TABLE_NAME = 'pnr_tracking';

  /**
   * Add or update a PNR for tracking
   */
  async trackPnr(data: Omit<PnrRecord, 'id' | 'last_updated' | 'status_changed'>) {
    try {
      const payload: Partial<PnrRecord> = {
        ...data,
        journey_date: this.normalizeDateForDb(data.journey_date), // normalize before DB write
        last_updated: new Date().toISOString(),
        status_changed: false
      };

      const { data: existing } = await supabase
        .from(this.TABLE_NAME)
        .select('id')
        .eq('pnr_number', data.pnr_number)
        .eq('session_id', data.session_id)
        .maybeSingle();

      let error;
      if (existing) {
        const { error: updateError } = await supabase
          .from(this.TABLE_NAME)
          .update(payload)
          .eq('id', existing.id);
        error = updateError;
      } else {
        const { error: insertError } = await supabase
          .from(this.TABLE_NAME)
          .insert(payload);
        error = insertError;
      }

      if (error) throw error;

      winstonLogger.info(`[PNR_TRACE] Tracked/Updated PNR ${data.pnr_number}`);
      return { success: true, pnr: data.pnr_number };
    } catch (err: any) {
      winstonLogger.error(`[PNR_TRACE] Failed for ${data.pnr_number}: ${err.message}`);
      return { success: false, error: err.message };
    }
  }

  /**
   * 🔥 FIX_7 : Fetch PNR with Strict Global Priority
   * IRCTC → RailRadar → RapidAPI → DB (if needed)
   */
  async fetchPnrWithPriority(pnr: string) {
    winstonLogger.info(`[PNR_TRACE] Starting priority fetch for PNR ${pnr}`);

    let usedApi = "UNKNOWN";

    try {
      const pnrData = await fetchWithPriority<any>({
        irctc: async () => {
          const guard = await providerConfigService.isProviderEnabled('IRCTC');
          if (guard.enabled) {
            const res = await irctcService.checkPNRStatus(pnr);
            if (res) usedApi = "IRCTC";
            return res;
          } else {
            const skipLabel = (guard.reason === 'PROVIDER_UNHEALTHY' || guard.reason === 'CIRCUIT_BREAKER_BLOCKED')
              ? '[PROVIDER_SKIPPED_UNHEALTHY]'
              : '[PROVIDER_SKIPPED_DISABLED]';
            winstonLogger.info(`${skipLabel} IRCTC | Reason: ${guard.reason}`);
            return null;
          }
        },
        railradar: async () => {
          const guard = await providerConfigService.isProviderEnabled('RAILRADAR');
          if (guard.enabled) {
            if (typeof railRadarService.getPNRStatus === 'function') {
              const res = await railRadarService.getPNRStatus(pnr);
              if (res) usedApi = "RAILRADAR";
              return res;
            } else {
              winstonLogger.warn('[PROVIDER_SKIPPED_MAPPING_ERROR] RailRadar PNR check method not found.');
              return null;
            }
          } else {
            const skipLabel = (guard.reason === 'PROVIDER_UNHEALTHY' || guard.reason === 'CIRCUIT_BREAKER_BLOCKED')
              ? '[PROVIDER_SKIPPED_UNHEALTHY]'
              : '[PROVIDER_SKIPPED_DISABLED]';
            winstonLogger.info(`${skipLabel} RAILRADAR | Reason: ${guard.reason}`);
            return null;
          }
        },
        rapid: async () => {
          const guard = await providerConfigService.isProviderEnabled('RAPIDAPI');
          if (guard.enabled) {
            const res = await rapidApiService.getPNRStatus(pnr);
            if (res) usedApi = "RAPIDAPI";
            return res;
          } else {
            const skipLabel = (guard.reason === 'PROVIDER_UNHEALTHY' || guard.reason === 'CIRCUIT_BREAKER_BLOCKED')
              ? '[PROVIDER_SKIPPED_UNHEALTHY]'
              : '[PROVIDER_SKIPPED_DISABLED]';
            winstonLogger.info(`${skipLabel} RAPIDAPI | Reason: ${guard.reason}`);
            return null;
          }
        },
        db: async () => {
          winstonLogger.info("[DB_FALLBACK_USED] PNR - Using cached DB record");
          const twentyFourHoursAgo = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
          const { data } = await supabase
            .from(this.TABLE_NAME)
            .select('*')
            .eq('pnr_number', pnr)
            .gte('last_updated', twentyFourHoursAgo)
            .order('last_updated', { ascending: false })
            .limit(1)
            .maybeSingle();
          return data;
        }
      });

      if (pnrData) {
        winstonLogger.info(`[PNR_SUCCESS] ${pnr} | Source: ${usedApi}`);
        return { ...pnrData, api_used: usedApi };
      }

      throw new Error("No PNR data from any source");

    } catch (err: any) {
      winstonLogger.error(`[PNR_FAIL] ${pnr}: ${err.message}`);

      // Final DB fallback
      try {
        const twentyFourHoursAgo = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
        const { data } = await supabase
          .from(this.TABLE_NAME)
          .select('*')
          .eq('pnr_number', pnr)
          .gte('last_updated', twentyFourHoursAgo)
          .order('last_updated', { ascending: false })
          .limit(1)
          .maybeSingle();

        if (data) {
          winstonLogger.info(`[PNR_DB_FALLBACK] Using last cached record for ${pnr}`);
          return { ...data, api_used: "DATABASE_FALLBACK" };
        }
      } catch (dbErr) {
        winstonLogger.warn(`[PNR_DB_FALLBACK_FAILED] ${pnr}`);
      }

      return {
        pnr_number: pnr,
        current_status: "PNR status temporarily unavailable",
        prediction_score: null,
        api_used: "FAILED"
      };
    }
  }

  // ==================== Other Methods (Unchanged) ====================

  async upsertPnr(data: Omit<PnrRecord, 'id' | 'last_updated' | 'status_changed'>) {
    return this.trackPnr(data);
  }

  private parseDate(dateStr: string): Date | null {
    if (!dateStr || dateStr === 'N/A') return null;

    // Extract date portion if time is appended (e.g. "08/06/26 8:05 PM" -> "08/06/26")
    const datePart = dateStr.trim().split(/\s+/)[0];

    // Split on slashes or hyphens
    const parts = datePart.split(/[-/]/);
    if (parts.length === 3) {
      let dd, mm, yyyy;

      if (parts[0].length === 4) {
        // Format: YYYY-MM-DD or YYYY/MM/DD
        yyyy = parts[0];
        mm = parts[1].padStart(2, '0');
        dd = parts[2].padStart(2, '0');
      } else {
        // Format: DD-MM-YYYY, DD/MM/YYYY, DD-MM-YY
        dd = parts[0].padStart(2, '0');
        mm = parts[1].padStart(2, '0');
        const yy = parts[2];
        yyyy = yy.length === 2 ? `20${yy}` : yy;
      }
      
      const d = new Date(`${yyyy}-${mm}-${dd}T00:00:00Z`);
      if (!isNaN(d.getTime())) {
        return d;
      }
    }

    const d = new Date(dateStr);
    return isNaN(d.getTime()) ? null : d;
  }

  /**
   * Converts any recognized journey date string to a Postgres-safe "YYYY-MM-DD" string.
   * Returns undefined (field omitted) when the value is absent, "N/A", or unparseable.
   * Handles: DD/MM/YY H:MM AM|PM, DD/MM/YYYY, YYYY-MM-DD, ISO-8601.
   */
  private normalizeDateForDb(raw: string | undefined | null): string | undefined {
    if (!raw || raw === 'N/A') return undefined;
    const parsed = this.parseDate(raw);
    if (!parsed || isNaN(parsed.getTime())) return undefined;
    return parsed.toISOString().split('T')[0]; // always "YYYY-MM-DD"
  }


  async listBySession(sessionId: string): Promise<PnrRecord[]> {
    try {
      const { data, error } = await supabase
        .from(this.TABLE_NAME)
        .select('*')
        .eq('session_id', sessionId)
        .order('last_updated', { ascending: false });

      if (error) throw error;
      
      const now = Date.now();
      const active = (data || []).filter((record: any) => {
        const status = (record.current_status || '').toUpperCase();
        if (status.includes('FLUSHED') || status.includes('NOT FOUND') || status.includes('DELETED')) {
          return false; // Terminal states should never be shown in active UI tracking
        }

        // ── Case 1: No journey date stored ──
        // These used to be shown forever; now age them out after 7 days by last_updated.
        if (!record.journey_date || record.journey_date === 'N/A') {
          if (!record.last_updated) return true; // no timestamps at all — keep
          const hoursSinceUpdate = (now - new Date(record.last_updated).getTime()) / (1000 * 60 * 60);
          return hoursSinceUpdate < 168; // 7 days = 168 hours
        }

        // ── Case 2: journey_date present but unparseable ──
        const d = this.parseDate(record.journey_date);
        if (!d) {
          // Fallback: expire by last_updated (7 days)
          if (!record.last_updated) return true;
          const hoursSinceUpdate = (now - new Date(record.last_updated).getTime()) / (1000 * 60 * 60);
          return hoursSinceUpdate < 168;
        }

        // ── Case 3: Valid journey date — keep existing 96h behaviour ──
        const hoursSinceJourney = (now - d.getTime()) / (1000 * 60 * 60);
        return hoursSinceJourney < 96;
      });

      
      return active as PnrRecord[];
    } catch (err: any) {
      winstonLogger.error(`[PNR_LIST] Error for session ${sessionId}: ${err.message}`);
      return [];
    }
  }

  async clearChangeFlag(sessionId: string): Promise<void> {
    try {
      const { error } = await supabase
        .from(this.TABLE_NAME)
        .update({ status_changed: false })
        .eq('session_id', sessionId);

      if (error) throw error;
      winstonLogger.info(`[PNR_CLEAR] Reset flags for session ${sessionId}`);
    } catch (err: any) {
      winstonLogger.error(`[PNR_CLEAR] Failed for ${sessionId}: ${err.message}`);
    }
  }

  async getByPnr(sessionId: string, pnrNumber: string): Promise<PnrRecord | null> {
    try {
      const { data, error } = await supabase
        .from(this.TABLE_NAME)
        .select('*')
        .eq('session_id', sessionId)
        .eq('pnr_number', pnrNumber)
        .maybeSingle();

      if (error) throw error;
      return data as PnrRecord | null;
    } catch (err: any) {
      if (err.code === 'PGRST116') return null;
      winstonLogger.error(`[PNR_GET] Failed for ${pnrNumber}: ${err.message}`);
      return null;
    }
  }

  async updatePnrStatus(
    sessionId: string,
    pnrNumber: string,
    currentStatus: string,
    predictionScore?: number,
    journeyDate?: string,
    chartStatus?: string
  ): Promise<boolean> {
    try {
      const updatePayload: any = {
        current_status: currentStatus,
        prediction_score: predictionScore,
        last_updated: new Date().toISOString(),
        status_changed: true
      };

      const safeJourneyDate = this.normalizeDateForDb(journeyDate);
      if (safeJourneyDate) {
        updatePayload.journey_date = safeJourneyDate; // normalized to "YYYY-MM-DD"
      }

      if (chartStatus) {
        updatePayload.chart_status = chartStatus;
      }

      const { error } = await supabase
        .from(this.TABLE_NAME)
        .update(updatePayload)
        .eq('session_id', sessionId)
        .eq('pnr_number', pnrNumber);

      if (error) throw error;
      return true;
    } catch (err: any) {
      winstonLogger.error(`[PNR_UPDATE] Failed for ${pnrNumber}: ${err.message}`);
      return false;
    }
  }
}

export const pnrTrackingService = new PnrTrackingService();