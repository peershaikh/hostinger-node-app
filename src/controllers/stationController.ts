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
        ],
        'PRAYAGRAJ': [
          { Station_Code: 'PRYJ', Station_Name: 'Prayagraj Junction' },
          { Station_Code: 'PCOI', Station_Name: 'Prayagraj Chheoki' },
          { Station_Code: 'PRRB', Station_Name: 'Prayagraj Rambag' },
          { Station_Code: 'SFG', Station_Name: 'Subedarganj' },
          { Station_Code: 'ALD', Station_Name: 'Allahabad Jn (Old Code)' }
        ],
        'ALLAHABAD': [
          { Station_Code: 'PRYJ', Station_Name: 'Prayagraj Junction (Formerly Allahabad)' },
          { Station_Code: 'PCOI', Station_Name: 'Prayagraj Chheoki' },
          { Station_Code: 'ALD', Station_Name: 'Allahabad Jn' },
          { Station_Code: 'PRRB', Station_Name: 'Prayagraj Rambag' }
        ],
        'VARANASI': [
          { Station_Code: 'BSB', Station_Name: 'Varanasi Junction' },
          { Station_Code: 'BSBS', Station_Name: 'Banaras' },
          { Station_Code: 'DDU', Station_Name: 'Pt. Deen Dayal Upadhyaya (Mughalsarai)' },
          { Station_Code: 'MUV', Station_Name: 'Manduadih' }
        ],
        'BANARAS': [
          { Station_Code: 'BSBS', Station_Name: 'Banaras' },
          { Station_Code: 'BSB', Station_Name: 'Varanasi Junction' },
          { Station_Code: 'MUV', Station_Name: 'Manduadih' }
        ],
        'MUGHALSARAI': [
          { Station_Code: 'DDU', Station_Name: 'Pt. Deen Dayal Upadhyaya (Formerly Mughalsarai)' },
          { Station_Code: 'MGS', Station_Name: 'Mughalsarai Jn' }
        ],
        'AYODHYA': [
          { Station_Code: 'AY', Station_Name: 'Ayodhya Dham' },
          { Station_Code: 'AYC', Station_Name: 'Ayodhya Cantt (Formerly Faizabad)' }
        ],
        'FAIZABAD': [
          { Station_Code: 'AYC', Station_Name: 'Ayodhya Cantt (Formerly Faizabad)' },
          { Station_Code: 'FD', Station_Name: 'Faizabad Jn' },
          { Station_Code: 'AY', Station_Name: 'Ayodhya Dham' }
        ],
        'BHOPAL': [
          { Station_Code: 'BPL', Station_Name: 'Bhopal Junction' },
          { Station_Code: 'RKMP', Station_Name: 'Rani Kamalapati (Habibganj)' }
        ],
        'HABIBGANJ': [
          { Station_Code: 'RKMP', Station_Name: 'Rani Kamalapati (Formerly Habibganj)' },
          { Station_Code: 'HBJ', Station_Name: 'Habibganj' },
          { Station_Code: 'BPL', Station_Name: 'Bhopal Junction' }
        ],
        'JHANSI': [
          { Station_Code: 'VGLJ', Station_Name: 'Virangana Lakshmibai Jhansi' },
          { Station_Code: 'JHS', Station_Name: 'Jhansi Junction' }
        ]
      };

      // 1. Exact Major City Match
      if (majorCities[upper]) {
        const data = majorCities[upper];
        cacheService.set(cacheKey, data, 3600);
        return res.json(data);
      }

      // 2. City Prefix Match (e.g. "mumb" -> MUMBAI, "del" -> DELHI, "beng" -> BENGALURU)
      const cityKey = Object.keys(majorCities).find(c => c.startsWith(upper) && upper.length >= 3);
      let cityDirect: any[] = cityKey ? majorCities[cityKey] : [];

      // 3. Database Search with proper lowercase column names
      const [registryRes, aliasRes] = await Promise.all([
        supabase
          .from('station_registry')
          .select('station_code, station_name, city_name')
          .or(`station_name.ilike.%${query}%,station_code.ilike.%${query}%,city_name.ilike.%${query}%`)
          .limit(40)
          .order('station_name', { ascending: true }),
        supabase
          .from('station_aliases')
          .select('station_code, alias_name')
          .or(`alias_name.ilike.%${query}%,station_code.ilike.%${query}%`)
          .limit(10)
      ]);

      if (registryRes.error) throw registryRes.error;

      const dbResults = (registryRes.data || []).map((r: any) => ({
        Station_Code: r.station_code,
        Station_Name: r.station_name,
        station_code: r.station_code,
        station_name: r.station_name,
        city_name: r.city_name
      }));

      // Resolve any alias codes not already in dbResults
      let aliasStations: any[] = [];
      if (aliasRes.data && aliasRes.data.length > 0) {
        const aliasCodes = [...new Set(aliasRes.data.map((a: any) => a.station_code))];
        const missingCodes = aliasCodes.filter(c => !dbResults.some((r: any) => r.Station_Code === c));
        if (missingCodes.length > 0) {
          for (const mCity of Object.values(majorCities)) {
            for (const stn of mCity) {
              if (missingCodes.includes(stn.Station_Code) && !aliasStations.some(s => s.Station_Code === stn.Station_Code)) {
                aliasStations.push(stn);
              }
            }
          }
        }
      }

      // Combine and deduplicate
      const seen = new Set<string>();
      const combined: any[] = [];

      for (const item of [...cityDirect, ...aliasStations, ...dbResults]) {
        const code = (item.Station_Code || item.station_code || '').toUpperCase();
        if (code && !seen.has(code)) {
          seen.add(code);
          combined.push({
            Station_Code: item.Station_Code || item.station_code,
            Station_Name: item.Station_Name || item.station_name,
            station_code: item.station_code || item.Station_Code,
            station_name: item.station_name || item.Station_Name,
            city_name: item.city_name
          });
        }
      }

      // 🔥 Prioritize Matches
      combined.sort((a: any, b: any) => {
        const aCode = (a.Station_Code || '').toUpperCase();
        const bCode = (b.Station_Code || '').toUpperCase();
        const aName = (a.Station_Name || '').toUpperCase();
        const bName = (b.Station_Name || '').toUpperCase();
        
        // Exact Code Match First
        if (aCode === upper && bCode !== upper) return -1;
        if (bCode === upper && aCode !== upper) return 1;

        // Exact Name Match Second
        if (aName === upper && bName !== upper) return -1;
        if (bName === upper && aName !== upper) return 1;

        // Starts With Code Match Third
        if (aCode.startsWith(upper) && !bCode.startsWith(upper)) return -1;
        if (bCode.startsWith(upper) && !aCode.startsWith(upper)) return 1;

        // Starts With Name Match Fourth
        if (aName.startsWith(upper) && !bName.startsWith(upper)) return -1;
        if (bName.startsWith(upper) && !aName.startsWith(upper)) return 1;

        return 0;
      });

      // Final Slice (Limit 30 as requested)
      const finalResults = combined.slice(0, 30);

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