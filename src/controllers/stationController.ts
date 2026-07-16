import { Request, Response } from 'express';
import { supabase } from '../config/supabase';
import { winstonLogger } from '../middleware/logger';
import { cacheService } from '../services/cacheService';
import { selfLearningService } from '../services/selfLearningService';

export class StationController {
  /**
   * Smart Station Autocomplete
   */
  async searchStations(req: Request, res: Response) {
    const { q } = req.query;
    
    if (!q || typeof q !== 'string' || q.trim().length < 2) {
      return res.json([]);
    }

    const query = q.trim();
    const cacheKey = `station_search_${query.toLowerCase()}`;

    // Cache hit
    const cached = cacheService.get(cacheKey);
    if (cached) return res.json(cached);

    try {
      const upper = query.toUpperCase();

      // 🔥 Special Handling for Major Cities (Most Common Searches)
      const majorCities: Record<string, any[]> = {
        'MUMBAI': [
          { Station_Code: 'CSMT', Station_Name: 'Mumbai CSMT' },
          { Station_Code: 'LTT', Station_Name: 'Lokmanya Tilak Terminus' },
          { Station_Code: 'BDTS', Station_Name: 'Bandra Terminus' },
          { Station_Code: 'MMCT', Station_Name: 'Mumbai Central' },
          { Station_Code: 'DR', Station_Name: 'Dadar' }
        ],
        'BOMBAY': [
          { Station_Code: 'CSMT', Station_Name: 'Mumbai CSMT' },
          { Station_Code: 'LTT', Station_Name: 'Lokmanya Tilak Terminus' },
          { Station_Code: 'BDTS', Station_Name: 'Bandra Terminus' },
          { Station_Code: 'MMCT', Station_Name: 'Mumbai Central' },
          { Station_Code: 'DR', Station_Name: 'Dadar' }
        ],
        'DELHI': [
          { Station_Code: 'NDLS', Station_Name: 'New Delhi' },
          { Station_Code: 'DLI', Station_Name: 'Old Delhi' },
          { Station_Code: 'NZM', Station_Name: 'Hazrat Nizamuddin' },
          { Station_Code: 'ANVT', Station_Name: 'Anand Vihar' }
        ],
        'BANGALORE': [
          { Station_Code: 'SBC', Station_Name: 'KSR Bengaluru' },
          { Station_Code: 'YPR', Station_Name: 'Yesvantpur' },
          { Station_Code: 'SMVB', Station_Name: 'SMVT Bengaluru' }
        ],
        'BENGALURU': [
          { Station_Code: 'SBC', Station_Name: 'KSR Bengaluru' },
          { Station_Code: 'YPR', Station_Name: 'Yesvantpur' },
          { Station_Code: 'SMVB', Station_Name: 'SMVT Bengaluru' }
        ],
        'CHENNAI': [
          { Station_Code: 'MAS', Station_Name: 'Chennai Central' },
          { Station_Code: 'MS', Station_Name: 'Chennai Egmore' },
          { Station_Code: 'PER', Station_Name: 'Perambur' }
        ],
        'KOLKATA': [
          { Station_Code: 'HWH', Station_Name: 'Howrah' },
          { Station_Code: 'SDAH', Station_Name: 'Sealdah' },
          { Station_Code: 'KOAA', Station_Name: 'Kolkata' },
          { Station_Code: 'SHM', Station_Name: 'Shalimar' }
        ],
        'HYDERABAD': [
          { Station_Code: 'SC', Station_Name: 'Secunderabad' },
          { Station_Code: 'HYB', Station_Name: 'Hyderabad Deccan' },
          { Station_Code: 'KCG', Station_Name: 'Kacheguda' }
        ]
      };

      if (majorCities[upper]) {
        const data = majorCities[upper];
        cacheService.set(cacheKey, data, 3600);
        return res.json(data);
      }

      // General Database Search
      const { data, error } = await supabase
        .from('station_registry')
        .select('Station_Code, Station_Name, city_name')
        .or(`Station_Name.ilike.%${query}%,Station_Code.ilike.%${query}%,city_name.ilike.%${query}%`)
        .limit(40)                    // Fetched more for better sorting
        .order('Station_Name', { ascending: true });

      if (error) throw error;

      let results = data || [];

      // 🔥 Prioritize Exact Matches (Fix 4.4)
      results = results.sort((a: any, b: any) => {
        const aCode = a.Station_Code.toUpperCase();
        const bCode = b.Station_Code.toUpperCase();
        const aName = a.Station_Name.toUpperCase();
        const bName = b.Station_Name.toUpperCase();
        
        // Exact Code Match First
        if (aCode === upper && bCode !== upper) return -1;
        if (bCode === upper && aCode !== upper) return 1;

        // Exact Name Match Second
        if (aName === upper && bName !== upper) return -1;
        if (bName === upper && aName !== upper) return 1;

        // Starts With Match Third
        if (aName.startsWith(upper) && !bName.startsWith(upper)) return -1;
        if (bName.startsWith(upper) && !aName.startsWith(upper)) return 1;

        return 0;
      });

      // Final Slice (Limit 30 as requested)
      const finalResults = results.slice(0, 30);

      if (finalResults.length > 0) {
        cacheService.set(cacheKey, finalResults, 1800); // 30 min cache
      } else {
        const userId = req.headers['x-user-id'] as string || null;
        setImmediate(() => {
          selfLearningService.logMissingStation(query, userId).catch(() => {});
        });
      }

      return res.json(finalResults);

    } catch (err: any) {
      winstonLogger.error(`[STATION_SEARCH] Error for "${query}": ${err.message}`);
      // Graceful fallback remains same...

      // Graceful fallback
      const fallback = [
        { Station_Code: 'NDLS', Station_Name: 'New Delhi' },
        { Station_Code: 'CSMT', Station_Name: 'Mumbai CSMT' },
        { Station_Code: 'BZA', Station_Name: 'Vijayawada' },
        { Station_Code: 'SBC', Station_Name: 'Bengaluru' }
      ];
      return res.json(fallback);
    }
  }
}

export const stationController = new StationController();