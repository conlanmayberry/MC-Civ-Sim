/**
 * Thought injection: the operator's channel into a running agent.
 *
 * Every injection is recorded to telemetry as an intervention, and that is a
 * scientific requirement rather than bookkeeping. An experiment where the
 * operator quietly steered the agents is not a record of emergent behaviour, so
 * the log has to show exactly where a human reached in and what they said.
 * Analysis can then exclude, or specifically study, the steered intervals.
 *
 * Bounded on purpose: an unbounded queue would let a burst of injections
 * dominate a later prompt long after they stopped being relevant.
 */

export interface Injection {
  text: string;
  from: string;
  at: string;
}

export interface Inbox {
  /** Queue an operator instruction for the next decision. */
  inject: (text: string, from: string) => Injection | null;
  /** Take everything pending, clearing the queue. */
  drain: () => Injection[];
  pending: () => number;
  /** Read without clearing, for the dashboard. */
  peek: () => readonly Injection[];
}

const MAX_PENDING = 8;
const MAX_LENGTH = 500;

export function createInbox(): Inbox {
  const queue: Injection[] = [];

  return {
    inject(text, from) {
      const trimmed = text.trim().slice(0, MAX_LENGTH);
      if (trimmed === '') return null;

      const injection: Injection = { text: trimmed, from, at: new Date().toISOString() };
      queue.push(injection);

      // Drop the oldest rather than the newest: a stale instruction is worth
      // less than the one just given.
      while (queue.length > MAX_PENDING) queue.shift();

      return injection;
    },

    drain() {
      return queue.splice(0, queue.length);
    },

    pending: () => queue.length,
    peek: () => [...queue],
  };
}
