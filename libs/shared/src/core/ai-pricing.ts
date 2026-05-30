/**
 * Anthropic model pricing constants (USD per million tokens).
 * Update when Anthropic changes pricing.
 */
export const MODEL_PRICING: Record<string, { inputPerM: number; outputPerM: number }> = {
  'claude-haiku-4-5-20251001': { inputPerM: 0.80,  outputPerM: 4.00  },
  'claude-haiku-4-5':          { inputPerM: 0.80,  outputPerM: 4.00  },
  'claude-sonnet-4-6':         { inputPerM: 3.00,  outputPerM: 15.00 },
  'claude-opus-4-7':           { inputPerM: 15.00, outputPerM: 75.00 },
};

const FALLBACK_PRICING = { inputPerM: 15.00, outputPerM: 75.00 };

export function estimateCostUsd(model: string, inputTokens: number, outputTokens: number): number {
  const pricing = MODEL_PRICING[model] ?? FALLBACK_PRICING;
  return (inputTokens / 1_000_000) * pricing.inputPerM
       + (outputTokens / 1_000_000) * pricing.outputPerM;
}

/**
 * Rough upper-bound estimate from raw text byte count.
 * Assumes ~4 bytes/token average and a 1:4 input:output ratio.
 * Used for pre-upload cost checks — actual cost will vary.
 */
export function estimateCostFromBytes(
  model: string,
  bytes: number,
  outputTokenEstimate = 2000,
): number {
  const inputTokens = Math.ceil(bytes / 4);
  return estimateCostUsd(model, inputTokens, outputTokenEstimate);
}

export const FINANCE_CAPS = {
  /** Hard block per knowledge source upload (pipeline 3). */
  perSourceUsd: 2.00,
  /** Hard block for pipeline 2 + 3 combined per calendar month. */
  monthlyUsd: 20.00,
  /** Soft warn on Regenerate button (pipeline 2). */
  regenWarnUsd: 1.00,
} as const;
