import cron from 'node-cron';
import { winstonLogger } from '../middleware/logger';
import { renewalNotificationService, RenewalScanResult } from '../services/renewalNotificationService';

export class RenewalNotificationJob {
  private isRunning: boolean = false;

  start() {
    winstonLogger.info('[RENEWAL_JOB] Scheduled daily at 10:00 IST (04:30 UTC).');

    // Run every day at 10:00 AM IST (04:30 UTC)
    cron.schedule('30 4 * * *', async () => {
      try {
        await this.runScan();
      } catch (err: any) {
        winstonLogger.error(`[RENEWAL_JOB] Cron trigger error: ${err.message}`);
      }
    });
  }

  async runScan(): Promise<RenewalScanResult | null> {
    if (this.isRunning) {
      winstonLogger.warn('[RENEWAL_JOB] Scan already in progress, skipping duplicate invocation.');
      return null;
    }

    this.isRunning = true;
    try {
      winstonLogger.info('[RENEWAL_JOB] Executing subscription renewal scan...');
      const results = await renewalNotificationService.scanAndSendRenewalAlerts();
      winstonLogger.info(
        `[RENEWAL_JOB] Scan completed. Scanned: ${results.scanned}, Eligible: ${results.eligible}, Emails Sent: ${results.emailsSent}, Skipped: ${results.skippedAlreadySent}, Errors: ${results.errors}`
      );
      return results;
    } catch (err: any) {
      winstonLogger.error(`[RENEWAL_JOB] Exception during scan execution: ${err.message}`);
      return null;
    } finally {
      this.isRunning = false;
    }
  }
}

export const renewalNotificationJob = new RenewalNotificationJob();
