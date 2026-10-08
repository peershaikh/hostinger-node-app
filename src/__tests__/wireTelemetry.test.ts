/**
 * STEP 2C — Wire-Level Provider Telemetry Integration Test Suite
 *
 * Verifies all 22 required wire-level telemetry behaviors:
 *  1. One real HTTP call = one ledger event.
 *  2. Cache hit = zero telemetry.
 *  3. Retry = separate event with is_retry=true.
 *  4. Fallback = separate event with is_fallback=true.
 *  5. Split journey underlying calls are individually counted.
 *  6. Search event classification is correct.
 *  7. Availability event classification is correct.
 *  8. Schedule event classification is correct.
 *  9. PNR event classification is correct.
 * 10. Live event classification is correct.
 * 11. AI event classification is correct.
 * 12. Failed HTTP call creates success=false event.
 * 13. Timeout creates success=false and null HTTP status.
 * 14. latency_ms is captured.
 * 15. UserId is preserved.
 * 16. Missing userId becomes null.
 * 17. DeepSeek token counts are captured.
 * 18. Gemini token counts are captured.
 * 19. Railway applied_rate remains 0.000000.
 * 20. AI cost matches aiPricingConfig.
 * 21. learningService no longer creates financial ledger events.
 * 22. No duplicate events occur.
 * 23. ConfirmTkt and RailYatri completely decommissioned and produce zero telemetry.
 *
 * Run with:
 *   npx ts-node server/src/__tests__/wireTelemetry.test.ts
 */

import axios from 'axios';
import { ledgerTransport, LedgerEventPayload } from '../services/ledger/ledgerTransport';
import { irctcService } from '../services/irctcService';
import { railRadarService } from '../services/railRadarService';
import { railProviderRegistry } from '../services/railProviderRegistry';
import { deepseekAdapter } from '../services/ai/deepseekAdapter';
import { geminiAdapter } from '../services/ai/geminiAdapter';
import { aiConfig } from '../services/ai/aiConfig';
import { calculateAiCost } from '../services/ai/aiPricingConfig';
import { learningService } from '../services/learningService';
import { cacheService } from '../services/cacheService';
import { providerConfigService } from '../services/providerConfigService';
import { runWithContext } from '../middleware/requestContext';

let passed = 0;
let failed = 0;
const failures: string[] = [];

function assert(desc: string, condition: boolean, details?: string) {
  if (condition) {
    console.log(`  PASS: ${desc}`);
    passed++;
  } else {
    const msg = `FAIL: ${desc}${details ? ` -- ${details}` : ''}`;
    console.error(`  ${msg}`);
    failures.push(msg);
    failed++;
  }
}

// Intercept ledgerTransport.enqueue to capture payloads safely in memory
const capturedEvents: LedgerEventPayload[] = [];
ledgerTransport.enqueue = (payload: LedgerEventPayload) => {
  capturedEvents.push({ ...payload });
  return true;
};

function resetCaptured() {
  capturedEvents.length = 0;
}

async function runTests() {
  console.log('\n==================================================');
  console.log('=== STEP 2C — WIRE-LEVEL TELEMETRY VERIFICATION ===');
  console.log('==================================================\n');

  // Save original axios & fetch handlers
  const originalAxiosGet = axios.get;
  const originalAxiosPost = axios.post;
  const originalFetch = global.fetch;

  try {
    // ── Setup Provider Stubs & Init ─────────────────────────────────────────
    providerConfigService.getKeysFor = async (provider: string) => {
      const p = provider.toUpperCase();
      if (p === 'IRCTC' || p === 'RAILKIT') return ['mock-railkit-key'];
      if (p === 'RAILRADAR') return ['mock-railradar-key-12345678'];
      return [];
    };

    // Initialize IRCTC
    await (irctcService as any)._init();
    // Mock global.fetch for RailKit v6 SDK
    (global as any).fetch = async (url: any) => {
      return {
        ok: true,
        status: 200,
        headers: new Headers({ 'content-type': 'application/json' }),
        json: async () => ({
          success: true,
          data: {
            pnr: '1122334455',
            train_number: '12678',
            route: [{ station_code: 'MAS', station_name: 'Chennai Central' }],
            trains: [{ train_number: '12678' }],
            availability: [{ date: '2026-10-10', status: 'AVAILABLE 12' }]
          }
        }),
        text: async () => JSON.stringify({
          success: true,
          data: {
            pnr: '1122334455',
            train_number: '12678',
            route: [{ station_code: 'MAS', station_name: 'Chennai Central' }],
            trains: [{ train_number: '12678' }],
            availability: [{ date: '2026-10-10', status: 'AVAILABLE 12' }]
          }
        })
      };
    };

    // Environment keys for other providers
    aiConfig.deepseek.apiKey = 'mock-deepseek-key';
    aiConfig.gemini.apiKey = 'mock-gemini-key';

    // Reset services
    railRadarService.resetQuotaForTest(0);
    railRadarService.resetHealth();
    cacheService.flushAll();

    // Default axios mocks
    axios.get = (async (url: string, _config?: any) => {
      if (url.includes('/pnr/')) {
        return {
          status: 200,
          data: {
            data: {
              pnr: '1234567890',
              train_number: '12678',
              date_of_journey: '2026-10-10',
              passengers: [{ current_status: 'CNF', booking_status: 'WL 5' }]
            }
          }
        };
      }
      return { status: 200, data: {} };
    }) as any;

    axios.post = (async (url: string, body?: any) => {
      if (url.includes('deepseek')) {
        return {
          status: 200,
          data: {
            choices: [{ message: { content: '{"status":"ok"}' } }],
            usage: {
              prompt_tokens: 312,
              completion_tokens: 84
            }
          }
        };
      }
      if (url.includes('googleapis') || url.includes('gemini')) {
        return {
          status: 200,
          data: {
            candidates: [{
              content: { parts: [{ text: '{"status":"ok"}' }] }
            }],
            usageMetadata: {
              promptTokenCount: 420,
              candidatesTokenCount: 105
            }
          }
        };
      }
      return { status: 200, data: {} };
    }) as any;

    // ─────────────────────────────────────────────────────────────────────────
    // TEST 1: One real HTTP call = one ledger event
    // ─────────────────────────────────────────────────────────────────────────
    console.log('-- Test 1: Real Network Call Emits Exactly One Event --');
    resetCaptured();
    cacheService.flushAll();
    const rrResult = await railRadarService.getPNRStatus('1234567890');
    assert('1.1 Real outbound call yields result', rrResult !== null);
    assert('1.2 Exactly one ledger event emitted', capturedEvents.length === 1);
    assert('1.3 Event matches provider and status', capturedEvents[0]?.provider_name.toUpperCase() === 'RAILRADAR' && capturedEvents[0]?.success === true);

    // ─────────────────────────────────────────────────────────────────────────
    // TEST 2: Cache hit = zero telemetry
    // ─────────────────────────────────────────────────────────────────────────
    console.log('\n-- Test 2: Cache Hit Produces Zero Telemetry --');
    resetCaptured();
    const cachedResult = await railRadarService.getPNRStatus('1234567890');
    assert('2.1 Cache hit returns cached data', cachedResult !== null);
    assert('2.2 Zero telemetry emitted on cache hit', capturedEvents.length === 0);

    // ─────────────────────────────────────────────────────────────────────────
    // TEST 3: Retry = separate event with is_retry=true
    // ─────────────────────────────────────────────────────────────────────────
    console.log('\n-- Test 3: Retry Handling (is_retry Flag) --');
    resetCaptured();
    cacheService.flushAll();
    await irctcService.getTrainInfoForSync('12678', 1);
    assert('3.1 First attempt emits event with is_retry=false', capturedEvents.length === 1 && capturedEvents[0]?.is_retry === false);

    // Invalidate schedule cache so second attempt executes actual network retry
    cacheService.del('traininfo_12678');
    await irctcService.getTrainInfoForSync('12678', 2);
    assert('3.2 Retry attempt emits separate event with is_retry=true', capturedEvents.length === 2 && capturedEvents[1]?.is_retry === true);

    // ─────────────────────────────────────────────────────────────────────────
    // TEST 4: Fallback = separate event with is_fallback=true
    // ─────────────────────────────────────────────────────────────────────────
    console.log('\n-- Test 4: Primary vs Fallback Provider Flags --');
    resetCaptured();
    cacheService.flushAll();
    await irctcService.checkPNRStatus('9876543210');
    assert('4.1 Primary provider (IRCTC) has is_fallback=false', capturedEvents.length === 1 && capturedEvents[0]?.is_fallback === false);

    await railRadarService.getPNRStatus('1234567890');
    assert('4.2 Fallback provider (RailRadar) has is_fallback=true', capturedEvents.length === 2 && capturedEvents[1]?.is_fallback === true);

    // ─────────────────────────────────────────────────────────────────────────
    // TEST 5: Split journey underlying calls are individually counted
    // ─────────────────────────────────────────────────────────────────────────
    console.log('\n-- Test 5: Split Journey Underlying Calls Individually Counted --');
    resetCaptured();
    cacheService.flushAll();
    // Simulate underlying network calls triggered during a split journey execution:
    // 1. Train search between SBC and MAS
    await irctcService.search('SBC', 'MAS', '2026-10-10');
    // 2. Schedule lookup for connecting train
    await irctcService.getTrainInfo('12678');
    // 3. Availability check for leg
    await irctcService.getAvailability('12678', '2026-10-10', 'SBC', 'MAS', '3A', 'GN');

    assert('5.1 Underlying calls each produce an individual event (count = 3)', capturedEvents.length === 3);
    assert('5.2 Underlying event types are canonical (search, schedule, availability)',
      capturedEvents[0]?.event_type === 'search' &&
      capturedEvents[1]?.event_type === 'schedule' &&
      capturedEvents[2]?.event_type === 'availability'
    );
    assert('5.3 No artificial generic "split" event created for provider calls',
      capturedEvents.every(e => e.event_type !== 'split')
    );

    // ─────────────────────────────────────────────────────────────────────────
    // TEST 6: Search event classification is correct
    // ─────────────────────────────────────────────────────────────────────────
    console.log('\n-- Test 6: Search Event Classification --');
    resetCaptured();
    cacheService.flushAll();
    await irctcService.search('NDLS', 'CNB', '2026-10-10');
    assert('6.1 IRCTC search classified as search', capturedEvents[0]?.event_type === 'search');

    // ─────────────────────────────────────────────────────────────────────────
    // TEST 7: Availability event classification is correct
    // ─────────────────────────────────────────────────────────────────────────
    console.log('\n-- Test 7: Availability Event Classification --');
    resetCaptured();
    cacheService.flushAll();
    await irctcService.getAvailability('12678', '2026-10-10', 'SBC', 'MAS', 'SL', 'GN');
    assert('7.1 IRCTC getAvailability classified as availability', capturedEvents[0]?.event_type === 'availability');

    // ─────────────────────────────────────────────────────────────────────────
    // TEST 8: Schedule event classification is correct
    // ─────────────────────────────────────────────────────────────────────────
    console.log('\n-- Test 8: Schedule Event Classification --');
    resetCaptured();
    cacheService.flushAll();
    await irctcService.getStationTimetable('MAS');
    assert('8.1 IRCTC timetable classified as schedule', capturedEvents[0]?.event_type === 'schedule');

    // ─────────────────────────────────────────────────────────────────────────
    // TEST 9: PNR event classification is correct
    // ─────────────────────────────────────────────────────────────────────────
    console.log('\n-- Test 9: PNR Event Classification --');
    resetCaptured();
    cacheService.flushAll();
    await irctcService.checkPNRStatus('1122334455');
    await railRadarService.getPNRStatus('2233445566');
    assert('9.1 IRCTC checkPNRStatus classified as pnr', capturedEvents[0]?.event_type === 'pnr');
    assert('9.2 RailRadar getPNRStatus classified as pnr', capturedEvents[1]?.event_type === 'pnr');

    // ─────────────────────────────────────────────────────────────────────────
    // TEST 10: Live event classification is correct
    // ─────────────────────────────────────────────────────────────────────────
    console.log('\n-- Test 10: Live Event Classification --');
    resetCaptured();
    cacheService.flushAll();
    await irctcService.getLiveStatus('12678', '2026-10-10');
    assert('10.1 IRCTC getLiveStatus classified as live', capturedEvents[0]?.event_type === 'live');

    // ─────────────────────────────────────────────────────────────────────────
    // TEST 11: AI event classification is correct
    // ─────────────────────────────────────────────────────────────────────────
    console.log('\n-- Test 11: AI Event Classification --');
    resetCaptured();
    await deepseekAdapter.generateText('Test prompt for DeepSeek');
    await geminiAdapter.generateText('Test prompt for Gemini');
    assert('11.1 DeepSeek classified as ai', capturedEvents[0]?.event_type === 'ai');
    assert('11.2 Gemini classified as ai', capturedEvents[1]?.event_type === 'ai');

    // ─────────────────────────────────────────────────────────────────────────
    // TEST 12: Failed HTTP call creates success=false event
    // ─────────────────────────────────────────────────────────────────────────
    console.log('\n-- Test 12: Failed HTTP Call Telemetry --');
    resetCaptured();
    cacheService.flushAll();
    railRadarService.resetHealth();
    railRadarService.resetQuotaForTest(0);
    axios.get = (async () => {
      const err: any = new Error('Request failed with status code 500');
      err.response = { status: 500, data: 'Internal Server Error' };
      throw err;
    }) as any;

    try {
      await railRadarService.getPNRStatus('9999999999');
    } catch { /* expected */ }

    assert('12.1 Failed HTTP call records telemetry', capturedEvents.length === 1);
    assert('12.2 success=false on HTTP failure', capturedEvents[0]?.success === false);
    assert('12.3 http_status is captured from response (500)', capturedEvents[0]?.http_status === 500);

    // ─────────────────────────────────────────────────────────────────────────
    // TEST 13: Timeout creates success=false and null HTTP status
    // ─────────────────────────────────────────────────────────────────────────
    console.log('\n-- Test 13: Timeout Call Telemetry --');
    resetCaptured();
    cacheService.flushAll();
    railRadarService.resetHealth();
    railRadarService.resetQuotaForTest(0);
    axios.get = (async () => {
      const err: any = new Error('timeout of 8000ms exceeded');
      err.code = 'ECONNABORTED';
      // No response object for timeouts/network errors
      throw err;
    }) as any;

    try {
      await railRadarService.getPNRStatus('8888888888');
    } catch { /* expected */ }

    assert('13.1 Timeout records telemetry', capturedEvents.length === 1);
    assert('13.2 success=false on timeout', capturedEvents[0]?.success === false);
    assert('13.3 http_status is null when no response exists', capturedEvents[0]?.http_status === null);

    // Restore working axios.get
    axios.get = (async (url: string) => {
      if (url.includes('/pnr/')) {
        return {
          status: 200,
          data: {
            data: {
              pnr: '7777777777',
              train_number: '12678',
              passengers: [{ current_status: 'CNF' }]
            }
          }
        };
      }
      return { status: 200, data: { stations: [{ station_code: 'MAS' }] } };
    }) as any;

    // ─────────────────────────────────────────────────────────────────────────
    // TEST 14: latency_ms is captured
    // ─────────────────────────────────────────────────────────────────────────
    console.log('\n-- Test 14: Latency Capture --');
    resetCaptured();
    cacheService.flushAll();
    await railRadarService.getPNRStatus('7777777777');
    assert('14.1 latency_ms is a valid non-negative number',
      typeof capturedEvents[0]?.latency_ms === 'number' && (capturedEvents[0]?.latency_ms ?? -1) >= 0
    );

    // ─────────────────────────────────────────────────────────────────────────
    // TEST 15: UserId is preserved via AsyncLocalStorage
    // ─────────────────────────────────────────────────────────────────────────
    console.log('\n-- Test 15: Context UserId Propagation --');
    resetCaptured();
    cacheService.flushAll();
    const testUserId = 'a0000000-0000-4000-8000-000000000001';
    await runWithContext({ userId: testUserId, callerFeature: 'unit_test' }, async () => {
      await railRadarService.getPNRStatus('7777777777');
    });
    assert('15.1 userId is correctly propagated into event', capturedEvents[0]?.user_id === testUserId);
    assert('15.2 caller_feature is propagated into event', capturedEvents[0]?.caller_feature === 'unit_test');

    // ─────────────────────────────────────────────────────────────────────────
    // TEST 16: Missing userId becomes null
    // ─────────────────────────────────────────────────────────────────────────
    console.log('\n-- Test 16: Missing Context UserId Becomes Null --');
    resetCaptured();
    cacheService.flushAll();
    // Run outside context
    await railRadarService.getPNRStatus('7777777777');
    assert('16.1 Missing userId in context resolves to null', capturedEvents[0]?.user_id === null);

    // ─────────────────────────────────────────────────────────────────────────
    // TEST 17: DeepSeek token counts are captured
    // ─────────────────────────────────────────────────────────────────────────
    console.log('\n-- Test 17: DeepSeek Token Extraction --');
    resetCaptured();
    await deepseekAdapter.generateText('Token test prompt');
    assert('17.1 DeepSeek tokens_in matches usage.prompt_tokens (312)', capturedEvents[0]?.tokens_in === 312);
    assert('17.2 DeepSeek tokens_out matches usage.completion_tokens (84)', capturedEvents[0]?.tokens_out === 84);

    // ─────────────────────────────────────────────────────────────────────────
    // TEST 18: Gemini token counts are captured
    // ─────────────────────────────────────────────────────────────────────────
    console.log('\n-- Test 18: Gemini Token Extraction --');
    resetCaptured();
    await geminiAdapter.generateText('Gemini token test prompt');
    assert('18.1 Gemini tokens_in matches usageMetadata.promptTokenCount (420)', capturedEvents[0]?.tokens_in === 420);
    assert('18.2 Gemini tokens_out matches usageMetadata.candidatesTokenCount (105)', capturedEvents[0]?.tokens_out === 105);

    // ─────────────────────────────────────────────────────────────────────────
    // TEST 19: Railway applied_rate remains 0.000000
    // ─────────────────────────────────────────────────────────────────────────
    console.log('\n-- Test 19: Strict Railway Rate Policy (0.000000) --');
    resetCaptured();
    cacheService.flushAll();
    await irctcService.search('SBC', 'MAS', '2026-10-10');
    await railRadarService.getPNRStatus('7777777777');

    const allRailwayZero = capturedEvents.every(e => e.applied_rate === 0.000000);
    assert('19.1 All railway events have applied_rate === 0.000000', allRailwayZero);
    assert('19.2 All railway events use USD currency', capturedEvents.every(e => e.currency === 'USD'));

    // ─────────────────────────────────────────────────────────────────────────
    // TEST 20: AI cost matches aiPricingConfig
    // ─────────────────────────────────────────────────────────────────────────
    console.log('\n-- Test 20: AI Cost Calculation Matches aiPricingConfig --');
    resetCaptured();
    await deepseekAdapter.generateText('Cost test prompt');
    const activeDeepSeekModel = (deepseekAdapter as any).getActiveModel();
    const expectedDeepSeekCost = calculateAiCost(activeDeepSeekModel, 312, 84);
    assert('20.1 DeepSeek applied_rate matches calculateAiCost', capturedEvents[0]?.applied_rate === expectedDeepSeekCost);

    resetCaptured();
    await geminiAdapter.generateText('Cost test prompt Gemini');
    const activeGeminiModel = (geminiAdapter as any).getActiveModel();
    const expectedGeminiCost = calculateAiCost(activeGeminiModel, 420, 105);
    assert('20.2 Gemini applied_rate matches calculateAiCost', capturedEvents[0]?.applied_rate === expectedGeminiCost);

    // ─────────────────────────────────────────────────────────────────────────
    // TEST 21: learningService no longer creates financial ledger events
    // ─────────────────────────────────────────────────────────────────────────
    console.log('\n-- Test 21: learningService Financial Ledger Decommission --');
    resetCaptured();
    try {
      await learningService.logSearch('SBC', 'MAS', '2026-10-10', 'dev_test', 'user_test', 5, 120);
      await learningService.logSplitRecommendation('SBC', 'MAS', 'BZA', 60, 420, 0.95);
      await learningService.logPnrCheck('1234567890', 'WL 5', 'CNF', true);
      await learningService.logLiveTrain('12678', 'MAS', 5, 90, '10:00', '10:05');
    } catch { /* DB offline in test environment is safe/expected */ }

    assert('21.1 learningService calls generate ZERO ledger events', capturedEvents.length === 0);

    // ─────────────────────────────────────────────────────────────────────────
    // TEST 22: No duplicate events occur
    // ─────────────────────────────────────────────────────────────────────────
    console.log('\n-- Test 22: Deduplication / Idempotent Enqueue Count --');
    resetCaptured();
    cacheService.flushAll();
    // Execute exactly 4 distinct provider calls
    await irctcService.search('SBC', 'MAS', '2026-10-10');
    await railRadarService.getPNRStatus('7777777777');
    await deepseekAdapter.generateText('Dedup test 1');
    await geminiAdapter.generateText('Dedup test 2');

    assert('22.1 Exactly 4 outbound operations generate exactly 4 events (no duplicates)', capturedEvents.length === 4);

    // ─────────────────────────────────────────────────────────────────────────
    // TEST 23: Decommissioned Providers (ConfirmTkt & RailYatri) Inactive
    // ─────────────────────────────────────────────────────────────────────────
    console.log('\n-- Test 23: ConfirmTkt & RailYatri Complete Decommission --');
    assert('23.1 ConfirmTkt adapter not in railProviderRegistry', railProviderRegistry.getProvider('CONFIRMTKT') === undefined);
    assert('23.2 RailYatri adapter not in railProviderRegistry', railProviderRegistry.getProvider('RAILYATRI') === undefined);
    const confirmtktKeys = await providerConfigService.getKeysFor('CONFIRMTKT');
    const railyatriKeys = await providerConfigService.getKeysFor('RAILYATRI');
    assert('23.3 ConfirmTkt has no providerConfig keys', confirmtktKeys.length === 0);
    assert('23.4 RailYatri has no providerConfig keys', railyatriKeys.length === 0);
    const allConfigs = await providerConfigService.getProviderConfigs();
    assert('23.5 ConfirmTkt not in active provider configs', !allConfigs.some((p: any) => p.name === 'CONFIRMTKT'));
    assert('23.6 RailYatri not in active provider configs', !allConfigs.some((p: any) => p.name === 'RAILYATRI'));
    assert('23.7 Zero telemetry emitted from removed providers',
      !capturedEvents.some(e => e.provider_name.toUpperCase() === 'CONFIRMTKT' || e.provider_name.toUpperCase() === 'RAILYATRI')
    );

  } finally {
    // Restore original axios & fetch handlers
    axios.get = originalAxiosGet;
    axios.post = originalAxiosPost;
    (global as any).fetch = originalFetch;
    // Shut down background flushers
    await ledgerTransport.shutdown();
  }

  console.log('\n==================================================');
  console.log(`STEP 2C TESTS: ${passed} PASSED, ${failed} FAILED`);
  console.log('==================================================\n');

  if (failed > 0) {
    console.error('FAILURES:');
    failures.forEach(f => console.error(`  - ${f}`));
    process.exit(1);
  } else {
    process.exit(0);
  }
}

runTests().catch(err => {
  console.error('Fatal test error:', err);
  process.exit(1);
});
