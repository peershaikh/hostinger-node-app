import { supabase } from '../config/supabase';
import { winstonLogger } from '../middleware/logger';
import { analyticsService } from './analyticsService';
import { cacheService } from './cacheService';
import { pnrTrackingService } from './pnrTrackingService';
import { irctcService } from './irctcService';
import { alertService } from './alertService';
import { normalizeRawPnr } from '../utils/pnrNormalizer';
import { feedbackSyncService } from './feedbackSyncService';

export class PnrWorker {
  private timer: NodeJS.Timeout | null = null;
  private isProcessing = false;
  private lastCleanupTime = 0;

  private readonly POLL_INTERVAL_MS = 5 * 60 * 1000; // 5 minutes

  /**
   * Starts the background PNR polling worker
   */
  start() {
    if (this.timer) return;

    winstonLogger.info('🚀 PNR Adaptive Worker: Starting background engine');
    this.run();
  }

  stop() {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
      winstonLogger.info('🛑 PNR Worker stopped');
    }
  }

  private async run() {
    try {
      // Sync offline feedbacks
      try {
        await feedbackSyncService.syncAllFallbacks();
      } catch (syncErr: any) {
        winstonLogger.error(`[PNR_WORKER] Feedback sync failed: ${syncErr.message}`);
      }

      await this.processAllPnrs();

      // Daily cleanup checks (run every 12 hours)
      const now = Date.now();
      if (now - this.lastCleanupTime > 12 * 60 * 60 * 1000) {
        await this.cleanupExpiredPnrs();
        this.lastCleanupTime = now;
      }
    } catch (err: any) {
      winstonLogger.error(`[PNR_WORKER] Critical error in run cycle: ${err.message}`);
    } finally {
      // Schedule next run
      this.timer = setTimeout(() => this.run(), this.POLL_INTERVAL_MS);
    }
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


  private async processAllPnrs() {
    if (this.isProcessing) {
      winstonLogger.debug('[PNR_WORKER] Already processing - skipping this cycle');
      return;
    }

    this.isProcessing = true;
    const startTime = Date.now();

    try {
      const { data: pnrs, error } = await supabase
        .from('pnr_tracking')
        .select('*')
        .order('last_updated', { ascending: true }); // oldest first for fairness

      if (error) {
        if (error.code !== '42P01') throw error;
        winstonLogger.warn('[PNR_WORKER] pnr_tracking table not found');
        return;
      }

      if (!pnrs || pnrs.length === 0) {
        winstonLogger.debug('[PNR_WORKER] No PNRs to process');
        return;
      }

      winstonLogger.info(`[PNR_WORKER] Checking ${pnrs.length} tracked PNRs...`);

      let processed = 0;
      let changed = 0;

      for (const record of pnrs) {
        if (await this.shouldPoll(record)) {
          const statusChanged = await this.updatePnrStatus(record);
          if (statusChanged) changed++;
          processed++;

          // Small delay to be gentle on API quota
          if (processed % 5 === 0) {
            await new Promise(r => setTimeout(r, 800));
          }
        }
      }

      const duration = Date.now() - startTime;
      winstonLogger.info(`[PNR_WORKER] Cycle completed | Processed: ${processed} | Changes: ${changed} | Duration: ${duration}ms`);

      // Track telemetry
      await analyticsService.trackEvent('pnr_worker_cycle', null, {
        processed,
        changes: changed,
        duration_ms: duration
      });

    } catch (err: any) {
      winstonLogger.error(`[PNR_WORKER] Process cycle failed: ${err.message}`);
    } finally {
      this.isProcessing = false;
    }
  }

  /**
   * Intelligent polling decision based on journey proximity and last update
   */
  private async shouldPoll(record: any): Promise<boolean> {
    const cacheKey = `pnr_poll_${record.pnr_number}`;
    if (cacheService.get(cacheKey)) return false; // recently polled

    const lastUpdated = new Date(record.last_updated || 0).getTime();
    const now = Date.now();
    const minutesSinceUpdate = (now - lastUpdated) / (1000 * 60);

    const journeyDate = this.parseDate(record.journey_date);
    const hoursToJourney = journeyDate
      ? (journeyDate.getTime() - now) / (1000 * 60 * 60)
      : 999;

    // Expiry logic: do not poll if journey was completed >96h ago (handles multi-day trains)
    if (journeyDate && hoursToJourney < -96) {
      return false;
    }

    // Priority logic:
    if (hoursToJourney >= 0 && hoursToJourney <= 24) {
      // Near journey → poll more frequently
      return minutesSinceUpdate > 45; // ~every 45 mins when close
    }

    if (hoursToJourney <= 72) {
      return minutesSinceUpdate > 90; // every 1.5 hours
    }

    // Far journey or no date
    return minutesSinceUpdate > 180; // every 3 hours
  }

  /**
   * Update single PNR using service layer
   */
  private async updatePnrStatus(record: any): Promise<boolean> {
    try {
      const cacheKey = `pnr_status_${record.pnr_number}`;
      const cached = cacheService.get(cacheKey);

      if (cached) {
        winstonLogger.debug(`[PNR_WORKER] Cache hit for ${record.pnr_number}`);
        return false;
      }

      winstonLogger.info(`[PNR_WORKER] Fetching latest status for PNR ${record.pnr_number} with priority`);

      const latestData = await pnrTrackingService.fetchPnrWithPriority(record.pnr_number);

      if (!latestData) {
        winstonLogger.warn(`[PNR_WORKER] No data returned for ${record.pnr_number}`);
        return false;
      }

      const normalized = normalizeRawPnr(latestData);
      const newStatus = this.summarizeStatus(normalized);
      const hasChanged = newStatus !== record.current_status;

      const latestJourneyDate = normalized.journey_date;

      // ── Chart Prepared Detection ─────────────────────────────────────────────
      // normalizeRawPnr always produces a chart_status string. Compare against
      // the last stored value (record.chart_status) to detect the unprepared →
      // prepared transition exactly once.
      const newChartStatus = normalized.chart_status || 'Chart Not Prepared';
      const oldChartStatus = (record.chart_status as string) || 'Chart Not Prepared';

      const isNowPrepared =
        newChartStatus.toUpperCase().includes('PREPARED') &&
        !newChartStatus.toUpperCase().includes('NOT PREPARED');
      const wasPrepared =
        oldChartStatus.toUpperCase().includes('PREPARED') &&
        !oldChartStatus.toUpperCase().includes('NOT PREPARED');
      const chartJustPrepared = isNowPrepared && !wasPrepared;
      // ────────────────────────────────────────────────────────────────────────

      const success = await pnrTrackingService.updatePnrStatus(
        record.session_id,
        record.pnr_number,
        newStatus,
        latestData.prediction_score || undefined,
        latestJourneyDate,
        newChartStatus   // persist so next cycle compares correctly
      );

      if (success) {
        // Cache for 10 minutes to prevent rapid re-polling
        cacheService.set(cacheKey, true, 10);

        if (hasChanged) {
          winstonLogger.info(`[PNR_WORKER] ✅ STATUS CHANGE: ${record.pnr_number} → ${newStatus}`);
          await analyticsService.trackEvent('pnr_status_changed', record.pnr_number, {
            old_status: record.current_status,
            new_status: newStatus
          });
          await alertService.triggerWaitlistAlert(
            record.session_id,
            record.pnr_number,
            record.current_status,
            newStatus
          );
        } else {
          winstonLogger.debug(`[PNR_WORKER] No change for ${record.pnr_number}`);
        }

        // ── Chart Prepared alert (fires independently of status change) ────────
        if (chartJustPrepared) {
          winstonLogger.info(`[PNR_WORKER] 📋 CHART PREPARED: ${record.pnr_number} | ${newChartStatus}`);
          await analyticsService.trackEvent('pnr_chart_prepared', record.pnr_number, {
            chart_status: newChartStatus
          });
          const totalPassengers = normalized.passengers?.length || 0;
          const isCnfStatus = (s: string) => {
            const upper = (s || '').toUpperCase();
            return upper.includes('CNF') || upper.includes('CONFIRM') || upper.includes('CONFIRMED') || (upper.includes('-') && !upper.includes('WL') && !upper.includes('RAC'));
          };
          const cnfCount = normalized.passengers?.filter((p: any) => isCnfStatus(p.current_status || p.booking_status)).length || 0;

          await alertService.triggerChartPreparedAlert(
            record.session_id,
            record.pnr_number,
            newChartStatus,
            cnfCount,
            totalPassengers
          );
        }
        // ──────────────────────────────────────────────────────────────────────
      }

      return hasChanged;
    } catch (err: any) {
      winstonLogger.warn(`[PNR_WORKER] Failed to update ${record.pnr_number}: ${err.message}`);
      return false;
    }
  }

  private async cleanupExpiredPnrs() {
    try {
      winstonLogger.info(`[PNR_WORKER] Starting expired PNR cleanup...`);
      const { data: pnrs, error } = await supabase.from('pnr_tracking').select('id, journey_date, last_updated, current_status');

      if (error) {
        winstonLogger.error(`[PNR_WORKER] Cleanup fetch failed: ${error.message}`);
        return;
      }

      if (!pnrs || pnrs.length === 0) return;

      const now = Date.now();
      const expiredIds: string[] = [];

      for (const record of pnrs) {
        // ── Case 0: Terminal Statuses (Flushed / Not Found) ──
        const status = (record.current_status || '').toUpperCase();
        if (status.includes('FLUSHED') || status.includes('NOT FOUND') || status.includes('DELETED')) {
          expiredIds.push(record.id);
          continue;
        }

        // ── Case 1: No journey date — expire by last_updated (7 days) ──
        if (!record.journey_date || record.journey_date === 'N/A') {
          if (record.last_updated) {
            const hrsOld = (now - new Date(record.last_updated).getTime()) / (1000 * 60 * 60);
            if (hrsOld > 168) expiredIds.push(record.id);
          }
          continue;
        }

        // ── Case 2: Unparseable date — expire by last_updated (7 days) ──
        const d = this.parseDate(record.journey_date);
        if (!d) {
          if (record.last_updated) {
            const hrsOld = (now - new Date(record.last_updated).getTime()) / (1000 * 60 * 60);
            if (hrsOld > 168) expiredIds.push(record.id);
          }
          continue;
        }

        // ── Case 3: Valid journey date — existing 96h behaviour ──
        const hoursSinceJourney = (now - d.getTime()) / (1000 * 60 * 60);
        if (hoursSinceJourney > 96) {
          expiredIds.push(record.id);
        }
      }

      if (expiredIds.length > 0) {
        winstonLogger.info(`[PNR_WORKER] Deleting ${expiredIds.length} expired PNRs...`);
        // Supabase limits IN clauses, chunk if needed. Assuming <1000 for now.
        const { error: delError } = await supabase
          .from('pnr_tracking')
          .delete()
          .in('id', expiredIds);

        if (delError) {
          winstonLogger.error(`[PNR_WORKER] Cleanup deletion failed: ${delError.message}`);
        } else {
          winstonLogger.info(`[PNR_WORKER] Expired PNR cleanup completed successfully`);
        }
      } else {
        winstonLogger.info(`[PNR_WORKER] No expired PNRs to clean up`);
      }
    } catch (err: any) {
      winstonLogger.error(`[PNR_WORKER] Error during expired PNR cleanup: ${err.message}`);
    }
  }

  private summarizeStatus(data: any): string {
    if (!data?.passengers?.length) return "UNKNOWN";

    // Most reliable way - use first passenger's current status
    const passenger = data.passengers[0];
    return passenger.current_status || "UNKNOWN";
  }
}

export const pnrWorker = new PnrWorker();