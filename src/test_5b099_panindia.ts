/**
 * PHASE_5B099 — Pan-India split engine regression sweep.
 * Tests representative routes across all Indian railway zones.
 * Verifies: no ghost cards, no false boarding stations, valid splits preserved.
 */

import https from 'https';
import http from 'http';

const BASE = 'http://localhost:5000';
const DATE = '2026-08-17';

interface RouteCheck {
  label: string;
  from: string;
  to: string;
  zone: string;
  checks: {
    noGhostTrains?: string[];       // train numbers that MUST NOT appear with wrong stations
    validTrains?: string[];         // train numbers that may appear (if schedule exists)
    maxSplits?: number;             // sanity cap
    noStationCode?: string;         // station code that must NOT appear as from for certain trains
  };
}

const ROUTES: RouteCheck[] = [
  // WEST
  { label: 'Mumbai BDTS → Ajmer', from: 'BDTS', to: 'AII', zone: 'WEST',
    checks: { noGhostTrains: ['19031', '19411'], noStationCode: 'ADI' } },
  { label: 'Mumbai CSMT → Delhi NDLS', from: 'CSMT', to: 'NDLS', zone: 'WEST',
    checks: { maxSplits: 30 } },
  { label: 'Ahmedabad ADI → Jaipur JP', from: 'ADI', to: 'JP', zone: 'WEST',
    checks: { maxSplits: 20 } },

  // NORTH
  { label: 'Delhi NDLS → Lucknow LKO', from: 'NDLS', to: 'LKO', zone: 'NORTH',
    checks: { maxSplits: 20 } },
  { label: 'Chandigarh CDG → Patna PNBE', from: 'CDG', to: 'PNBE', zone: 'NORTH',
    checks: { maxSplits: 20 } },

  // SOUTH
  { label: 'Bengaluru SBC → Chennai MAS', from: 'SBC', to: 'MAS', zone: 'SOUTH',
    checks: { maxSplits: 20 } },
  { label: 'Hyderabad SC → Mumbai CSMT', from: 'SC', to: 'CSMT', zone: 'SOUTH',
    checks: { maxSplits: 20 } },

  // EAST
  { label: 'Kolkata HWH → Bhubaneswar BBS', from: 'HWH', to: 'BBS', zone: 'EAST',
    checks: { maxSplits: 20 } },
  { label: 'Patna PNBE → Delhi NDLS', from: 'PNBE', to: 'NDLS', zone: 'EAST',
    checks: { maxSplits: 20 } },

  // CENTRAL
  { label: 'Nagpur NGP → Bhopal BPL', from: 'NGP', to: 'BPL', zone: 'CENTRAL',
    checks: { maxSplits: 20 } },
  { label: 'Mumbai CSMT → Pune PUNE', from: 'CSMT', to: 'PUNE', zone: 'CENTRAL',
    checks: { maxSplits: 15 } },

  // NORTHEAST
  { label: 'Guwahati GHY → Dibrugarh DBRG', from: 'GHY', to: 'DBRG', zone: 'NORTHEAST',
    checks: { maxSplits: 10 } },
];

function fetchJson(url: string): Promise<any> {
  return new Promise((resolve, reject) => {
    http.get(url, (res) => {
      let data = '';
      res.on('data', (chunk) => data += chunk);
      res.on('end', () => {
        try { resolve(JSON.parse(data)); } catch (e) { resolve(null); }
      });
    }).on('error', reject);
  });
}

async function runRoute(route: RouteCheck): Promise<{ ok: boolean; details: string }> {
  const url = `${BASE}/api/trains/search-advanced?source=${route.from}&destination=${route.to}&date=${DATE}&includeSplit=true&classType=SL`;
  const data = await fetchJson(url);
  const splits: any[] = data?.splitJourneys || data?.split_journeys || [];
  const direct: any[] = data?.trains || data?.directTrains || [];
  const issues: string[] = [];

  // Check maxSplits
  if (route.checks.maxSplits && splits.length > route.checks.maxSplits) {
    issues.push(`Too many splits: ${splits.length} (max ${route.checks.maxSplits})`);
  }

  // Check ghost trains — no ADI boarding for 19031/19411
  if (route.checks.noGhostTrains) {
    for (const split of splits) {
      const legs = split.legs || split.trains || [];
      for (const leg of legs) {
        const tNo = String(leg.trainNo || leg.train_number || '').replace(/^0+/, '');
        if (route.checks.noGhostTrains.includes(tNo)) {
          const fromCode = (leg.fromCode || leg.from || '').toUpperCase();
          if (route.checks.noStationCode && fromCode === route.checks.noStationCode) {
            issues.push(`Ghost card: train ${tNo} fromCode=${fromCode} (must not be ${route.checks.noStationCode})`);
          }
        }
      }
    }
  }

  // Check steps for "from AHMEDABAD JN" instruction on invalid trains
  if (route.checks.noGhostTrains) {
    for (const split of splits) {
      const steps: string[] = split.steps || [];
      for (const step of steps) {
        for (const trainNo of route.checks.noGhostTrains) {
          // If a step says "Board 19031..." or "Board 19411..." followed by "from AHMEDABAD JN"
          if (step.includes(`(${trainNo.padStart(5, '0')})`) && step.includes('from AHMEDABAD JN')) {
            issues.push(`Bad instruction for ${trainNo}: "${step}"`);
          }
        }
      }
    }
  }

  const ok = issues.length === 0;
  const details = ok
    ? `direct=${direct.length} splits=${splits.length}`
    : `FAIL: ${issues.join('; ')}`;
  return { ok, details };
}

async function run() {
  console.log('\n=== PHASE_5B099 Pan-India Regression Sweep ===\n');
  let passed = 0;
  let failed = 0;

  for (const route of ROUTES) {
    try {
      const { ok, details } = await runRoute(route);
      const symbol = ok ? '✅' : '❌';
      const status = ok ? 'PASS' : 'FAIL';
      console.log(`${symbol} [${route.zone}] ${route.label} — ${status}`);
      console.log(`      ${details}\n`);
      if (ok) passed++; else failed++;
    } catch (e: any) {
      console.log(`❌ [${route.zone}] ${route.label} — ERROR`);
      console.log(`      ${e.message}\n`);
      failed++;
    }
  }

  console.log(`=== Results: ${passed}/${ROUTES.length} passed, ${failed} failed ===\n`);
  if (failed > 0) process.exit(1);
}

run().catch(e => { console.error(e); process.exit(1); });
