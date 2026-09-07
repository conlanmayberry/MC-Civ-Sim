/**
 * Event-shaped logging.
 *
 * Stage 2 has no database, and this file deliberately does not build one. What
 * it does build is the *call-site shape*: every meaningful thing the bot does is
 * recorded as a structured record with an event type drawn from the Stage 4
 * vocabulary in the project brief.
 *
 * Stage 4 replaces `consoleSink` with a SQLite writer and adds `minecraftTick`.
 * No call site should have to change. That is the entire point of doing this
 * now rather than later.
 */

/**
 * A union rather than an enum: `enum` is not erasable syntax, and Node's native
 * type stripping cannot run it. See docs/decisions.md ADR-004.
 *
 * Only the types Stage 2 actually emits are listed. The rest of the brief's
 * vocabulary (block_mined, goal_started, decision, ...) arrives with the stages
 * that emit them -- an unused type here would be a promise we have not kept.
 */
export type EventType =
  | 'bot_connected'
  | 'bot_disconnected'
  | 'bot_reconnecting'
  | 'observation'
  | 'chat_received'
  | 'chat_sent'
  | 'command_received'
  | 'command_rejected'
  | 'damage_taken'
  | 'death'
  | 'error'
  // Stage 3 actions. Each action emits exactly one of these, success or
  // failure, via the runAction wrapper (ADR-007).
  | 'movement'
  | 'block_mined'
  | 'block_placed'
  | 'item_collected'
  | 'item_crafted'
  | 'item_consumed'
  // Stage 5 -- the AI layer. `decision` carries structured metadata only:
  // goal, chosen tools, a one-line reason, tokens and cost. Never
  // chain-of-thought (project brief, Stage 13).
  | 'decision'
  | 'thought_injected'
  | 'budget_warning'
  | 'agent_started'
  | 'agent_stopped'
  | 'goal_set'
  | 'place_remembered';

export interface TelemetryEvent {
  readonly timestamp: string;
  readonly agentId: string;
  readonly eventType: EventType;
  readonly data: Readonly<Record<string, unknown>>;
}

export type Sink = (event: TelemetryEvent) => void;

const DIM = '\x1b[2m';
const RED = '\x1b[31m';
const YELLOW = '\x1b[33m';
const CYAN = '\x1b[36m';
const RESET = '\x1b[0m';

const COLOUR: Partial<Record<EventType, string>> = {
  bot_connected: CYAN,
  bot_disconnected: YELLOW,
  bot_reconnecting: YELLOW,
  damage_taken: YELLOW,
  death: RED,
  error: RED,
};

/** Compact one-line rendering of an event's payload. */
function renderData(data: Readonly<Record<string, unknown>>): string {
  const parts: string[] = [];
  for (const [key, value] of Object.entries(data)) {
    if (value === undefined) continue;
    const rendered =
      typeof value === 'object' && value !== null ? JSON.stringify(value) : String(value);
    parts.push(`${key}=${rendered}`);
  }
  return parts.join(' ');
}

export const consoleSink: Sink = (event) => {
  const time = event.timestamp.slice(11, 19);
  const colour = COLOUR[event.eventType] ?? '';
  const body = renderData(event.data);
  const stream = event.eventType === 'error' ? process.stderr : process.stdout;
  stream.write(
    `${DIM}${time}${RESET} ${colour}${event.eventType}${RESET}` +
      (body ? ` ${DIM}${body}${RESET}` : '') +
      '\n',
  );
};

export interface Logger {
  event(type: EventType, data?: Readonly<Record<string, unknown>>): void;
  /** Convenience for the common `error` shape; keeps stacks out of the record. */
  error(where: string, err: unknown): void;
}

export function createLogger(agentId: string, sink: Sink = consoleSink): Logger {
  return {
    event(type, data = {}) {
      sink({ timestamp: new Date().toISOString(), agentId, eventType: type, data });
    },
    error(where, err) {
      const message = err instanceof Error ? err.message : String(err);
      sink({
        timestamp: new Date().toISOString(),
        agentId,
        eventType: 'error',
        data: { where, message },
      });
    },
  };
}
