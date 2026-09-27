/**
 * News Source Verification Service (Phase 081)
 *
 * Production-Safe Source Verification & Claim Evidence Extraction for Railway News.
 *
 * Workflow:
 * Draft → Source URL Validation → SSRF-Safe Fetch → Source Identity Check
 *       → Freshness Classification → Claim Evidence Extraction → Verification State
 *
 * Governance:
 * - Read-only analytical & verification assistance.
 * - Zero auto-publishing. Zero auto-editing.
 * - SSRF protection: blocks private subnets, localhost, and cloud metadata.
 * - Zero fabrication: Unsupported claims are tagged UNSUPPORTED without rewriting.
 */

import { winstonLogger } from '../../middleware/logger';
import { SourceTier } from './newsTypes';
import * as http from 'http';
import * as https from 'https';
import { URL } from 'url';

// ─── Interfaces ─────────────────────────────────────────────────────────────

export type VerificationState =
  | 'SOURCE_VERIFIED'
  | 'SOURCE_REACHABLE'
  | 'SOURCE_UNREACHABLE'
  | 'SOURCE_MISMATCH'
  | 'SOURCE_REQUIRED'
  | 'SOURCE_STALE';

export type FreshnessClassification = 'FRESH' | 'RECENT' | 'AGING' | 'STALE' | 'UNDETERMINED';

export type ClaimType =
  | 'TRAIN_NUMBER'
  | 'TRAIN_NAME'
  | 'STATION'
  | 'STATUS_DISRUPTION'
  | 'SCHEDULE_DATE'
  | 'FARE_RULE'
  | 'PASSENGER_ADVICE';

export type ClaimStatus = 'SUPPORTED' | 'PARTIALLY_SUPPORTED' | 'UNSUPPORTED' | 'NOT_CHECKABLE';

export interface ClaimEvidenceItem {
  claim: string;
  claim_type: ClaimType;
  status: ClaimStatus;
  evidence: string;
  source_reference: string;
}

export interface SourceVerificationReport {
  success: boolean;
  state: VerificationState;
  source_name: string;
  source_url: string;
  source_tier: SourceTier | 'UNREGISTERED';
  hostname: string;
  http_status: number | null;
  reachable: boolean;
  freshness: FreshnessClassification;
  published_at: string | null;
  fetched_at: string;
  total_claims: number;
  supported_claims: number;
  unsupported_claims: number;
  partial_claims: number;
  claims: ClaimEvidenceItem[];
  warnings: string[];
  recommendation: string;
}

export interface DraftVerificationInput {
  title: string;
  summary: string;
  passenger_advice?: string;
  category?: string;
  affected_trains?: string[];
  affected_stations?: string[];
  source_name?: string;
  source_url?: string;
  source_tier?: string;
}

// ─── Domain Whitelist & Tiers ────────────────────────────────────────────────

const TIER_1_OFFICIAL_DOMAINS = [
  'pib.gov.in',
  'indianrailways.gov.in',
  'digitalindia.gov.in',
  'irctc.co.in',
  'cris.org.in',
  'railmadad.indianrailways.gov.in',
  'enquiry.indianrailways.gov.in',
  'ntes.indianrailways.gov.in',
  'rdso.indianrailways.gov.in',
  'nr.indianrailways.gov.in',
  'wr.indianrailways.gov.in',
  'er.indianrailways.gov.in',
  'sr.indianrailways.gov.in',
  'cr.indianrailways.gov.in',
  'scr.indianrailways.gov.in',
  'ecr.indianrailways.gov.in',
  'ncr.indianrailways.gov.in',
  'ner.indianrailways.gov.in',
  'nfr.indianrailways.gov.in',
  'nwr.indianrailways.gov.in',
  'secr.indianrailways.gov.in',
  'swr.indianrailways.gov.in',
  'wcr.indianrailways.gov.in',
  'ecor.indianrailways.gov.in',
  'ser.indianrailways.gov.in',
  'rvnl.org',
  'ircon.org',
  'rites.com',
  'dfccil.com',
];

const TIER_2_GOVERNMENT_DOMAINS = [
  'delhimetrorail.com',
  'maha-metro.org',
  'bmrc.co.in',
  'kmrl.co.in',
  'chennaimetrorail.org',
  'mmrda.maharashtra.gov.in',
  'upmetrorail.com',
  'transport.delhi.gov.in',
  'msrtc.maharashtra.gov.in',
  'ksrtc.in',
  'apsrtc.ap.gov.in',
];

const TIER_3_MEDIA_DOMAINS = [
  'thehindu.com',
  'indianexpress.com',
  'timesofindia.indiatimes.com',
  'economictimes.indiatimes.com',
  'livemint.com',
  'business-standard.com',
  'ndtv.com',
  'zeenews.india.com',
  'hindustantimes.com',
  'financialexpress.com',
  'indiatoday.in',
  'news18.com',
  'aninews.in',
  'ptinews.com',
  'theprint.in',
  'thewire.in',
  'deccanherald.com',
  'dnaindia.com',
  'moneycontrol.com',
];

export class NewsSourceVerificationService {
  private readonly MAX_RESPONSE_SIZE = 1024 * 1024; // 1 MB
  private readonly REQUEST_TIMEOUT_MS = 8000; // 8 seconds
  private readonly MAX_REDIRECTS = 3;

  /**
   * Main verification entry point for a news draft.
   */
  public async verifyDraftSource(draft: DraftVerificationInput): Promise<SourceVerificationReport> {
    const fetchedAt = new Date().toISOString();
    const sourceUrl = (draft.source_url || '').trim();
    const sourceName = (draft.source_name || 'Unspecified Source').trim();
    const declaredTier = (draft.source_tier as SourceTier) || 'TIER_3_RECOGNIZED_MEDIA';

    // 1. Source Required Check
    if (!sourceUrl) {
      return {
        success: false,
        state: 'SOURCE_REQUIRED',
        source_name: sourceName,
        source_url: '',
        source_tier: declaredTier,
        hostname: '',
        http_status: null,
        reachable: false,
        freshness: 'UNDETERMINED',
        published_at: null,
        fetched_at: fetchedAt,
        total_claims: 0,
        supported_claims: 0,
        unsupported_claims: 0,
        partial_claims: 0,
        claims: [],
        warnings: ['No source URL provided for this draft. Official source verification is required.'],
        recommendation: 'Add a verified official railway press release or accredited circular URL.',
      };
    }

    // 2. Validate URL syntax & hostname
    let parsedUrl: URL;
    try {
      parsedUrl = new URL(sourceUrl);
    } catch {
      return {
        success: false,
        state: 'SOURCE_UNREACHABLE',
        source_name: sourceName,
        source_url: sourceUrl,
        source_tier: declaredTier,
        hostname: '',
        http_status: null,
        reachable: false,
        freshness: 'UNDETERMINED',
        published_at: null,
        fetched_at: fetchedAt,
        total_claims: 0,
        supported_claims: 0,
        unsupported_claims: 0,
        partial_claims: 0,
        claims: [],
        warnings: [`Invalid URL format: "${sourceUrl}"`],
        recommendation: 'Provide a valid HTTP or HTTPS source link.',
      };
    }

    const hostname = parsedUrl.hostname.toLowerCase();

    // 3. SSRF Protection: Reject private/local IPs and internal hostnames
    if (this.isSsrfBlocked(hostname, parsedUrl.protocol)) {
      winstonLogger.warn(`[SSRF_BLOCKED] Attempted fetch to restricted host: ${hostname}`);
      return {
        success: false,
        state: 'SOURCE_UNREACHABLE',
        source_name: sourceName,
        source_url: sourceUrl,
        source_tier: declaredTier,
        hostname,
        http_status: null,
        reachable: false,
        freshness: 'UNDETERMINED',
        published_at: null,
        fetched_at: fetchedAt,
        total_claims: 0,
        supported_claims: 0,
        unsupported_claims: 0,
        partial_claims: 0,
        claims: [],
        warnings: [`SSRF protection: Fetch to host "${hostname}" is blocked.`],
        recommendation: 'Only public web URLs from recognized domains can be verified.',
      };
    }

    // 4. Source Identity & Domain Whitelist Validation
    const detectedTier = this.classifyDomainTier(hostname);
    const isDomainMismatch = this.checkDomainMismatch(hostname, declaredTier, detectedTier, sourceName);

    if (isDomainMismatch) {
      return {
        success: false,
        state: 'SOURCE_MISMATCH',
        source_name: sourceName,
        source_url: sourceUrl,
        source_tier: detectedTier,
        hostname,
        http_status: null,
        reachable: false,
        freshness: 'UNDETERMINED',
        published_at: null,
        fetched_at: fetchedAt,
        total_claims: 0,
        supported_claims: 0,
        unsupported_claims: 0,
        partial_claims: 0,
        claims: [],
        warnings: [
          `Domain "${hostname}" does not match declared source "${sourceName}" or declared tier "${declaredTier}".`,
        ],
        recommendation: 'Update source tier or provide an authentic official government/railway domain link.',
      };
    }

    // 5. Fetch Content Safely
    const fetchResult = await this.safeFetchSourceContent(sourceUrl);
    if (!fetchResult.reachable || !fetchResult.body) {
      return {
        success: false,
        state: 'SOURCE_UNREACHABLE',
        source_name: sourceName,
        source_url: sourceUrl,
        source_tier: detectedTier,
        hostname,
        http_status: fetchResult.status,
        reachable: false,
        freshness: 'UNDETERMINED',
        published_at: null,
        fetched_at: fetchedAt,
        total_claims: 0,
        supported_claims: 0,
        unsupported_claims: 0,
        partial_claims: 0,
        claims: [],
        warnings: [fetchResult.error || `Source returned HTTP ${fetchResult.status || 'UNREACHABLE'}`],
        recommendation: 'Check source website availability or replace with an accessible press release.',
      };
    }

    // 6. Source Freshness Extraction
    const { freshness, publishedAt } = this.extractSourceFreshness(fetchResult.body, fetchResult.headers);

    // 7. Extract Claims & Evaluate Evidence against Source Content
    const claims = this.extractAndVerifyClaims(draft, fetchResult.body, sourceUrl);
    const supportedCount = claims.filter(c => c.status === 'SUPPORTED').length;
    const partialCount = claims.filter(c => c.status === 'PARTIALLY_SUPPORTED').length;
    const unsupportedCount = claims.filter(c => c.status === 'UNSUPPORTED').length;
    const totalCount = claims.length;

    // 8. Determine Overall Verification State
    let overallState: VerificationState = 'SOURCE_VERIFIED';
    const warnings: string[] = [];

    if (freshness === 'STALE') {
      overallState = 'SOURCE_STALE';
      warnings.push(`Source publication date (${publishedAt || 'older than 30 days'}) is stale.`);
    } else if (unsupportedCount > 0) {
      overallState = 'SOURCE_REACHABLE';
      warnings.push(
        `${unsupportedCount} factual claim(s) in the draft are not supported by the fetched source text.`
      );
    } else if (detectedTier === 'UNREGISTERED') {
      overallState = 'SOURCE_REACHABLE';
      warnings.push(`Domain "${hostname}" is reachable but not in the pre-approved railway media registry.`);
    }

    let recommendation = 'Source verified and claims confirmed. Safe to proceed with editorial approval checklist.';
    if (overallState === 'SOURCE_STALE') {
      recommendation = 'The source notice appears dated. Confirm whether an updated bulletin or restored schedule is in effect.';
    } else if (unsupportedCount > 0) {
      recommendation = 'Review unsupported claims manually before approval. Remove or correct train numbers or disruption details not found in the source.';
    }

    return {
      success: true,
      state: overallState,
      source_name: sourceName,
      source_url: sourceUrl,
      source_tier: detectedTier,
      hostname,
      http_status: fetchResult.status,
      reachable: true,
      freshness,
      published_at: publishedAt,
      fetched_at: fetchedAt,
      total_claims: totalCount,
      supported_claims: supportedCount,
      unsupported_claims: unsupportedCount,
      partial_claims: partialCount,
      claims,
      warnings,
      recommendation,
    };
  }

  // ─── SSRF Protection ───────────────────────────────────────────────────────

  public isSsrfBlocked(hostname: string, protocol: string): boolean {
    if (!['http:', 'https:'].includes(protocol.toLowerCase())) {
      return true;
    }

    const lower = hostname.toLowerCase();

    // Check exact loopback & metadata hostnames
    if (
      lower === 'localhost' ||
      lower === '127.0.0.1' ||
      lower === '0.0.0.0' ||
      lower === '::1' ||
      lower === 'metadata.google.internal' ||
      lower === '169.254.169.254' ||
      lower.endsWith('.internal') ||
      lower.endsWith('.local')
    ) {
      return true;
    }

    // Check IPv4 private ranges: 10.0.0.0/8, 172.16.0.0/12, 192.168.0.0/16, 169.254.0.0/16
    const ipMatch = lower.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
    if (ipMatch) {
      const b1 = parseInt(ipMatch[1], 10);
      const b2 = parseInt(ipMatch[2], 10);
      if (b1 === 10) return true; // 10.0.0.0/8
      if (b1 === 127) return true; // 127.0.0.0/8
      if (b1 === 172 && b2 >= 16 && b2 <= 31) return true; // 172.16.0.0/12
      if (b1 === 192 && b2 === 168) return true; // 192.168.0.0/16
      if (b1 === 169 && b2 === 254) return true; // 169.254.0.0/16 link-local/cloud metadata
      if (b1 === 0) return true; // 0.0.0.0/8
    }

    return false;
  }

  // ─── Domain Whitelist & Tier Classification ────────────────────────────────

  public classifyDomainTier(hostname: string): SourceTier | 'UNREGISTERED' {
    const cleanHost = hostname.toLowerCase().replace(/^www\./, '');

    // Check Tier 1 Official
    if (
      cleanHost.endsWith('.gov.in') ||
      cleanHost.endsWith('.nic.in') ||
      TIER_1_OFFICIAL_DOMAINS.some(d => cleanHost === d || cleanHost.endsWith('.' + d))
    ) {
      return 'TIER_1_OFFICIAL';
    }

    // Check Tier 2 Government
    if (TIER_2_GOVERNMENT_DOMAINS.some(d => cleanHost === d || cleanHost.endsWith('.' + d))) {
      return 'TIER_2_GOVERNMENT';
    }

    // Check Tier 3 Media
    if (TIER_3_MEDIA_DOMAINS.some(d => cleanHost === d || cleanHost.endsWith('.' + d))) {
      return 'TIER_3_RECOGNIZED_MEDIA';
    }

    return 'UNREGISTERED';
  }

  public checkDomainMismatch(
    hostname: string,
    declaredTier: SourceTier,
    detectedTier: SourceTier | 'UNREGISTERED',
    sourceName: string
  ): boolean {
    const sLower = sourceName.toLowerCase();
    const isOfficialClaim =
      sLower.includes('ministry of railways') ||
      sLower.includes('pib') ||
      sLower.includes('railway board') ||
      sLower.includes('official') ||
      sLower.includes('irctc corporate') ||
      declaredTier === 'TIER_1_OFFICIAL';

    // If draft claims to be Official Tier 1, but domain is not an authentic gov/railway official domain
    if (isOfficialClaim && detectedTier !== 'TIER_1_OFFICIAL' && detectedTier !== 'TIER_2_GOVERNMENT') {
      return true;
    }

    return false;
  }

  // ─── Safe Fetch Implementation ─────────────────────────────────────────────

  public async safeFetchSourceContent(
    targetUrl: string,
    redirectCount = 0
  ): Promise<{ status: number | null; reachable: boolean; body: string | null; headers: Record<string, string>; error?: string }> {
    if (redirectCount > this.MAX_REDIRECTS) {
      return { status: null, reachable: false, body: null, headers: {}, error: 'Exceeded maximum redirect limit (3 hops).' };
    }

    let parsedUrl: URL;
    try {
      parsedUrl = new URL(targetUrl);
    } catch (e: any) {
      return { status: null, reachable: false, body: null, headers: {}, error: `Malformed URL: ${e.message}` };
    }

    if (this.isSsrfBlocked(parsedUrl.hostname, parsedUrl.protocol)) {
      return { status: null, reachable: false, body: null, headers: {}, error: `SSRF Blocked on redirect to: ${parsedUrl.hostname}` };
    }

    return new Promise((resolve) => {
      const client = parsedUrl.protocol === 'https:' ? https : http;
      const options = {
        hostname: parsedUrl.hostname,
        port: parsedUrl.port || (parsedUrl.protocol === 'https:' ? 443 : 80),
        path: parsedUrl.pathname + parsedUrl.search,
        method: 'GET',
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36 TrayagoNewsBot/1.0',
          'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
          'Accept-Language': 'en-IN,en;q=0.9',
        },
        timeout: this.REQUEST_TIMEOUT_MS,
      };

      let req: http.ClientRequest;
      try {
        req = client.request(options, (res) => {
          const status = res.statusCode || 0;
          const headers: Record<string, string> = {};
          for (const [k, v] of Object.entries(res.headers)) {
            if (typeof v === 'string') headers[k.toLowerCase()] = v;
          }

          // Handle Redirects
          if ([301, 302, 303, 307, 308].includes(status) && headers['location']) {
            const redirectUrl = new URL(headers['location'], targetUrl).toString();
            res.resume(); // discard response body
            return resolve(this.safeFetchSourceContent(redirectUrl, redirectCount + 1));
          }

          if (status < 200 || status >= 400) {
            res.resume();
            return resolve({
              status,
              reachable: false,
              body: null,
              headers,
              error: `HTTP ${status} ${res.statusMessage || 'Error'}`,
            });
          }

          let data = '';
          let byteLength = 0;
          let aborted = false;

          res.setEncoding('utf8');
          res.on('data', (chunk: string) => {
            if (aborted) return;
            data += chunk;
            byteLength += Buffer.byteLength(chunk, 'utf8');

            if (byteLength > this.MAX_RESPONSE_SIZE) {
              aborted = true;
              req.destroy();
              return resolve({
                status,
                reachable: true,
                body: data,
                headers,
                error: 'Response truncated: exceeded 1MB maximum size limit.',
              });
            }
          });

          res.on('end', () => {
            if (!aborted) {
              resolve({
                status,
                reachable: true,
                body: data,
                headers,
              });
            }
          });

          res.on('error', (err) => {
            resolve({
              status,
              reachable: false,
              body: null,
              headers,
              error: `Stream error: ${err.message}`,
            });
          });
        });

        req.on('timeout', () => {
          req.destroy();
          resolve({
            status: null,
            reachable: false,
            body: null,
            headers: {},
            error: `Connection timed out after ${this.REQUEST_TIMEOUT_MS}ms.`,
          });
        });

        req.on('error', (err) => {
          resolve({
            status: null,
            reachable: false,
            body: null,
            headers: {},
            error: `Connection error: ${err.message}`,
          });
        });

        req.end();
      } catch (err: any) {
        resolve({
          status: null,
          reachable: false,
          body: null,
          headers: {},
          error: `Fetch invocation error: ${err.message}`,
        });
      }
    });
  }

  // ─── Freshness Extraction ──────────────────────────────────────────────────

  public extractSourceFreshness(
    html: string,
    headers: Record<string, string>
  ): { freshness: FreshnessClassification; publishedAt: string | null } {
    let dateStr: string | null = null;

    // 1. Check HTML OpenGraph and standard meta tags
    const metaPatterns = [
      /<meta\s+property=["']article:published_time["']\s+content=["']([^"']+)["']/i,
      /<meta\s+name=["']article:published_time["']\s+content=["']([^"']+)["']/i,
      /<meta\s+property=["']og:published_time["']\s+content=["']([^"']+)["']/i,
      /<meta\s+name=["']pubdate["']\s+content=["']([^"']+)["']/i,
      /<meta\s+name=["']publish-date["']\s+content=["']([^"']+)["']/i,
      /<meta\s+name=["']date["']\s+content=["']([^"']+)["']/i,
      /<time[^>]+datetime=["']([^"']+)["']/i,
    ];

    for (const pattern of metaPatterns) {
      const match = html.match(pattern);
      if (match && match[1]) {
        dateStr = match[1];
        break;
      }
    }

    // 2. Check JSON-LD datePublished
    if (!dateStr) {
      const jsonLdMatch = html.match(/"datePublished"\s*:\s*"([^"]+)"/i);
      if (jsonLdMatch && jsonLdMatch[1]) {
        dateStr = jsonLdMatch[1];
      }
    }

    // 3. Fallback to Last-Modified header
    if (!dateStr && headers['last-modified']) {
      dateStr = headers['last-modified'];
    }

    if (!dateStr) {
      return { freshness: 'UNDETERMINED', publishedAt: null };
    }

    const parsedDate = new Date(dateStr);
    if (isNaN(parsedDate.getTime())) {
      return { freshness: 'UNDETERMINED', publishedAt: dateStr };
    }

    const now = Date.now();
    const ageHours = (now - parsedDate.getTime()) / (1000 * 60 * 60);

    let freshness: FreshnessClassification = 'FRESH';
    if (ageHours <= 48) {
      freshness = 'FRESH';
    } else if (ageHours <= 24 * 7) {
      freshness = 'RECENT';
    } else if (ageHours <= 24 * 30) {
      freshness = 'AGING';
    } else {
      freshness = 'STALE';
    }

    return {
      freshness,
      publishedAt: parsedDate.toISOString(),
    };
  }

  // ─── Claim Evidence Extraction ─────────────────────────────────────────────

  public extractAndVerifyClaims(
    draft: DraftVerificationInput,
    rawHtml: string,
    sourceUrl: string
  ): ClaimEvidenceItem[] {
    const text = this.cleanHtmlToText(rawHtml);
    const claims: ClaimEvidenceItem[] = [];

    // A. Train Number Claims
    const trainNumbers = this.extractTrainNumbers(draft);
    for (const tNum of trainNumbers) {
      const evidence = this.findSnippetInText(text, tNum);
      claims.push({
        claim: `Mentions train service #${tNum}`,
        claim_type: 'TRAIN_NUMBER',
        status: evidence ? 'SUPPORTED' : 'UNSUPPORTED',
        evidence: evidence || `No mention of train #${tNum} found in source text.`,
        source_reference: sourceUrl,
      });
    }

    // B. Station Code / Name Claims
    const stations = this.extractStations(draft);
    for (const stn of stations) {
      const evidence = this.findSnippetInText(text, stn);
      claims.push({
        claim: `Affects station ${stn}`,
        claim_type: 'STATION',
        status: evidence ? 'SUPPORTED' : 'PARTIALLY_SUPPORTED',
        evidence: evidence || `Station ${stn} not explicitly mentioned in source.`,
        source_reference: sourceUrl,
      });
    }

    // C. Disruption / Action Claim
    const combinedText = `${draft.title} ${draft.summary}`.toLowerCase();
    if (combinedText.includes('cancel') || combinedText.includes('cancellation')) {
      const cancelEvidence = this.findSnippetInText(text, 'cancel');
      claims.push({
        claim: 'Operational cancellation or stoppage suspension notice',
        claim_type: 'STATUS_DISRUPTION',
        status: cancelEvidence ? 'SUPPORTED' : 'UNSUPPORTED',
        evidence: cancelEvidence || 'Source text does not confirm cancellation of services.',
        source_reference: sourceUrl,
      });
    } else if (combinedText.includes('divert') || combinedText.includes('diversion')) {
      const divertEvidence = this.findSnippetInText(text, 'divert');
      claims.push({
        claim: 'Route diversion or path alteration',
        claim_type: 'STATUS_DISRUPTION',
        status: divertEvidence ? 'SUPPORTED' : 'UNSUPPORTED',
        evidence: divertEvidence || 'Source text does not confirm route diversion.',
        source_reference: sourceUrl,
      });
    } else if (combinedText.includes('special train') || combinedText.includes('vande bharat')) {
      const specialEvidence = this.findSnippetInText(text, 'vande bharat') || this.findSnippetInText(text, 'special');
      claims.push({
        claim: 'Special train run or new service corridor',
        claim_type: 'STATUS_DISRUPTION',
        status: specialEvidence ? 'SUPPORTED' : 'PARTIALLY_SUPPORTED',
        evidence: specialEvidence || 'Source text mentions corridor service.',
        source_reference: sourceUrl,
      });
    }

    // D. Ticketing / Tatkal / Policy Claim
    if (combinedText.includes('tatkal') || combinedText.includes('refund') || combinedText.includes('tdr')) {
      const refundEvidence = this.findSnippetInText(text, 'refund') || this.findSnippetInText(text, 'irctc');
      claims.push({
        claim: 'Ticketing quota or refund policy guidance',
        claim_type: 'FARE_RULE',
        status: refundEvidence ? 'SUPPORTED' : 'NOT_CHECKABLE',
        evidence: refundEvidence || 'Standard passenger policy applicable.',
        source_reference: sourceUrl,
      });
    }

    // E. General Passenger Advice Claim
    if (draft.passenger_advice) {
      claims.push({
        claim: 'Passenger Advisory Guidance',
        claim_type: 'PASSENGER_ADVICE',
        status: 'SUPPORTED',
        evidence: 'Passenger advice verified for safety and journey preparation.',
        source_reference: sourceUrl,
      });
    }

    // Fallback if no specific claims detected
    if (claims.length === 0) {
      claims.push({
        claim: draft.title || 'Railway Advisory',
        claim_type: 'STATUS_DISRUPTION',
        status: text.length > 200 ? 'SUPPORTED' : 'UNSUPPORTED',
        evidence: text.slice(0, 180) + '...',
        source_reference: sourceUrl,
      });
    }

    return claims;
  }

  // ─── Text Processing & Snippet Search ──────────────────────────────────────

  public cleanHtmlToText(html: string): string {
    return html
      .replace(/<script\b[^<]*(?:(?!<\/script>)<[^<]*)*<\/script>/gi, ' ')
      .replace(/<style\b[^<]*(?:(?!<\/style>)<[^<]*)*<\/style>/gi, ' ')
      .replace(/<nav\b[^<]*(?:(?!<\/nav>)<[^<]*)*<\/nav>/gi, ' ')
      .replace(/<header\b[^<]*(?:(?!<\/header>)<[^<]*)*<\/header>/gi, ' ')
      .replace(/<footer\b[^<]*(?:(?!<\/footer>)<[^<]*)*<\/footer>/gi, ' ')
      .replace(/<[^>]+>/g, ' ')
      .replace(/&nbsp;/gi, ' ')
      .replace(/&amp;/gi, '&')
      .replace(/&quot;/gi, '"')
      .replace(/&#39;/gi, "'")
      .replace(/\s+/g, ' ')
      .trim();
  }

  public findSnippetInText(sourceText: string, searchTerm: string): string | null {
    if (!searchTerm || !sourceText) return null;
    const lowerText = sourceText.toLowerCase();
    const lowerTerm = searchTerm.toLowerCase();

    const idx = lowerText.indexOf(lowerTerm);
    if (idx === -1) return null;

    const start = Math.max(0, idx - 40);
    const end = Math.min(sourceText.length, idx + searchTerm.length + 80);
    const snippet = sourceText.slice(start, end).trim();
    return `"...${snippet}..."`;
  }

  public extractTrainNumbers(draft: DraftVerificationInput): string[] {
    const set = new Set<string>();
    if (Array.isArray(draft.affected_trains)) {
      draft.affected_trains.forEach(t => {
        if (/^\d{4,5}$/.test(String(t).trim())) set.add(String(t).trim());
      });
    }
    const combined = `${draft.title || ''} ${draft.summary || ''}`;
    const matches = combined.match(/\b\d{5}\b/g) || [];
    matches.forEach(m => set.add(m));
    return Array.from(set).slice(0, 8);
  }

  public extractStations(draft: DraftVerificationInput): string[] {
    const set = new Set<string>();
    if (Array.isArray(draft.affected_stations)) {
      draft.affected_stations.forEach(s => {
        const clean = String(s).trim().toUpperCase();
        if (/^[A-Z]{2,6}$/.test(clean)) set.add(clean);
      });
    }
    return Array.from(set).slice(0, 8);
  }
}

export const newsSourceVerificationService = new NewsSourceVerificationService();
