import axios from 'axios';
import { winstonLogger } from '../../middleware/logger';
import { aiConfig } from './aiConfig';
import { aiAdminConfigService } from './aiAdminConfigService';
import { aiObservabilityService } from './aiObservabilityService';
import {
  AiProvider,
  AiCapabilities,
  AiError,
  PnrPredictionInput,
  PnrPredictionOutput,
  RouteAnalysisInput,
  RouteAnalysisOutput,
  RouteEnrichmentInput,
  RouteEnrichmentOutput,
  FeedbackCategorizationInput,
  FeedbackCategorizationOutput,
  ScheduleGenerationOutput,
  AvailabilityItemOutput,
  NewsDistillationInput,
  NewsDistillationOutput
} from './aiProvider';

export class GeminiAdapter implements AiProvider {
  public readonly providerId = 'GEMINI';
  public readonly displayName = 'Google Gemini (Gemini 3.6 Flash)';

  public readonly capabilities: AiCapabilities = {
    predictPnr: true,
    analyzeRoute: true,
    enrichRoute: true,
    categorizeFeedback: true,
    generateSchedule: true,
    normalizeAvailability: true,
    suggestAlternatives: true,
    genericPrompt: true,
    distillNewsArticle: true
  };

  private getApiKey(): string {
    return aiConfig.gemini.apiKey || process.env.GEMINI_API_KEY || '';
  }

  /**
   * Reads active Gemini model from admin config at call time (runtime, no restart).
   * featureKey allows per-feature model override via the routing table.
   * Falls back to GEMINI_MODEL env / aiConfig for backward compatibility.
   */
  private getActiveModel(featureKey?: string): string {
    try {
      const config = aiAdminConfigService.getConfig();
      // 1. Per-feature model override (only when GEMINI is the primaryProvider for this feature)
      if (featureKey) {
        const route = (config.routing as any)[featureKey];
        if (route && route.primaryProvider === 'GEMINI' && route.model) {
          return route.model;
        }
      }
      // 2. Provider-level activeModel from admin config
      const providerModel = config.providers['GEMINI']?.activeModel;
      if (providerModel) return providerModel;
    } catch { /* config not ready yet — fall through */ }
    // 3. Env / aiConfig fallback (backward compat)
    return aiConfig.gemini.model || 'gemini-3.6-flash';
  }

  private getEndpointUrl(featureKey?: string): string {
    const model = this.getActiveModel(featureKey);
    const baseUrl = aiConfig.gemini.baseUrl || 'https://generativelanguage.googleapis.com/v1beta/models';
    return `${baseUrl}/${model}:generateContent`;
  }

  /**
   * Concurrency-safe admin probe: tests a specific model without touching shared config.
   * model is an explicit, stack-local parameter — getActiveModel() is NOT called.
   * Concurrent production requests cannot observe the probe model at any await point.
   * This method is intentionally NOT on the AiProvider interface — it is adapter-internal.
   */
  public async probeWithModel(prompt: string, model: string, json: boolean = true): Promise<any> {
    const apiKey = this.getApiKey();
    if (!apiKey) {
      throw new AiError({
        code: 'CONFIGURATION_ERROR',
        message: 'GEMINI_API_KEY is not configured',
        provider: this.providerId
      });
    }
    const baseUrl = aiConfig.gemini.baseUrl || 'https://generativelanguage.googleapis.com/v1beta/models';
    const url = `${baseUrl}/${model}:generateContent?key=${apiKey}`;
    const finalPrompt = json
      ? prompt + '\n\nIMPORTANT: Return ONLY a valid JSON object without markdown formatting, backticks, or extra text.'
      : prompt;
    const timeout = aiConfig.gemini.timeoutMs || 10000;
    winstonLogger.info(`[AI_PROBE] [GEMINI] Model: ${model} (isolated probe — no config mutation)`);
    const response = await axios.post(url, {
      contents: [{ parts: [{ text: finalPrompt }] }],
      generationConfig: { responseMimeType: json ? 'application/json' : 'text/plain' }
    }, { timeout });
    const text = response.data?.candidates?.[0]?.content?.parts?.[0]?.text;
    if (!text) throw new AiError({ code: 'INVALID_RESPONSE', message: 'Probe returned empty response', provider: this.providerId });
    if (json) {
      const cleaned = text.replace(/```json/gi, '').replace(/```/g, '').trim();
      return JSON.parse(cleaned);
    }
    return text;
  }

  /**
   * Internal helper to make raw POST requests to Gemini API
   */
  private async executeGeminiCall(
    prompt: string,
    json: boolean = false,
    timeoutMs?: number,
    featureName: string = 'GENERIC'
  ): Promise<any> {
    const startTime = Date.now();
    const apiKey = this.getApiKey();
    const model = this.getActiveModel(featureName);
    if (!apiKey) {
      aiObservabilityService.recordAiUsage({
        provider: this.providerId,
        model,
        feature: featureName,
        success: false,
        latencyMs: 0,
        fallbackUsed: false,
        errorCategory: 'CONFIGURATION_ERROR'
      });
      throw new AiError({
        code: 'CONFIGURATION_ERROR',
        message: 'GEMINI_API_KEY is not configured',
        provider: this.providerId
      });
    }

    const url = `${this.getEndpointUrl(featureName)}?key=${apiKey}`;
    const finalPrompt = json
      ? prompt + '\n\nIMPORTANT: Return ONLY a valid JSON object without markdown formatting, backticks, or extra text.'
      : prompt;

    const timeout = timeoutMs || aiConfig.gemini.timeoutMs || 10000;

    try {
      winstonLogger.info(`[AI_CALL] [GEMINI_ACTIVE] Model: ${model}`);
      const response = await axios.post(
        url,
        {
          contents: [{ parts: [{ text: finalPrompt }] }],
          generationConfig: {
            responseMimeType: json ? 'application/json' : 'text/plain'
          }
        },
        { timeout }
      );

      const candidate = response.data?.candidates?.[0];
      if (!candidate || !candidate.content?.parts?.[0]?.text) {
        aiObservabilityService.recordAiUsage({
          provider: this.providerId,
          model,
          feature: featureName,
          success: false,
          latencyMs: Date.now() - startTime,
          fallbackUsed: false,
          errorCategory: 'INVALID_RESPONSE'
        });
        throw new AiError({
          code: 'INVALID_RESPONSE',
          message: 'Gemini returned an empty candidate or missing text part',
          provider: this.providerId
        });
      }

      const usage = response.data?.usageMetadata;
      const inputTokens = usage?.promptTokenCount;
      const outputTokens = usage?.candidatesTokenCount;
      const totalTokens = usage?.totalTokenCount;
      const latencyMs = Date.now() - startTime;

      aiObservabilityService.recordAiUsage({
        provider: this.providerId,
        model,
        feature: featureName,
        success: true,
        latencyMs,
        inputTokens,
        outputTokens,
        totalTokens,
        fallbackUsed: false
      });

      const text = candidate.content.parts[0].text;
      if (json) {
        const cleaned = text.replace(/```json/gi, '').replace(/```/g, '').trim();
        try {
          return JSON.parse(cleaned);
        } catch (parseErr: any) {
          throw new AiError({
            code: 'INVALID_RESPONSE',
            message: `Failed to parse Gemini response as JSON: ${parseErr.message}`,
            provider: this.providerId
          });
        }
      }

      return text;
    } catch (err: any) {
      const latencyMs = Date.now() - startTime;
      aiObservabilityService.recordAiUsage({
        provider: this.providerId,
        model,
        feature: featureName,
        success: false,
        latencyMs,
        fallbackUsed: false,
        errorCategory: err?.code || (axios.isAxiosError(err) ? 'HTTP_ERROR' : 'EXECUTION_ERROR')
      });

      if (err instanceof AiError) throw err;

      if (axios.isAxiosError(err)) {
        if (err.code === 'ECONNABORTED' || err.message?.includes('timeout')) {
          throw new AiError({
            code: 'TIMEOUT',
            message: `Gemini API call timed out after ${timeout}ms`,
            provider: this.providerId,
            status: 408,
            retryable: true
          });
        }

        const status = err.response?.status;
        if (status === 429) {
          const errData = err.response?.data?.error;
          const retryAfter = err.response?.headers?.['retry-after'] || err.response?.headers?.['Retry-After'];
          const quotaReason = (
            errData?.details?.[0]?.violations?.[0]?.description ||
            errData?.message ||
            'Gemini API rate limit exceeded'
          ).replace(/[\r\n]+/g, ' ');

          winstonLogger.warn(
            `[GEMINI_RATE_LIMIT_DETAILS] status=429 code=${errData?.code || 'RESOURCE_EXHAUSTED'} retry_after=${retryAfter || 'none'} reason="${quotaReason.slice(0, 150)}"`
          );

          throw new AiError({
            code: 'RATE_LIMITED',
            message: 'Gemini API rate limit exceeded',
            provider: this.providerId,
            status: 429,
            retryable: true
          });
        }

        throw new AiError({
          code: 'PROVIDER_UNAVAILABLE',
          message: err.response?.data?.error?.message || err.message,
          provider: this.providerId,
          status: status || 503,
          retryable: status ? status >= 500 : true
        });
      }

      throw new AiError({
        code: 'PROVIDER_UNAVAILABLE',
        message: err?.message || 'Unknown error occurred in GeminiAdapter',
        provider: this.providerId
      });
    }
  }

  public async generateText(
    prompt: string,
    options?: { json?: boolean; temperature?: number; timeoutMs?: number }
  ): Promise<any> {
    return this.executeGeminiCall(prompt, options?.json ?? false, options?.timeoutMs);
  }

  public async predictPnr(input: PnrPredictionInput): Promise<PnrPredictionOutput> {
    const heuristicRef: Record<string, string> = {
      GNWL: 'GNWL: pos≤1-10→88%, 11-20→78%, 21-35→62%, 36-60→42%, >60→22%',
      TQWL: 'TQWL (Tatkal — tiny quota, rarely confirms): pos≤1-3→22%, 4-8→12%, >8→6%',
      RLWL: 'RLWL: pos≤1-8→65%, 9-18→45%, 19-30→28%, >30→15%',
      PQWL: 'PQWL: pos≤1-5→55%, 6-10→38%, 11-20→22%, >20→12%',
      RAC: 'RAC: 92–95% (almost always gets a full berth)'
    };

    const wlType = (input.wl_type || 'GNWL').toUpperCase();
    const wlPos = Number(input.wl_position) || 0;
    const heuristicLine = heuristicRef[wlType] || heuristicRef['GNWL'];

    let prompt = `
      You are an expert Indian Railways AI assistant helping passengers understand their waitlist confirmation chances.

      Indian Railways Domain Context:
      - GNWL (General Waitlist) has the highest confirmation rate, especially positions 1-20
      - TQWL (Tatkal Waitlist) rarely confirms - very low rate
      - RLWL (Remote Location WL) clears less reliably than GNWL
      - PQWL (Pooled Quota WL) has moderate confirmation rates
      - RAC tickets almost always get a berth (95%+ rate)
      - Charts are prepared 4-6 hours before departure
      - WL below 15 on GNWL typically confirms 75%+ of the time
      - Season, route popularity and quota type all affect confirmation

      CALIBRATED HEURISTIC REFERENCE TABLE (use as your probability anchor):
      ${heuristicLine}
      WL Type for this ticket: ${wlType}, WL Position: ${wlPos}
      Expected probability range from heuristic: ~${heuristicRef[wlType] || heuristicRef['GNWL']}

      PNR Data: ${JSON.stringify(input)}
    `;

    if (input.enrichmentContext) {
      prompt += `
      Aggregated Historical Outcomes & Feedback Drift (VERIFIED STATISTICS ONLY):
      ${JSON.stringify(input.enrichmentContext, null, 2)}

      Enrichment Instructions (MANDATORY — read carefully):
      1. Each historical data point has a confidence level: HIGH (>100 samples), MEDIUM (21-100), or LOW (5-20).
      2. IGNORE any data point labelled confidence=LOW. It has too few samples to be reliable.
      3. For MEDIUM confidence data, treat it as a supporting signal only — do not let it override the heuristic table by more than 10 percentage points.
      4. For HIGH confidence data, you may blend it with the heuristic as a primary signal.
      5. YOUR PROBABILITY OUTPUT MUST STAY WITHIN ±15 POINTS OF THE HEURISTIC CEILING FOR THIS WL TYPE AND POSITION.
      6. NEVER output 100% for a waitlist ticket.
      `;
    } else {
      prompt += `
      No historical aggregate data available. Use the heuristic reference table above as your primary calibration anchor.
      Do NOT output a probability above the heuristic ceiling + 15 for this WL type and position.
      NEVER output 100% for a waitlist ticket.
      `;
    }

    prompt += `
      Return ONLY a JSON object with these exact keys:
      {
        "probability": "(integer 0-100 as string, e.g. \"62\". Must be calibrated to WL type and position. NEVER 100 for a WL ticket.)",
        "prediction": "(one of: Likely Confirm | Risky | Unlikely)",
        "explanation": "(2-3 plain English sentences for the traveller. No raw percentages. No jargon. Explain WHY in simple terms based on WL type, position, and travel context.)",
        "advice": "(one clear action sentence e.g. Berth allocation probable; keep monitoring / Book a backup / Monitor closer to departure)"
      }
    `;

    const disclaimer = 'Prediction is based on AI trends and historical patterns. May not be 100% accurate.';

    const result = await this.executeGeminiCall(prompt, true, 8000, 'PNR_PREDICTION');
    return {
      probability: String(result.probability || '50'),
      prediction: result.prediction || 'Indeterminate',
      explanation: result.explanation || '',
      advice: result.advice || 'Keep checking closer to departure.',
      disclaimer
    };
  }

  public async analyzeRoute(input: RouteAnalysisInput): Promise<RouteAnalysisOutput> {
    const prompt = `
      You are an elite Indian Railway AI analyst.
      Analyze this route from ${input.source} to ${input.destination}:
      Train Data (JSON): ${JSON.stringify(input.trains || [])}
      Context: ${input.isSplit ? 'This is a split journey via ' + input.hub : 'Direct route'}

      Determine:
      1. risk_level: "Low" (if CNF available), "Medium" (if RAC or WL < 20), "High" (if WL >= 20 or no trains).
      2. insight: 1-sentence travel advice based on availability.
      3. recommendation_reason: Why this specific option is being shown to the user.

      Return ONLY a JSON object: { "insight": "...", "recommendation_reason": "...", "risk_level": "..." }
    `;

    const response = await this.executeGeminiCall(prompt, true, 8000, 'ROUTE_ANALYSIS');
    return {
      insight: response.insight || 'Review confirmed real-time availability for this route.',
      recommendation_reason: response.recommendation_reason || 'Primary verified option for your journey.',
      risk_level: response.risk_level || 'Medium'
    };
  }

  public async enrichRoute(input: RouteEnrichmentInput): Promise<RouteEnrichmentOutput> {
    const prompt = `
      You are an expert Indian Railways transit analyst.
      Analyze this missing route search from "${input.source}" to "${input.destination}".
      The direct search returned zero results.
      
      Suggest:
      1. A candidate hub/junction station code for a split journey (e.g., "ET", "BPL", "NGP", "BZA", "KYN", "BSB").
      2. A logical train routing (list of train numbers for Leg 1 and Leg 2).
      3. A candidate station alias or correction if one of the codes might be misspelled or represent a secondary station (e.g., "NDLS" for Delhi).
      4. An alternate train code or alias.
      
      Format the output as a JSON object with these exact keys:
      {
        "candidateRoute": "FROM -> HUB -> TO",
        "candidateHub": "HUB_CODE",
        "trainNos": ["TRAIN1", "TRAIN2"],
        "stationAlias": "STATION_ALIAS_CORRECTION",
        "trainAlias": "TRAIN_ALIAS_CORRECTION",
        "confidence": "HIGH|MEDIUM|LOW",
        "reason": "Explain why this route works or what alternative trains serve this corridor."
      }
    `;

    const result = await this.executeGeminiCall(prompt, true, 10000, 'ROUTE_ENRICHMENT');
    return {
      candidateRoute: result.candidateRoute || `${input.source} -> ${input.destination}`,
      candidateHub: String(result.candidateHub || '').trim().toUpperCase(),
      trainNos: Array.isArray(result.trainNos) ? result.trainNos : [],
      stationAlias: result.stationAlias,
      trainAlias: result.trainAlias,
      confidence: result.confidence || 'MEDIUM',
      reason: result.reason || 'AI corridor enrichment'
    };
  }

  public async categorizeFeedback(input: FeedbackCategorizationInput): Promise<FeedbackCategorizationOutput> {
    const prompt = `
You are an AI triage assistant for an Indian Railway app called Trayago.
Analyze the following user feedback and return a structured classification.

User Feedback: "${input.feedbackText}"
Context: Feature tested: ${input.metadata?.feature || 'Unknown'}, Severity: ${input.metadata?.severity || 'Unknown'}, Device: ${input.metadata?.device || 'Unknown'}

CATEGORIES (pick exactly one):
- BUG: A clear software defect or crash
- UI_ISSUE: Layout, visual, or design problem
- SEARCH_ISSUE: Train search not returning results or wrong results
- LIVE_TRACKING_ISSUE: Live train status wrong or unavailable
- PNR_ISSUE: PNR check failed or returned incorrect data
- SPLIT_ROUTE_ISSUE: AI split journey routing broken or wrong
- FEATURE_REQUEST: User asking for a new capability
- PERFORMANCE: App slow, timeout, or loading issue
- OTHER: Cannot be classified into above categories

PRIORITY rules:
- CRITICAL: App unusable, data completely wrong, crashes
- HIGH: Core feature broken, significant user impact
- MEDIUM: Minor but noticeable defect
- LOW: Cosmetic, enhancement, or vague

Return ONLY a JSON object with these exact keys:
{
  "category": "...",
  "confidence": "HIGH|MEDIUM|LOW",
  "priority": "CRITICAL|HIGH|MEDIUM|LOW",
  "summary": "One concise sentence (max 12 words) describing the core issue",
  "suggestedAction": "One specific technical action for the dev team (max 15 words)"
}
    `.trim();

    const result = await this.executeGeminiCall(prompt, true, 8000, 'FEEDBACK_CATEGORIZATION');
    const validCategories = ['BUG', 'UI_ISSUE', 'SEARCH_ISSUE', 'LIVE_TRACKING_ISSUE', 'PNR_ISSUE', 'SPLIT_ROUTE_ISSUE', 'FEATURE_REQUEST', 'PERFORMANCE', 'OTHER'];
    const validPriorities = ['CRITICAL', 'HIGH', 'MEDIUM', 'LOW'];
    const validConfidence = ['HIGH', 'MEDIUM', 'LOW'];

    return {
      category: validCategories.includes(result.category) ? result.category : 'OTHER',
      confidence: validConfidence.includes(result.confidence) ? result.confidence : 'LOW',
      priority: validPriorities.includes(result.priority) ? result.priority : 'MEDIUM',
      summary: result.summary || 'User reported an issue.',
      suggestedAction: result.suggestedAction || 'Review and triage manually.'
    };
  }

  public async generateSchedule(trainNo: string): Promise<ScheduleGenerationOutput | null> {
    const prompt = `You are an Indian Railways timetable expert.
Give me the complete schedule for Indian Railways train number ${trainNo}.

Return ONLY a valid JSON object in this exact format:
{
  "train_number": "${trainNo}",
  "train_name": "FULL TRAIN NAME",
  "stations": [
    {
      "sn": 1,
      "station_code": "XXX",
      "station_name": "Station Name",
      "arrival_time": "--:--",
      "departure_time": "HH:MM",
      "day": 1
    }
  ]
}

Rules:
- station_code must be official Indian Railways code
- First station arrival_time = "--:--"
- Last station departure_time = "--:--"
- If unknown, return empty stations array.`;

    const parsed = await this.executeGeminiCall(prompt, true, 12000, 'SCHEDULE_GENERATION');
    if (!parsed || !parsed.stations || parsed.stations.length === 0 || !parsed.train_name) {
      return null;
    }

    return {
      train_number: String(parsed.train_number || trainNo),
      train_name: parsed.train_name,
      stations: parsed.stations
    };
  }

  public async normalizeAvailability(rawAvailString: string): Promise<AvailabilityItemOutput[]> {
    if (!rawAvailString || rawAvailString.trim() === '') return [];

    const prompt = `Convert railway availability text into structured JSON.
Input: "${rawAvailString}"
Extract class (3A, SL, 2A), status (AVAILABLE, WL, RAC), and count.
Return ONLY a JSON array, e.g., [{"class": "3A", "status": "AVAILABLE", "count": 45}].`;

    const result = await this.executeGeminiCall(prompt, true, 8000, 'AVAILABILITY_NORMALIZATION');
    return Array.isArray(result) ? result : [];
  }

  public async distillNewsArticle(input: NewsDistillationInput): Promise<NewsDistillationOutput | null> {
    if (!input || !input.title) return null;

    const prompt = `You are a certified Indian Railways Passenger Intelligence Analyst.
Distill the following official railway announcement into structured, passenger-first facts and SEO metadata.

SOURCE INFORMATION:
- Source Name: ${input.sourceName}
- Source Tier: ${input.sourceTier}
- Publication Date: ${input.publishedAt}
- Category: ${input.category}
- Raw Title: "${input.title}"
- Raw Content: "${input.summary}"

STRICT GUARDRAIL RULES:
1. ZERO FABRICATION: Extract ONLY facts present in the text above. Do NOT invent train numbers, timings, station names, fare amounts, or quotes.
2. If specific timings or train numbers are NOT mentioned in the source, write "Specific timings/trains to be notified by zonal railways".
3. Formulate 3 key takeaways:
   - what_happened: 1-2 sentence factual summary of the event.
   - who_is_affected: Which routes, passengers, or zones are impacted.
   - what_passengers_should_do: Clear actionable advice for travelers.
4. Formulate 2-3 passenger FAQs answerable strictly from the source.
5. Create concise SEO metadata:
   - seo_title: Max 60 characters, keyword rich.
   - meta_description: Max 155 characters.
   - slug: Clean, URL-friendly slug (e.g. western-railway-special-trains-mumbai-delhi-2026).

Return ONLY valid JSON matching this schema:
{
  "title": "Clear concise headline (max 80 chars)",
  "summary": "Passenger summary (1-2 paragraphs in markdown)",
  "key_takeaways": {
    "what_happened": "...",
    "who_is_affected": "...",
    "what_passengers_should_do": "..."
  },
  "affected_trains": ["12345"],
  "affected_stations": ["NDLS"],
  "seo_title": "...",
  "meta_description": "...",
  "slug": "...",
  "faqs": [
    { "question": "...", "answer": "..." }
  ],
  "confidence": "HIGH"
}`;

    const result = await this.executeGeminiCall(prompt, true, 10000, 'NEWS_DISTILLATION');
    if (!result || !result.title || !result.key_takeaways) {
      return null;
    }

    return {
      title: String(result.title || input.title),
      summary: String(result.summary || input.summary),
      key_takeaways: {
        what_happened: String(result.key_takeaways?.what_happened || ''),
        who_is_affected: String(result.key_takeaways?.who_is_affected || ''),
        what_passengers_should_do: String(result.key_takeaways?.what_passengers_should_do || '')
      },
      affected_trains: Array.isArray(result.affected_trains) ? result.affected_trains.map(String) : [],
      affected_stations: Array.isArray(result.affected_stations) ? result.affected_stations.map(String) : [],
      seo_title: String(result.seo_title || result.title).slice(0, 70),
      meta_description: String(result.meta_description || result.summary).slice(0, 160),
      slug: String(result.slug || '').toLowerCase().replace(/[^\w-]/g, '').slice(0, 80),
      faqs: Array.isArray(result.faqs) ? result.faqs : [],
      confidence: result.confidence === 'LOW' || result.confidence === 'MEDIUM' ? result.confidence : 'HIGH',
      model: this.getActiveModel('NEWS_DISTILLATION')
    };
  }

  public async suggestAlternatives(source: string, destination: string): Promise<any[]> {
    const prompt = `
The train availability from ${source} to ${destination} is very poor.
Suggest 2 alternatives (Bus or Flight).
Based on Indian geography/travel:
- Suggest FLIGHT if distance is long (> 500km).
- Suggest BUS if distance is short/medium.

Return ONLY a JSON object: { "alternatives": [ { "type": "Bus/Flight", "reason": "...", "advice": "..." } ] }
    `;

    const result = await this.executeGeminiCall(prompt, true, 8000, 'ROUTE_ANALYSIS');
    return Array.isArray(result.alternatives) ? result.alternatives : [];
  }

  public async healthCheck(): Promise<{ status: 'HEALTHY' | 'DEGRADED' | 'UNHEALTHY'; latencyMs: number; message: string }> {
    const start = Date.now();
    const apiKey = this.getApiKey();
    if (!apiKey) {
      return {
        status: 'UNHEALTHY',
        latencyMs: 0,
        message: 'GEMINI_API_KEY is missing'
      };
    }

    try {
      await this.executeGeminiCall('Reply with single word: OK', false, 5000);
      const latencyMs = Date.now() - start;
      return {
        status: latencyMs < 2000 ? 'HEALTHY' : 'DEGRADED',
        latencyMs,
        message: `Gemini active (${latencyMs}ms)`
      };
    } catch (err: any) {
      return {
        status: 'UNHEALTHY',
        latencyMs: Date.now() - start,
        message: err.message || 'Gemini health check probe failed'
      };
    }
  }
}

export const geminiAdapter = new GeminiAdapter();
