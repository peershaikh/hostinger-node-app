"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.pnrHistoryService = exports.PnrHistoryService = void 0;
const supabase_1 = require("../config/supabase");
const logger_1 = require("../middleware/logger");
class PnrHistoryService {
    /**
     * Save PNR check result to history
     */
    async savePnrHistory(pnrData) {
        try {
            const historyRecord = {
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
            const { data: existingRecord, error: selectError } = await supabase_1.supabase
                .from('pnr_history')
                .select('id')
                .eq('pnr', historyRecord.pnr)
                .order('checked_at', { ascending: false })
                .limit(1)
                .single();
            if (selectError && selectError.code !== 'PGRST116') {
                logger_1.winstonLogger.error(`[PNR_HISTORY] Error checking existing record: ${selectError.message}`);
                return;
            }
            // Insert or update record
            if (existingRecord) {
                const { error: updateError } = await supabase_1.supabase
                    .from('pnr_history')
                    .update(historyRecord)
                    .eq('id', existingRecord.id);
                if (updateError) {
                    logger_1.winstonLogger.error(`[PNR_HISTORY] Error updating record: ${updateError.message}`);
                }
                else {
                    logger_1.winstonLogger.info(`[PNR_HISTORY] Updated record for PNR: ${historyRecord.pnr}`);
                }
            }
            else {
                const { error: insertError } = await supabase_1.supabase
                    .from('pnr_history')
                    .insert(historyRecord);
                if (insertError) {
                    logger_1.winstonLogger.error(`[PNR_HISTORY] Error inserting record: ${insertError.message}`);
                }
                else {
                    logger_1.winstonLogger.info(`[PNR_HISTORY] Inserted new record for PNR: ${historyRecord.pnr}`);
                }
            }
        }
        catch (error) {
            logger_1.winstonLogger.error(`[PNR_HISTORY] Unexpected error: ${error.message}`);
        }
    }
    /**
     * Get historical data for smart predictions
     */
    async getHistoricalDataForPrediction(source, destination, currentStatus) {
        try {
            // Parse the current status to get the waitlist number
            const wlMatch = currentStatus.match(/(WL|TQWL)[\/\-]?\s*(\d+)/i);
            if (!wlMatch)
                return null;
            const wlPosition = parseInt(wlMatch[2]);
            if (isNaN(wlPosition))
                return null;
            // Get historical data for similar routes and WL positions
            const { data, error } = await supabase_1.supabase
                .from('pnr_history')
                .select('current_status, final_status')
                .eq('source', source)
                .eq('destination', destination)
                .ilike('current_status', `${wlMatch[1]}%`); // Match same WL type
            if (error) {
                logger_1.winstonLogger.error(`[PNR_PREDICTION] Error fetching historical data: ${error.message}`);
                return null;
            }
            if (!data || data.length === 0)
                return null;
            // Filter records with similar WL positions (within 5 positions)
            const similarRecords = data.filter(record => {
                const recordWlMatch = record.current_status.match(/(WL|TQWL)[\/\-]?\s*(\d+)/i);
                if (!recordWlMatch)
                    return false;
                const recordWlPosition = parseInt(recordWlMatch[2]);
                return Math.abs(recordWlPosition - wlPosition) <= 5;
            });
            if (similarRecords.length === 0)
                return null;
            // Calculate success rate (confirmed final status)
            const confirmedCount = similarRecords.filter(record => record.final_status?.toUpperCase().includes('CNF') ||
                record.final_status?.toUpperCase().includes('CONFIRMED')).length;
            return {
                successRate: Math.round((confirmedCount / similarRecords.length) * 100),
                totalCount: similarRecords.length
            };
        }
        catch (error) {
            logger_1.winstonLogger.error(`[PNR_PREDICTION] Unexpected error: ${error.message}`);
            return null;
        }
    }
}
exports.PnrHistoryService = PnrHistoryService;
exports.pnrHistoryService = new PnrHistoryService();
