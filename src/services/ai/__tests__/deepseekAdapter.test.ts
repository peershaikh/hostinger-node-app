/**
 * PHASE_087N21 — DeepSeek Adapter Unit Tests
 *
 * Tests:
 *  T1.  success path — plain text returned
 *  T2.  success path — JSON parsed and returned
 *  T3.  ECONNABORTED → AiError code=TIMEOUT
 *  T4.  HTTP 429 → AiError code=RATE_LIMITED, retryable=true
 *  T5.  HTTP 401 → AiError code=CONFIGURATION_ERROR, retryable=false
 *  T6.  HTTP 403 → AiError code=CONFIGURATION_ERROR
 *  T7.  HTTP 503 → AiError code=PROVIDER_UNAVAILABLE, retryable=true
 *  T8.  Missing API key → AiError code=CONFIGURATION_ERROR, no HTTP call made
 *  T9.  API key never appears in error.message (security)
 *  T10. Invalid JSON response → AiError code=INVALID_RESPONSE
 *  T11. Empty choices → AiError code=INVALID_RESPONSE
 *  T12. providerId = 'DEEPSEEK', all capabilities true
 *  T13. distillNewsArticle result contains model field from deepseek config
 *  T14. AiProviderResolver registers DeepSeek alongside Gemini
 *  T15. Resolver returns DeepSeek when defaultProvider=DEEPSEEK
 *  T16. Resolver returns Gemini when defaultProvider=GEMINI (no regression)
 *  T17. Both providers report distillNewsArticle capability
 *
 * Run with:
 *   cd c:\trine && npx ts-node server/src/services/ai/__tests__/deepseekAdapter.test.ts
 */

import axios from 'axios';

// ── Patch axios.post before importing the adapter ────────────────────────────
// We monkey-patch axios.post and axios.isAxiosError on the module instance
// since the adapter imports axios directly.

type MockedPost = typeof axios.post & { _mock?: (url: string, data?: any, config?: any) => Promise<any> };

const originalPost = axios.post;
const originalIsAxiosError = axios.isAxiosError;

let _mockPost: ((url: string, data?: any, config?: any) => Promise<any>) | null = null;
let _mockIsAxiosError: ((err: any) => boolean) | null = null;

(axios as any).post = async (url: string, data?: any, config?: any) => {
  if (_mockPost) return _mockPost(url, data, config);
  return originalPost(url, data, config);
};

(axios as any).isAxiosError = (err: any): boolean => {
  if (_mockIsAxiosError) return _mockIsAxiosError(err);
  return originalIsAxiosError(err);
};

// ── Import after patching ────────────────────────────────────────────────────
import { DeepSeekAdapter } from '../deepseekAdapter';
import { GeminiAdapter } from '../geminiAdapter';
import { AiError } from '../aiProvider';
import { aiConfig } from '../aiConfig';
import { aiAdminConfigService } from '../aiAdminConfigService';
import { AiProviderResolver } from '../aiProviderResolver';

// ── Silence observability writes during tests ────────────────────────────────
import { aiObservabilityService } from '../aiObservabilityService';
(aiObservabilityService as any).recordAiUsage = () => {};

// ── Test harness ─────────────────────────────────────────────────────────────
let passed = 0;
let failed = 0;
const failures: string[] = [];

function assertEq(label: string, actual: any, expected: any) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (ok) {
    console.log(`  ✅ PASS [${label}]`);
    passed++;
  } else {
    const msg = `${label}: expected=${JSON.stringify(expected)} got=${JSON.stringify(actual)}`;
    console.error(`  ❌ FAIL [${label}]: ${msg}`);
    failures.push(msg);
    failed++;
  }
}

function assertBool(label: string, result: boolean, expected: boolean) {
  assertEq(label, result, expected);
}

function assertContains(label: string, haystack: string, needle: string) {
  const ok = haystack.includes(needle);
  if (ok) {
    console.log(`  ✅ PASS [${label}]`);
    passed++;
  } else {
    const msg = `${label}: expected "${haystack}" to contain "${needle}"`;
    console.error(`  ❌ FAIL [${label}]: ${msg}`);
    failures.push(msg);
    failed++;
  }
}

function assertNotContains(label: string, haystack: string, forbidden: string) {
  const ok = !haystack.includes(forbidden);
  if (ok) {
    console.log(`  ✅ PASS [${label}]`);
    passed++;
  } else {
    const msg = `${label}: "${haystack}" must NOT contain "${forbidden}"`;
    console.error(`  ❌ FAIL [${label}]: ${msg}`);
    failures.push(msg);
    failed++;
  }
}

async function assertThrowsAiError(label: string, fn: () => Promise<any>, expectedCode: string, extraChecks?: (err: AiError) => void) {
  try {
    await fn();
    const msg = `${label}: expected AiError{code:'${expectedCode}'} but no error was thrown`;
    console.error(`  ❌ FAIL [${label}]: ${msg}`);
    failures.push(msg);
    failed++;
  } catch (err: any) {
    if (!(err instanceof AiError)) {
      const msg = `${label}: expected AiError but got ${err?.constructor?.name}: ${err?.message}`;
      console.error(`  ❌ FAIL [${label}]: ${msg}`);
      failures.push(msg);
      failed++;
      return;
    }
    if (err.code !== expectedCode) {
      const msg = `${label}: expected code='${expectedCode}' but got '${err.code}'`;
      console.error(`  ❌ FAIL [${label}]: ${msg}`);
      failures.push(msg);
      failed++;
      return;
    }
    if (extraChecks) {
      try {
        extraChecks(err);
      } catch (checkErr: any) {
        console.error(`  ❌ FAIL [${label}] extraCheck: ${checkErr.message}`);
        failures.push(`${label} extraCheck: ${checkErr.message}`);
        failed++;
        return;
      }
    }
    console.log(`  ✅ PASS [${label}]`);
    passed++;
  }
}

function makeSuccessResponse(content: string) {
  return {
    data: {
      choices: [{ message: { content } }],
      usage: { prompt_tokens: 100, completion_tokens: 50, total_tokens: 150 }
    }
  };
}

function makeAxiosError(status: number, message?: string): any {
  const err: any = new Error(message || `HTTP ${status}`);
  err.response = { status, data: { error: { message: message || 'API error' } } };
  return err;
}

// ── Tests ────────────────────────────────────────────────────────────────────
const FAKE_KEY = 'sk-test-deepseek-key-definitely-not-real';

async function runTests() {
  const adapter = new DeepSeekAdapter();

  // ── T1: Success path — plain text ─────────────────────────────────────────
  console.log('\n[T1] Success path — plain text');
  aiConfig.deepseek.apiKey = FAKE_KEY;
  _mockPost = async () => makeSuccessResponse('Reply OK');
  _mockIsAxiosError = () => false;
  try {
    const result = await adapter.generateText('Say OK');
    assertEq('T1', result, 'Reply OK');
  } catch (e: any) {
    assertEq('T1', `threw: ${e.message}`, 'Reply OK');
  }

  // ── T2: Success path — JSON ───────────────────────────────────────────────
  console.log('\n[T2] Success path — JSON parsed');
  _mockPost = async () => makeSuccessResponse('{"status":"HEALTHY","probe":"ai_admin_test"}');
  _mockIsAxiosError = () => false;
  try {
    const result = await adapter.generateText('test', { json: true });
    assertEq('T2', result.status, 'HEALTHY');
  } catch (e: any) {
    assertEq('T2', `threw: ${e.message}`, 'object');
  }

  // ── T3: ECONNABORTED → TIMEOUT ────────────────────────────────────────────
  console.log('\n[T3] ECONNABORTED → TIMEOUT');
  _mockIsAxiosError = () => true;
  _mockPost = async () => {
    const err: any = new Error('timeout of 15000ms exceeded');
    err.code = 'ECONNABORTED';
    err.response = undefined;
    throw err;
  };
  await assertThrowsAiError('T3', () => adapter.generateText('test'), 'TIMEOUT');

  // ── T4: HTTP 429 → RATE_LIMITED ───────────────────────────────────────────
  console.log('\n[T4] HTTP 429 → RATE_LIMITED');
  _mockIsAxiosError = () => true;
  _mockPost = async () => { throw makeAxiosError(429); };
  await assertThrowsAiError('T4', () => adapter.generateText('test'), 'RATE_LIMITED', (err) => {
    if (!err.retryable) throw new Error('retryable should be true');
    if (err.status !== 429) throw new Error(`status should be 429 got ${err.status}`);
  });

  // ── T5: HTTP 401 → CONFIGURATION_ERROR ───────────────────────────────────
  console.log('\n[T5] HTTP 401 → CONFIGURATION_ERROR');
  _mockIsAxiosError = () => true;
  _mockPost = async () => { throw makeAxiosError(401, 'Incorrect API key'); };
  await assertThrowsAiError('T5', () => adapter.generateText('test'), 'CONFIGURATION_ERROR', (err) => {
    if (err.retryable) throw new Error('retryable should be false for 401');
  });

  // ── T6: HTTP 403 → CONFIGURATION_ERROR ───────────────────────────────────
  console.log('\n[T6] HTTP 403 → CONFIGURATION_ERROR');
  _mockIsAxiosError = () => true;
  _mockPost = async () => { throw makeAxiosError(403, 'Forbidden'); };
  await assertThrowsAiError('T6', () => adapter.generateText('test'), 'CONFIGURATION_ERROR');

  // ── T7: HTTP 503 → PROVIDER_UNAVAILABLE, retryable ───────────────────────
  console.log('\n[T7] HTTP 503 → PROVIDER_UNAVAILABLE');
  _mockIsAxiosError = () => true;
  _mockPost = async () => { throw makeAxiosError(503, 'Service Unavailable'); };
  await assertThrowsAiError('T7', () => adapter.generateText('test'), 'PROVIDER_UNAVAILABLE', (err) => {
    if (!err.retryable) throw new Error('retryable should be true for 5xx');
  });

  // ── T8: Missing API key → CONFIGURATION_ERROR, no HTTP ───────────────────
  console.log('\n[T8] Missing API key → CONFIGURATION_ERROR before HTTP');
  aiConfig.deepseek.apiKey = '';
  const savedEnv = process.env.DEEPSEEK_API_KEY;
  delete process.env.DEEPSEEK_API_KEY;
  let postCalledForT8 = false;
  _mockPost = async () => { postCalledForT8 = true; return makeSuccessResponse('ok'); };
  _mockIsAxiosError = () => false;
  await assertThrowsAiError('T8a', () => adapter.generateText('test'), 'CONFIGURATION_ERROR');
  assertBool('T8b_no_http', postCalledForT8, false);
  if (savedEnv !== undefined) process.env.DEEPSEEK_API_KEY = savedEnv;
  aiConfig.deepseek.apiKey = FAKE_KEY;

  // ── T9: API key never in error.message ────────────────────────────────────
  console.log('\n[T9] API key never leaks into error message');
  _mockIsAxiosError = () => true;
  _mockPost = async () => { throw makeAxiosError(500, 'Internal Server Error'); };
  try {
    await adapter.generateText('test');
    failures.push('T9: expected throw but none');
    failed++;
  } catch (err: any) {
    assertNotContains('T9', err.message || '', FAKE_KEY);
  }

  // ── T10: Invalid JSON → INVALID_RESPONSE ──────────────────────────────────
  console.log('\n[T10] Invalid JSON in response → INVALID_RESPONSE');
  _mockPost = async () => makeSuccessResponse('not { valid json {{{{');
  _mockIsAxiosError = () => false;
  await assertThrowsAiError('T10', () => adapter.generateText('test', { json: true }), 'INVALID_RESPONSE');

  // ── T11: Empty choices → INVALID_RESPONSE ─────────────────────────────────
  console.log('\n[T11] Empty choices → INVALID_RESPONSE');
  _mockPost = async () => ({ data: { choices: [], usage: {} } });
  _mockIsAxiosError = () => false;
  await assertThrowsAiError('T11', () => adapter.generateText('test'), 'INVALID_RESPONSE');

  // ── T12: providerId and capabilities ──────────────────────────────────────
  console.log('\n[T12] providerId=DEEPSEEK and all capabilities true');
  assertEq('T12a_providerId', adapter.providerId, 'DEEPSEEK');
  assertBool('T12b_predictPnr', adapter.capabilities.predictPnr, true);
  assertBool('T12c_generateSchedule', adapter.capabilities.generateSchedule, true);
  assertBool('T12d_distillNewsArticle', (adapter.capabilities as any).distillNewsArticle, true);
  assertBool('T12e_genericPrompt', adapter.capabilities.genericPrompt, true);

  // ── T13: distillNewsArticle returns model field from ADMIN config ─────────
  // V3: model is resolved from aiAdminConfigService at call time (deepseek-v4-flash)
  console.log('\n[T13] distillNewsArticle result.model = admin config activeModel (v4-flash)');
  const payload = {
    title: 'Railway Update',
    summary: 'Service resuming.',
    key_takeaways: { what_happened: 'X', who_is_affected: 'Y', what_passengers_should_do: 'Z' },
    affected_trains: [],
    affected_stations: [],
    seo_title: 'Railway Update',
    meta_description: 'desc',
    slug: 'railway-update',
    faqs: [],
    confidence: 'HIGH'
  };
  _mockPost = async () => makeSuccessResponse(JSON.stringify(payload));
  _mockIsAxiosError = () => false;
  const distillResult = await adapter.distillNewsArticle({
    title: 'Railway Update',
    summary: 'Service resuming.',
    sourceName: 'IR Official',
    sourceUrl: 'https://indianrailways.gov.in',
    sourceTier: 'TIER_1_OFFICIAL',
    publishedAt: '2026-08-30',
    category: 'General'
  });
  // V3: model comes from admin config (deepseek-v4-flash is default activeModel)
  assertEq('T13', distillResult?.model, 'deepseek-v4-flash');

  // ── T14: AiProviderResolver registers DeepSeek ───────────────────────────
  console.log('\n[T14] AiProviderResolver registers DeepSeek');
  const resolver = new AiProviderResolver();
  const dsProvider = resolver.getProvider('DEEPSEEK');
  assertEq('T14a', dsProvider?.providerId, 'DEEPSEEK');

  // ── T15: Resolver uses admin config defaultProvider (V3 behaviour) ─────────
  // V3: resolveProvider reads from aiAdminConfigService, not aiConfig.
  // Patch the live admin config's defaultProvider to verify runtime read.
  console.log('\n[T15] Resolver uses admin config defaultProvider at call time');
  const liveConfig = (aiAdminConfigService as any).config;
  const origAdminDefault = liveConfig.defaultProvider;
  // Temporarily enable DEEPSEEK in admin config so it resolves
  const origDsEnabled = liveConfig.providers['DEEPSEEK']?.enabled;
  if (liveConfig.providers['DEEPSEEK']) liveConfig.providers['DEEPSEEK'].enabled = true;
  liveConfig.defaultProvider = 'DEEPSEEK';
  const resolvedDs = resolver.resolveProvider('genericPrompt');
  assertEq('T15', resolvedDs?.providerId, 'DEEPSEEK');
  liveConfig.defaultProvider = origAdminDefault;
  if (liveConfig.providers['DEEPSEEK'] && origDsEnabled !== undefined) {
    liveConfig.providers['DEEPSEEK'].enabled = origDsEnabled;
  }

  // ── T16: Resolver returns Gemini when defaultProvider=GEMINI (no regression)
  console.log('\n[T16] Resolver returns Gemini when defaultProvider=GEMINI');
  liveConfig.defaultProvider = 'GEMINI';
  const resolvedGem = resolver.resolveProvider('genericPrompt');
  assertEq('T16', resolvedGem?.providerId, 'GEMINI');

  // ── T17: Both providers list distillNewsArticle capability ────────────────
  console.log('\n[T17] Both Gemini and DeepSeek report distillNewsArticle');
  const capable = resolver.getProvidersByCapability('distillNewsArticle');
  const capIds = capable.map(p => p.providerId).sort();
  assertBool('T17a_deepseek_in_list', capIds.includes('DEEPSEEK'), true);
  assertBool('T17b_gemini_in_list', capIds.includes('GEMINI'), true);

  // ── T18: Runtime model switch — V3 (no restart) ───────────────────────────
  console.log('\n[T18] Runtime model switch: admin changes activeModel flash→pro, next call uses pro');
  // Verify default is flash
  const liveConfigRef = (aiAdminConfigService as any).config;
  assertEq('T18a_default_flash', liveConfigRef.providers['DEEPSEEK']?.activeModel, 'deepseek-v4-flash');
  // Switch to pro at runtime
  liveConfigRef.providers['DEEPSEEK'].activeModel = 'deepseek-v4-pro';
  let capturedModel18 = '';
  const origPost18 = _mockPost;
  _mockPost = async (url: string, data: any) => { capturedModel18 = data?.model || ''; return makeSuccessResponse('ping'); };
  _mockIsAxiosError = () => false;
  await adapter.generateText('test18');
  assertEq('T18b_switched_to_pro', capturedModel18, 'deepseek-v4-pro');
  // Restore
  liveConfigRef.providers['DEEPSEEK'].activeModel = 'deepseek-v4-flash';
  _mockPost = origPost18;

  // ── T19: NEWS_DISTILLATION feature routing uses deepseek-v4-flash ─────────
  console.log('\n[T19] NEWS_DISTILLATION routing table model = deepseek-v4-flash');
  const newsRoute = (aiAdminConfigService.getConfig() as any).routing['NEWS_DISTILLATION'];
  assertEq('T19a_primary', newsRoute?.primaryProvider, 'DEEPSEEK');
  assertEq('T19b_model', newsRoute?.model, 'deepseek-v4-flash');
  assertEq('T19c_fallback', newsRoute?.fallbackProvider, 'GEMINI');

  // ── T20: FEEDBACK_CATEGORIZATION routing = DEEPSEEK/v4-flash ─────────────
  console.log('\n[T20] FEEDBACK_CATEGORIZATION routing = DEEPSEEK/deepseek-v4-flash');
  const fbRoute = (aiAdminConfigService.getConfig() as any).routing['FEEDBACK_CATEGORIZATION'];
  assertEq('T20a_primary', fbRoute?.primaryProvider, 'DEEPSEEK');
  assertEq('T20b_model', fbRoute?.model, 'deepseek-v4-flash');

  // ── T21: resolveForFeature falls back to GEMINI when DEEPSEEK disabled ────
  console.log('\n[T21] resolveForFeature falls back to GEMINI when DEEPSEEK disabled');
  // DEEPSEEK.enabled is false in default config
  const resolvedNews = resolver.resolveForFeature('NEWS_DISTILLATION', 'distillNewsArticle');
  // DEEPSEEK.enabled=false → tryProvider fails → fallback GEMINI → resolveProvider(GEMINI)
  assertEq('T21', resolvedNews?.providerId, 'GEMINI');

  // ── T22: resolveForFeature returns DEEPSEEK when DEEPSEEK enabled ──────────
  console.log('\n[T22] resolveForFeature returns DEEPSEEK when DEEPSEEK enabled');
  const cfg22 = (aiAdminConfigService as any).config;
  cfg22.providers['DEEPSEEK'].enabled = true;
  const resolvedNews22 = resolver.resolveForFeature('NEWS_DISTILLATION', 'distillNewsArticle');
  assertEq('T22', resolvedNews22?.providerId, 'DEEPSEEK');
  cfg22.providers['DEEPSEEK'].enabled = false;

  // ── T23: Model registry contains deepseek-v4-flash and deepseek-v4-pro ────
  console.log('\n[T23] Model registry contains both DeepSeek models');
  const registry = aiAdminConfigService.getConfig().modelRegistry;
  assertBool('T23a_flash_in_registry', 'deepseek-v4-flash' in registry, true);
  assertBool('T23b_pro_in_registry', 'deepseek-v4-pro' in registry, true);
  assertEq('T23c_flash_pricing_input', registry['deepseek-v4-flash']?.pricing?.inputPerMillionUsd, 0.22);
  assertEq('T23d_pro_pricing_input', registry['deepseek-v4-pro']?.pricing?.inputPerMillionUsd, 0.66);
  assertBool('T23e_flash_has_cache_hit', registry['deepseek-v4-flash']?.pricing?.cacheHitInputPerMillionUsd !== undefined, true);

  // ── T24: probeWithModel — exact model, no shared config mutation ──────────
  // Replaces the former withActiveModel test (removed — it was concurrency-unsafe).
  // probeWithModel takes model as a stack-local param. Shared config NEVER mutated.
  console.log('\n[T24] probeWithModel: sends exact model, does NOT mutate shared config');
  const cfg24 = (aiAdminConfigService as any).config;
  const before24 = cfg24.providers['DEEPSEEK']?.activeModel; // 'deepseek-v4-flash'
  let captured24 = '';
  _mockPost = async (url: string, data: any) => { captured24 = data?.model || ''; return makeSuccessResponse('ok'); };
  _mockIsAxiosError = () => false;
  // probeWithModel takes 'deepseek-v4-pro' as an explicit param — never touches config
  await adapter.probeWithModel('probe24', 'deepseek-v4-pro', false);
  assertEq('T24a_probed_pro', captured24, 'deepseek-v4-pro');
  // Shared config must be UNCHANGED after the probe
  assertEq('T24b_config_unchanged', cfg24.providers['DEEPSEEK']?.activeModel, before24);
  _mockPost = null;

  // ── T25: AiFeatureKey includes NEWS_DISTILLATION and GENERIC_PROMPT ────────
  console.log('\n[T25] AiFeatureKey routing table covers NEWS_DISTILLATION and GENERIC_PROMPT');
  const routingKeys = Object.keys(aiAdminConfigService.getConfig().routing);
  assertBool('T25a_news_key', routingKeys.includes('NEWS_DISTILLATION'), true);
  assertBool('T25b_generic_key', routingKeys.includes('GENERIC_PROMPT'), true);

  // ── T26: API key never in any adapter error or observable field ────────────
  console.log('\n[T26] API key never exposed in error or log fields');
  aiConfig.deepseek.apiKey = 'SUPER_SECRET_KEY_26';
  _mockIsAxiosError = () => true;
  _mockPost = async () => { throw makeAxiosError(500, 'Internal Error'); };
  try {
    await adapter.generateText('test26');
  } catch (err: any) {
    assertNotContains('T26_key_not_in_message', err.message || '', 'SUPER_SECRET_KEY_26');
  }
  aiConfig.deepseek.apiKey = FAKE_KEY;

  // ── T27: Gemini adapter reads model from admin config (V3 gap closed) ──────
  console.log('\n[T27] GeminiAdapter reads activeModel from admin config at call time');
  const geminiAdapterTest = new GeminiAdapter();
  const cfg27 = (aiAdminConfigService as any).config;
  cfg27.providers['GEMINI'].activeModel = 'gemini-1.5-pro';
  // Verify getActiveModel returns admin config value
  // We can infer via log — call generateText and check model used in the URL
  // (We won't make a real HTTP call; just verify config plumbing)
  const currentGeminiModel = (geminiAdapterTest as any).getActiveModel();
  assertEq('T27', currentGeminiModel, 'gemini-1.5-pro');
  cfg27.providers['GEMINI'].activeModel = 'gemini-2.5-flash'; // restore

  // ── T28: Concurrency regression — probe cannot pollute shared config ────────
  // Proves: a concurrent production request reading aiAdminConfigService.getConfig()
  // DURING an in-flight probeWithModel sees the original config, not the probe model.
  // This is the regression guard: withActiveModel was concurrency-unsafe (it mutated
  // this.config across await). probeWithModel is request-local and never mutates config.
  console.log('\n[T28] Concurrency regression: probeWithModel never mutates shared config');
  const cfg28 = (aiAdminConfigService as any).config;
  const beforeProbe28 = cfg28.providers['DEEPSEEK']?.activeModel; // 'deepseek-v4-flash'
  let configObservedDuringProbe28 = 'NOT_OBSERVED'; // will be set during the await
  _mockIsAxiosError = () => false;
  _mockPost = async (url: string, data: any) => {
    // This simulates a concurrent request reading shared config at the await point
    configObservedDuringProbe28 = (aiAdminConfigService as any).config.providers['DEEPSEEK']?.activeModel || '';
    return makeSuccessResponse('concurrent-test');
  };
  // Probe with 'deepseek-v4-pro' — should NOT change shared config to 'deepseek-v4-pro'
  await adapter.probeWithModel('concurrent-probe', 'deepseek-v4-pro', false);
  // Concurrent request must have seen 'deepseek-v4-flash' (original), NOT 'deepseek-v4-pro'
  assertEq('T28a_concurrent_sees_original', configObservedDuringProbe28, 'deepseek-v4-flash');
  // Shared config unchanged after probe
  assertEq('T28b_config_unchanged_after', cfg28.providers['DEEPSEEK']?.activeModel, beforeProbe28);
  _mockPost = null;

  // ── Restore ────────────────────────────────────────────────────────────────
  _mockPost = null;
  _mockIsAxiosError = null;
  aiConfig.deepseek.apiKey = '';

  // ── Summary ────────────────────────────────────────────────────────────────
  console.log(`\n${'─'.repeat(60)}`);
  console.log(`PHASE_087N21 DeepSeek Adapter Tests — ${passed + failed} total`);
  console.log(`✅ Passed: ${passed}   ❌ Failed: ${failed}`);
  if (failures.length > 0) {
    console.error('\nFailed tests:');
    failures.forEach(f => console.error(`  - ${f}`));
    process.exit(1);
  } else {
    console.log('All tests passed.');
    process.exit(0);
  }
}

runTests().catch(err => {
  console.error('Test runner crashed:', err);
  process.exit(1);
});
