import { winstonLogger } from '../middleware/logger';
import { supabase } from '../config/supabase';

export interface AlertTrigger {
  userId?: string | null;
  type: 'DELAY' | 'WL_CONFIRM' | 'SPLIT_UPDATE' | 'PLATFORM_CHANGE' | 'CHART_PREPARED' | 'WAKEUP_ALARM';
  metadata: Record<string, any>;
  priority: 'HIGH' | 'MEDIUM' | 'LOW';
}

const isUuid = (str: string) => /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(str);

export class AlertService {
  /**
   * Evaluates conditions and prepares alerts for processing.
   * This is the backend architecture foundation for Step 6.
   * Push notifications are intentionally NOT implemented here yet.
   */
  async queueAlert(trigger: AlertTrigger): Promise<void> {
    try {
      // 1. Validate Alert Trigger
      if (!trigger.type) {
        throw new Error('Invalid alert payload: type is required');
      }

      const userIdVal = trigger.userId || null;
      let resolvedUserId: string | null = null;
      let resolvedDeviceId: string | null = null;

      if (userIdVal) {
        if (isUuid(userIdVal)) {
          resolvedUserId = userIdVal;
        } else {
          resolvedDeviceId = userIdVal;
        }
      } else if (trigger.metadata?.device_id) {
        resolvedDeviceId = trigger.metadata.device_id;
      }

      if (!resolvedUserId && !resolvedDeviceId) {
        throw new Error('Alert payload must have either userId or device_id in metadata');
      }

      // 2. Deduplication check (last 12 hours)
      try {
        const twelveHoursAgo = new Date(Date.now() - 12 * 60 * 60 * 1000).toISOString();
        let dbQuery = supabase
          .from('smart_alerts')
          .select('id, metadata')
          .eq('alert_type', trigger.type)
          .gt('created_at', twelveHoursAgo);

        if (resolvedUserId) {
          dbQuery = dbQuery.eq('user_id', resolvedUserId);
        } else {
          dbQuery = dbQuery.is('user_id', null);
        }

        const { data: existingAlerts, error: fetchError } = await dbQuery;

        if (!fetchError && existingAlerts && existingAlerts.length > 0) {
          const isDuplicate = existingAlerts.some((existing: any) => {
            const extMeta = existing.metadata || {};
            const trigMeta = trigger.metadata || {};

            if (resolvedDeviceId && extMeta.device_id !== resolvedDeviceId) {
              return false;
            }

            if (trigger.type === 'DELAY') {
              return extMeta.trainNo === trigMeta.trainNo && extMeta.currentDelayMins === trigMeta.currentDelayMins;
            }
            if (trigger.type === 'WL_CONFIRM') {
              return extMeta.pnr === trigMeta.pnr && extMeta.newStatus === trigMeta.newStatus;
            }
            if (trigger.type === 'CHART_PREPARED') {
              return extMeta.pnr === trigMeta.pnr;
            }
            if (trigger.type === 'PLATFORM_CHANGE') {
              return extMeta.trainNo === trigMeta.trainNo && extMeta.station === trigMeta.station && extMeta.newPlatform === trigMeta.newPlatform;
            }
            return false;
          });

          if (isDuplicate) {
            winstonLogger.info(`[ALERT_SERVICE] Deduplicated duplicate ${trigger.type} alert for user/device.`);
            return;
          }
        }
      } catch (dedupErr: any) {
        winstonLogger.warn(`[ALERT_SERVICE] Deduplication check failed: ${dedupErr.message}`);
      }

      // 3. Prepare database payload for queued processing
      const finalMetadata = {
        ...trigger.metadata,
        ...(resolvedDeviceId ? { device_id: resolvedDeviceId } : {})
      };

      const payload = {
        user_id: resolvedUserId,
        alert_type: trigger.type,
        metadata: finalMetadata,
        priority: trigger.priority,
        status: 'PENDING',
        created_at: new Date().toISOString()
      };

      // 4. Store in Supabase for async worker processing
      const { error } = await supabase.from('smart_alerts').insert([payload]);
      
      if (error && error.code !== '42P01') {
         winstonLogger.error(`[ALERT_SERVICE] Database error queueing alert: ${error.message}`);
      } else if (error && error.code === '42P01') {
         // Fallback logging if table doesn't exist yet
         winstonLogger.info(`[ALERT_SERVICE_FALLBACK] Alert queued in-memory: ${JSON.stringify(payload)}`);
      } else {
         winstonLogger.info(`[ALERT_SERVICE] Queued ${trigger.type} alert for user ${resolvedUserId || resolvedDeviceId}`);
      }

    } catch (err: any) {
      winstonLogger.error(`[ALERT_SERVICE] Failed to queue alert: ${err.message}`);
    }
  }

  // --- Domain Specific Alert Triggers ---

  async triggerTrainDelayAlert(userId: string, trainNo: string, currentDelayMins: number) {
    if (currentDelayMins > 30) {
       await this.queueAlert({
         userId,
         type: 'DELAY',
         priority: currentDelayMins > 120 ? 'HIGH' : 'MEDIUM',
         metadata: { trainNo, currentDelayMins, message: `Train ${trainNo} is delayed by ${currentDelayMins} minutes.` }
       });
    }
  }

  async triggerWaitlistAlert(userId: string, pnr: string, oldStatus: string, newStatus: string) {
    if (oldStatus.includes('WL') && (newStatus.includes('CNF') || newStatus.includes('RAC'))) {
       await this.queueAlert({
         userId,
         type: 'WL_CONFIRM',
         priority: 'HIGH',
         metadata: { pnr, oldStatus, newStatus, message: `Great news! PNR ${pnr} has moved to ${newStatus}.` }
       });
    }
  }

  async triggerPlatformChangeAlert(userId: string, trainNo: string, station: string, oldPlatform: string, newPlatform: string) {
    if (oldPlatform !== newPlatform) {
       await this.queueAlert({
         userId,
         type: 'PLATFORM_CHANGE',
         priority: 'HIGH',
         metadata: { trainNo, station, oldPlatform, newPlatform, message: `Platform changed to ${newPlatform} at ${station}.` }
       });
    }
  }

  /**
   * Fires when chart_status transitions from unprepared → prepared.
   * This is the most actionable notification for WL ticket holders.
   */
  async triggerChartPreparedAlert(userId: string, pnr: string, chartStatus: string, cnfCount?: number, totalPassengers?: number) {
    let message = `The chart for PNR ${pnr} is now prepared. Your final seat/berth allocation is locked in.`;
    if (cnfCount !== undefined && totalPassengers !== undefined) {
      if (cnfCount === totalPassengers) {
        message = "All passengers confirmed.";
      } else if (cnfCount > 0 && cnfCount < totalPassengers) {
        message = `Chart Prepared. ${cnfCount} of ${totalPassengers} passengers are confirmed. Remaining passengers are waitlisted.`;
      } else {
        message = "No passengers confirmed.";
      }
    }

    await this.queueAlert({
      userId,
      type: 'CHART_PREPARED',
      priority: 'HIGH',
      metadata: {
        pnr,
        chartStatus,
        title: `📋 Chart Prepared — PNR ${pnr}`,
        message
      }
    });
  }
}

export const alertService = new AlertService();
