"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.pnrHistoryService = exports.PnrHistoryService = void 0;
const supabase_1 = require("../config/supabase");
const logger_1 = require("../middleware/logger");
class PnrHistoryService {
    /**
     * Save PNR check result to learning and user history
     */
    async savePnrHistory(pnrData) {
        try {
            const initialStatus = pnrData.passengers?.[0]?.booking_status || 'Unknown';
            const currentStatus = pnrData.passengers?.[0]?.current_status || 'Unknown';
            const isChartPrepared = pnrData.chart_status?.toLowerCase().includes('prepared') || false;
            // 1. Save outcome into pnr_learning table
            try {
                await supabase_1.supabase.from('pnr_learning').insert([{
                        pnr: pnrData.pnr,
                        initial_status: initialStatus,
                        final_status: currentStatus,
                        chart_prepared: isChartPrepared,
                        time_checked: new Date().toISOString()
                    }]);
            }
            catch (learnErr) {
                logger_1.winstonLogger.debug(`[PNR_HISTORY] pnr_learning insert note: ${learnErr?.message}`);
            }
            // 2. Save/Update record in pnr_history bookmarks table if available
            try {
                const historyRecord = {
                    pnr: pnrData.pnr,
                    train_no: pnrData.train_no,
                    train_name: pnrData.train_name,
                    source: pnrData.source,
                    destination: pnrData.destination,
                    class: pnrData.class || 'Unknown',
                    booking_status: initialStatus,
                    current_status: currentStatus,
                    chart_prepared: isChartPrepared,
                    prediction_chance: pnrData.prediction?.probability || 'N/A',
                    checked_at: new Date().toISOString(),
                    final_status: currentStatus
                };
                const { data: existingRecord } = await supabase_1.supabase
                    .from('pnr_history')
                    .select('id, history')
                    .eq('pnr', historyRecord.pnr)
                    .limit(1)
                    .maybeSingle();
                if (existingRecord) {
                    const historyArray = Array.isArray(existingRecord.history) ? existingRecord.history : [];
                    historyArray.unshift(historyRecord);
                    await supabase_1.supabase
                        .from('pnr_history')
                        .update({
                        history: historyArray.slice(0, 10),
                        last_checked: new Date().toISOString()
                    })
                        .eq('id', existingRecord.id);
                }
                else {
                    await supabase_1.supabase
                        .from('pnr_history')
                        .insert([{
                            pnr: historyRecord.pnr,
                            history: [historyRecord],
                            is_active: true,
                            last_checked: new Date().toISOString()
                        }]);
                }
            }
            catch (histErr) {
                logger_1.winstonLogger.debug(`[PNR_HISTORY] pnr_history bookmarks write note: ${histErr?.message}`);
            }
        }
        catch (error) {
            logger_1.winstonLogger.debug(`[PNR_HISTORY] Handled unexpected error in savePnrHistory: ${error?.message}`);
        }
    }
    /**
     * Get historical data for smart predictions from pnr_learning
     */
    async getHistoricalDataForPrediction(source, destination, currentStatus) {
        try {
            // Parse the current status to get the waitlist number & quota
            const QUOTA_REGEX = /(GNWL|TQWL|RLWL|PQWL|CKWL|RSWL|WL)[\/\-]?\s*(\d+)/i;
            const wlMatch = currentStatus.match(QUOTA_REGEX);
            if (!wlMatch)
                return null;
            const quotaType = wlMatch[1].toUpperCase();
            const wlPosition = parseInt(wlMatch[2]);
            if (isNaN(wlPosition))
                return null;
            // Query authoritative pnr_learning table for matching waitlist types
            const { data, error } = await supabase_1.supabase
                .from('pnr_learning')
                .select('initial_status, final_status')
                .ilike('initial_status', `%${quotaType}%`)
                .limit(200);
            if (error) {
                logger_1.winstonLogger.debug(`[PNR_PREDICTION] Note fetching historical data: ${error.message}`);
                return null;
            }
            if (!data || data.length === 0)
                return null;
            // Filter records with similar WL positions (within 5 positions)
            const similarRecords = data.filter(record => {
                const statusStr = record.initial_status || '';
                const recordWlMatch = statusStr.match(QUOTA_REGEX);
                if (!recordWlMatch)
                    return false;
                const recordWlPosition = parseInt(recordWlMatch[2]);
                return Math.abs(recordWlPosition - wlPosition) <= 5;
            });
            if (similarRecords.length === 0)
                return null;
            // Calculate success rate (confirmed final status)
            const confirmedCount = similarRecords.filter(record => {
                const fs = (record.final_status || '').toUpperCase();
                return fs.includes('CNF') || fs.includes('CONFIRM') || /^[A-Z]\d+-\d+/.test(fs);
            }).length;
            return {
                successRate: Math.round((confirmedCount / similarRecords.length) * 100),
                totalCount: similarRecords.length
            };
        }
        catch (error) {
            logger_1.winstonLogger.debug(`[PNR_PREDICTION] Handled prediction error: ${error?.message}`);
            return null;
        }
    }
}
exports.PnrHistoryService = PnrHistoryService;
exports.pnrHistoryService = new PnrHistoryService();
