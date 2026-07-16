import dotenv from 'dotenv';
import path from 'path';
import fs from 'fs';

// Load environment variables from server/.env
dotenv.config({ path: path.join(__dirname, '../.env') });

import { SplitJourneyEngine } from './services/splitJourneyEngine';
import { winstonLogger } from './middleware/logger';
import { SplitDebugLogger } from './utils/splitDebugLogger';

// Capture logs locally during searches
const searchLogs: Record<string, string[]> = {};
let currentSearchKey = '';

// Intercept winstonLogger using loose casting to avoid compilation errors
const originalDebug = (winstonLogger as any).debug;
(winstonLogger as any).debug = function(message: any, ...meta: any[]) {
  if (currentSearchKey && typeof message === 'string') {
    if (!searchLogs[currentSearchKey]) searchLogs[currentSearchKey] = [];
    searchLogs[currentSearchKey].push(message);
  }
  return originalDebug.apply(winstonLogger, [message, ...meta]);
};

const originalInfo = (winstonLogger as any).info;
(winstonLogger as any).info = function(message: any, ...meta: any[]) {
  if (currentSearchKey && typeof message === 'string') {
    if (!searchLogs[currentSearchKey]) searchLogs[currentSearchKey] = [];
    searchLogs[currentSearchKey].push(message);
  }
  return originalInfo.apply(winstonLogger, [message, ...meta]);
};

const originalWarn = (winstonLogger as any).warn;
(winstonLogger as any).warn = function(message: any, ...meta: any[]) {
  if (currentSearchKey && typeof message === 'string') {
    if (!searchLogs[currentSearchKey]) searchLogs[currentSearchKey] = [];
    searchLogs[currentSearchKey].push(message);
  }
  return originalWarn.apply(winstonLogger, [message, ...meta]);
};

async function auditSearch(engine: SplitJourneyEngine, source: string, dest: string, date: string) {
  const searchKey = `${source}→${dest}`;
  currentSearchKey = searchKey;
  searchLogs[searchKey] = [];

  console.log(`\n==================================================`);
  console.log(`Running Split Search: ${source} → ${dest} on ${date}`);
  console.log(`==================================================`);

  const t0 = Date.now();
  let result: any = null;
  try {
    result = await engine.findCombinedRoutes(source, dest, date, [], 'audit-user');
  } catch (err: any) {
    console.error(`Search error for ${searchKey}:`, err.message);
  }
  const duration = Date.now() - t0;

  // Read latest entries from debug log to fetch candidate/rejected hubs
  const latestDebugLogs = SplitDebugLogger.readLatestEntries(5);
  const matchedDebug = latestDebugLogs.find(
    (log: any) => log.source.toUpperCase() === source.toUpperCase() && 
                 log.destination.toUpperCase() === dest.toUpperCase()
  );

  const logs = searchLogs[searchKey] || [];

  // Parse logs for provider selection
  const providerSelected = logs.find(l => l.includes('[PROVIDER_SELECTED]') || l.includes('provider') || l.includes('Primary API') || l.includes('keys')) || 'IRCTC (Local DB / Cache)';
  
  // Parse leg trains
  const leg1Trains: string[] = [];
  const leg2Trains: string[] = [];
  logs.forEach(l => {
    if (l.includes('[LEG1]') || l.includes('Leg 1') || l.includes('leg1')) {
      const match = l.match(/\b\d{5}\b/);
      if (match) leg1Trains.push(match[0]);
    }
    if (l.includes('[LEG2]') || l.includes('Leg 2') || l.includes('leg2')) {
      const match = l.match(/\b\d{5}\b/);
      if (match) leg2Trains.push(match[0]);
    }
  });

  // Extract explicit rejections
  const hubRejections: Record<string, string> = {};
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
    hubSelected: result?.split?.map((s: any) => s.hub) || [],
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
  const engine = new SplitJourneyEngine();
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

  fs.writeFileSync(
    path.join(__dirname, '../../scratch/splits_audit_results.json'),
    JSON.stringify(results, null, 2),
    'utf8'
  );
  console.log("\nSaved results to scratch/splits_audit_results.json");
  process.exit(0);
}

run();
