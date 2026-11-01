import { supabase } from '../config/supabase';
import { winstonLogger } from '../middleware/logger';

interface SearchHistoryRecord {
    source: string;
    destination: string;
    date: string;
    user_id: string | null;
    device_id: string | null;
    direct_train_count: number;
    split_used: boolean;
    clicked_train_no: string | null;
}

interface SearchPopularityRecord {
    route_key: string;
    source: string;
    destination: string;
    count: number;
}

export class SearchHistoryService {
    /**
     * Save search result to history
     */
    async saveSearchHistory(searchData: any): Promise<void> {
        try {
            const historyRecord: SearchHistoryRecord = {
                source: searchData.source,
                destination: searchData.destination,
                date: searchData.date,
                user_id: searchData.userId || null,
                device_id: searchData.deviceId || null,
                direct_train_count: searchData.directTrainCount || 0,
                split_used: searchData.splitUsed || false,
                clicked_train_no: searchData.clickedTrainNo || null
            };

            const { error } = await supabase
                .from('search_history')
                .insert(historyRecord);

            if (error) {
                winstonLogger.error(`[SEARCH_HISTORY] Error saving search history: ${error.message}`);
            } else {
                winstonLogger.info(`[SEARCH_HISTORY] Saved search history for route: ${searchData.source} → ${searchData.destination}`);
            }
        } catch (error: any) {
            winstonLogger.error(`[SEARCH_HISTORY] Unexpected error: ${error.message}`);
        }
    }

    /**
     * Update search popularity counter
     */
    async updateSearchPopularity(source: string, destination: string): Promise<void> {
        try {
            const s = String(source || '').trim().toUpperCase();
            const d = String(destination || '').trim().toUpperCase();
            if (!s || !d || s === d) return;

            const { error } = await supabase.rpc('increment_search_popularity', {
                p_source: s,
                p_destination: d
            });

            if (error) {
                winstonLogger.warn(`[SEARCH_POPULARITY] RPC increment_search_popularity skipped: ${error.message}`);
            } else {
                winstonLogger.info(`[SEARCH_POPULARITY] Updated popularity for route: ${s} -> ${d}`);
            }
        } catch (error: any) {
            winstonLogger.error(`[SEARCH_POPULARITY] Unexpected error: ${error.message}`);
        }
    }

    /**
     * Get trending routes
     */
    async getTrendingRoutes(limit: number = 10): Promise<any[]> {
        try {
            const { data, error } = await supabase
                .from('search_popularity')
                .select('source, destination, search_count')
                .order('search_count', { ascending: false })
                .limit(limit);

            if (error) {
                winstonLogger.error(`[TRENDING_ROUTES] Error fetching trending routes: ${error.message}`);
                return [];
            }

            return (data || []).map((row: any) => ({
                source: row.source,
                destination: row.destination,
                count: Number(row.search_count || 1),
                search_count: Number(row.search_count || 1)
            }));
        } catch (error: any) {
            winstonLogger.error(`[TRENDING_ROUTES] Unexpected error: ${error.message}`);
            return [];
        }
    }

    /**
     * Save split learning data
     */
    async saveSplitLearning(source: string, destination: string, hub: string, routeUsed: boolean, userClicked: boolean): Promise<void> {
        try {
            const { error } = await supabase
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
                winstonLogger.error(`[SPLIT_LEARNING] Error saving split learning data: ${error.message}`);
            } else {
                winstonLogger.info(`[SPLIT_LEARNING] Saved learning data for route: ${source} → ${destination} via ${hub}`);
            }
        } catch (error: any) {
            winstonLogger.error(`[SPLIT_LEARNING] Unexpected error: ${error.message}`);
        }
    }

    /**
     * Update split learning success count
     */
    async updateSplitLearningSuccess(source: string, destination: string, hub: string): Promise<void> {
        try {
            const { error } = await supabase
                .from('split_learning')
                .update({
                    success_count: supabase.rpc('increment', { input: 1 }),
                    updated_at: new Date().toISOString()
                })
                .eq('source', source)
                .eq('destination', destination)
                .eq('hub', hub);

            if (error) {
                winstonLogger.error(`[SPLIT_LEARNING] Error updating success count: ${error.message}`);
            }
        } catch (error: any) {
            winstonLogger.error(`[SPLIT_LEARNING] Unexpected error updating success count: ${error.message}`);
        }
    }
}

export const searchHistoryService = new SearchHistoryService();