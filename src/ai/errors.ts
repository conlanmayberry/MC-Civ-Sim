/**
 * Is a provider error worth retrying?
 *
 * Written after a run logged 42 identical "429 You have no credits remaining"
 * errors: the loop caught the failure, backed off five seconds, and tried again
 * forever. Nothing was spent, but a process that retries a permanent condition
 * indefinitely is a runaway loop, and the project brief's safety section exists
 * to prevent exactly that.
 *
 * The distinction that matters is PERMANENT vs TRANSIENT, and it is not the
 * same as the HTTP status. A 429 can mean "slow down" (retry) or "you have no
 * credits" (never retry) -- the status alone would get this wrong, so the
 * error code and message are checked too.
 */

export type ErrorKind = 'permanent' | 'transient';

export interface Classification {
  kind: ErrorKind;
  /** Short, human-readable reason, safe to log. Never contains the key. */
  reason: string;
}

/**
 * Conditions no amount of waiting will fix. Retrying these wastes time and, on
 * a rate-limited endpoint, looks like abuse.
 */
const PERMANENT_PATTERNS: Array<{ pattern: RegExp; reason: string }> = [
  { pattern: /insufficient_quota|no credits remaining|billing/i, reason: 'account has no credits' },
  { pattern: /invalid[_ ]api[_ ]key|incorrect api key|401/i, reason: 'API key rejected' },
  { pattern: /403|permission|not authoriz|access denied/i, reason: 'not authorised' },
  { pattern: /model[_ ]not[_ ]found|does not exist|unknown model|404/i, reason: 'model unavailable' },
  { pattern: /content[_ ]policy|moderation/i, reason: 'content policy' },
  { pattern: /unsupported|invalid[_ ]request|schema/i, reason: 'request rejected as invalid' },
];

/** Worth another go: the network, the provider being briefly unhappy. */
const TRANSIENT_PATTERNS: RegExp[] = [
  /rate[_ ]?limit/i,
  /timeout|timed out|ETIMEDOUT/i,
  /ECONNRESET|ECONNREFUSED|EPIPE|ENOTFOUND|socket hang up/i,
  /50[0234]|server[_ ]error|overloaded|try again/i,
];

export function classifyProviderError(err: unknown): Classification {
  const message = err instanceof Error ? err.message : String(err);

  // Some SDK errors carry a structured code; prefer it over the message text.
  const code =
    typeof err === 'object' && err !== null && 'code' in err
      ? String((err as { code?: unknown }).code ?? '')
      : '';
  const haystack = `${code} ${message}`;

  for (const { pattern, reason } of PERMANENT_PATTERNS) {
    if (pattern.test(haystack)) {
      // "no credits" arrives as a 429, so the permanent check must run BEFORE
      // the rate-limit check or it would be retried forever.
      return { kind: 'permanent', reason };
    }
  }

  for (const pattern of TRANSIENT_PATTERNS) {
    if (pattern.test(haystack)) {
      return { kind: 'transient', reason: 'temporary provider or network problem' };
    }
  }

  // Unknown errors are treated as transient, but the consecutive-failure limit
  // in the agent loop stops them becoming infinite. Failing closed on anything
  // unrecognised would end runs over harmless one-offs.
  return { kind: 'transient', reason: 'unrecognised error' };
}

/** Exponential backoff with a ceiling, for transient failures. */
export function backoffMs(consecutiveFailures: number): number {
  return Math.min(60_000, 2_000 * 2 ** Math.max(0, consecutiveFailures - 1));
}
