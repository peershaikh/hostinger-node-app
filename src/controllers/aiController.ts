import { Request, Response } from 'express';
import { llmService } from '../services/llmService';
import { winstonLogger } from '../middleware/logger';

export class AiController {
  /**
   * POST /api/ai/voice-parse
   * Body: { transcript: string }
   * Returns: { success: true, result: { source: string|null, dest: string|null } }
   *
   * Proxies voice intent parsing to the backend LLM service.
   * API keys stay server-side — never exposed to the client bundle.
   */
  voiceParse = async (req: Request, res: Response) => {
    const { transcript } = req.body;

    if (!transcript || typeof transcript !== 'string' || transcript.trim().length === 0) {
      return res.status(400).json({
        success: false,
        error: 'transcript is required and must be a non-empty string',
      });
    }

    const trimmed = transcript.trim().slice(0, 500); // Hard cap — no prompt injection via huge transcript

    try {
      winstonLogger.info(`[AI] voice-parse: "${trimmed.slice(0, 80)}..."`);

      const prompt = `
Extract travel source and destination from this Indian train-related voice transcript: "${trimmed}"
Return ONLY JSON: { "source": "CITY_NAME", "dest": "CITY_NAME" }.
If a field is missing, return null for that field. Use official Indian city names.
      `.trim();

      const result = await llmService['callAi'](prompt, true);

      return res.json({
        success: true,
        result: {
          source: result?.source ?? null,
          dest:   result?.dest   ?? null,
        },
      });
    } catch (err: any) {
      winstonLogger.warn(`[AI] voice-parse failed: ${err.message}`);
      // Graceful fallback — mobile handles null values
      return res.json({
        success: true,
        result: { source: null, dest: null },
      });
    }
  };

  /**
   * POST /api/ai/complaint-gen
   * Body: { prompt: string }
   * Returns: { success: true, result: string }
   *
   * Proxies complaint/tweet generation to the backend LLM service.
   * API keys stay server-side — never exposed to the client bundle.
   */
  complaintGen = async (req: Request, res: Response) => {
    const { prompt } = req.body;

    if (!prompt || typeof prompt !== 'string' || prompt.trim().length === 0) {
      return res.status(400).json({
        success: false,
        error: 'prompt is required and must be a non-empty string',
      });
    }

    const trimmedPrompt = prompt.trim().slice(0, 1000); // Hard cap

    try {
      winstonLogger.info(`[AI] complaint-gen invoked`);

      const fullPrompt = `
You are a helpful assistant that generates concise, factual Indian Railway complaint tweets.
${trimmedPrompt}
Write a tweet (max 280 characters) that is professional, specific, and constructive.
Return ONLY the tweet text — no quotes, no JSON, no explanation.
      `.trim();

      const response = await llmService['callAi'](fullPrompt, false);
      const tweetText = typeof response === 'string' ? response.trim().slice(0, 280) : '';

      return res.json({
        success: true,
        result: tweetText || 'Unable to generate complaint text. Please try again.',
      });
    } catch (err: any) {
      winstonLogger.warn(`[AI] complaint-gen failed: ${err.message}`);
      return res.json({
        success: true,
        result: 'Unable to generate complaint text at this time. Please try again.',
      });
    }
  };
}

export const aiController = new AiController();
