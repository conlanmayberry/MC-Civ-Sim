/**
 * What the agent has already tried that did not work.
 *
 * Added after finding one placement attempted and refused 110 times across
 * seven runs -- the same coordinate, the same reason ("the block is still
 * spruce_sapling"), eighteen to fifty seconds apart, so it was not one bad
 * batch but the agent re-deciding to do the identical doomed thing turn after
 * turn for the better part of an hour.
 *
 * The system prompt already said "repeating a failed action unchanged will
 * fail the same way". Saying it once is not the same as remembering it: the
 * history window is six turns, and a failure eight turns ago is simply gone.
 * This is the memory that makes that instruction actionable, and it is the
 * cheapest available fix for an agent stuck in a loop -- it does not need to
 * reason better, it needs to be told what it already knows.
 *
 * Deliberately short-lived. A setback is a fact about a moment, not a
 * permanent law: the sapling can be mined, the ground can be levelled, the
 * player can come back into range. Entries expire so an agent is not talked
 * out of retrying something that has genuinely changed.
 */

export interface Setback {
  /** Identifies the attempt: same key means "you did exactly this before". */
  key: string;
  /** Human-readable version of what was attempted. */
  what: string;
  /** The failure the world gave back. */
  why: string;
  /** The most recent turn this failed on. */
  turn: number;
  /** How many times it has failed, so repetition itself becomes visible. */
  count: number;
}

export interface Setbacks {
  record: (action: string, args: Record<string, unknown>, why: string, turn: number) => void;
  /** Clears the record for an attempt that has now worked. */
  succeeded: (action: string, args: Record<string, unknown>) => void;
  all: (turn: number) => Setback[];
  /**
   * Is this EXACT attempt already a known setback? Used to stop a single
   * decision from spending several of its own tool calls on the identical
   * doomed thing -- see agent.ts, where a decision to place three cobblestone
   * at the same already-solid coordinate ran all three against the world
   * before the model ever saw that the first one had failed.
   */
  active: (action: string, args: Record<string, unknown>, turn: number) => Setback | null;
}

/** How many turns a setback is remembered for. */
export const SETBACK_TTL_TURNS = 12;
/** Ceiling, so a flailing agent cannot fill its own prompt with its failures. */
export const MAX_SETBACKS = 6;

/**
 * A stable identity for "this exact attempt".
 *
 * Keys are sorted so argument order cannot make the same call look like two
 * different ones, and the whole argument set is included: the agent should be
 * discouraged from repeating what it literally already did, not from ever
 * touching a coordinate again.
 */
export function attemptKey(action: string, args: Record<string, unknown>): string {
  const parts = Object.keys(args)
    .sort()
    .filter((k) => args[k] !== null && args[k] !== undefined)
    .map((k) => `${k}=${String(args[k])}`);
  return `${action}(${parts.join(',')})`;
}

export function createSetbacks(): Setbacks {
  const setbacks = new Map<string, Setback>();

  function prune(turn: number): void {
    for (const [key, setback] of setbacks) {
      if (turn - setback.turn > SETBACK_TTL_TURNS) setbacks.delete(key);
    }
    // Oldest first out: a Map preserves insertion order, and re-recording
    // deletes before setting, so the front of the map is the stalest entry.
    while (setbacks.size > MAX_SETBACKS) {
      const oldest = setbacks.keys().next().value;
      if (oldest === undefined) break;
      setbacks.delete(oldest);
    }
  }

  return {
    record(action, args, why, turn) {
      const key = attemptKey(action, args);
      const existing = setbacks.get(key);

      setbacks.delete(key);
      setbacks.set(key, {
        key,
        what: key,
        why,
        turn,
        count: (existing?.count ?? 0) + 1,
      });

      prune(turn);
    },

    succeeded(action, args) {
      // It worked this time, so it is no longer a reason not to try again.
      setbacks.delete(attemptKey(action, args));
    },

    all(turn) {
      prune(turn);
      return [...setbacks.values()];
    },

    active(action, args, turn) {
      const key = attemptKey(action, args);
      const setback = setbacks.get(key);
      if (setback === undefined) return null;
      if (turn - setback.turn > SETBACK_TTL_TURNS) return null;
      return setback;
    },
  };
}

/** Renders setbacks for the prompt, most-repeated first. */
export function describeSetbacks(setbacks: readonly Setback[]): string[] {
  if (setbacks.length === 0) return [];

  const lines = ['You have already tried these and they did not work:'];
  const sorted = [...setbacks].sort((a, b) => b.count - a.count || b.turn - a.turn);

  for (const setback of sorted) {
    const times = setback.count > 1 ? ` -- ${setback.count} times now` : '';
    lines.push(`  ${setback.what}: ${setback.why}${times}`);
  }

  lines.push(
    'Doing any of these again unchanged will fail the same way. Either change ' +
      'something concrete about it, or do something else.',
  );

  return lines;
}
