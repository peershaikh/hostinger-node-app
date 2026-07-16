"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const dotenv_1 = __importDefault(require("dotenv"));
const path_1 = __importDefault(require("path"));
const fs_1 = __importDefault(require("fs"));
// Load environment variables from server/.env
dotenv_1.default.config({ path: path_1.default.join(__dirname, '../.env') });
const splitJourneyEngine_1 = require("./services/splitJourneyEngine");
const logger_1 = require("./middleware/logger");
const splitDebugLogger_1 = require("./utils/splitDebugLogger");
// Capture logs locally during searches
const searchLogs = {};
let currentSearchKey = '';
// Intercept winstonLogger using loose casting to avoid compilation errors
const originalDebug = logger_1.winstonLogger.debug;
logger_1.winstonLogger.debug = function (message, ...meta) {
    if (currentSearchKey && typeof message === 'string') {
        if (!searchLogs[currentSearchKey])
            searchLogs[currentSearchKey] = [];
        searchLogs[currentSearchKey].push(message);
    }
    return originalDebug.apply(logger_1.winstonLogger, [message, ...meta]);
};
const originalInfo = logger_1.winstonLogger.info;
logger_1.winstonLogger.info = function (message, ...meta) {
    if (currentSearchKey && typeof message === 'string') {
        if (!searchLogs[currentSearchKey])
            searchLogs[currentSearchKey] = [];
        searchLogs[currentSearchKey].push(message);
    }
    return originalInfo.apply(logger_1.winstonLogger, [message, ...meta]);
};
const originalWarn = logger_1.winstonLogger.warn;
logger_1.winstonLogger.warn = function (message, ...meta) {
    if (currentSearchKey && typeof message === 'string') {
        if (!searchLogs[currentSearchKey])
            searchLogs[currentSearchKey] = [];
        searchLogs[currentSearchKey].push(message);
    }
    return originalWarn.apply(logger_1.winstonLogger, [message, ...meta]);
};
async function auditSearch(engine, source, dest, date) {
    const searchKey = `${source}→${dest}`;
    currentSearchKey = searchKey;
    searchLogs[searchKey] = [];
    console.log(`\n==================================================`);
    console.log(`Running Split Search: ${source} → ${dest} on ${date}`);
    console.log(`==================================================`);
    const t0 = Date.now();
    let result = null;
    try {
        result = await engine.findCombinedRoutes(source, dest, date, [], 'audit-user');
    }
    catch (err) {
        console.error(`Search error for ${searchKey}:`, err.message);
    }
    const duration = Date.now() - t0;
    // Read latest entries from debug log to fetch candidate/rejected hubs
    const latestDebugLogs = splitDebugLogger_1.SplitDebugLogger.readLatestEntries(5);
    const matchedDebug = latestDebugLogs.find((log) => log.source.toUpperCase() === source.toUpperCase() &&
        log.destination.toUpperCase() === dest.toUpperCase());
    const logs = searchLogs[searchKey] || [];
    // Parse logs for provider selection
    const providerSelected = logs.find(l => l.includes('[PROVIDER_SELECTED]') || l.includes('provider') || l.includes('Primary API') || l.includes('keys')) || 'IRCTC (Local DB / Cache)';
    // Parse leg trains
    const leg1Trains = [];
    const leg2Trains = [];
    logs.forEach(l => {
        if (l.includes('[LEG1]') || l.includes('Leg 1') || l.includes('leg1')) {
            const match = l.match(/\b\d{5}\b/);
            if (match)
                leg1Trains.push(match[0]);
        }
        if (l.includes('[LEG2]') || l.includes('Leg 2') || l.includes('leg2')) {
            const match = l.match(/\b\d{5}\b/);
            if (match)
                leg2Trains.push(match[0]);
        }
    });
    // Extract explicit rejections
    const hubRejections = {};
    logs.forEach(l => {
        if (l.includes('[HUB_REJECT]') || l.includes('[GEO_FILTER] Rejected') || l.includes('is only') || l.includes('below')) {
            // Find hub code
            const words = l.split(/\s+/);
            const hub = words.find(w => w.length === 3 || w.length === 4 || w === 'PUNE' || w === 'SUR' || w === 'UBL' || w === 'MRJ');
            if (hub) {
                hubRejections[hub] = l;
            }
        }
    });
    const finalResult = {
        search: searchKey,
        date,
        durationMs: duration,
        finalSplitCount: result?.split?.length || 0,
        providerSelected,
        hubCandidatesGenerated: matchedDebug?.candidateHubs || [],
        hubSelected: result?.split?.map((s) => s.hub) || [],
        leg1Trains: [...new Set(leg1Trains)],
        leg2Trains: [...new Set(leg2Trains)],
        rejectedHubs: matchedDebug?.rejectedHubs || [],
        hubRejectionsText: hubRejections,
        response: result
    };
    console.log(`Duration: ${duration}ms`);
    console.log(`Final Split Count: ${finalResult.finalSplitCount}`);
    console.log(`Hub Candidates:`, finalResult.hubCandidatesGenerated);
    console.log(`Selected Hubs:`, finalResult.hubSelected);
    if (finalResult.finalSplitCount === 0) {
        // Print logs that might explain why
        console.log(`--- Log Trace (Last 20) ---`);
        console.log(logs.slice(-20).join('\n'));
    }
    return finalResult;
}
async function run() {
    const engine = new splitJourneyEngine_1.SplitJourneyEngine();
    const date = '2026-07-20';
    const results = [];
    const targets = [
        { from: 'CSMT', to: 'GDG' },
        { from: 'CSMT', to: 'BELAGAVI' },
        { from: 'CSMT', to: 'BGM' },
        { from: 'CSMT', to: 'HUBBALLI' },
        { from: 'CSMT', to: 'GOA' }
    ];
    for (const t of targets) {
        const res = await auditSearch(engine, t.from, t.to, date);
        results.push(res);
    }
    fs_1.default.writeFileSync(path_1.default.join(__dirname, '../../scratch/splits_audit_results.json'), JSON.stringify(results, null, 2), 'utf8');
    console.log("\nSaved results to scratch/splits_audit_results.json");
    process.exit(0);
}
run();
