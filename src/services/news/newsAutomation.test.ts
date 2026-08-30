/**
 * Phase 068 — Railway News Automation & Source Expansion Test Suite
 *
 * Tests:
 * 1. Source registration (Tier 1, Tier 2, Tier 3)
 * 2. Successful feed URL normalization & slug generation
 * 3. Source timeout handling & graceful degradation
 * 4. HTTP 429 rate limit handling & circuit breaker
 * 5. HTTP 500 failure isolation
 * 6. Malformed feed handling
 * 7. Duplicate URL suppression
 * 8. Near-duplicate SimHash suppression
 * 9. Changed source article detection (creates updated draft)
 * 10. AI failure graceful fallback to deterministic extraction
 * 11. Hallucination validation rejection (unsupported trains/stations)
 * 12. Strict no auto-publish verification
 *
 * Run with: npx ts-node src/services/news/newsAutomation.test.ts
 */

import { newsSourceRegistry, NewsSourceRegistry } from './newsSourceRegistry';
import { NewsIngestionEngine } from './newsIngestionEngine';
import { NewsDistillationService, NewsFactValidator } from './newsDistillationService';
import { CanonicalNewsArticle, NewsSource } from './newsTypes';
import { SimHash } from './simHash';

let passed = 0;
let failed = 0;
const results: string[] = [];

async function test(name: string, fn: () => void | Promise<void>) {
  try {
    await fn();
    passed++;
    results.push(`  ✅ ${name}`);
  } catch (err: any) {
    failed++;
    results.push(`  ❌ ${name}: ${err.message}`);
  }
}

function assert(condition: boolean, msg: string) {
  if (!condition) throw new Error(msg);
}

async function runSuite() {
  console.log('\n=== RUNNING PHASE 068 NEWS AUTOMATION & SOURCE EXPANSION TESTS ===\n');

  // 1. Source Registration (Tier 1, Tier 2, Tier 3)
  await test('1. Source registration across all 3 tiers', () => {
    const registry = new NewsSourceRegistry();
    const all = registry.getAllSources();
    assert(all.length >= 10, `Expected at least 10 sources, got ${all.length}`);

    const tier1 = registry.getSourcesByTier('TIER_1_OFFICIAL');
    const tier2 = registry.getSourcesByTier('TIER_2_GOVERNMENT');
    const tier3 = registry.getSourcesByTier('TIER_3_RECOGNIZED_MEDIA');

    assert(tier1.length >= 4, `Expected >= 4 Tier 1 sources, got ${tier1.length}`);
    assert(tier2.length >= 4, `Expected >= 4 Tier 2 sources, got ${tier2.length}`);
    assert(tier3.length >= 3, `Expected >= 3 Tier 3 sources, got ${tier3.length}`);

    const pib = registry.getSource('src_pib_railways');
    assert(pib !== undefined, 'PIB source should be defined');
    assert(pib?.tier === 'TIER_1_OFFICIAL', 'PIB must be Tier 1');
    assert(pib?.enabled === true, 'PIB must be enabled');
  });

  // 2. Successful Fetch & Normalization
  await test('2. Successful feed URL normalization and slug generation', () => {
    const engine = new NewsIngestionEngine();
    const cleanUrl = engine.normalizeUrl('https://pib.gov.in/PressReleasePage.aspx?PRID=12345&utm_source=google&utm_medium=rss#section');
    assert(cleanUrl === 'https://pib.gov.in/PressReleasePage.aspx?PRID=12345', `Unexpected normalized URL: ${cleanUrl}`);

    const slug = engine.generateSlug('Vande Bharat Express Route Expanded', '2026-08-25T10:00:00Z');
    assert(slug === 'vande-bharat-express-route-expanded-2026-08-25', `Unexpected slug: ${slug}`);
  });

  // 3. Source Timeout Handling
  await test('3. Source timeout handling does not crash ingestion', async () => {
    const engine = new NewsIngestionEngine();

    // Override fetchFeedWithRetry to simulate timeout
    engine.fetchFeedWithRetry = async () => {
      throw new Error('Connection timed out after 10000ms');
    };

    const testSource: NewsSource = {
      id: 'test_timeout_src',
      name: 'Timeout Test Feed',
      url: 'https://invalid-timeout.gov.in/feed',
      tier: 'TIER_1_OFFICIAL',
      category: 'Official',
      enabled: true,
    };
    newsSourceRegistry.registerSource(testSource);

    const res = await engine.ingestSource(testSource, []);
    assert(res.status === 'FAILED', `Expected status FAILED, got ${res.status}`);
    assert(res.accepted.length === 0, 'No articles should be accepted on timeout');
    assert(res.error?.includes('timed out') || false, 'Error message should mention timeout');
  });

  // 4. HTTP 429 Rate Limit Handling
  await test('4. HTTP 429 rate limit trips circuit breaker and pauses source', () => {
    const testSource: NewsSource = {
      id: 'test_429_src',
      name: 'Rate Limited Feed',
      url: 'https://test.gov.in/feed',
      tier: 'TIER_2_GOVERNMENT',
      category: 'Operations',
      enabled: true,
    };
    newsSourceRegistry.registerSource(testSource);

    assert(newsSourceRegistry.canAttempt('test_429_src') === true, 'Should initially be able to attempt');

    // Record HTTP 429 failure
    newsSourceRegistry.recordFailure('test_429_src', 'Too Many Requests', 150, 429);

    const health = newsSourceRegistry.getHealthSummary().find(h => h.sourceId === 'test_429_src');
    assert(health?.status === 'CIRCUIT_BROKEN', `Expected CIRCUIT_BROKEN, got ${health?.status}`);
    assert(health?.httpStatus === 429, `Expected HTTP 429, got ${health?.httpStatus}`);
    assert(newsSourceRegistry.canAttempt('test_429_src') === false, 'Circuit breaker should block attempts during rate limit');
  });

  // 5. HTTP 500 Failure Isolation
  await test('5. HTTP 500 server error isolates failure without affecting other sources', () => {
    const registry = new NewsSourceRegistry();
    const s1: NewsSource = { id: 's1', name: 'Broken Feed', url: 'http://s1', tier: 'TIER_1_OFFICIAL', category: 'Official', enabled: true };
    const s2: NewsSource = { id: 's2', name: 'Healthy Feed', url: 'http://s2', tier: 'TIER_1_OFFICIAL', category: 'Official', enabled: true };
    registry.registerSource(s1);
    registry.registerSource(s2);

    registry.recordFailure('s1', 'Internal Server Error', 500, 500);
    registry.recordSuccess('s2', 120, 200);

    const health1 = registry.getHealthSummary().find(h => h.sourceId === 's1');
    const health2 = registry.getHealthSummary().find(h => h.sourceId === 's2');

    assert(health1?.status === 'DEGRADED', `Expected DEGRADED for s1, got ${health1?.status}`);
    assert(health2?.status === 'HEALTHY', `Expected HEALTHY for s2, got ${health2?.status}`);
    assert(registry.canAttempt('s2') === true, 'Healthy source s2 should remain active');
  });

  // 6. Malformed Feed Handling
  await test('6. Malformed or empty feed handles gracefully with zero accepted', async () => {
    const engine = new NewsIngestionEngine();
    engine.fetchFeedWithRetry = async () => ({
      items: [
        { title: 'Bad', link: 'not-a-url', summary: '' },
        { title: '', link: '', summary: '' }
      ]
    });

    const dummySource: NewsSource = {
      id: 'dummy_malformed',
      name: 'Malformed Source',
      url: 'https://example.com/bad.xml',
      tier: 'TIER_3_RECOGNIZED_MEDIA',
      category: 'Operations',
      enabled: true,
    };
    newsSourceRegistry.registerSource(dummySource);

    const res = await engine.ingestSource(dummySource, []);
    assert(res.status === 'SUCCESS', `Expected SUCCESS, got ${res.status}`);
    assert(res.accepted.length === 0, 'Should accept 0 items');
    assert(res.rejectedCount === 2, `Expected 2 rejected items, got ${res.rejectedCount}`);
  });

  // 7. Duplicate URL Suppression
  await test('7. Duplicate canonical URL is suppressed', () => {
    const engine = new NewsIngestionEngine();
    const existing: CanonicalNewsArticle[] = [{
      id: 'art_1',
      slug: 'train-cancel-1',
      title: 'Train 12004 Cancelled Due to Track Repair',
      summary: 'Northern railway announced cancellation of train 12004.',
      source_url: 'https://news.rail.gov/cancel-12004',
      source_guid: 'guid-12004',
      content_hash: 'hash123',
      simhash: SimHash.compute('Train 12004 Cancelled Due to Track Repair'),
      source_name: 'Northern Railway',
      source_id: 'src_nr',
      source_tier: 'TIER_1_OFFICIAL',
      category: 'Cancellation',
      status: 'PUBLISHED',
      ingestion_status: 'INGESTION_COMPLETE',
      published_at: '2026-08-25T10:00:00Z',
      first_seen_at: '2026-08-25T10:00:00Z',
      last_seen_at: '2026-08-25T10:00:00Z',
      created_at: '2026-08-25T10:00:00Z',
      updated_at: '2026-08-25T10:00:00Z',
      key_takeaways: [],
      affected_trains: ['12004'],
      affected_stations: ['NDLS'],
      relevance_score: 150,
      image_url: null,
      seo_title: null,
      meta_description: null,
    }];

    const dedup = engine.checkDeduplicationAndChange(
      'https://news.rail.gov/cancel-12004',
      'guid-12004',
      'hash123',
      SimHash.compute('Train 12004 Cancelled Due to Track Repair'),
      existing
    );

    assert(dedup.isDuplicate === true, 'Should be duplicate');
    assert(dedup.isChangeDetected === false, 'Should not detect change on identical content');
  });

  // 8. Near-duplicate SimHash Suppression
  await test('8. Near-duplicate article with minor headline variation is suppressed via SimHash', () => {
    const engine = new NewsIngestionEngine();
    const title1 = 'Ministry of Railways flags off new Vande Bharat Express between Delhi and Varanasi';
    const title2 = 'Ministry of Railways flagged off new Vande Bharat Express between Delhi and Varanasi today';

    const sim1 = SimHash.compute(title1);
    const sim2 = SimHash.compute(title2);

    const existing: CanonicalNewsArticle[] = [{
      id: 'art_vb_1',
      slug: 'vb-delhi-varanasi',
      title: title1,
      summary: 'New Vande Bharat train flagged off.',
      source_url: 'https://pib.gov.in/vb-1',
      source_guid: null,
      content_hash: 'hash_vb_1',
      simhash: sim1,
      source_name: 'PIB',
      source_id: 'src_pib',
      source_tier: 'TIER_1_OFFICIAL',
      category: 'Vande Bharat',
      status: 'PUBLISHED',
      ingestion_status: 'INGESTION_COMPLETE',
      published_at: '2026-08-25T10:00:00Z',
      first_seen_at: '2026-08-25T10:00:00Z',
      last_seen_at: '2026-08-25T10:00:00Z',
      created_at: '2026-08-25T10:00:00Z',
      updated_at: '2026-08-25T10:00:00Z',
      key_takeaways: [],
      affected_trains: [],
      affected_stations: ['NDLS', 'BSB'],
      relevance_score: 160,
      image_url: null,
      seo_title: null,
      meta_description: null,
    }];

    const dedup = engine.checkDeduplicationAndChange(
      'https://syndicated.com/vb-mirror',
      null,
      'different_hash',
      sim2,
      existing
    );

    assert(dedup.isDuplicate === true, 'Near-duplicate story should be suppressed by SimHash');
  });

  // 9. Changed Source Article Detection (Creates Updated Draft)
  await test('9. Material content change in existing article URL creates updated draft without overwriting', () => {
    const engine = new NewsIngestionEngine();
    const existing: CanonicalNewsArticle[] = [{
      id: 'art_published_orig',
      slug: 'special-train-monsoon',
      title: 'Special Trains Announced for Festival Rush',
      summary: 'Northern Railway announces 10 festival special trains.',
      source_url: 'https://nr.gov.in/festival-specials',
      source_guid: 'guid-fest-1',
      content_hash: 'original_hash_111',
      simhash: SimHash.compute('Special Trains Announced for Festival Rush'),
      source_name: 'Northern Railway',
      source_id: 'src_nr',
      source_tier: 'TIER_1_OFFICIAL',
      category: 'Operations',
      status: 'PUBLISHED',
      ingestion_status: 'INGESTION_COMPLETE',
      published_at: '2026-08-25T08:00:00Z',
      first_seen_at: '2026-08-25T08:00:00Z',
      last_seen_at: '2026-08-25T08:00:00Z',
      created_at: '2026-08-25T08:00:00Z',
      updated_at: '2026-08-25T08:00:00Z',
      key_takeaways: [],
      affected_trains: [],
      affected_stations: [],
      relevance_score: 150,
      image_url: null,
      seo_title: null,
      meta_description: null,
    }];

    // Same URL, but content changed (e.g. 5 more trains added)
    const dedup = engine.checkDeduplicationAndChange(
      'https://nr.gov.in/festival-specials',
      'guid-fest-1',
      'updated_hash_999_more_trains',
      SimHash.compute('Special Trains Announced for Festival Rush — 15 Additional Trains Added'),
      existing
    );

    assert(dedup.isChangeDetected === true, 'Change detection should flag material update');
    assert(dedup.matchedArticleId === 'art_published_orig', 'Should link to original article ID');
  });

  // 10. AI Failure Graceful Fallback
  await test('10. AI distillation failure falls back to deterministic extraction', () => {
    const distillation = new NewsDistillationService();
    const article: CanonicalNewsArticle = {
      id: 'test_ai_fallback',
      slug: 'irctc-tatkal-guide',
      title: 'IRCTC Issues Advisory on Tatkal Booking Timings and Guidelines',
      summary: 'IRCTC clarifies booking windows for AC and Non-AC Tatkal reservations.',
      source_name: 'IRCTC Official',
      source_url: 'https://irctc.co.in/tatkal-rules',
      source_id: 'src_irctc',
      source_tier: 'TIER_1_OFFICIAL',
      source_guid: null,
      content_hash: 'hash_irctc_tatkal',
      simhash: SimHash.compute('IRCTC Tatkal booking rules'),
      relevance_score: 150,
      category: 'Tatkal',
      status: 'READY_FOR_AI',
      ingestion_status: 'PENDING_AI',
      published_at: '2026-08-25T10:00:00Z',
      first_seen_at: '2026-08-25T10:00:00Z',
      last_seen_at: '2026-08-25T10:00:00Z',
      created_at: '2026-08-25T10:00:00Z',
      updated_at: '2026-08-25T10:00:00Z',
      key_takeaways: [],
      affected_trains: [],
      affected_stations: [],
      image_url: null,
      seo_title: null,
      meta_description: null,
    };

    const draft = distillation.generateDeterministicDraft(article);
    assert(!!draft.key_takeaways?.what_happened, 'Takeaways what_happened should exist');
    assert(draft.faqs.length >= 1, 'FAQs should be generated');
    assert(draft.model === 'DETERMINISTIC_FALLBACK', 'Should flag model as DETERMINISTIC_FALLBACK');
  });

  // 11. Hallucination Validation Rejection
  await test('11. Hallucinated train numbers or stations are strictly rejected', () => {
    const source = {
      title: 'Track Maintenance on Delhi Mathura Section',
      summary: 'Northern railway will conduct maintenance work between Delhi and Mathura.',
      sourceName: 'Northern Railway',
      sourceUrl: 'https://nr.gov.in',
      sourceTier: 'TIER_1_OFFICIAL' as const,
      publishedAt: '2026-08-25T10:00:00Z',
      category: 'Delays',
      candidateTrains: [],
      candidateStations: ['NDLS', 'MTJ'],
    };

    const hallucinatedOutput = {
      title: 'Track Maintenance on Delhi Mathura Section',
      summary: 'Maintenance work ongoing.',
      key_takeaways: {
        what_happened: 'Track work underway.',
        who_is_affected: 'Passengers.',
        what_passengers_should_do: 'Plan ahead.',
      },
      affected_trains: ['99999'], // Fabricated train number not in source
      affected_stations: ['NDLS', 'MTJ'],
      seo_title: 'Track Maintenance',
      meta_description: 'Track work',
      slug: 'track-maintenance',
      faqs: [],
      confidence: 'HIGH' as const,
    };

    const val = NewsFactValidator.validate(source, hallucinatedOutput);
    assert(val.isValid === false, 'Should be invalid due to hallucinated train number');
    assert(val.confidence === 'REJECTED', 'Confidence should be REJECTED');
    assert(val.rejectionReason === 'UNSUPPORTED_CLAIM', 'Reason should be UNSUPPORTED_CLAIM');
    assert(val.unsupportedEntities?.includes('Train 99999') || false, 'Should flag Train 99999');
  });

  // 12. Strict No Auto-Publish Verification
  await test('12. Distillation output status is AI_DRAFTED and NEVER PUBLISHED', async () => {
    const distillation = new NewsDistillationService();
    const article: CanonicalNewsArticle = {
      id: 'test_no_autopublish',
      slug: 'pib-bullet-train-progress',
      title: 'Ministry of Railways Releases Progress Update on Mumbai Ahmedabad Bullet Train Project',
      summary: 'Over 300 km of pier work completed on the high speed rail corridor between Mumbai and Ahmedabad.',
      source_name: 'Ministry of Railways (PIB)',
      source_url: 'https://pib.gov.in/bullet-train-update',
      source_id: 'src_pib_railways',
      source_tier: 'TIER_1_OFFICIAL',
      source_guid: null,
      content_hash: 'hash_bullet_300km',
      simhash: SimHash.compute('Mumbai Ahmedabad Bullet train pier work 300km'),
      relevance_score: 180,
      category: 'New Routes',
      status: 'READY_FOR_AI',
      ingestion_status: 'PENDING_AI',
      published_at: '2026-08-25T11:00:00Z',
      first_seen_at: '2026-08-25T11:00:00Z',
      last_seen_at: '2026-08-25T11:00:00Z',
      created_at: '2026-08-25T11:00:00Z',
      updated_at: '2026-08-25T11:00:00Z',
      key_takeaways: [],
      affected_trains: [],
      affected_stations: ['BCT', 'ADI'],
      image_url: null,
      seo_title: null,
      meta_description: null,
    };

    const result = await distillation.distillArticle(article);
    const draftedArticle = (result as any).article || result;
    assert(draftedArticle.status === 'AI_DRAFTED', `Expected status AI_DRAFTED, got ${draftedArticle.status}`);
    assert(draftedArticle.status !== 'PUBLISHED', 'Distillation must NEVER automatically set status to PUBLISHED');
  });

  // Print results summary
  console.log(results.join('\n'));
  console.log(`\nTOTAL: ${passed + failed} | PASSED: ${passed} | FAILED: ${failed}`);

  if (failed > 0) {
    process.exit(1);
  }
}

runSuite().catch(err => {
  console.error('Test runner fatal error:', err);
  process.exit(1);
});
