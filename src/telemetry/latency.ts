/**
 * How long the agent leaves somebody waiting.
 *
 * Separated from the CLI because the pairing rules are judgement calls, not
 * formatting, and they are easy to get quietly wrong: an operator command
 * counted as a question, or a message that was never answered left pending
 * forever so the next real reply appears to have taken hours.
 *
 * The measurement exists because the slow path was invisible. An agent that
 * replies in five seconds and one that replies in seventy-eight look identical
 * while you are standing next to it -- both are "thinking" -- and the second
 * one is the difference between a participant and a bystander.
 */

/** The three columns of an events row this needs. */
export interface ChatEventRow {
  timestamp: string;
  event_type: string;
  data: string;
}

export interface Reply {
  askedAt: number;
  waitedMs: number;
  from: string;
  text: string;
  directed: boolean;
  /** How many messages had piled up before the agent answered. */
  burst: number;
}

export interface Unanswered {
  at: string;
  from: string;
  text: string;
  directed: boolean;
}

/**
 * Nearest-rank percentile, done by hand because SQLite has none and the
 * alternative is a dependency for six lines of arithmetic. Nearest-rank is the
 * honest choice on the small samples a single run produces -- interpolating
 * between two points invents precision that is not there.
 */
export function percentile(samples: readonly number[], p: number): number {
  if (samples.length === 0) return 0;
  const sorted = [...samples].sort((a, b) => a - b);
  const rank = Math.ceil((p / 100) * sorted.length);
  return sorted[Math.min(sorted.length - 1, Math.max(0, rank - 1))] ?? 0;
}

export function secs(ms: number): string {
  return `${(ms / 1000).toFixed(1)}s`;
}

/** n / p50 / p90 / max over a set of durations, ready to tabulate. */
export function distribution(
  label: string,
  samples: readonly number[],
): Record<string, string | number> {
  const empty = samples.length === 0;
  return {
    what: label,
    n: samples.length,
    p50: empty ? '' : secs(percentile(samples, 50)),
    p90: empty ? '' : secs(percentile(samples, 90)),
    max: empty ? '' : secs(Math.max(...samples)),
  };
}

/** Does this message name the agent? Mirrors isDirectedAt in agent/hearing.ts. */
export function namesAgent(username: string, text: string): boolean {
  const escaped = username.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`\\b${escaped}\\b`, 'i').test(text);
}

/** `agent tell ...`, `agent stop` -- operator commands, not conversation. */
function isOperatorCommand(text: string): boolean {
  return /^agent( |$)/.test(text);
}

/**
 * Pair what people said with what the agent said back.
 *
 * A reply is timed from the FIRST message the agent had not yet answered rather
 * than the last: if somebody says three things and gets one answer, the wait
 * they actually experienced began with the first. A `chat_sent` with nothing
 * outstanding is the agent speaking unprompted, which is not a response time
 * and is not counted as one.
 */
export function pairReplies(
  events: readonly ChatEventRow[],
  username: string,
): { replies: Reply[]; unanswered: Unanswered[] } {
  const replies: Reply[] = [];
  let pending: Array<{ t: number; at: string; from: string; text: string }> = [];

  for (const event of events) {
    let data: { from?: string; message?: string } = {};
    try {
      data = JSON.parse(event.data ?? '{}') as { from?: string; message?: string };
    } catch {
      continue;
    }

    const t = Date.parse(event.timestamp);
    if (Number.isNaN(t)) continue;

    if (event.event_type === 'chat_received') {
      const from = data.from ?? '?';
      const text = data.message ?? '';
      // The bot may see its own line come back off the server, and operator
      // commands are handled elsewhere -- neither is somebody awaiting a reply.
      if (from === username || isOperatorCommand(text)) continue;
      pending.push({ t, at: event.timestamp, from, text });
      continue;
    }

    if (event.event_type !== 'chat_sent') continue;

    const first = pending[0];
    if (first === undefined) continue;

    replies.push({
      askedAt: first.t,
      waitedMs: t - first.t,
      from: first.from,
      text: first.text,
      directed: pending.some((m) => namesAgent(username, m.text)),
      burst: pending.length,
    });
    pending = [];
  }

  return {
    replies,
    unanswered: pending.map((m) => ({
      at: m.at,
      from: m.from,
      text: m.text,
      directed: namesAgent(username, m.text),
    })),
  };
}

/**
 * Collapse a decision trigger into a kind.
 *
 * "Bob addressed you" and "Ann addressed you" are the same sort of event, and
 * grouping by the raw string would give one sample per player.
 */
export function triggerKind(trigger: string): string {
  if (/addressed you$/.test(trigger)) return 'addressed by name';
  if (/^chat from /.test(trigger)) return 'nearby chat';
  return trigger;
}
