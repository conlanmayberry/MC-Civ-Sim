/**
 * Re-make recorded decisions under a different prompt or model.
 *
 * A decision is a pure function of its inputs: system prompt, observation,
 * history and injections in; tool calls out. The agent records the inputs
 * (decision_inputs) and the output (the `decision` event), so any past
 * situation can be put to a different model, or to the current code's prompt,
 * and the answers compared like for like.
 *
 * WHAT THIS CAN AND CANNOT TELL YOU. It tests DECISIONS, never execution:
 * nothing here touches Minecraft, so it cannot say whether a move would have
 * arrived or a placement would have landed. It answers "would the agent have
 * chosen differently", which is exactly the question a prompt or model change
 * poses. Execution is what the scenario tests are for.
 *
 * It is also counterfactual only one step deep. The replayed decision is
 * compared against the original, but the world is not re-run from it, so a
 * different choice at turn 40 does not change what turn 41 observed.
 */

import type { DatabaseSync } from 'node:sqlite';

import type { AiProvider, ToolSchema } from '../ai/provider.ts';
import { costOf } from '../ai/pricing.ts';
import type { RunInfo } from '../telemetry/sessions.ts';
import type { Call, Comparison } from './compare.ts';
import { compareCalls } from './compare.ts';

export interface RecordedDecision {
  runId: string;
  agentId: string;
  cycle: number;
  timestamp: string;
  trigger: string;
  observation: string;
  history: string[];
  injections: string[];
  original: {
    calls: Call[];
    summary: string;
    model: string;
    costUsd: number;
    inputTokens: number;
    outputTokens: number;
  };
}

export interface ReplayResult {
  decision: RecordedDecision;
  replayed: { calls: Call[]; summary: string; model: string; costUsd: number } | null;
  comparison: Comparison | null;
  error: string | null;
}

export interface LoadOptions {
  agent?: string;
  /** Only situations whose observation matches, e.g. /STANDING ORDER/. */
  filter?: RegExp;
  /** Only decisions woken by a matching trigger, e.g. /addressed you/. */
  trigger?: RegExp;
}

function parseArray(text: unknown): string[] {
  try {
    const value: unknown = JSON.parse(String(text ?? '[]'));
    return Array.isArray(value) ? value.map(String) : [];
  } catch {
    return [];
  }
}

/**
 * Recorded situations joined to what was originally decided in them.
 *
 * A situation with no matching decision event -- the process died inside the
 * API call -- is skipped: there is nothing to compare the replay against.
 */
export function loadRecorded(
  db: DatabaseSync,
  runs: readonly RunInfo[],
  options: LoadOptions = {},
): RecordedDecision[] {
  const out: RecordedDecision[] = [];

  for (const run of runs) {
    if (options.agent !== undefined && run.agentId !== options.agent) continue;

    const inputs = db
      .prepare(
        `SELECT cycle, timestamp, trigger, observation, history, injections
         FROM decision_inputs WHERE run_id = ? AND agent_id = ? ORDER BY cycle`,
      )
      .all(run.runId, run.agentId) as Array<Record<string, unknown>>;
    if (inputs.length === 0) continue;

    const decisions = new Map<number, Record<string, unknown>>();
    for (const row of db
      .prepare(
        `SELECT data FROM events WHERE run_id = ? AND agent_id = ? AND event_type = 'decision'`,
      )
      .all(run.runId, run.agentId) as Array<{ data: string }>) {
      try {
        const data = JSON.parse(row.data) as Record<string, unknown>;
        if (typeof data['cycle'] === 'number') decisions.set(data['cycle'], data);
      } catch {
        /* a malformed row is not worth failing the whole load over */
      }
    }

    for (const input of inputs) {
      const cycle = Number(input['cycle']);
      const decision = decisions.get(cycle);
      if (decision === undefined) continue;

      const observation = String(input['observation']);
      const trigger = String(input['trigger'] ?? 'interval');
      if (options.filter !== undefined && !options.filter.test(observation)) continue;
      if (options.trigger !== undefined && !options.trigger.test(trigger)) continue;

      const tools = Array.isArray(decision['tools']) ? (decision['tools'] as unknown[]) : [];
      const args = Array.isArray(decision['args']) ? (decision['args'] as unknown[]) : [];

      out.push({
        runId: run.runId,
        agentId: run.agentId,
        cycle,
        timestamp: String(input['timestamp']),
        trigger,
        observation,
        history: parseArray(input['history']),
        injections: parseArray(input['injections']),
        original: {
          calls: tools.map((name, i) => ({
            name: String(name),
            args: (args[i] ?? {}) as Record<string, unknown>,
          })),
          summary: String(decision['summary'] ?? ''),
          model: String(decision['model'] ?? 'unknown'),
          costUsd: Number(decision['costUsd'] ?? 0),
          inputTokens: Number(decision['inputTokens'] ?? 0),
          outputTokens: Number(decision['outputTokens'] ?? 0),
        },
      });
    }
  }

  return out;
}

/**
 * Evenly spaced, not the first N.
 *
 * The first forty decisions of a session are all "gather wood and make tools";
 * a sample that spans the run covers hunger, building, handovers and being
 * spoken to, which is what a change actually needs to be tested against.
 */
export function sampleEvenly<T>(items: readonly T[], limit: number): T[] {
  if (limit <= 0) return [];
  if (items.length <= limit) return [...items];
  const stride = items.length / limit;
  return Array.from({ length: limit }, (_, i) => items[Math.floor(i * stride)] as T);
}

/**
 * What a replay should cost, from the tokens the originals actually used.
 *
 * An estimate, and a deliberately cautious one: cached input is priced as
 * fresh, since whether the provider caches a replay's shared prompt prefix is
 * not something to count on. A model that reasons at more length than the
 * original will still cost more than this says.
 */
export function estimateCost(decisions: readonly RecordedDecision[], model: string): number {
  return decisions.reduce(
    (sum, d) =>
      sum +
      costOf(model, {
        inputTokens: d.original.inputTokens,
        cachedTokens: 0,
        outputTokens: Math.max(d.original.outputTokens, 1),
      }),
    0,
  );
}

export interface ReplayOptions {
  provider: AiProvider;
  /** The system prompt to decide under, per agent. */
  systemFor: (agentId: string, runId: string) => string;
  tools: readonly ToolSchema[];
  /** Stop starting new decisions once this much has been spent. */
  maxUsd: number;
  concurrency: number;
  onProgress?: (done: number, total: number, spentUsd: number) => void;
}

export async function runReplay(
  decisions: readonly RecordedDecision[],
  options: ReplayOptions,
): Promise<{ results: ReplayResult[]; spentUsd: number; stoppedForBudget: boolean }> {
  const results: ReplayResult[] = new Array(decisions.length);
  let next = 0;
  let done = 0;
  let spentUsd = 0;
  let stoppedForBudget = false;

  async function worker(): Promise<void> {
    for (;;) {
      if (spentUsd >= options.maxUsd) {
        stoppedForBudget = next < decisions.length;
        return;
      }
      const index = next++;
      const decision = decisions[index];
      if (decision === undefined) return;

      try {
        const outcome = await options.provider.decide({
          system: options.systemFor(decision.agentId, decision.runId),
          observation: decision.observation,
          history: decision.history,
          injections: decision.injections,
          tools: [...options.tools],
        });
        spentUsd += outcome.costUsd;

        const calls = outcome.toolCalls.map((c) => ({ name: c.name, args: c.args }));
        results[index] = {
          decision,
          replayed: {
            calls,
            summary: outcome.summary,
            model: outcome.model,
            costUsd: outcome.costUsd,
          },
          comparison: compareCalls(decision.original.calls, calls),
          error: null,
        };
      } catch (err) {
        results[index] = {
          decision,
          replayed: null,
          comparison: null,
          error: err instanceof Error ? err.message : String(err),
        };
      }

      done++;
      options.onProgress?.(done, decisions.length, spentUsd);
    }
  }

  await Promise.all(
    Array.from({ length: Math.max(1, Math.min(options.concurrency, decisions.length)) }, () =>
      worker(),
    ),
  );

  return { results: results.filter((r) => r !== undefined), spentUsd, stoppedForBudget };
}
