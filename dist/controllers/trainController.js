"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.trainController = exports.TrainController = void 0;
const featureFlags_1 = require("../config/featureFlags");
const logger_1 = require("../middleware/logger");
const authService_1 = require("../services/authService");
const complaintService_1 = require("../services/complaintService");
const liveTrackingService_1 = require("../services/liveTrackingService");
const llmService_1 = require("../services/llmService");
const splitJourneyEngine_1 = require("../services/splitJourneyEngine");
const trainService_1 = require("../services/trainService");
const normalizeLiveTrain_1 = require("../utils/normalizeLiveTrain");
const cacheService_1 = require("../services/cacheService");
const alertService_1 = require("../services/alertService");
const selfLearningService_1 = require("../services/selfLearningService");
const knowledgeMetricsService_1 = require("../services/knowledgeMetricsService");
const rankingService_1 = require("../services/rankingService");
const segmentAvailabilityEngine_1 = require("../services/segmentAvailabilityEngine");
class TrainController {
    constructor() {
        /**
         * Main Train Search Endpoint
         */
        this.search = async (req, res) => {
            try {
                const payload = {
                    source: (req.body.source || req.query.source || req.body.from || req.query.from),
                    destination: (req.body.destination || req.query.destination || req.body.to || req.query.to),
                    date: (req.body.date || req.query.date),
                    classType: (req.body.classType || req.query.classType),
                    quota: (req.body.quota || req.query.quota),
                    isAISuggestion: req.body.isAISuggestion === true,
                    includeSplit: req.body.includeSplit === true ||
                        req.query.includeSplit === 'true'
                };
                if (!payload.source || !payload.destination) {
                    return res.status(400).json({
                        success: false,
                        error: 'Source and Destination are required'
                    });
                }
                logger_1.winstonLogger.info(`[CONTROLLER] Search request: ${payload.source} → ${payload.destination}`);
                // ── STEP 1: Direct train search — 8s guard ───────────────────────────────────────────
                let directTimer;
                const directTimeout = new Promise((resolve) => {
                    directTimer = setTimeout(() => {
                        logger_1.winstonLogger.warn('[CONTROLLER] Direct search timed out after 8s');
                        // PHASE_4C931: Timeout path must carry success+status so the response builder
                        // never emits status:undefined regardless of which Promise.race branch wins.
                        resolve({ direct: [], trains: [], split: [], success: false, status: 'NO_TRAINS_FOUND' });
                    }, 8000);
                });
                const results = await Promise.race([
                    trainService_1.trainService.searchAdvanced(payload.source, payload.destination, payload.date, { includeSplit: payload.includeSplit }),
                    directTimeout
                ]).finally(() => {
                    if (directTimer)
                        clearTimeout(directTimer);
                });
                const allTrains = (results.direct || results.trains || []).map((t) => ({
                    ...t,
                    risk_level: this.calculateRisk(t)
                }));
                logger_1.winstonLogger.info(`[CONTROLLER] Direct trains found: ${allTrains.length}`);
                // ── STEP 2: AI enhancement — 3s guard ──────────────────────────────────
                const aiPromise = Promise.all(allTrains.slice(0, 3).map(async (train) => {
                    const aiInsight = await llmService_1.llmService.getRouteAnalysis?.({
                        source: payload.source,
                        destination: payload.destination,
                        trains: [train],
                        isSplit: false
                    }).catch(() => null);
                    return { ...train, ai_insight: aiInsight?.insight || null };
                }));
                let aiTimer;
                const aiTimeout = new Promise((resolve) => {
                    aiTimer = setTimeout(() => resolve(allTrains.slice(0, 3)), 3000);
                });
                const bestTrains = await Promise.race([aiPromise, aiTimeout]).finally(() => {
                    if (aiTimer)
                        clearTimeout(aiTimer);
                });
                // ── STEP 3: Reuse split from searchAdvanced (PHASE_4C880 — avoid duplicate engine run) ──
                let finalSplits = [];
                if (payload.includeSplit) {
                    knowledgeMetricsService_1.knowledgeMetricsService.beginSearchContext(payload.source, payload.destination);
                    knowledgeMetricsService_1.knowledgeMetricsService.recordDuplicateSplitPrevented();
                    const rawSplits = results.split || results.smart_routes || [];
                    const mergedSplits = rawSplits;
                    // Deduplicate splits
                    const seen = new Set();
                    const uniqueSplits = mergedSplits.filter((s) => {
                        if (!s)
                            return false;
                        const leg1No = s.leg1?.trainNo || s.legs?.[0]?.trainNo || '';
                        const leg2No = s.leg2?.trainNo || s.legs?.[1]?.trainNo || '';
                        const key = `${s.hub}_${leg1No}_${leg2No}_${s.leg1?.departure || ''}`;
                        if (seen.has(key))
                            return false;
                        seen.add(key);
                        return true;
                    });
                    const rankedSplits = rankingService_1.rankingService.rankTrains(uniqueSplits);
                    finalSplits = rankedSplits.slice(0, 5); // NEVER more than 5
                    logger_1.winstonLogger.info(`[CONTROLLER] Split results: ${finalSplits.length}`);
                    knowledgeMetricsService_1.knowledgeMetricsService.endSearchContext();
                }
                const responseBody = {
                    // PHASE_4C931: Pass through success and status from service/timeout — do NOT hardcode success:true
                    success: results.success || finalSplits.length > 0,
                    status: results.status,
                    all: allTrains,
                    best: bestTrains,
                    direct: allTrains,
                    split: finalSplits,
                    smart_routes: finalSplits,
                    split_recommended: finalSplits.length > 0,
                    message: finalSplits.length > 0
                        ? 'Better options available via split'
                        : (allTrains.length > 0 ? 'Trains found' : 'No trains found'),
                    data_source: results.data_source || results.dataSource || 'LIVE',
                    api_used: results.api_used,
                    total_found: allTrains.length,
                    source: results.source,
                    warning: results.warning,
                    smart_suggestions: {
                        best_route: bestTrains[0] || null,
                        fastest_route: [...allTrains].sort((a, b) => (a.duration_mins || 9999) - (b.duration_mins || 9999))[0] || null
                    },
                    timestamp: new Date().toISOString()
                };
                logger_1.winstonLogger.info(`[CONTROLLER] Response: direct=${responseBody.direct?.length} split=${responseBody.split?.length}`);
                return res.status(200).json(responseBody);
            }
            catch (err) {
                logger_1.winstonLogger.error(`[TRAIN_CONTROLLER] Search failed: ${err.message}`);
                return res.status(500).json({
                    success: false,
                    error: 'Search failed. Please try again.',
                    message: err.message
                });
            }
        };
        this.searchAdvanced = async (req, res) => {
            try {
                // P0-4 (PHASE_4C885): capture wall-time here — timeTakenMs must be actual elapsed ms,
                // NOT Date.now() - Date.parse(date) which produces epoch-deltas in the billions
                // and overflows a Postgres integer column (max 2,147,483,647).
                const searchStart = Date.now();
                const source = (req.body.source || req.query.source || req.body.from || req.query.from);
                const destination = (req.body.destination || req.query.destination || req.body.to || req.query.to);
                const date = (req.body.date || req.query.date);
                const includeSplit = req.body.includeSplit === true ||
                    req.query.includeSplit === 'true';
                if (!source || !destination) {
                    return res.status(400).json({ success: false, error: 'Source and Destination are required' });
                }
                // Check if user can use this feature
                const userId = req.headers['x-user-id'] || null;
                const deviceId = req.headers['x-device-id'];
                const betaCode = req.headers['x-beta-code'];
                if (userId || betaCode) {
                    // Authenticated user or beta - check usage limits
                    const canUse = await authService_1.authService.canUseFeature(userId, 'search', betaCode);
                    if (!canUse) {
                        return res.status(403).json({
                            success: false,
                            error: "limit_exceeded",
                            message: "Upgrade to continue"
                        });
                    }
                    // Increment usage count
                    await authService_1.authService.incrementUsage(userId, 'search', betaCode);
                }
                else {
                    // Guest user
                }
                logger_1.winstonLogger.info(`[ADVANCED] ${source} → ${destination} | split=${includeSplit}`);
                const [memoryRoutes, trainData] = await Promise.all([
                    selfLearningService_1.selfLearningService.getRouteMemory(source, destination).catch((err) => {
                        logger_1.winstonLogger.warn(`[ADVANCED] Failed to check route memory: ${err.message}`);
                        return [];
                    }),
                    trainService_1.trainService.getTrainData(source, destination, date),
                ]);
                const allTrains = (trainData?.direct || []).map((t) => ({
                    ...t,
                    risk_level: this.calculateRisk(t)
                }));
                logger_1.winstonLogger.info(`[ADVANCED] source=${trainData.source} directCount=${allTrains.length}`);
                let finalSplits = [];
                if (includeSplit) {
                    // Check if user can use split feature
                    const userId = req.headers['x-user-id'] || null;
                    const betaCode = req.headers['x-beta-code'];
                    let canUse = false;
                    if (userId || betaCode) {
                        canUse = await authService_1.authService.canUseSplit(userId, betaCode);
                    }
                    const effectiveClass2 = (req.body.classType || req.query.classType || '');
                    if (!effectiveClass2) {
                        logger_1.winstonLogger.info('[ADVANCED] classType not specified — defaulting to 3A for segment scan');
                    }
                    const splitQuota = (req.body.quota || req.query.quota || 'GN');
                    const splitRouteOptions = { classType: effectiveClass2 || '3A', quota: splitQuota };
                    knowledgeMetricsService_1.knowledgeMetricsService.beginSearchContext(source, destination);
                    const runSplitAttempt = async (timeoutMs) => {
                        let splitTimer;
                        const timeoutPromise = new Promise((_, reject) => {
                            splitTimer = setTimeout(() => reject(new Error("Split timeout")), timeoutMs);
                        });
                        const result = await Promise.race([
                            splitJourneyEngine_1.splitJourneyEngine.findCombinedRoutes(source, destination, date, allTrains, undefined, splitRouteOptions),
                            timeoutPromise
                        ]).finally(() => {
                            if (splitTimer)
                                clearTimeout(splitTimer);
                        }).catch(() => ({
                            direct: [],
                            split: [],
                            smart_routes: [],
                            split_recommended: false,
                            message: "Search took longer than expected. Try again."
                        }));
                        return result;
                    };
                    const execStart = Date.now();
                    let splitResult = await runSplitAttempt(55000);
                    const firstEmpty = Array.isArray(splitResult)
                        ? splitResult.length === 0
                        : (splitResult?.split || []).length === 0;
                    const firstTimedOut = splitResult?.message === 'Search took longer than expected. Try again.';
                    // PHASE_4C880: retry only on timeout — not when engine completed with zero splits
                    if (firstEmpty && firstTimedOut) {
                        splitResult = await runSplitAttempt(20000);
                    }
                    // findCombinedRoutes already runs findSegmentSplits once — do not invoke again (PHASE_4C868)
                    knowledgeMetricsService_1.knowledgeMetricsService.recordDuplicateSplitPrevented();
                    const rawSplits = Array.isArray(splitResult)
                        ? splitResult
                        : (splitResult?.split || splitResult?.smart_routes || []);
                    const mergedSplits = rawSplits;
                    // Deduplicate splits
                    const seen = new Set();
                    const uniqueSplits = mergedSplits.filter((s) => {
                        if (!s)
                            return false;
                        const leg1No = s.leg1?.trainNo || s.legs?.[0]?.trainNo || '';
                        const leg2No = s.leg2?.trainNo || s.legs?.[1]?.trainNo || '';
                        const key = `${s.hub}_${leg1No}_${leg2No}_${s.leg1?.departure || ''}`;
                        if (seen.has(key))
                            return false;
                        seen.add(key);
                        return true;
                    });
                    const rankedSplits = rankingService_1.rankingService.rankTrains(uniqueSplits);
                    const slicedSplits = rankedSplits.slice(0, 20);
                    if (!canUse) {
                        logger_1.winstonLogger.info('[ADVANCED] User split limit exceeded/guest access, returning locked split preview');
                        finalSplits = slicedSplits.map((route) => ({
                            ...route,
                            isLocked: true,
                            leg1: route.leg1 ? {
                                ...route.leg1,
                                trainNo: "XXXXX",
                                trainName: "AI Split Train",
                                departure: "XX:XX",
                                arrival: "XX:XX",
                                availability: "Unlock to view status"
                            } : null,
                            leg2: route.leg2 ? {
                                ...route.leg2,
                                trainNo: "XXXXX",
                                trainName: "AI Split Train",
                                departure: "XX:XX",
                                arrival: "XX:XX",
                                availability: "Unlock to view status"
                            } : null,
                            steps: ["Unlock this route to view booking steps"],
                            ai_insight: "Upgrade to Safar Pro to read full analysis of this alternate route.",
                            ai_reason: "Unlock to show seat recommendation rationale.",
                            irctcUrl: null
                        }));
                    }
                    else {
                        finalSplits = slicedSplits;
                    }
                    const execTime = Date.now() - execStart;
                    knowledgeMetricsService_1.knowledgeMetricsService.recordSearchLatency(execTime, `${source}→${destination}`);
                    knowledgeMetricsService_1.knowledgeMetricsService.endSearchContext();
                    if (finalSplits.length > 0) {
                        logger_1.winstonLogger.info(`[CONTROLLER_SUCCESS] route=${source}→${destination} time=${execTime}ms splits=${finalSplits.length} totalFound=${rawSplits.length}`);
                    }
                    else {
                        logger_1.winstonLogger.warn(`[CONTROLLER_TIMEOUT] route=${source}→${destination} time=${execTime}ms splits=0 totalFound=0`);
                    }
                }
                logger_1.winstonLogger.info(`[ADVANCED] finalSplits=${finalSplits.length} | source=${source} dest=${destination}`);
                if (finalSplits.length === 0) {
                    logger_1.winstonLogger.warn('[ADVANCED] Returning 0 splits to frontend');
                }
                // PHASE_4C880: defer non-critical learning writes — do not block response
                setImmediate(() => {
                    try {
                        const { learningService } = require('../services/learningService');
                        learningService.logSearch(source.toUpperCase(), destination.toUpperCase(), date, deviceId || 'anonymous', userId || null, allTrains.length, Date.now() - searchStart).catch((saveError) => {
                            logger_1.winstonLogger.error(`[SEARCH_LEARNING] Failed to log search for route: ${source} → ${destination}: ${saveError.message}`);
                        });
                        learningService.trackApiUsage('search').catch(() => { });
                    }
                    catch (saveError) {
                        logger_1.winstonLogger.error(`[SEARCH_LEARNING] Failed to log search for route: ${source} → ${destination}: ${saveError.message}`);
                    }
                });
                logger_1.winstonLogger.info(`[ADVANCED] API response: split=${finalSplits.length} hubs=[${finalSplits.map(s => s.hub || s.via).join(',')}]`);
                if (allTrains.length === 0) {
                    setImmediate(() => {
                        selfLearningService_1.selfLearningService.logMissingQuery(source, destination, date, userId).catch(() => { });
                    });
                }
                if (includeSplit && finalSplits.length === 0) {
                    setImmediate(() => {
                        selfLearningService_1.selfLearningService.logMissingRoute(source, destination, userId).catch(() => { });
                    });
                }
                return res.json({
                    success: true,
                    all: allTrains,
                    direct: allTrains,
                    split: finalSplits,
                    smart_routes: finalSplits,
                    memory_routes: memoryRoutes || [],
                    split_recommended: finalSplits.length > 0 || (memoryRoutes && memoryRoutes.length > 0),
                    message: includeSplit
                        ? (finalSplits.length > 0 ? 'Split routes available' : 'Fallback split route provided')
                        : (allTrains.length > 0 ? 'Trains found' : 'No direct trains found'),
                    data_source: trainData.data_source || 'LIVE',
                    api_used: trainData.api_used,
                    total_found: allTrains.length,
                    warning: trainData.warning,
                    timestamp: new Date().toISOString()
                });
            }
            catch (err) {
                logger_1.winstonLogger.error('❌ search-advanced error:', err);
                logger_1.winstonLogger.error(`[ADVANCED] Failed: ${err.message}`);
                return res.json({
                    success: false,
                    direct: [],
                    split: [],
                    smart_routes: [],
                    message: 'Search failed'
                });
            }
        };
        /**
         * Live Train Status
         */
        this.getLiveStatus = async (req, res) => {
            const { trainNo } = req.params;
            const { date } = req.query;
            // Check if user can use this feature
            const userId = req.headers['x-user-id'] || null;
            const deviceId = req.headers['x-device-id'];
            const betaCode = req.headers['x-beta-code'];
            if (userId || betaCode) {
                // Authenticated user or beta - check usage limits
                const canUse = await authService_1.authService.canUseFeature(userId, 'live', betaCode);
                if (!canUse) {
                    return res.status(403).json({
                        success: false,
                        error: "limit_exceeded",
                        message: "Upgrade to continue"
                    });
                }
                // Increment usage count
                await authService_1.authService.incrementUsage(userId, 'live', betaCode);
            }
            else {
                // Guest user
            }
            try {
                const live = await liveTrackingService_1.liveTrackingService.getTrainRunningStatus(trainNo, (date || new Date().toISOString().split('T')[0]));
                if (live) {
                    const normalizedLive = (0, normalizeLiveTrain_1.normalizeLiveTrainData)(live);
                    try {
                        const { learningService } = require('../services/learningService');
                        await learningService.logLiveTrain(trainNo, normalizedLive.currentStation || 'Unknown', normalizedLive.delay || 0, 0, // speed
                        normalizedLive.stations?.[0]?.arrival_time || '', normalizedLive.stations?.[0]?.departure_time || '', live.api_used || 'RAILRADAR');
                        await learningService.trackApiUsage('live');
                    }
                    catch (e) { }
                    // Alert dispatch logic
                    try {
                        const sessionId = userId || deviceId || null;
                        if (sessionId) {
                            // 1. Train delay alert wiring
                            if (normalizedLive.delay > 30) {
                                await alertService_1.alertService.triggerTrainDelayAlert(sessionId, trainNo, normalizedLive.delay);
                            }
                            // 2. Platform change tracking and alert wiring
                            const stations = normalizedLive.stations || [];
                            for (const stop of stations) {
                                if (stop.platform) {
                                    const platformCacheKey = `platform_no:${trainNo}:${stop.station_code}`;
                                    const cachedPlatform = cacheService_1.cacheService.get(platformCacheKey);
                                    if (cachedPlatform && cachedPlatform !== stop.platform) {
                                        // Platform changed! Trigger platform change alert
                                        await alertService_1.alertService.triggerPlatformChangeAlert(sessionId, trainNo, stop.station_name, cachedPlatform, stop.platform);
                                    }
                                    // Cache the platform for 24 hours to track future changes
                                    cacheService_1.cacheService.set(platformCacheKey, stop.platform, 86400);
                                }
                            }
                        }
                    }
                    catch (alertErr) {
                        logger_1.winstonLogger.warn(`[TRAIN_CONTROLLER] Failed to evaluate live alerts: ${alertErr.message}`);
                    }
                    res.json({
                        success: true,
                        data: normalizedLive,
                        source: live.api_used || 'LIVE'
                    });
                }
                else {
                    setImmediate(() => {
                        selfLearningService_1.selfLearningService.logMissingTrain(trainNo, userId).catch(() => { });
                    });
                    res.status(404).json({ success: false, error: 'Live status not available' });
                }
            }
            catch (err) {
                logger_1.winstonLogger.error(`[TRAIN_CONTROLLER] Live status failed: ${err.message}`);
                res.status(500).json({ success: false, error: 'Failed to fetch live status' });
            }
        };
        this.addComplaint = async (req, res) => {
            try {
                const { trainNo, category, description, seatNo, coach, date, priority } = req.body;
                const userId = req.headers['x-user-id'] || null;
                const success = await complaintService_1.complaintService.addComplaint({
                    trainNo,
                    issueType: category,
                    coach: coach || 'N/A',
                    seat: seatNo,
                    date: date || new Date().toISOString().split('T')[0],
                    priority: priority || 'medium',
                    reported_by: userId || undefined
                });
                res.json({ success: !!success });
            }
            catch (err) {
                res.status(500).json({ success: false, error: err.message });
            }
        };
        this.getComplaints = async (req, res) => {
            try {
                const { trainNo } = req.params;
                const stats = await complaintService_1.complaintService.getComplaintAggregation(trainNo);
                res.json({ success: true, stats });
            }
            catch (err) {
                res.status(500).json({ success: false, error: err.message });
            }
        };
        /**
         * POST /api/trains/same-train-rescue
         * User-triggered Same Train Rescue — finds hidden confirmed seats on the
         * SAME train the user has already selected, via mid-journey hub segments.
         *
         * Body: { trainNo, source, destination, journeyDate, classCode }
         * Returns: { success, trainNo, rescueOptions[] }
         */
        this.sameTrainRescue = async (req, res) => {
            try {
                const trainNo = (req.body.trainNo || req.body.train_no);
                const source = (req.body.source || req.body.from);
                const destination = (req.body.destination || req.body.to);
                const journeyDate = (req.body.journeyDate || req.body.date);
                const classCode = (req.body.classCode || req.body.classType || '3A');
                const quota = (req.body.quota || 'GN');
                // ── Validation ────────────────────────────────────────────────────────
                if (!trainNo || !source || !destination || !journeyDate) {
                    return res.status(400).json({
                        success: false,
                        error: 'trainNo, source, destination, and journeyDate are required'
                    });
                }
                if (!/^\d{4,5}$/.test(trainNo.trim())) {
                    return res.status(400).json({
                        success: false,
                        error: 'trainNo must be a 4–5 digit number'
                    });
                }
                if (source.toUpperCase() === destination.toUpperCase()) {
                    return res.status(400).json({
                        success: false,
                        error: 'source and destination cannot be the same'
                    });
                }
                // ── Auth / quota check + Pro split gate (mirrors searchAdvanced) ─────────
                const userId = req.headers['x-user-id'] || null;
                const betaCode = req.headers['x-beta-code'];
                if (userId || betaCode) {
                    const canUse = await authService_1.authService.canUseFeature(userId, 'search', betaCode);
                    if (!canUse) {
                        return res.status(403).json({
                            success: false,
                            error: 'limit_exceeded',
                            message: 'Upgrade to continue'
                        });
                    }
                    // Rescue counts as one search usage
                    await authService_1.authService.incrementUsage(userId, 'search', betaCode);
                }
                // ── Pro split gate (same as searchAdvanced:262) ──────────────────────────
                let canUseRescue = false;
                if (userId || betaCode) {
                    canUseRescue = await authService_1.authService.canUseSplit(userId, betaCode);
                }
                // P1.4 (PHASE_4C812): Track total request time from the top
                const requestStart = Date.now();
                logger_1.winstonLogger.info(`[RESCUE_CTRL] Train ${trainNo} | ${source} → ${destination} | ${journeyDate} | class=${classCode}`);
                // ── Execute rescue scan ───────────────────────────────────────────────
                const authMs = Date.now() - requestStart;
                logger_1.winstonLogger.info(`[RESCUE_TIMING] AUTH_MS=${authMs}`);
                // P1.1 (PHASE_4C812): Timeout is created HERE — immediately before Promise.race —
                // so it measures ONLY the engine execution, not auth / import overhead.
                const engineStart = Date.now();
                let rescueTimer;
                const rescueTimeout = new Promise((resolve) => {
                    rescueTimer = setTimeout(() => {
                        logger_1.winstonLogger.warn(`[RESCUE_CTRL] Rescue scan timed out after 20s | AUTH_MS=${authMs}`);
                        resolve([]);
                    }, 20000);
                });
                const rescueOptions = await Promise.race([
                    segmentAvailabilityEngine_1.segmentAvailabilityEngine.sameTrainRescueForTrain(trainNo.trim(), source.toUpperCase().trim(), destination.toUpperCase().trim(), journeyDate, classCode, quota),
                    rescueTimeout
                ]).finally(() => {
                    if (rescueTimer)
                        clearTimeout(rescueTimer);
                });
                const engineMs = Date.now() - engineStart;
                const totalMs = Date.now() - requestStart;
                knowledgeMetricsService_1.knowledgeMetricsService.recordRescueLatency(totalMs, trainNo.trim());
                logger_1.winstonLogger.info(`[RESCUE_TIMING] ENGINE_MS=${engineMs} TOTAL_REQUEST_MS=${totalMs} results=${rescueOptions.length}`);
                const startTime = requestStart; // keep for learningService.logSearch below
                logger_1.winstonLogger.info(`[RESCUE_CTRL] Rescue options found: ${rescueOptions.length}`);
                // ── Split confirmed vs partial RAC (PHASE_4C807) ──────────────────────
                // Confirmed rescues (rescueType = SAME_TRAIN_SEGMENT) are unchanged.
                // Partial RAC rescues (rescueType = PARTIAL_RAC) are separated only when
                // the PARTIAL_RAC_RESCUE feature flag is active; otherwise the array is
                // empty and the response field is omitted entirely.
                const partialRacEnabled = process.env.PARTIAL_RAC_RESCUE === 'true';
                const confirmedOptions = rescueOptions.filter((o) => o.rescueType !== 'PARTIAL_RAC');
                const partialRacOptions = partialRacEnabled
                    ? rescueOptions.filter((o) => o.rescueType === 'PARTIAL_RAC')
                    : [];
                logger_1.winstonLogger.info(`[RESCUE_CTRL] Confirmed: ${confirmedOptions.length} | Partial RAC: ${partialRacOptions.length} (flag=${partialRacEnabled})`);
                // DB Log Integration
                try {
                    const { learningService } = require('../services/learningService');
                    const deviceId = req.headers['x-device-id'] || 'anonymous';
                    await learningService.logSearch(source.toUpperCase().trim(), destination.toUpperCase().trim(), journeyDate, deviceId, userId, rescueOptions.length, Date.now() - startTime);
                    for (const option of rescueOptions) {
                        const recId = await learningService.logSplitRecommendation(source.toUpperCase().trim(), destination.toUpperCase().trim(), option.hub, option.bufferMinutes || 0, option.totalDuration || 0, option.score || 95);
                        if (recId) {
                            option.recommendation_id = recId;
                        }
                        learningService.logRescueOutcome({
                            eventType: 'SHOWN',
                            trainNo: trainNo.trim(),
                            source: source.toUpperCase().trim(),
                            destination: destination.toUpperCase().trim(),
                            hubStation: option.hub,
                            journeyDate,
                            classCode,
                            userId,
                            deviceId,
                        }).catch(() => { });
                    }
                }
                catch (logError) {
                    logger_1.winstonLogger.error(`[RESCUE_CTRL] Telemetry logging failed: ${logError.message}`);
                }
                // ── Apply Pro gate masking — mirrors searchAdvanced:326-351 ─────────────
                const maskOption = (opt) => ({
                    ...opt,
                    isLocked: true,
                    hub: opt.hub,
                    score: opt.score,
                    rescueType: opt.rescueType,
                    isSameTrain: opt.isSameTrain,
                    badges: opt.badges,
                    confidence: opt.confidence,
                    warning: opt.warning,
                    // Premium data — hidden for guest/free users
                    leg1: opt.leg1 ? {
                        ...opt.leg1,
                        trainNo: 'XXXXX',
                        trainName: 'AI Rescue Train',
                        departure: 'XX:XX',
                        arrival: 'XX:XX',
                        availability: 'Unlock to view seat status',
                    } : null,
                    leg2: opt.leg2 ? {
                        ...opt.leg2,
                        trainNo: 'XXXXX',
                        trainName: 'AI Rescue Train',
                        departure: 'XX:XX',
                        arrival: 'XX:XX',
                        availability: 'Unlock to view seat status',
                    } : null,
                    irctcUrl: null,
                    steps: ['Unlock this route to view booking steps'],
                    ai_insight: 'Upgrade to Safar Pro to read full analysis of this rescue route.',
                });
                const visibleOptions = canUseRescue
                    ? confirmedOptions
                    : confirmedOptions.slice(0, 2).map(maskOption);
                const visiblePartialOptions = canUseRescue
                    ? partialRacOptions
                    : partialRacOptions.slice(0, 1).map(maskOption);
                // Build response — partialRescueOptions only included when flag is active
                const responseBody = {
                    success: true,
                    trainNo: trainNo.trim(),
                    source: source.toUpperCase().trim(),
                    destination: destination.toUpperCase().trim(),
                    journeyDate,
                    classCode,
                    rescueOptions: visibleOptions,
                    message: visibleOptions.length > 0
                        ? `${visibleOptions.length} rescue segment(s) found on the same train`
                        : 'No confirmed segments found on this train for the selected date and class',
                    reason: visibleOptions.length > 0 ? undefined : 'NO_CONFIRMED_SEGMENTS',
                    timestamp: new Date().toISOString()
                };
                // Append partial RAC options only when the feature flag is enabled
                // This keeps the response shape identical to production when flag is off
                if (partialRacEnabled) {
                    responseBody.partialRescueOptions = visiblePartialOptions;
                    responseBody.partialRescueMessage = visiblePartialOptions.length > 0
                        ? `${visiblePartialOptions.length} potential RAC rescue segment(s) found (one leg on RAC)`
                        : 'No RAC rescue segments found';
                }
                return res.status(200).json(responseBody);
            }
            catch (err) {
                logger_1.winstonLogger.error(`[RESCUE_CTRL] Failed: ${err.message}`);
                return res.status(500).json({
                    success: false,
                    error: 'Same Train Rescue scan failed. Please try again.',
                    message: err.message
                });
            }
        };
        this.rescueBookRedirect = async (req, res) => {
            try {
                const id = req.query.id;
                const fromStation = req.query.fromStation || '';
                const toStation = req.query.toStation || '';
                const trainNo = req.query.trainNo || '';
                const journeyDate = req.query.journeyDate || '';
                if (id) {
                    try {
                        const { learningService } = require('../services/learningService');
                        await learningService.updateSplitInteraction(id, true, false);
                    }
                    catch (dbErr) {
                        logger_1.winstonLogger.error(`[RESCUE_REDIRECT] Failed to update telemetry for id ${id}: ${dbErr.message}`);
                    }
                }
                // Construct target IRCTC URL
                let irctcUrl = `https://www.irctc.co.in/nget/train-search?fromStation=${encodeURIComponent(fromStation)}&toStation=${encodeURIComponent(toStation)}&trainNo=${encodeURIComponent(trainNo)}&journeyDate=${encodeURIComponent(journeyDate)}`;
                // PHASE_4C823 — Partner Attribution (feature-flagged, additive only)
                if (featureFlags_1.featureFlags.partnerAttribution) {
                    const partnerId = req.query.partnerId;
                    const campaignId = req.query.campaignId;
                    const utmSource = req.query.source;
                    const utmMedium = req.query.medium;
                    if (partnerId)
                        irctcUrl += `&partner_id=${encodeURIComponent(partnerId)}`;
                    if (campaignId)
                        irctcUrl += `&campaign_id=${encodeURIComponent(campaignId)}`;
                    if (utmSource)
                        irctcUrl += `&utm_source=${encodeURIComponent(utmSource)}`;
                    if (utmMedium)
                        irctcUrl += `&utm_medium=${encodeURIComponent(utmMedium)}`;
                }
                return res.redirect(302, irctcUrl);
            }
            catch (err) {
                logger_1.winstonLogger.error(`[RESCUE_REDIRECT] Redirect failed: ${err.message}`);
                return res.redirect(302, 'https://www.irctc.co.in/nget/train-search');
            }
        };
        this.getAvailability = async (req, res) => {
            try {
                const { trainNo, from, to, date, classType, quota } = req.query;
                // Validate required parameters
                if (!trainNo || !from || !to || !date) {
                    return res.status(400).json({ success: false, error: 'Missing required parameters' });
                }
                const tn = String(trainNo);
                const fr = String(from);
                const to_ = String(to);
                const dt = String(date);
                const cls = String(classType || '3A');
                const qt = String(quota || 'GN');
                const { smartAvailabilityService } = require('../services/smartAvailabilityService');
                const providerResult = await smartAvailabilityService.getAvailability({
                    trainNo: tn,
                    from: fr,
                    to: to_,
                    date: dt,
                    classType: cls,
                    quota: qt
                });
                if (providerResult.success === false) {
                    return res.json({
                        success: false,
                        reason: providerResult.reason || 'PROVIDER_UNAVAILABLE',
                        message: providerResult.message
                    });
                }
                const rawData = providerResult.data;
                const source = 'RAPIDAPI';
                if (!rawData) {
                    return res.json({ success: true, availability: null });
                }
                let fare = rawData?.data?.fare || rawData?.fare || null;
                if (!fare) {
                    try {
                        const { providerConfigService } = require('../services/providerConfigService');
                        const irctcGuard = await providerConfigService.isProviderEnabled('IRCTC');
                        if (irctcGuard.enabled) {
                            const { irctcService } = require('../services/irctcService');
                            const fareRes = await irctcService.fareLookup(tn, fr, to_, dt, cls, qt);
                            if (fareRes && fareRes.success !== false) {
                                fare = fareRes.data || fareRes;
                            }
                        }
                    }
                    catch (err) {
                        logger_1.winstonLogger.warn(`[AVAIL_FARE_FALLBACK_FAIL] ${tn}: ${err.message}`);
                    }
                }
                // ── STEP 3: Normalize response into consistent shape ──────────────────
                // The raw response may be:
                //   A) A class-keyed map: { "3A": { status, availability, current_status, ... } }
                //   B) A flat object: { status, current_status, availability, booking_status, probability }
                //   C) An array of class objects: [{ class_type, status, ... }]
                const validStatuses = ['CNF', 'RAC', 'WL', 'GNWL', 'RLWL', 'PQWL', 'AVAILABLE', 'AVL'];
                const normalizeStatus = (st) => {
                    if (!st)
                        return null;
                    const s = String(st).toUpperCase().trim();
                    if (validStatuses.some(v => s === v || s.includes(v)))
                        return s;
                    return null;
                };
                const buildEntry = (raw) => {
                    const st = normalizeStatus(raw?.availabilityText || raw?.status || raw?.current_status || raw?.availability ||
                        raw?.booking_status || raw?.avl_status);
                    if (!st)
                        return null;
                    const prob = raw?.probability ?? raw?.chance ?? raw?.booking_probability ?? raw?.predictionPercentage ?? null;
                    const isCnf = st.includes('CNF') || st.includes('AVL') || st.includes('AVAILABLE');
                    const isRac = st.includes('RAC');
                    const isWl = st.includes('WL');
                    // Dynamic WL chance: parse WL queue number for smarter estimation
                    // WL1-5: ~55-65% (high chance of confirmation), WL6-20: ~35-55%, WL21-50: ~15-30%, WL50+: <10%
                    let chance;
                    if (isCnf) {
                        chance = 90;
                    }
                    else if (isRac) {
                        chance = 60;
                    }
                    else if (isWl) {
                        // Extract WL position from status string e.g. "WL#12", "GNWL/15", "RLWL/8"
                        const wlNumMatch = st.match(/(\d+)/);
                        const wlNum = wlNumMatch ? parseInt(wlNumMatch[1], 10) : null;
                        if (wlNum === null) {
                            chance = 25; // Unknown WL position — conservative estimate
                        }
                        else if (wlNum <= 5) {
                            chance = 65; // Very short waitlist — high confirmation probability
                        }
                        else if (wlNum <= 15) {
                            chance = 45; // Short-medium waitlist
                        }
                        else if (wlNum <= 30) {
                            chance = 25; // Medium-long waitlist
                        }
                        else if (wlNum <= 60) {
                            chance = 12; // Long waitlist
                        }
                        else {
                            chance = 5; // Very long waitlist — very unlikely
                        }
                        // If probability provided from provider, use it as override (it's more accurate)
                        if (typeof prob === 'number' && prob >= 0 && prob <= 100) {
                            chance = Math.round(prob);
                        }
                    }
                    else {
                        chance = 50;
                    }
                    return { status: st, available: isCnf, probability: prob, chance };
                };
                let actualData = rawData;
                if (rawData?.data?.availability) {
                    actualData = rawData.data.availability;
                }
                else if (rawData?.availability) {
                    actualData = rawData.availability;
                }
                else if (rawData?.data && Array.isArray(rawData.data)) {
                    actualData = rawData.data;
                }
                const validatedData = {};
                if (Array.isArray(actualData) && actualData.length > 0 && actualData[0].availabilityText) {
                    // IRCTC connect format: array of date objects for the requested class
                    // Use the first element (which corresponds to the requested date)
                    const entry = buildEntry(actualData[0]);
                    if (entry)
                        validatedData[cls.toUpperCase()] = entry;
                }
                else {
                    // Case A: class-keyed map
                    const isClassMap = Object.keys(actualData || {}).some(k => /^(SL|3A|2A|1A|CC|2S|EC|FC|3E|2)$/i.test(k));
                    if (isClassMap) {
                        for (const [clsKey, info] of Object.entries(actualData)) {
                            const entry = buildEntry(info);
                            if (entry)
                                validatedData[clsKey.toUpperCase()] = entry;
                        }
                    }
                    else if (Array.isArray(actualData)) {
                        // Case C: array
                        for (const item of actualData) {
                            const clsKey = (item?.class_type || item?.classType || item?.class || 'UNK').toUpperCase();
                            const entry = buildEntry(item);
                            if (entry)
                                validatedData[clsKey] = entry;
                        }
                    }
                    else {
                        // Case B: flat single-class object — put under requested class key
                        const entry = buildEntry(actualData);
                        if (entry)
                            validatedData[cls.toUpperCase()] = entry;
                    }
                }
                if (Object.keys(validatedData).length === 0) {
                    return res.json({ success: true, availability: null, fare });
                }
                return res.json({ success: true, availability: validatedData, fare, source });
            }
            catch (err) {
                logger_1.winstonLogger.error(`[AVAIL_CONTROLLER_ERROR] ${err.message}`);
                return res.json({ success: true, availability: null, fare: null });
            }
        };
        /**
         * GET /api/trains/metadata/:trainNo
         * Returns train name, type, days of operation, and distance.
         * Fails gracefully with { success: false, data: null } if not found.
         */
        this.getTrainMetadata = async (req, res) => {
            const { trainNo } = req.params;
            if (!trainNo)
                return res.status(400).json({ success: false, error: 'trainNo is required' });
            try {
                const data = await trainService_1.trainService.getTrainMetadata(trainNo).catch(() => null);
                if (!data)
                    return res.json({ success: false, data: null });
                return res.json({ success: true, data });
            }
            catch (err) {
                logger_1.winstonLogger.warn(`[METADATA] ${trainNo}: ${err.message}`);
                return res.json({ success: false, data: null });
            }
        };
        /**
         * GET /api/trains/coaches/:trainNo
         * Returns coach composition (class, count, position) for a train.
         * Fails gracefully with { success: false, data: null } if not found.
         */
        this.getTrainCoaches = async (req, res) => {
            const { trainNo } = req.params;
            if (!trainNo)
                return res.status(400).json({ success: false, error: 'trainNo is required' });
            try {
                const data = await trainService_1.trainService.getCoachComposition(trainNo).catch(() => null);
                if (!data)
                    return res.json({ success: false, data: null });
                return res.json({ success: true, data });
            }
            catch (err) {
                logger_1.winstonLogger.warn(`[COACHES] ${trainNo}: ${err.message}`);
                return res.json({ success: false, data: null });
            }
        };
        /**
         * GET /api/trains/delay-history/:trainNo
         * Returns historical delay patterns for a train by day of week.
         * Fails gracefully with { success: false, data: null } if not found.
         */
        this.getTrainDelayHistory = async (req, res) => {
            const { trainNo } = req.params;
            if (!trainNo)
                return res.status(400).json({ success: false, error: 'trainNo is required' });
            try {
                const data = await trainService_1.trainService.getDelayHistory(trainNo).catch(() => null);
                if (!data)
                    return res.json({ success: false, data: null });
                return res.json({ success: true, data });
            }
            catch (err) {
                logger_1.winstonLogger.warn(`[DELAY_HISTORY] ${trainNo}: ${err.message}`);
                return res.json({ success: false, data: null });
            }
        };
    }
    /**
     * Advanced Search — Direct trains + Split engine in PARALLEL
     * This is the dedicated handler for /api/trains/search-advanced
     */
    generateBasicSplit(src, dest) {
        return [
            {
                via: 'PUNE',
                legs: [
                    {
                        trainNo: '11140',
                        trainName: 'CSMT HPT EXP'
                    },
                    {
                        trainNo: '12127',
                        trainName: 'INTERCITY EXP'
                    }
                ]
            }
        ];
    }
    calculateRisk(train) {
        // Simplified risk calculation
        if (train.delay_mins > 60)
            return 'high';
        if (train.delay_mins > 30)
            return 'medium';
        return 'low';
    }
}
exports.TrainController = TrainController;
exports.trainController = new TrainController();
