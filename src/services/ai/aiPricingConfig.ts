export interface ModelPricing {
  inputPerMillionUsd: number;
  outputPerMillionUsd: number;
  /** Cache-hit input token price (e.g. DeepSeek prompt cache). Optional. */
  cacheHitInputPerMillionUsd?: number;
  /** Human-readable pricing notes for Admin UI display. */
  notes?: string;
}

export const AI_MODEL_PRICING: Record<string, ModelPricing> = {
  'gemini-3.6-flash': {
    inputPerMillionUsd: 0.75,
    outputPerMillionUsd: 3.75,
    notes: 'Introductory through Dec 31, 2026. Standard $1.50/$7.50.'
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
  // DeepSeek Flash — official rates (DeepSeek-V4.1-Flash).
  // Off-peak: In $0.15/M, Out $0.60/M. Peak: In $0.30/M, Out $1.20/M. Cache-hit: $0.003-$0.006/M.
  // Blended average: In $0.22/M, Out $0.90/M.
  'deepseek-flash': {
    inputPerMillionUsd: 0.22,
    outputPerMillionUsd: 0.90,
    cacheHitInputPerMillionUsd: 0.005,
    notes: 'DeepSeek-V4.1-Flash (Off-peak $0.15/$0.60, Peak $0.30/$1.20 per M tokens)'
  },
  'deepseek-v4-flash': {
    inputPerMillionUsd: 0.22,
    outputPerMillionUsd: 0.90,
    cacheHitInputPerMillionUsd: 0.005,
    notes: 'DeepSeek-V4.1-Flash legacy alias (billed at Flash rate)'
  },
  'deepseek-chat': {
    inputPerMillionUsd: 0.14,
    outputPerMillionUsd: 0.28,
    cacheHitInputPerMillionUsd: 0.014,
    notes: 'DeepSeek Chat V3 ($0.14 in, $0.28 out per M tokens)'
  },
  'deepseek-reasoner': {
    inputPerMillionUsd: 0.55,
    outputPerMillionUsd: 2.19,
    cacheHitInputPerMillionUsd: 0.14,
    notes: 'DeepSeek Reasoner R1 ($0.55 in, $2.19 out per M tokens)'
  },
  // DeepSeek V4-Pro — official off-peak cache-miss rates.
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

  let modelKey = (model || '').toLowerCase().trim();
  if (modelKey.startsWith('deepseek') && (modelKey.includes('flash') || modelKey.includes('v4-flash') || modelKey.includes('v4.1'))) {
    modelKey = 'deepseek-flash';
  } else if (modelKey === 'deepseek-v3' || modelKey === 'deepseek-chat-v3') {
    modelKey = 'deepseek-chat';
  } else if (modelKey === 'deepseek-r1' || modelKey === 'deepseek-reasoner-r1') {
    modelKey = 'deepseek-reasoner';
  }

  const pricing = AI_MODEL_PRICING[modelKey] || AI_MODEL_PRICING[(model || '').toLowerCase().trim()];
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
