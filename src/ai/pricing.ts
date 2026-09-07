/**
 * Model pricing and cost arithmetic.
 *
 * The spend cap is only as trustworthy as this table, so it is pinned with a
 * verification date rather than guessed, and an unknown model is a hard error
 * rather than a silent zero. A budget that quietly fails open is worse than no
 * budget at all -- it reads as safe while spending without limit.
 *
 * Prices drift. Re-check them at
 * https://developers.openai.com/api/docs/pricing and update `VERIFIED_ON`.
 */

/** The single model every agent uses. */
export const MODEL = 'gpt-5.6-luna';

export const PRICING_VERIFIED_ON = '2026-09-06';

export interface ModelPrice {
  /** USD per million input tokens. */
  readonly inputPerMillion: number;
  /** USD per million cached input tokens. Cached input is billed cheaper. */
  readonly cachedInputPerMillion: number;
  /** USD per million output tokens. */
  readonly outputPerMillion: number;
}

/**
 * Only models we have actually priced. Adding one without its real prices
 * would defeat the cap, so the table is deliberately short.
 */
export const PRICES: Readonly<Record<string, ModelPrice>> = {
  'gpt-5.6-luna': { inputPerMillion: 0.2, cachedInputPerMillion: 0.02, outputPerMillion: 1.2 },
  'gpt-5.6-terra': { inputPerMillion: 2.0, cachedInputPerMillion: 0.2, outputPerMillion: 12.0 },
  'gpt-5.6-sol': { inputPerMillion: 4.0, cachedInputPerMillion: 0.4, outputPerMillion: 20.0 },
  'gpt-6-astra': { inputPerMillion: 10.0, cachedInputPerMillion: 1.0, outputPerMillion: 50.0 },
};

export interface TokenUsage {
  inputTokens: number;
  /** Subset of inputTokens served from cache, billed at the cheaper rate. */
  cachedTokens: number;
  outputTokens: number;
}

export class UnknownModelError extends Error {
  constructor(model: string) {
    super(
      `No pricing for model "${model}". Add it to src/ai/pricing.ts with real ` +
        `prices, or the spend cap cannot be enforced.`,
    );
    this.name = 'UnknownModelError';
  }
}

/**
 * Cost of one call, in USD.
 *
 * `input_tokens` from the Responses API is the TOTAL including cached ones, so
 * the cached portion is subtracted before charging the full rate -- otherwise
 * prompt caching makes the estimate drift high and the cap trips early.
 */
export function costOf(model: string, usage: TokenUsage): number {
  const price = PRICES[model];
  if (price === undefined) throw new UnknownModelError(model);

  const cached = Math.max(0, Math.min(usage.cachedTokens, usage.inputTokens));
  const fresh = Math.max(0, usage.inputTokens - cached);

  return (
    (fresh / 1_000_000) * price.inputPerMillion +
    (cached / 1_000_000) * price.cachedInputPerMillion +
    (Math.max(0, usage.outputTokens) / 1_000_000) * price.outputPerMillion
  );
}

/** Human-readable price line, printed at startup so cost is never a surprise. */
export function describeModel(model: string): string {
  const price = PRICES[model];
  if (price === undefined) throw new UnknownModelError(model);
  return (
    `${model}  $${price.inputPerMillion}/M in, $${price.outputPerMillion}/M out ` +
    `(cached in $${price.cachedInputPerMillion}/M, verified ${PRICING_VERIFIED_ON})`
  );
}

/** Small USD amounts need more than two decimals to mean anything. */
export function formatUsd(amount: number): string {
  if (amount === 0) return '$0.0000';
  if (amount < 0.01) return `$${amount.toFixed(5)}`;
  return `$${amount.toFixed(4)}`;
}
