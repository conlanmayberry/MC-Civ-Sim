/**
 * When the agent is allowed to stop waiting.
 *
 * This is a separate file because the policy is subtle and it was wrong in a
 * way nothing could see. The loop sleeps between decisions, and a `setTimeout`
 * can only be cancelled while it exists -- so a nudge raised *during* a cycle
 * had nothing to cancel and was silently dropped. The agent then slept the full
 * interval anyway. In telemetry that looked like an agent being told something
 * at 16:42:50 and answering at 16:43:11: twenty-one seconds of standing still,
 * for a reply it had already been asked for.
 *
 * So a wake request is state, not an event. It is remembered until a cycle
 * consumes it, and `wait` refuses to sleep while one is outstanding.
 */

export interface WakeRequest {
  reason: string;
  /**
   * Worth abandoning what the agent is part-way through.
   *
   * Being addressed by name is; chat that merely happened nearby is not. The
   * distinction matters because cutting a plan short has a cost, and paying it
   * for every passing remark would make an agent that never finishes anything.
   */
  urgent: boolean;
}

export interface Waker {
  /** Ask for a decision sooner than the interval. */
  nudge: (reason: string, urgent?: boolean) => void;
  /**
   * Consume the pending request and return its reason, or 'interval' when the
   * cycle is simply due. Clears the urgent flag: from here on, only news that
   * arrives *after* this point may cut the cycle short.
   */
  takeTrigger: () => string;
  /** A reason to abandon the rest of the current batch, if there is one. */
  interruption: () => string | null;
  /** Sleep, unless a wake request is already outstanding. */
  wait: (ms: number) => Promise<void>;
}

export function createWaker(): Waker {
  let pending: WakeRequest | null = null;
  let urgent: string | null = null;
  let cancelSleep: (() => void) | null = null;

  return {
    nudge(reason, isUrgent = false) {
      pending = { reason, urgent: isUrgent };
      if (isUrgent) urgent = reason;
      // Null unless currently sleeping -- which is exactly the case `wait`
      // covers by checking `pending` before it sets a timer.
      cancelSleep?.();
    },

    takeTrigger() {
      const reason = pending?.reason ?? 'interval';
      pending = null;
      urgent = null;
      return reason;
    },

    interruption: () => urgent,

    async wait(ms) {
      if (pending !== null) return;

      await new Promise<void>((resolve) => {
        const timer = setTimeout(() => {
          cancelSleep = null;
          resolve();
        }, ms);
        // Unref'd: a pending think must not hold the process open at shutdown.
        timer.unref();
        cancelSleep = () => {
          clearTimeout(timer);
          cancelSleep = null;
          resolve();
        };
      });
    },
  };
}
