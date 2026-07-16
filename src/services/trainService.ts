import { isSupabaseConfigured, supabase } from '../config/supabase';
import { winstonLogger } from '../middleware/logger';
import { isDayActive, normalizeRunningDays } from '../utils/dayUtils';
import { dbService } from './dbService';
import { irctcService } from './irctcService';
import { railRadarService } from './railRadarService';
import { rankingService } from './rankingService';
import { rapidApiService } from './rapidApiService';
import { providerConfigService } from './providerConfigService';
import { stationService } from './stationService';
import { cacheService } from './cacheService';

import { normalizeTrainNumber } from '../utils/availabilityCacheKeys';

const SOURCES = ['IRCTC', 'RAILRADAR', 'RAPIDAPI', 'DB'] as const;

export interface TrainSearchQuery {
  source: string;
  destination: string;
  date?: string;
}

function withTimeout<T>(promise: Promise<T>, ms: number = 5000): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const timeoutPromise = new Promise<T>((_, reject) => {
    timer = setTimeout(() => reject(new Error('TIMEOUT')), ms);
  });
  return Promise.race([promise, timeoutPromise]).finally(() => {
    if (timer) clearTimeout(timer);
  });
}

class TrainService {
  async getTrainData(source: string, destination: string, date?: string) {
    const searchDate = date || new Date().toISOString().split('T')[0];
    const sCode = (await stationService.getStationsForCity(source))[0] || source.toUpperCase();
    const dCode = (await stationService.getStationsForCity(destination))[0] || destination.toUpperCase();

    const cachedSearch = cacheService.getCachedSearch(sCode, dCode, searchDate);
    if (Array.isArray(cachedSearch) && cachedSearch.length > 0) {
      const direct = this.normalizeAndDeduplicate(cachedSearch, searchDate, sCode, dCode);
      winstonLogger.info(`[TRAIN_SERVICE] search cache hit directCount=${direct.length}`);
      return {
        direct,
        success: direct.length > 0,
        status: direct.length > 0 ? 'SUCCESS' : 'NO_TRAINS_FOUND',
        source: 'CACHE',
        api_used: 'CACHE',
        data_source: 'CACHE',
        warning: null,
      };
    }

    // Pre-warm provider enable cache (10s TTL) before sequential fallback chain
    await Promise.all([
      providerConfigService.isProviderEnabled('IRCTC'),
      providerConfigService.isProviderEnabled('RAILRADAR'),
      providerConfigService.isProviderEnabled('RAPIDAPI'),
    ]);

    let sourceUsed = 'DB';
    let apiUsed = 'DB';
    let dataSource = 'DATABASE';
    let directResults: any[] = [];
    // PHASE_4C931 TASK 2: track whether any live provider was attempted and succeeded
    let anyProviderAttempted = false;
    let anyProviderSucceeded = false;
    const providerAttempted: string[] = [];

    const tryFetch = async (
      label: string,
      fn: () => Promise<any[] | null>
    ) => {
      try {
        const result = await withTimeout(fn(), 5000);
        if (Array.isArray(result) && result.length > 0) {
          return result;
        }
        if (result && typeof result === 'object' && Object.keys(result).length > 0) {
          return result;
        }
      } catch (err: any) {
        console.warn(`❌ ${label} FAILED`, err?.message || err);
      }
      return null;
    };

    // Fire DB search concurrently to use as a baseline for detecting cancelled trains
    const dbPromise = withTimeout(dbService.searchTrains(sCode, dCode, searchDate), 5000).catch(() => []);

    // 1. IRCTC primary
    const irctcGuard = await providerConfigService.isProviderEnabled('IRCTC');
    if (irctcGuard.enabled) {
      anyProviderAttempted = true;
      providerAttempted.push('IRCTC');
      const irctcResult = await tryFetch('IRCTC', async () => irctcService.search(sCode, dCode, searchDate));
      if (irctcResult) {
        winstonLogger.info('[TRAIN_SERVICE] IRCTC returned results');
        sourceUsed = 'IRCTC';
        apiUsed = 'IRCTC';
        dataSource = 'LIVE';
        directResults = irctcResult as any[];
        anyProviderSucceeded = true;
      }
    } else {
      const skipLabel = (irctcGuard.reason === 'PROVIDER_UNHEALTHY' || irctcGuard.reason === 'CIRCUIT_BREAKER_BLOCKED')
        ? '[PROVIDER_SKIPPED_UNHEALTHY]'
        : '[PROVIDER_SKIPPED_DISABLED]';
      winstonLogger.info(`${skipLabel} IRCTC | Reason: ${irctcGuard.reason}`);
    }

    // 2. RailRadar fallback
    if (!directResults.length) {
      const rrGuard = await providerConfigService.isProviderEnabled('RAILRADAR');
      if (rrGuard.enabled) {
        anyProviderAttempted = true;
        providerAttempted.push('RAILRADAR');
        const railRadarResult = await tryFetch('RailRadar', async () => railRadarService.search(sCode, dCode, searchDate));
        if (railRadarResult) {
          winstonLogger.info('[TRAIN_SERVICE] RailRadar returned results');
          sourceUsed = 'RAILRADAR';
          apiUsed = 'RAILRADAR';
          dataSource = 'LIVE';
          directResults = railRadarResult as any[];
          anyProviderSucceeded = true;
        }
      } else {
        const skipLabel = (rrGuard.reason === 'PROVIDER_UNHEALTHY' || rrGuard.reason === 'CIRCUIT_BREAKER_BLOCKED')
          ? '[PROVIDER_SKIPPED_UNHEALTHY]'
          : '[PROVIDER_SKIPPED_DISABLED]';
        winstonLogger.info(`${skipLabel} RAILRADAR | Reason: ${rrGuard.reason}`);
      }
    }


    // 4. Database fallback
    if (!directResults.length) {
      // PHASE_4C931 TASK 2: Log explicitly when ALL live providers have been exhausted
      if (anyProviderAttempted && !anyProviderSucceeded) {
        winstonLogger.warn(
          `[PROVIDER_ALL_FAILED] All live providers exhausted for ${sCode}→${dCode}. ` +
          `Attempted: [${providerAttempted.join(', ')}]. Falling back to DB.`
        );
      } else if (!anyProviderAttempted) {
        winstonLogger.warn(
          `[NO_PROVIDER_AVAILABLE] No live providers enabled/configured for ${sCode}→${dCode}. ` +
          `Falling back to DB.`
        );
      }
      console.warn('⚠️ USING DB FALLBACK');
      try {
        const dbResult = await dbPromise;
        directResults = Array.isArray(dbResult) ? dbResult : [];
      } catch (err: any) {
        console.warn('❌ DB FAILED', err?.message || err);
      }
    } else if (anyProviderSucceeded) {
      // Cross-reference live results with DB baseline to detect CANCELLED trains
      try {
        const dbTrains = await dbPromise;
        if (Array.isArray(dbTrains)) {
          const liveTrainNos = new Set(directResults.map(t => String(t.trainNo || t.train_number || t.train_no || t.number || t.Train_No)));
          for (const dbT of dbTrains) {
            const tNo = String(dbT.trainNo || dbT.train_number || dbT.train_no || dbT.number || dbT.Train_No);
            if (tNo && !liveTrainNos.has(tNo)) {
              winstonLogger.info(`[CANCELLED_TRAIN_DETECTED] ${tNo} found in DB but missing from live provider (${sourceUsed})`);
              const cancelledTrain = {
                ...dbT,
                isCancelled: true,
                status: 'CANCELLED',
                warning: 'This train is cancelled or suspended for this date.',
              };
              directResults.push(cancelledTrain);
            }
          }
        }
      } catch (e: any) {
        winstonLogger.error(`[CANCELLED_CHECK_FAILED] ${e.message}`);
      }
    }

    const direct = this.normalizeAndDeduplicate(directResults || [], searchDate, sCode, dCode);

    if (direct.length > 0 && sourceUsed !== 'DB') {
      cacheService.cacheSearch(sCode, dCode, searchDate, directResults);
    }

    winstonLogger.info(`[TRAIN_SERVICE] source=${sourceUsed} directCount=${direct.length}`);

    // ── Post-normalization: DB name enrichment pass ─────────────────────────
    // For trains that still have no name after live API normalization,
    // attempt a lightweight DB lookup (capped at 10 trains to stay within latency budget).
    const unnamedTrains = direct.filter(t => !t.name);
    if (unnamedTrains.length > 0) {
      const enrichmentTargets = unnamedTrains.slice(0, 10);
      await Promise.allSettled(
        enrichmentTargets.map(async (train) => {
          try {
            const dbName = await dbService.dbLookupTrainName(train.trainNo);
            if (dbName) {
              train.name       = dbName;
              train.train_name = dbName;
              winstonLogger.debug(`[NAME_ENRICH] ${train.trainNo} → "${dbName}" (DB)`);
            } else {
              // Last-resort: synthetic identifier so UI never renders blank
              train.name       = `Train ${train.trainNo}`;
              train.train_name = `Train ${train.trainNo}`;
              winstonLogger.debug(`[NAME_ENRICH] ${train.trainNo} → synthetic fallback`);
            }
          } catch (e: any) {
            // Non-fatal: leave name as null; frontend has its own fallback
            winstonLogger.warn(`[NAME_ENRICH_FAIL] ${train.trainNo}: ${e.message}`);
          }
        })
      );
    }

    // PHASE_4C931 TASK 2: Determine correct status code.
    // success=true ONLY when verified results exist.
    // Explicit status codes replace the blanket success:true masking.
    const liveProviderSucceeded = anyProviderSucceeded && direct.length > 0;
    const dbHasData = sourceUsed === 'DB' && direct.length > 0;
    const nothingFound = direct.length === 0;

    let status: string;
    if (liveProviderSucceeded) {
      status = 'SUCCESS';
    } else if (dbHasData) {
      status = 'DB_FALLBACK';
    } else if (nothingFound && anyProviderAttempted && !anyProviderSucceeded) {
      status = 'LIVE_UNAVAILABLE';
    } else if (nothingFound && !anyProviderAttempted) {
      status = 'NO_PROVIDER_AVAILABLE';
    } else {
      status = 'NO_TRAINS_FOUND';
    }

    return {
      success: direct.length > 0,
      status,
      direct,
      trains: direct,
      source: sourceUsed,
      data_source: dataSource,
      api_used: apiUsed,
      total_found: direct.length,
      warning: nothingFound
        ? `Live search status: ${status}. Attempted providers: [${providerAttempted.join(', ') || 'none'}].`
        : undefined,
    };
  }
  private validateTrain(
    train: any,
    ss: any,
    ds: any,
    searchDate: string
  ): { isValid: boolean; reason?: string; binary?: string } {
    // SAFE VALIDATION PRIORITY - Block only cancelled/suspended/historical trains
    // Check for archived/historical schedules
    if (train.isHistorical || train.historical || train.is_historical) {
      if (process.env.NODE_ENV !== 'production') console.log(`[TRAIN_REJECTED_HISTORICAL] Train ${train.number || train.trainNo} is historical`);
      return { isValid: false, reason: 'HISTORICAL_TRAIN' };
    }

    // Check for cancelled/suspended trains
    const status = (train.status || train.train_status || train.trainName || '').toUpperCase();
    if (status === 'CANCELLED' || status.includes('SUSPENDED') || status.includes('CANCEL')) {
      if (process.env.NODE_ENV !== 'production') console.log(`[TRAIN_REJECTED_CANCELLED] Train ${train.number || train.trainNo} is cancelled/suspended`);
      return { isValid: false, reason: 'CANCELLED_TRAIN' };
    }

    // SOFTEN RUNNING-DAY VALIDATION
    // Only reject if explicit mismatch confirmed
    const rawRunningDays = train.runningDays || train.running_days || train.scheduleDays || train.travelDays;

    // If metadata missing, ALLOW train instead of rejecting
    if (!rawRunningDays) {
      if (process.env.NODE_ENV !== 'production') console.log(`[TRAIN_ALLOWED_METADATA_MISSING] Train ${train.number || train.trainNo} missing running days data, defaulting to true`);
      return { isValid: true, reason: 'METADATA_MISSING' };
    }

    const binary = normalizeRunningDays(rawRunningDays);

    // Only reject if explicit mismatch confirmed
    if (binary && !isDayActive(binary, searchDate)) {
      if (process.env.NODE_ENV !== 'production') console.log(`[TRAIN_REJECTED_NOT_RUNNING] Train ${train.number || train.trainNo} does not run on ${searchDate}`);
      return { isValid: false, reason: 'DAY_MISMATCH', binary: binary.join('') };
    }

    if (ss.SN >= ds.SN) {
      return { isValid: false, reason: 'INVALID_SEQUENCE' };
    }

    return { isValid: true, binary: binary ? binary.join('') : '1111111' };
  }

  private normalizeTrain(dt: any) {
    const safe = (v: any, d = "N/A") => (v !== undefined && v !== null && v !== "" ? v : d);

    return {
      trainNo: String(
        safe(dt.number || dt.train_number || dt.trainNo, "00000")
      ),
      trainName: safe(
        dt.train_name || dt.name || dt.trainName,
        undefined
      ),
      from: safe(
        dt.fromStationCode || dt.source || dt.from,
        "N/A"
      ),
      to: safe(
        dt.toStationCode || dt.destination || dt.to,
        "N/A"
      ),
      departure: safe(
        dt.departureTime || dt.departure,
        "--:--"
      ),
      arrival: safe(
        dt.arrivalTime || dt.arrival,
        "--:--"
      ),
      duration:
        typeof dt.duration_mins === "number"
          ? dt.duration_mins
          : 0,
      total_journey_time: dt.total_journey_time || `${Math.floor((dt.duration_mins || 0) / 60)}h ${(dt.duration_mins || 0) % 60}m`,
      type: dt.type || "Express",
      travelDate: dt.travelDate,
      _isLive: !!dt._isLive,
      api_used: dt.api_used || "DATABASE"
    };
  }

  async searchDirect(source: string, destination: string, searchDate?: string): Promise<any[]> {
    if (!isSupabaseConfigured()) return [];

    const s = source.toUpperCase().trim();
    const d = destination.toUpperCase().trim();
    if (!s || !d || s === d) return [];

    const matchingTrains: any[] = [];

    try {
      let [sourceRes, destRes] = await Promise.all([
        supabase.from('train_schedule').select('*').eq('Station_Code', s).order('SN'),
        supabase.from('train_schedule').select('*').eq('Station_Code', d).order('SN'),
      ]);

      if (sourceRes.data?.length === 0 && s === 'CSMT') {
        sourceRes = await supabase.from('train_schedule').select('*').eq('Station_Code', 'CSTM').order('SN');
      }
      if (destRes.data?.length === 0 && d === 'CSMT') {
        destRes = await supabase.from('train_schedule').select('*').eq('Station_Code', 'CSTM').order('SN');
      }

      const sources = (sourceRes.data || []).map((row: any) => ({
        ...row,
        Train_No: normalizeTrainNumber(row.Train_No.toString())
      }));
      const destinations = (destRes.data || []).map((row: any) => ({
        ...row,
        Train_No: normalizeTrainNumber(row.Train_No.toString())
      }));

      if (sources.length === 0 || destinations.length === 0) return [];

      const trainNumbers = [
        ...new Set([
          ...sources.map((row: any) => row.Train_No),
          ...destinations.map((row: any) => row.Train_No),
        ]),
      ];

      const { data: metaData } = await supabase
        .from('trains')
        .select('number, name, type, running_days')
        .in('number', trainNumbers);

      const metaMap = new Map((metaData || []).map((row: any) => [row.number, row]));

      // Dynamically compute day numbers for stations because train_schedule lacks Day_number column
      const { data: allSchedules } = await supabase
        .from('train_schedule')
        .select('Train_No, Station_Code, SN, Arrival_time, Departure_Time')
        .in('Train_No', trainNumbers)
        .order('SN');

      const dayNumberMap = new Map<string, number>();
      if (allSchedules && allSchedules.length > 0) {
        const trainGroups: Record<string, any[]> = {};
        for (const row of allSchedules) {
          const tNo = normalizeTrainNumber(row.Train_No.toString());
          if (!trainGroups[tNo]) trainGroups[tNo] = [];
          trainGroups[tNo].push(row);
        }

        const parseToMins = (time: string): number => {
          if (!time) return 0;
          const [h, m] = time.split(':').map(Number);
          return (h || 0) * 60 + (m || 0);
        };

        for (const [tNo, stations] of Object.entries(trainGroups)) {
          stations.sort((a, b) => a.SN - b.SN);
          let currentDay = 1;
          let prevMins = 0;
          for (let i = 0; i < stations.length; i++) {
            const station = stations[i];
            const arrMins = parseToMins(station.Arrival_time);
            const depMins = parseToMins(station.Departure_Time);
            if (i > 0) {
              if (arrMins < prevMins) {
                currentDay++;
              }
            }
            dayNumberMap.set(`${tNo}_${station.Station_Code}_${station.SN}`, currentDay);
            if (depMins < arrMins) {
              currentDay++;
            }
            prevMins = depMins;
          }
        }
      }

      for (const ss of sources) {
        const potentialDests = destinations.filter(
          (ds: any) => ds.Train_No.toString() === ss.Train_No.toString()
        );

        for (const ds of potentialDests) {
          const meta = metaMap.get(ss.Train_No.toString()) || {};
          const validation = this.validateTrain(meta, ss, ds, searchDate || '');
          if (!validation.isValid) continue;

          const depDay = dayNumberMap.get(`${ss.Train_No}_${ss.Station_Code}_${ss.SN}`) || 1;
          const arrDay = dayNumberMap.get(`${ds.Train_No}_${ds.Station_Code}_${ds.SN}`) || 1;

          const durationMins =
            rankingService.calculateCorrectDuration?.(
              ss.Departure_Time,
              ds.Arrival_time,
              depDay,
              arrDay
            ) || 0;

          matchingTrains.push({
            id: `db-${ss.Train_No}`,
            trainNo: ss.Train_No.toString(),
            name: meta.name || null, // never fabricate names
            fromStationCode: ss.Station_Code,
            toStationCode: ds.Station_Code,
            source: ss.Station_Name,
            destination: ds.Station_Name,
            departure: ss.Departure_Time,
            arrival: ds.Arrival_time,
            duration_mins: durationMins,
            total_journey_time: rankingService.formatDuration?.(durationMins) || '',
            type: meta.type || 'Express',
            travelDate: searchDate,
            _rawCategory: 'direct',
            _isLive: false,
            api_used: 'DATABASE',
          });
        }
      }

      return matchingTrains;
    } catch (err: any) {
      winstonLogger.error(`[TRAIN_DIRECT] Failed: ${err.message}`);
      return [];
    }
  }

  async searchAdvanced(
    source: string,
    destination: string,
    date?: string,
    options?: { includeSplit?: boolean } | boolean
  ) {
    const searchDate = date || new Date().toISOString().split('T')[0];
    const includeSplit =
      typeof options === 'boolean'
        ? options
        : options?.includeSplit === true;

    winstonLogger.info(`[TRAIN_SEARCH] ${source} -> ${destination} | ${searchDate}`);

    const [sResolved, dResolved] = await Promise.all([
      stationService.getStationsForCity(source),
      stationService.getStationsForCity(destination),
    ]);
    const sCode = sResolved[0] || source.toUpperCase();
    const dCode = dResolved[0] || destination.toUpperCase();

    const trainData = await this.getTrainData(source, destination, searchDate);
    const normalizedDirect = trainData.direct;
    const best = normalizedDirect.slice(0, 3);

    this._persistSearchAsync(source, destination, searchDate, normalizedDirect, trainData.data_source === 'LIVE');

    // Implement split journey functionality when includeSplit is true
    let finalSplits: any[] = [];
    let splitRecommended = false;

    if (includeSplit) {
      try {
        const { splitJourneyEngine } = await import('./splitJourneyEngine');

        let splitTimer: NodeJS.Timeout | undefined;
        const splitTimeout = new Promise<any>((resolve) => {
          splitTimer = setTimeout(() => {
            winstonLogger.warn('[TRAIN_SEARCH] Split search timed out after 28s');
            resolve({ split: [], smart_routes: [], message: 'Search timeout' });
          }, 28000);
        });

        const splitSearchPromise = splitJourneyEngine.findCombinedRoutes(
          source.toUpperCase(),
          destination.toUpperCase(),
          searchDate,
          normalizedDirect,
          undefined,
          { classType: '3A', quota: 'GN' }
        );

        const splitResult = await Promise.race([splitSearchPromise, splitTimeout]).finally(() => {
          if (splitTimer) clearTimeout(splitTimer);
        }) as any;

        // findCombinedRoutes already runs findSegmentSplits once (PHASE_4C868)
        const rawSplits = Array.isArray(splitResult)
          ? splitResult
          : (splitResult?.split || splitResult?.smart_routes || []);

        const mergedSplits = rawSplits;

        // Deduplicate splits
        const seen = new Set<string>();
        const uniqueSplits = mergedSplits.filter((s: any) => {
          if (!s) return false;
          const leg1No = s.leg1?.trainNo || s.legs?.[0]?.trainNo || '';
          const leg2No = s.leg2?.trainNo || s.legs?.[1]?.trainNo || '';
          const key = `${s.hub}_${leg1No}_${leg2No}_${s.leg1?.departure || ''}`;
          if (seen.has(key)) return false;
          seen.add(key);
          return true;
        });

        const { rankingService } = await import('./rankingService');
        const rankedSplits = rankingService.rankTrains(uniqueSplits);

        finalSplits = rankedSplits.slice(0, 5); // NEVER more than 5
        splitRecommended = finalSplits.length > 0;
        winstonLogger.info(`[TRAIN_SEARCH] Split results: ${finalSplits.length}`);
      } catch (error) {
        console.warn('❌ Split search failed', error);
        finalSplits = [];
        splitRecommended = false;
      }
    }

    return {
      success: trainData.success || splitRecommended,
      status: trainData.status,
      direct: normalizedDirect,
      trains: normalizedDirect,
      best,
      split: finalSplits,
      smart_routes: finalSplits,
      split_recommended: splitRecommended,
      isAISuggestion: false,
      data_source: trainData.data_source,
      api_used: trainData.api_used,
      total_found: normalizedDirect.length,
      message: normalizedDirect.length > 0
        ? 'Trains found'
        : splitRecommended
          ? 'Better options available via split'
          : 'No direct trains found. Try split journey search.',
      warning: trainData.warning,
      timestamp: new Date().toISOString(),
    };
  }

  private normalizeAndDeduplicate(
    trains: any[],
    date: string,
    sourceCode: string,
    destinationCode: string
  ): any[] {
    const seen = new Set<string>();
    const unique: any[] = [];

    for (const t of trains) {
      const normalized = this.normalizeSingleTrain(t, date);
      const trainNo = String(normalized.trainNo || '');
      if (!trainNo) continue;

      const key = `${trainNo}_${normalized.fromStationCode}`;
      if (seen.has(key)) continue;

      seen.add(key);
      unique.push(normalized);
    }

    return unique;
  }

  private stationMatches(actual: string, expected: string): boolean {
    const normalizedActual = String(actual || '').toUpperCase().trim();
    const normalizedExpected = String(expected || '').toUpperCase().trim();

    if (normalizedActual === normalizedExpected) return true;

    const aliases: Record<string, string[]> = {
      CSMT: ['CSTM'],
      CSTM: ['CSMT'],
    };

    return (aliases[normalizedExpected] || []).includes(normalizedActual);
  }

  private normalizeSingleTrain(t: any, date: string): any {
    const trainNo = String(t.train_no || t.train_number || t.trainNo || t.number || t.Train_No || '');

    // ── Strengthened name extraction ────────────────────────────────────────
    // Covers all known API field variants (case-sensitive and capitalised forms)
    // from IRCTC, RailRadar, RapidAPI, and DB sources.
    const name: string | null = (
      t.train_name   ||
      t.trainName    ||
      t.Train_Name   ||
      t.TRAIN_NAME   ||
      t.name         ||
      t.Name         ||
      t.train?.name  ||
      t.train?.trainName ||
      null
    );

    return {
      id: `live-${trainNo}`,
      trainNo,
      name,
      number: trainNo,
      train_number: trainNo,
      train_name: name,
      fromStationCode: t.from_stn_code || t.from_station_code || t.fromStnCode || t.fromStationCode || '',
      toStationCode: t.to_stn_code || t.to_station_code || t.toStnCode || t.toStationCode || '',
      source: t.from_stn_name || t.from_station_name || t.from_sta_name || t.source || '',
      destination: t.to_stn_name || t.to_station_name || t.to_sta_name || t.destination || '',
      departure: (t.from_time || t.departure_time || t.departure || '').slice(0, 5),
      arrival: (t.to_time || t.arrival_time || t.arrival || '').slice(0, 5),
      duration_mins: t.duration_mins || t.duration || 0,
      total_journey_time:
        t.travel_time ||
        t.total_journey_time ||
        rankingService.formatDuration?.(t.duration_mins || 0) ||
        '',
      type: t.type || t.train_type || 'Express',
      travelDate: date,
      _isLive: true,
      api_used: 'LIVE',
      isCancelled: t.isCancelled || false,
      status: t.status || undefined,
      warning: t.warning || undefined,
    };
  }

  private _persistSearchAsync(
    source: string,
    destination: string,
    date: string,
    ranked: any[],
    apiSuccess: boolean
  ) {
    setImmediate(async () => {
      try {
        if (ranked.length > 0) {
          await dbService.saveSearchToDB({
            source,
            destination,
            date,
            trains: ranked.slice(0, 10),
            api_used: apiSuccess ? 'LIVE' : 'DATABASE',
          });
        }
        await dbService.saveSearchPopularity({ source, destination });
      } catch (e: any) {
        winstonLogger.debug(`[PERSIST] Background save failed: ${e.message}`);
      }
    });
  }

  generateTwitterUrl(
    trainNo: string,
    coachOrDate: string = 'N/A',
    issue: string = 'Journey Issue'
  ): string {
    const text = `Trayago Alert\nTrain: ${trainNo} | Issue: ${issue}\nContext: ${coachOrDate}\n\nImmediate attention required @RailMinIndia @RailMadad @RailwaySeva #IndianRailways #Trayago`;
    return `https://twitter.com/intent/tweet?text=${encodeURIComponent(text)}`;
  }

  /**
   * Returns train metadata: name, type, days of operation, total distance.
   * Queries the train_schedules table for schedule-level metadata.
   * Returns null if no data found — controller handles gracefully.
   */
  async getTrainMetadata(trainNo: string): Promise<{
    trainNo: string;
    trainName: string;
    trainType: string;
    daysOfWeek: string[];
    totalDistance: number | null;
  } | null> {
    try {
      const { dbService } = await import('./dbService');
      const supabase = (dbService as any).supabase;
      if (!supabase) return null;

      const { data, error } = await supabase
        .from('train_schedules')
        .select('train_number, train_name, train_type, days_of_week, total_distance')
        .eq('train_number', trainNo.toString())
        .maybeSingle();

      if (error || !data) return null;

      return {
        trainNo: data.train_number,
        trainName: data.train_name || 'Unknown Train',
        trainType: data.train_type || 'EXPRESS',
        daysOfWeek: Array.isArray(data.days_of_week) ? data.days_of_week : [],
        totalDistance: data.total_distance ?? null,
      };
    } catch {
      return null;
    }
  }

  /**
   * Returns coach composition for a train.
   * Queries train_coaches table if it exists; graceful null return otherwise.
   */
  async getCoachComposition(trainNo: string): Promise<{
    trainNo: string;
    coaches: { class: string; count: number; position: number }[];
  } | null> {
    try {
      const { dbService } = await import('./dbService');
      const supabase = (dbService as any).supabase;
      if (!supabase) return null;

      const { data, error } = await supabase
        .from('train_coaches')
        .select('coach_class, coach_count, position')
        .eq('train_number', trainNo.toString())
        .order('position', { ascending: true });

      if (error || !data || data.length === 0) return null;

      return {
        trainNo,
        coaches: data.map((c: any) => ({
          class: c.coach_class,
          count: c.coach_count,
          position: c.position,
        })),
      };
    } catch {
      return null;
    }
  }

  /**
   * Returns historical delay patterns for a train by day of week.
   * Queries stop_times or delay_patterns table.
   * Returns null if no data available.
   */
  async getDelayHistory(trainNo: string): Promise<{
    trainNo: string;
    averageDelayMinutes: number;
    byDayOfWeek: Record<string, number>;
    sampleSize: number;
  } | null> {
    try {
      const { dbService } = await import('./dbService');
      const supabase = (dbService as any).supabase;
      if (!supabase) return null;

      const { data, error } = await supabase
        .from('delay_patterns')
        .select('day_of_week, avg_delay_minutes, sample_count')
        .eq('train_number', trainNo.toString());

      if (error || !data || data.length === 0) return null;

      const byDay: Record<string, number> = {};
      let totalDelay = 0;
      let totalSamples = 0;

      for (const row of data) {
        byDay[row.day_of_week] = row.avg_delay_minutes ?? 0;
        totalDelay += (row.avg_delay_minutes ?? 0) * (row.sample_count ?? 1);
        totalSamples += row.sample_count ?? 1;
      }

      return {
        trainNo,
        averageDelayMinutes: totalSamples > 0 ? Math.round(totalDelay / totalSamples) : 0,
        byDayOfWeek: byDay,
        sampleSize: totalSamples,
      };
    } catch {
      return null;
    }
  }
}

export const trainService = new TrainService();
