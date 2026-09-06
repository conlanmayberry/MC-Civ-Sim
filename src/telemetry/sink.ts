/**
 * Bridges the Stage 2 logger to the Stage 4 database.
 *
 * This file is the payoff of a decision made two stages ago. Every call site
 * already emits `log.event(type, data)` with an event type from the brief's
 * vocabulary, so turning console output into a queryable event store needs no
 * change to any of them -- only a different sink.
 *
 * The one thing a sink cannot get from the logger is *where* the bot was, since
 * `src/util/log.ts` deliberately knows nothing about Minecraft. So the context
 * (position, tick, dimension) is supplied by a callback the bot owns, keeping
 * the logger free of Minecraft types and the sink free of bot plumbing.
 */

import type { Sink, TelemetryEvent } from '../util/log.ts';
import type { EventRow, Store } from './store.ts';

export interface EventContext {
  minecraftTick: number | null;
  x: number | null;
  y: number | null;
  z: number | null;
  dimension: string | null;
}

/** Returns where the bot is right now, or nulls before it has spawned. */
export type ContextProvider = () => EventContext;

export const NO_CONTEXT: EventContext = {
  minecraftTick: null,
  x: null,
  y: null,
  z: null,
  dimension: null,
};

/**
 * Some fields are hoisted out of `data` into real columns because they are
 * queried constantly -- "which actions failed and why" should be an index scan,
 * not a JSON extract over every row.
 */
function hoist(event: TelemetryEvent): {
  action: string | null;
  ok: boolean | null;
  errorCode: string | null;
  durationMs: number | null;
  rest: Record<string, unknown>;
} {
  const { action, ok, error, durationMs, ...rest } = event.data as {
    action?: unknown;
    ok?: unknown;
    error?: unknown;
    durationMs?: unknown;
  } & Record<string, unknown>;

  return {
    action: typeof action === 'string' ? action : null,
    ok: typeof ok === 'boolean' ? ok : null,
    errorCode: typeof error === 'string' ? error : null,
    durationMs: typeof durationMs === 'number' ? durationMs : null,
    rest,
  };
}

export function createSqliteSink(
  store: Store,
  runId: string,
  getContext: ContextProvider = () => NO_CONTEXT,
): Sink {
  return (event: TelemetryEvent): void => {
    const context = getContext();
    const { action, ok, errorCode, durationMs, rest } = hoist(event);

    const row: EventRow = {
      runId,
      agentId: event.agentId,
      timestamp: event.timestamp,
      minecraftTick: context.minecraftTick,
      eventType: event.eventType,
      action,
      ok,
      errorCode,
      durationMs,
      x: context.x,
      y: context.y,
      z: context.z,
      dimension: context.dimension,
      data: rest,
    };

    store.writeEvent(row);
  };
}

/**
 * Send each event to several sinks.
 *
 * Used to keep the console readable while the database fills: an operator
 * watching a run should not have to query SQLite to see what is happening, and
 * a sink that throws must not stop the others from recording.
 */
export function fanOut(...sinks: Sink[]): Sink {
  return (event: TelemetryEvent): void => {
    for (const sink of sinks) {
      try {
        sink(event);
      } catch (err) {
        process.stderr.write(
          `[telemetry] sink failed: ${err instanceof Error ? err.message : String(err)}\n`,
        );
      }
    }
  };
}
