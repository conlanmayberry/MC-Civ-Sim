/**
 * The AI provider seam.
 *
 * The project brief requires the model provider to be swappable, and this is
 * that boundary: everything above it deals in observations and tool calls, and
 * nothing above it imports the OpenAI SDK. Swapping to a different provider
 * means writing one more implementation of this interface.
 *
 * It also gives us `stubProvider`, which is how the agent loop is tested at all
 * -- without it, every test of the decision cycle would cost money and require
 * a network.
 */

import type { ActionResult } from '../bot/actions/index.ts';
import type { TokenUsage } from './pricing.ts';

/** A tool the model may call. Schemas are built in ./tools.ts. */
export interface ToolSchema {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
}

export interface DecisionRequest {
  /** System framing: who the agent is and how it should behave. */
  system: string;
  /** The current situation, already serialised. */
  observation: string;
  /** Recent history: what it did and what happened, oldest first. */
  history: string[];
  /** Operator messages injected since the last decision. */
  injections: string[];
  tools: ToolSchema[];
}

export interface ProposedCall {
  callId: string;
  name: string;
  args: Record<string, unknown>;
}

export interface DecisionOutcome {
  /** What the model wants to do. Empty means it chose to do nothing. */
  toolCalls: ProposedCall[];
  /**
   * One short sentence of stated reasoning.
   *
   * Deliberately NOT chain-of-thought. The brief asks for structured decision
   * metadata for research, and a one-line summary is what can actually be
   * aggregated across thousands of decisions.
   */
  summary: string;
  model: string;
  usage: TokenUsage;
  costUsd: number;
}

export interface AiProvider {
  readonly id: string;
  readonly model: string;
  decide(request: DecisionRequest): Promise<DecisionOutcome>;
}

/**
 * A provider that never calls an API.
 *
 * Used by `npm run agent -- --dry-run` and by the unit tests. It cycles through
 * a scripted list of tool calls so the full observe/decide/act/record loop can
 * be exercised for $0.00 -- which is what makes it safe to verify the loop
 * before ever pointing it at a paid endpoint.
 */
export function createStubProvider(script: ProposedCall[][] = []): AiProvider {
  let step = 0;

  return {
    id: 'stub',
    model: 'stub',
    async decide(): Promise<DecisionOutcome> {
      const calls = script[step % Math.max(1, script.length)] ?? [];
      step++;
      return {
        toolCalls: calls,
        summary: `stub decision ${step}`,
        model: 'stub',
        usage: { inputTokens: 0, cachedTokens: 0, outputTokens: 0 },
        costUsd: 0,
      };
    },
  };
}

/** Renders an action result for the model: compact, and honest about failure. */
export function describeForModel(name: string, result: ActionResult): string {
  if (result.ok) {
    return `${name}: ok ${JSON.stringify(result.detail)}`;
  }
  return `${name}: FAILED [${result.error?.code ?? 'failed'}] ${result.error?.message ?? ''}`;
}
