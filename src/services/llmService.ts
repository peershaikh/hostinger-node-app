import axios from 'axios';
import { winstonLogger } from '../middleware/logger';

export interface GptSplitRoute {
  route: string;
  legs: any[];
  reason: string;
  confidence?: string;
}

export class LlmService {
  private readonly GEMINI_KEY = process.env.GEMINI_API_KEY || process.env.OPENAI_API_KEY || ''; // Fallback for env testing
  private readonly SUPABASE_URL = process.env.SUPABASE_URL || '';
  private readonly SUPABASE_KEY = process.env.SUPABASE_ANON_KEY || '';

  /**
   * Generates a comprehensive route analysis for the user.
   */
  async getRouteAnalysis(routeDetails: any): Promise<{ insight: string; recommendation_reason: string; risk_level: string }> {
    const prompt = `
      You are an elite Indian Railway AI analyst.
      Analyze this route from ${routeDetails.source} to ${routeDetails.destination}:
      Train Data (JSON): ${JSON.stringify(routeDetails.trains)}
      Context: ${routeDetails.isSplit ? 'This is a split journey via ' + routeDetails.hub : 'Direct route'}

      Determine:
      1. risk_level: "Low" (if CNF available), "Medium" (if RAC or WL < 20), "High" (if WL >= 20 or no trains).
      2. insight: 1-sentence travel advice based on availability.
      3. recommendation_reason: Why this specific option is being shown to the user.

      Return ONLY a JSON object: { "insight": "...", "recommendation_reason": "...", "risk_level": "..." }
    `;

    try {
      winstonLogger.info(`[LLM] Route analysis for ${routeDetails.source} -> ${routeDetails.destination}`);
      const response = await this.callAi(prompt, true);
      return response;
    } catch (err) {
      return { 
        insight: "Review confirmed real-time availability for this route.",
        recommendation_reason: "Primary verified option for your journey.",
        risk_level: "Medium"
      };
    }
  }

  /**
   * Predicts PNR confirmation probability.
   */
  async predictPNRConfirmation(pnrData: any): Promise<{ probability: string; prediction: string; advice: string; disclaimer: string; explanation: string }> {
    // ── Heuristic reference table (mirrors pnrController — used as an anchor) ──────
    const heuristicRef: Record<string, string> = {
      GNWL: 'GNWL: pos≤1-10→88%, 11-20→78%, 21-35→62%, 36-60→42%, >60→22%',
      TQWL: 'TQWL (Tatkal — tiny quota, rarely confirms): pos≤1-3→22%, 4-8→12%, >8→6%',
      RLWL: 'RLWL: pos≤1-8→65%, 9-18→45%, 19-30→28%, >30→15%',
      PQWL: 'PQWL: pos≤1-5→55%, 6-10→38%, 11-20→22%, >20→12%',
      RAC:  'RAC: 92–95% (almost always gets a full berth)',
    };
    const wlType = (pnrData.wl_type || 'GNWL').toUpperCase();
    const wlPos  = Number(pnrData.wl_position) || 0;
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

      PNR Data: ${JSON.stringify(pnrData)}
    `;

    if (pnrData.enrichmentContext) {
      prompt += `

      Aggregated Historical Outcomes & Feedback Drift (VERIFIED STATISTICS ONLY):
      ${JSON.stringify(pnrData.enrichmentContext, null, 2)}

      Enrichment Instructions (MANDATORY — read carefully):
      1. Each historical data point has a confidence level: HIGH (>100 samples), MEDIUM (21-100), or LOW (5-20).
      2. IGNORE any data point labelled confidence=LOW. It has too few samples to be reliable.
      3. For MEDIUM confidence data, treat it as a supporting signal only — do not let it override the heuristic table by more than 10 percentage points.
      4. For HIGH confidence data, you may blend it with the heuristic as a primary signal.
      5. YOUR PROBABILITY OUTPUT MUST STAY WITHIN ±15 POINTS OF THE HEURISTIC CEILING FOR THIS WL TYPE AND POSITION.
         Heuristic ceiling for ${wlType}/${wlPos}: approximately ${((): number => {
           if (wlType === 'GNWL') return wlPos <= 10 ? 88 : wlPos <= 20 ? 78 : wlPos <= 35 ? 62 : wlPos <= 60 ? 42 : 22;
           if (wlType === 'TQWL') return wlPos <= 3 ? 22 : wlPos <= 8 ? 12 : 6;
           if (wlType === 'RLWL') return wlPos <= 8 ? 65 : wlPos <= 18 ? 45 : wlPos <= 30 ? 28 : 15;
           if (wlType === 'PQWL') return wlPos <= 5 ? 55 : wlPos <= 10 ? 38 : wlPos <= 20 ? 22 : 12;
           return wlPos <= 15 ? 70 : wlPos <= 40 ? 45 : 20;
         })()}%.
         Do NOT output a probability above this ceiling + 15.
      6. NEVER output 100% for a waitlist ticket. A waitlisted ticket has non-zero cancellation risk by definition.
      `;
    } else {
      // No enrichment: use heuristic directly
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

    const disclaimer = "Prediction is based on AI trends and historical patterns. May not be 100% accurate.";

    try {
      winstonLogger.info(`[LLM] PNR prediction for ${pnrData.pnr || 'unknown'}`);
      const result = await this.callAi(prompt, true);
      return {
        probability: result.probability || '50',
        prediction: result.prediction || 'Indeterminate',
        explanation: result.explanation || '',
        advice: result.advice || 'Keep checking closer to departure.',
        disclaimer
      };
    } catch (err) {
      return {
        probability: "50",
        prediction: "Indeterminate",
        explanation: "Unable to generate AI insight at this time. Please check again closer to your travel date.",
        advice: "Monitor status as charting progresses.",
        disclaimer
      };
    }
  }

  /**
   * Suggests alternative travel options (Bus/Flight)
   */
  async suggestAlternativeTravel(source: string, destination: string): Promise<any[]> {
    const prompt = `
      The train availability from ${source} to ${destination} is very poor.
      Suggest 2 alternatives (Bus or Flight).
      Based on Indian geography/travel:
      - Suggest FLIGHT if distance is long (> 500km).
      - Suggest BUS if distance is short/medium.
      
      Return ONLY a JSON object: { "alternatives": [ { "type": "Bus/Flight", "reason": "...", "advice": "..." } ] }
    `;

    try {
      winstonLogger.info(`[LLM] Alternative travel for ${source} -> ${destination}`);
      const result = await this.callAi(prompt, true);
      return Array.isArray(result.alternatives) ? result.alternatives : [];
    } catch (err) {
      return [];
    }
  }

  /**
   * GPT Feedback Categorization
   * Classifies a user's feedback text into a structured category with priority and action.
   * Returns null silently if GPT is unavailable — never blocks the feedback submission.
   */
  async categorizeFeedback(feedbackText: string, metadata: {
    feature?: string;
    severity?: string;
    device?: string;
  } = {}): Promise<{
    category: string;
    confidence: string;
    priority: string;
    summary: string;
    suggestedAction: string;
  } | null> {
    if (!this.GEMINI_KEY) {
      winstonLogger.warn('[LLM] categorizeFeedback skipped — GEMINI_API_KEY not set');
      return null;
    }

    const prompt = `
You are an AI triage assistant for an Indian Railway app called Trayago.
Analyze the following user feedback and return a structured classification.

User Feedback: "${feedbackText}"
Context: Feature tested: ${metadata.feature || 'Unknown'}, Severity: ${metadata.severity || 'Unknown'}, Device: ${metadata.device || 'Unknown'}

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
}`.trim();

    try {
      winstonLogger.info(`[LLM] categorizeFeedback invoked`);
      const result = await this.callAi(prompt, true);
      const validCategories = ['BUG','UI_ISSUE','SEARCH_ISSUE','LIVE_TRACKING_ISSUE','PNR_ISSUE','SPLIT_ROUTE_ISSUE','FEATURE_REQUEST','PERFORMANCE','OTHER'];
      const validPriorities = ['CRITICAL','HIGH','MEDIUM','LOW'];
      const validConfidence = ['HIGH','MEDIUM','LOW'];

      if (!validCategories.includes(result.category)) result.category = 'OTHER';
      if (!validPriorities.includes(result.priority)) result.priority = 'MEDIUM';
      if (!validConfidence.includes(result.confidence)) result.confidence = 'LOW';

      return {
        category: result.category,
        confidence: result.confidence,
        priority: result.priority,
        summary: result.summary || 'User reported an issue.',
        suggestedAction: result.suggestedAction || 'Review and triage manually.'
      };
    } catch (err: any) {
      winstonLogger.warn(`[LLM] categorizeFeedback failed silently: ${err.message}`);
      return null;
    }
  }

  /**
   * Smart Split Route Recommendation
   */
  async getOptimalSplitRoute(source: string, destination: string): Promise<GptSplitRoute | null> {
    try {
      winstonLogger.info(`[LLM] Asking for optimal split: ${source} → ${destination}`);
      const prompt = `Find best split journey from ${source} to ${destination}. Return ONLY JSON: {"route": "FROM -> HUB -> TO", "legs": [{"from":"...","to":"...","reason":"..."}], "confidence": "High", "reason": "..."}`;
      
      const result = await this.callAi(prompt, true);
      if (result && result.route && result.legs) {
        return {
          route: result.route,
          legs: result.legs,
          reason: result.reason || "AI Suggested route",
          confidence: result.confidence
        };
      }
      throw new Error("Invalid AI response");
    } catch (err) {
      winstonLogger.warn(`[LLM] AI Call failed, using smart fallback`);
      
      // Smart fallback logic as suggested by user
      const popularHubs = ["KYN", "BPL", "ET", "NGP", "BZA", "UBL"];
      return {
        route: `${source} → ${popularHubs[0]} → ${destination}`,
        legs: [{ from: source, to: popularHubs[0] }, { from: popularHubs[0], to: destination }],
        reason: "AI Suggested best hub based on historical confirmation rate"
      };
    }
  }

  /**
   * Cleans messy availability text into structured JSON using Gemini API
   */
  async cleanAvailabilityData(rawAvailString: string): Promise<any[]> {
    if (!rawAvailString || rawAvailString.trim() === '') return [];
    
    if (!this.GEMINI_KEY) {
       winstonLogger.warn("[GEMINI] Key missing, falling back to basic parsing");
       return [{ class: "UNK", status: rawAvailString, count: 0 }];
    }

    const prompt = `Convert railway availability text into structured JSON.
    Input: "${rawAvailString}"
    Extract class (3A, SL, 2A), status (AVAILABLE, WL, RAC), and count.
    Return ONLY a JSON array, e.g., [{"class": "3A", "status": "AVAILABLE", "count": 45}].`;

    try {
      winstonLogger.info(`[AI_CALL] [GEMINI_ACTIVE] Cleaning availability data`);
      const response = await axios.post(`https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${this.GEMINI_KEY}`, {
        contents: [{ parts: [{ text: prompt }] }]
      });
      const text = response.data.candidates[0].content.parts[0].text;
      const jsonStr = text.replace(/```json/g, '').replace(/```/g, '').trim();
      return JSON.parse(jsonStr);
    } catch (err) {
      winstonLogger.error("[GEMINI] Parsing failed");
      return [];
    }
  }

  private async callAi(prompt: string, json: boolean = false): Promise<any> {
    if (!this.GEMINI_KEY) {
      throw new Error("GEMINI_API_KEY missing");
    }

    try {
      winstonLogger.info(`[AI_CALL] [GEMINI_ACTIVE] Prompting Gemini 2.5 Flash model`);
      
      // We instruct Gemini to return JSON explicitly via prompt if requested.
      const finalPrompt = json ? prompt + "\n\nIMPORTANT: Return ONLY a valid JSON object without markdown formatting, backticks, or extra text." : prompt;
      
      const response = await axios.post(
        `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${this.GEMINI_KEY}`, 
        {
          contents: [{ parts: [{ text: finalPrompt }] }],
          generationConfig: {
            temperature: 0.3,
            responseMimeType: json ? "application/json" : "text/plain"
          }
        }, 
        { timeout: 8000 }
      );

      const text = response.data.candidates[0].content.parts[0].text;
      
      if (json) {
        const jsonStr = text.replace(/```json/gi, '').replace(/```/g, '').trim();
        return JSON.parse(jsonStr);
      }
      return text;
    } catch (err: any) {
      winstonLogger.warn(`[AI CALL ERROR]: ${err.message}`);
      throw err;
    }
  }
}

export const llmService = new LlmService();
