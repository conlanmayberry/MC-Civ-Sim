/**
 * The OpenAI implementation of AiProvider.
 *
 * This is the only file that imports the OpenAI SDK. Everything above it deals
 * in observations and tool calls, which is what makes the provider genuinely
 * swappable rather than nominally so.
 *
 * Uses the Responses API (`client.responses.create`), which is the current
 * surface in SDK v7 -- `chat.completions` still exists but is not where new
 * capability lands.
 */

import OpenAI from 'openai';

import { MODEL, costOf } from './pricing.ts';
import type { TokenUsage } from './pricing.ts';
import type { AiProvider, DecisionOutcome, DecisionRequest, ProposedCall } from './provider.ts';

/** Cap output so a runaway response cannot cost much on its own. */
const MAX_OUTPUT_TOKENS = 700;
/** A stuck request must not stall the loop forever. */
const REQUEST_TIMEOUT_MS = 60_000;

export interface OpenAiOptions {
  apiKey: string;
  model?: string;
  maxOutputTokens?: number;
}

/**
 * The model is asked for a one-line summary alongside its tool calls. Anything
 * it writes as prose becomes that summary.
 */
function extractSummary(output: unknown[]): string {
  const parts: string[] = [];

  for (const item of output) {
    if (typeof item !== 'object' || item === null) continue;
    const record = item as { type?: unknown; content?: unknown };
    if (record.type !== 'message' || !Array.isArray(record.content)) continue;

    for (const chunk of record.content) {
      if (typeof chunk !== 'object' || chunk === null) continue;
      const text = (chunk as { text?: unknown }).text;
      if (typeof text === 'string' && text.trim() !== '') parts.push(text.trim());
    }
  }

  return parts.join(' ').slice(0, 400);
}

function extractToolCalls(output: unknown[]): ProposedCall[] {
  const calls: ProposedCall[] = [];

  for (const item of output) {
    if (typeof item !== 'object' || item === null) continue;
    const record = item as { type?: unknown; name?: unknown; arguments?: unknown; call_id?: unknown };
    if (record.type !== 'function_call') continue;
    if (typeof record.name !== 'string') continue;

    let args: Record<string, unknown> = {};
    if (typeof record.arguments === 'string' && record.arguments.trim() !== '') {
      try {
        const parsed: unknown = JSON.parse(record.arguments);
        if (typeof parsed === 'object' && parsed !== null) args = parsed as Record<string, unknown>;
      } catch {
        // Malformed arguments are the model's mistake, not a crash. The call is
        // still dispatched and the action layer rejects it with
        // invalid_argument, which the model sees next cycle.
      }
    }

    calls.push({
      callId: typeof record.call_id === 'string' ? record.call_id : `call_${calls.length}`,
      name: record.name,
      args,
    });
  }

  return calls;
}

function extractUsage(usage: unknown): TokenUsage {
  const u = (usage ?? {}) as {
    input_tokens?: unknown;
    output_tokens?: unknown;
    input_tokens_details?: { cached_tokens?: unknown };
  };
  const num = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) ? v : 0);

  return {
    inputTokens: num(u.input_tokens),
    outputTokens: num(u.output_tokens),
    cachedTokens: num(u.input_tokens_details?.cached_tokens),
  };
}

export function createOpenAiProvider(options: OpenAiOptions): AiProvider {
  const model = options.model ?? MODEL;
  const client = new OpenAI({
    apiKey: options.apiKey,
    timeout: REQUEST_TIMEOUT_MS,
    // One retry: a transient network blip should not end a run, but retrying
    // hard would multiply spend behind the request-per-minute limit.
    maxRetries: 1,
  });

  return {
    id: 'openai',
    model,

    async decide(request: DecisionRequest): Promise<DecisionOutcome> {
      const input = [
        { role: 'developer' as const, content: request.system },
        ...request.history.map((entry) => ({ role: 'assistant' as const, content: entry })),
        ...request.injections.map((text) => ({
          role: 'user' as const,
          // Marked as coming from the operator so the model can weigh it as a
          // directive rather than as world observation. Every one of these is
          // recorded to telemetry as an intervention.
          content: `[OPERATOR INSTRUCTION] ${text}`,
        })),
        { role: 'user' as const, content: request.observation },
      ];

      const response = await client.responses.create({
        model,
        input,
        max_output_tokens: options.maxOutputTokens ?? MAX_OUTPUT_TOKENS,
        tools: request.tools.map((tool) => ({
          type: 'function' as const,
          name: tool.name,
          description: tool.description,
          parameters: tool.parameters,
          // Strict mode guarantees arguments match the schema, which is what
          // lets the dispatcher in tools.ts trust the shapes it validates.
          strict: true,
        })),
      });

      const output = Array.isArray(response.output) ? (response.output as unknown[]) : [];
      const usage = extractUsage(response.usage);

      return {
        toolCalls: extractToolCalls(output),
        summary: extractSummary(output),
        model,
        usage,
        costUsd: costOf(model, usage),
      };
    },
  };
}
