"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.searchHistoryService = exports.SearchHistoryService = void 0;
const supabase_1 = require("../config/supabase");
const logger_1 = require("../middleware/logger");
class SearchHistoryService {
    /**
     * Save search result to history
     */
    async saveSearchHistory(searchData) {
        try {
            const historyRecord = {
                source: searchData.source,
                destination: searchData.destination,
                date: searchData.date,
                user_id: searchData.userId || null,
                device_id: searchData.deviceId || null,
                direct_train_count: searchData.directTrainCount || 0,
                split_used: searchData.splitUsed || false,
                clicked_train_no: searchData.clickedTrainNo || null
            };
            const { error } = await supabase_1.supabase
                .from('search_history')
                .insert(historyRecord);
            if (error) {
                logger_1.winstonLogger.error(`[SEARCH_HISTORY] Error saving search history: ${error.message}`);
            }
            else {
                logger_1.winstonLogger.info(`[SEARCH_HISTORY] Saved search history for route: ${searchData.source} → ${searchData.destination}`);
            }
        }
        catch (error) {
            logger_1.winstonLogger.error(`[SEARCH_HISTORY] Unexpected error: ${error.message}`);
        }
    }
    /**
     * Update search popularity counter
     */
    async updateSearchPopularity(source, destination) {
        try {
            const routeKey = `${source}_${destination}`;
            // Get current count
            const { data: existing, error: selectError } = await supabase_1.supabase
                .from('search_popularity')
                .select('count')
                .eq('route_key', routeKey)
                .single();
            if (selectError && selectError.code !== 'PGRST116') {
                logger_1.winstonLogger.error(`[SEARCH_POPULARITY] Error checking existing record: ${selectError.message}`);
                return;
            }
            const newCount = (existing?.count || 0) + 1;
            // Insert or update record
            if (existing) {
                const { error: updateError } = await supabase_1.supabase
                    .from('search_popularity')
                    .update({
                    count: newCount,
                    last_searched_at: new Date().toISOString()
                })
                    .eq('route_key', routeKey);
                if (updateError) {
                    logger_1.winstonLogger.error(`[SEARCH_POPULARITY] Error updating record: ${updateError.message}`);
                }
                else {
                    logger_1.winstonLogger.info(`[SEARCH_POPULARITY] Updated popularity for route: ${source} → ${destination} (count: ${newCount})`);
                }
            }
            else {
                const { error: insertError } = await supabase_1.supabase
                    .from('search_popularity')
                    .insert({
                    route_key: routeKey,
                    source,
                    destination,
                    count: 1,
                    last_searched_at: new Date().toISOString()
                });
                if (insertError) {
                    logger_1.winstonLogger.error(`[SEARCH_POPULARITY] Error inserting record: ${insertError.message}`);
                }
                else {
                    logger_1.winstonLogger.info(`[SEARCH_POPULARITY] Inserted new popularity record for route: ${source} → ${destination}`);
                }
            }
        }
        catch (error) {
            logger_1.winstonLogger.error(`[SEARCH_POPULARITY] Unexpected error: ${error.message}`);
        }
    }
    /**
     * Get trending routes
     */
    async getTrendingRoutes(limit = 10) {
        try {
            const { data, error } = await supabase_1.supabase
                .from('search_popularity')
                .select('source, destination, count')
                .order('count', { ascending: false })
                .limit(limit);
            if (error) {
                logger_1.winstonLogger.error(`[TRENDING_ROUTES] Error fetching trending routes: ${error.message}`);
                return [];
            }
            return data || [];
        }
        catch (error) {
            logger_1.winstonLogger.error(`[TRENDING_ROUTES] Unexpected error: ${error.message}`);
            return [];
        }
    }
    /**
     * Save split learning data
     */
    async saveSplitLearning(source, destination, hub, routeUsed, userClicked) {
        try {
            const { error } = await supabase_1.supabase
                .from('split_learning')
                .insert({
                source,
                destination,
                hub,
                route_used: routeUsed,
                user_clicked: userClicked,
                success_count: userClicked ? 1 : 0,
                created_at: new Date().toISOString(),
                updated_at: new Date().toISOString()
            });
            if (error) {
                logger_1.winstonLogger.error(`[SPLIT_LEARNING] Error saving split learning data: ${error.message}`);
            }
            else {
                logger_1.winstonLogger.info(`[SPLIT_LEARNING] Saved learning data for route: ${source} → ${destination} via ${hub}`);
            }
        }
        catch (error) {
            logger_1.winstonLogger.error(`[SPLIT_LEARNING] Unexpected error: ${error.message}`);
        }
    }
    /**
     * Update split learning success count
     */
    async updateSplitLearningSuccess(source, destination, hub) {
        try {
            const { error } = await supabase_1.supabase
                .from('split_learning')
                .update({
                success_count: supabase_1.supabase.rpc('increment', { input: 1 }),
                updated_at: new Date().toISOString()
            })
                .eq('source', source)
                .eq('destination', destination)
                .eq('hub', hub);
            if (error) {
                logger_1.winstonLogger.error(`[SPLIT_LEARNING] Error updating success count: ${error.message}`);
            }
        }
        catch (error) {
            logger_1.winstonLogger.error(`[SPLIT_LEARNING] Unexpected error updating success count: ${error.message}`);
        }
    }
}
exports.SearchHistoryService = SearchHistoryService;
exports.searchHistoryService = new SearchHistoryService();
