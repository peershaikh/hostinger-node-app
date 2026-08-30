export interface ModelPricing {
  inputPerMillionUsd: number;
  outputPerMillionUsd: number;
  /** Cache-hit input token price (e.g. DeepSeek prompt cache). Optional. */
  cacheHitInputPerMillionUsd?: number;
  /** Human-readable pricing notes for Admin UI display. */
  notes?: string;
}

export const AI_MODEL_PRICING: Record<string, ModelPricing> = {
  'gemini-2.5-flash': {
    inputPerMillionUsd: 0.075,
    outputPerMillionUsd: 0.30
  },
  'gemini-1.5-flash': {
    inputPerMillionUsd: 0.075,
    outputPerMillionUsd: 0.30
  },
  'gemini-1.5-pro': {
    inputPerMillionUsd: 1.25,
    outputPerMillionUsd: 5.00
  },
  'gpt-4o-mini': {
    inputPerMillionUsd: 0.15,
    outputPerMillionUsd: 0.60
  },
  'gpt-4o': {
    inputPerMillionUsd: 2.50,
    outputPerMillionUsd: 10.00
  },
  'claude-3-5-haiku': {
    inputPerMillionUsd: 0.80,
    outputPerMillionUsd: 4.00
  },
  'claude-3-5-sonnet': {
    inputPerMillionUsd: 3.00,
    outputPerMillionUsd: 15.00
  },
  // DeepSeek V4-Flash — official off-peak cache-miss rates (August 2026).
  // Cache-hit input: $0.007/M. Peak rates are 2x higher.
  // Source: https://api.deepseek.com (pricing page, verified August 2026).
  'deepseek-v4-flash': {
    inputPerMillionUsd: 0.22,
    outputPerMillionUsd: 0.66,
    cacheHitInputPerMillionUsd: 0.007,
    notes: 'Off-peak cache-miss. Peak is 2x. Cache-hit $0.007/M.'
  },
  // DeepSeek V4-Pro — official off-peak cache-miss rates (August 2026).
  // Cache-hit input: $0.022/M. Peak rates are 2x higher.
  // Source: https://api.deepseek.com (pricing page, verified August 2026).
  'deepseek-v4-pro': {
    inputPerMillionUsd: 0.66,
    outputPerMillionUsd: 1.98,
    cacheHitInputPerMillionUsd: 0.022,
    notes: 'Off-peak cache-miss. Peak is 2x. Cache-hit $0.022/M.'
  }
};


/**
 * Computes estimated cost in USD based on input/output tokens.
 * Returns null if pricing is unknown or tokens are missing.
 */
export function calculateAiCost(
  model: string,
  inputTokens?: number,
  outputTokens?: number
): number | null {
  if (inputTokens === undefined && outputTokens === undefined) {
    return null;
  }

  const pricing = AI_MODEL_PRICING[model.toLowerCase().trim()];
  if (!pricing) {
    return null;
  }

  const inTokens = Number(inputTokens) || 0;
  const outTokens = Number(outputTokens) || 0;

  const cost =
    (inTokens / 1_000_000) * pricing.inputPerMillionUsd +
    (outTokens / 1_000_000) * pricing.outputPerMillionUsd;

  return Math.round(cost * 1_000_000) / 1_000_000;
}
