import { supabase } from '../config/supabase';
import { winstonLogger } from '../middleware/logger';

interface PNRHistoryRecord {
    pnr: string;
    train_no: string;
    train_name: string;
    source: string;
    destination: string;
    class: string;
    booking_status: string;
    current_status: string;
    chart_prepared: boolean;
    prediction_chance: string;
    checked_at: string;
    final_status: string;
}

export class PnrHistoryService {
    /**
     * Save PNR check result to history
     */
    async savePnrHistory(pnrData: any): Promise<void> {
        try {
            const historyRecord: PNRHistoryRecord = {
                pnr: pnrData.pnr,
                train_no: pnrData.train_no,
                train_name: pnrData.train_name,
                source: pnrData.source,
                destination: pnrData.destination,
                class: pnrData.class || 'Unknown',
                booking_status: pnrData.passengers?.[0]?.booking_status || 'Unknown',
                current_status: pnrData.passengers?.[0]?.current_status || 'Unknown',
                chart_prepared: pnrData.chart_status?.toLowerCase().includes('prepared') || false,
                prediction_chance: pnrData.prediction?.probability || 'N/A',
                checked_at: new Date().toISOString(),
                final_status: pnrData.passengers?.[0]?.current_status || 'Unknown'
            };

            // Check if record already exists
            const { data: existingRecord, error: selectError } = await supabase
                .from('pnr_history')
                .select('id')
                .eq('pnr', historyRecord.pnr)
                .order('checked_at', { ascending: false })
                .limit(1)
                .single();

            if (selectError && selectError.code !== 'PGRST116') {
                winstonLogger.error(`[PNR_HISTORY] Error checking existing record: ${selectError.message}`);
                return;
            }

            // Insert or update record
            if (existingRecord) {
                const { error: updateError } = await supabase
                    .from('pnr_history')
                    .update(historyRecord)
                    .eq('id', existingRecord.id);

                if (updateError) {
                    winstonLogger.error(`[PNR_HISTORY] Error updating record: ${updateError.message}`);
                } else {
                    winstonLogger.info(`[PNR_HISTORY] Updated record for PNR: ${historyRecord.pnr}`);
                }
            } else {
                const { error: insertError } = await supabase
                    .from('pnr_history')
                    .insert(historyRecord);

                if (insertError) {
                    winstonLogger.error(`[PNR_HISTORY] Error inserting record: ${insertError.message}`);
                } else {
                    winstonLogger.info(`[PNR_HISTORY] Inserted new record for PNR: ${historyRecord.pnr}`);
                }
            }
        } catch (error: any) {
            winstonLogger.error(`[PNR_HISTORY] Unexpected error: ${error.message}`);
        }
    }

    /**
     * Get historical data for smart predictions
     */
    async getHistoricalDataForPrediction(
        source: string,
        destination: string,
        currentStatus: string
    ): Promise<{ successRate: number; totalCount: number } | null> {
        try {
            // Parse the current status to get the waitlist number & quota
            const QUOTA_REGEX = /(GNWL|TQWL|RLWL|PQWL|CKWL|RSWL|WL)[\/\-]?\s*(\d+)/i;
            const wlMatch = currentStatus.match(QUOTA_REGEX);
            if (!wlMatch) return null;

            const quotaType = wlMatch[1].toUpperCase();
            const wlPosition = parseInt(wlMatch[2]);
            if (isNaN(wlPosition)) return null;

            // Get historical data for similar routes and WL positions
            const { data, error } = await supabase
                .from('pnr_history')
                .select('current_status, final_status')
                .eq('source', source)
                .eq('destination', destination)
                .ilike('current_status', `%${quotaType}%`); // Match same WL quota type anywhere in string

            if (error) {
                winstonLogger.error(`[PNR_PREDICTION] Error fetching historical data: ${error.message}`);
                return null;
            }

            if (!data || data.length === 0) return null;

            // Filter records with similar WL positions (within 5 positions)
            const similarRecords = data.filter(record => {
                const recordWlMatch = record.current_status.match(QUOTA_REGEX);
                if (!recordWlMatch) return false;

                const recordWlPosition = parseInt(recordWlMatch[2]);
                return Math.abs(recordWlPosition - wlPosition) <= 5;
            });

            if (similarRecords.length === 0) return null;

            // Calculate success rate (confirmed final status)
            const confirmedCount = similarRecords.filter(record =>
                record.final_status?.toUpperCase().includes('CNF') ||
                record.final_status?.toUpperCase().includes('CONFIRMED')
            ).length;

            return {
                successRate: Math.round((confirmedCount / similarRecords.length) * 100),
                totalCount: similarRecords.length
            };
        } catch (error: any) {
            winstonLogger.error(`[PNR_PREDICTION] Unexpected error: ${error.message}`);
            return null;
        }
    }
}

export const pnrHistoryService = new PnrHistoryService();