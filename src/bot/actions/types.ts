/**
 * The action contract (ADR-007) -- the sibling of ADR-005's observation contract.
 *
 * Every action the bot can take returns one of these. The shape is fixed now,
 * before there are many call sites, because it has three consumers and only the
 * first exists yet:
 *
 *   Stage 3  chat commands print it
 *   Stage 4  telemetry writes it to SQLite
 *   Stage 5  Claude reads it as a tool result and decides what to do next
 *
 * That third consumer is why failures are VALUES rather than exceptions. A model
 * that gets an exception sees nothing and its agent loop dies; a model that gets
 * `{ ok: false, error: { code: 'no_tool' } }` can go and find a pickaxe.
 */

/**
 * A union rather than an enum -- `enum` is not erasable syntax and Node's type
 * stripping cannot run it (ADR-004).
 *
 * These are deliberately coarse and closed. Stage 4 will aggregate them ("how
 * often do agents fail as unreachable?") and Stage 5 will branch on them, and
 * neither is possible with free-text messages. The human-readable specifics go
 * in `message`; the machine-readable category goes here.
 */
export type ActionErrorCode =
  /** The target block, item, entity or recipe does not exist nearby. */
  | 'not_found'
  /** A path could not be computed, or movement wedged partway (ADR-006). */
  | 'unreachable'
  /** The inventory lacks the items this action needs. */
  | 'insufficient_items'
  /** The block needs a tool the bot does not have, so mining would drop nothing. */
  | 'no_tool'
  /** Physically prevented: no space to place, container locked, target occupied. */
  | 'blocked'
  /** Exceeded its time budget. Always possible; never a bug on its own. */
  | 'timeout'
  /** Superseded by another action, or the bot stopped. */
  | 'interrupted'
  /** The caller asked for something malformed. */
  | 'invalid_argument'
  /** Genuinely unexpected. If this shows up often, it wants a specific code. */
  | 'failed';

export interface ActionError {
  code: ActionErrorCode;
  message: string;
}

/**
 * `detail` must be plain JSON: no Vec3, Block, Item or Entity. It goes to a
 * database column in Stage 4 and into a prompt in Stage 5, and a live object
 * reference breaks both. Same rule as observations (ADR-005).
 */
export interface ActionResult {
  ok: boolean;
  /** Stable snake_case identifier, e.g. 'mine_block'. */
  action: string;
  durationMs: number;
  detail: Record<string, unknown>;
  error?: ActionError;
}

export interface Position {
  x: number;
  y: number;
  z: number;
}

/** Two decimals, matching observations.ts, so telemetry reads consistently. */
export function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

export function toPosition(v: { x: number; y: number; z: number }): Position {
  return { x: round2(v.x), y: round2(v.y), z: round2(v.z) };
}
