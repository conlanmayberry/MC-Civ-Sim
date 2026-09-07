/**
 * Spend cap, rate limits and the stop authority.
 *
 * The project brief requires these to exist *before* long-running autonomous
 * experiments, and it is right to insist: an agent loop is a program that
 * spends money in a while-loop. Everything here is designed to fail CLOSED --
 * if the budget cannot be computed, the run stops rather than continuing at an
 * unknown rate.
 *
 * Nothing here talks to a model or a bot. It answers one question -- "may the
 * next decision happen?" -- which makes it unit-testable without a network, and
 * that is the only way to have any confidence in a cap before trusting it.
 */

import { costOf, formatUsd } from './pricing.ts';
import type { TokenUsage } from './pricing.ts';

export interface BudgetLimits {
  /** Hard USD ceiling for this run. The agent stops on reaching it. */
  maxUsd: number;
  /** Ceiling on API calls per rolling minute. */
  maxRequestsPerMinute: number;
  /** Ceiling on decisions per rolling minute, so event triggers cannot storm. */
  maxDecisionsPerMinute: number;
  /** Wall-clock ceiling for the run, in milliseconds. */
  maxDurationMs: number;
}

export const DEFAULT_LIMITS: BudgetLimits = {
  maxUsd: 5,
  maxRequestsPerMinute: 20,
  maxDecisionsPerMinute: 30,
  maxDurationMs: 4 * 60 * 60 * 1000,
};

export type StopReason =
  | 'budget_exhausted'
  | 'duration_exceeded'
  | 'operator'
  | 'kill_file'
  | 'error';

export interface Verdict {
  allowed: boolean;
  /** Present when not allowed and the run should end entirely. */
  stop?: StopReason;
  /** Present when not allowed but the agent should simply wait. */
  waitMs?: number;
  reason: string;
}

export interface Budget {
  /** May a decision proceed right now? */
  check: () => Verdict;
  /** Record what a call actually cost. Returns the new total. */
  record: (model: string, usage: TokenUsage) => number;
  spentUsd: () => number;
  requestCount: () => number;
  /** Stop the run for good. */
  stop: (reason: StopReason) => void;
  stopped: () => StopReason | null;
  /** Crossed a warning threshold since the last call, if any. */
  takeWarning: () => string | null;
  summary: () => string;
}

/** Warn on the way up, so a run that is burning fast is visible before the cap. */
const WARN_AT = [0.5, 0.75, 0.9];

export function createBudget(
  limits: BudgetLimits = DEFAULT_LIMITS,
  now: () => number = Date.now,
): Budget {
  const startedAt = now();
  let spent = 0;
  let requests = 0;
  let stoppedFor: StopReason | null = null;
  let warned = 0;
  let pendingWarning: string | null = null;

  const requestTimes: number[] = [];
  const decisionTimes: number[] = [];

  function prune(times: number[]): void {
    const cutoff = now() - 60_000;
    while (times.length > 0 && (times[0] ?? 0) < cutoff) times.shift();
  }

  /** Time until the oldest entry in a full window ages out. */
  function waitFor(times: number[]): number {
    const oldest = times[0];
    return oldest === undefined ? 1_000 : Math.max(250, oldest + 60_000 - now());
  }

  return {
    check() {
      if (stoppedFor !== null) {
        return { allowed: false, stop: stoppedFor, reason: `stopped: ${stoppedFor}` };
      }

      if (now() - startedAt >= limits.maxDurationMs) {
        stoppedFor = 'duration_exceeded';
        return {
          allowed: false,
          stop: 'duration_exceeded',
          reason: `run exceeded ${Math.round(limits.maxDurationMs / 60_000)} minutes`,
        };
      }

      // Checked BEFORE the call, using what has already been spent. The next
      // call's cost is unknown, so the cap is enforced on the trailing side --
      // a single call can carry the total slightly past the ceiling, which is
      // why the ceiling is a budget rather than a hard billing limit.
      if (spent >= limits.maxUsd) {
        stoppedFor = 'budget_exhausted';
        return {
          allowed: false,
          stop: 'budget_exhausted',
          reason: `spent ${formatUsd(spent)} of ${formatUsd(limits.maxUsd)}`,
        };
      }

      prune(requestTimes);
      if (requestTimes.length >= limits.maxRequestsPerMinute) {
        return {
          allowed: false,
          waitMs: waitFor(requestTimes),
          reason: `${limits.maxRequestsPerMinute} requests/min limit`,
        };
      }

      prune(decisionTimes);
      if (decisionTimes.length >= limits.maxDecisionsPerMinute) {
        return {
          allowed: false,
          waitMs: waitFor(decisionTimes),
          reason: `${limits.maxDecisionsPerMinute} decisions/min limit`,
        };
      }

      decisionTimes.push(now());
      requestTimes.push(now());
      return { allowed: true, reason: 'ok' };
    },

    record(model, usage) {
      // A call that used no tokens cost nothing, whatever the model -- so the
      // stub provider and any zero-usage response need no price. This does not
      // weaken the fail-closed property: a REAL call always reports tokens, and
      // an unpriced model with tokens still throws below.
      const usedTokens = usage.inputTokens + usage.outputTokens;
      if (usedTokens > 0) {
        // Throws UnknownModelError on an unpriced model. Deliberate: an
        // uncountable call must stop the run, not pass as free.
        spent += costOf(model, usage);
      }
      requests++;

      const fraction = spent / limits.maxUsd;
      while (warned < WARN_AT.length && fraction >= (WARN_AT[warned] ?? 1)) {
        pendingWarning =
          `${Math.round((WARN_AT[warned] ?? 0) * 100)}% of budget used ` +
          `(${formatUsd(spent)} of ${formatUsd(limits.maxUsd)})`;
        warned++;
      }

      return spent;
    },

    spentUsd: () => spent,
    requestCount: () => requests,

    stop(reason) {
      stoppedFor ??= reason;
    },

    stopped: () => stoppedFor,

    takeWarning() {
      const warning = pendingWarning;
      pendingWarning = null;
      return warning;
    },

    summary() {
      const minutes = ((now() - startedAt) / 60_000).toFixed(1);
      return (
        `${requests} calls, ${formatUsd(spent)} of ${formatUsd(limits.maxUsd)}, ${minutes} min` +
        (stoppedFor === null ? '' : ` -- stopped: ${stoppedFor}`)
      );
    },
  };
}
