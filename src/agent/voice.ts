/**
 * How much an agent is allowed to talk.
 *
 * Measured across one hour of four agents: 550 messages, 7.4 a minute between
 * them. Each agent spoke every 32 seconds and HEARD one every 8 -- and since
 * chat woke an agent for a decision, most of the run's thinking was agents
 * answering each other. Not talking too much for a person; far too much for a
 * group that also has to get anything done.
 *
 * A budget rather than a mute. Talking is how these agents coordinate at all,
 * and the Stage 9 questions about rumour and misinformation need them
 * speaking. What was missing was a cost: chat was free and instantaneous
 * while every physical act took seconds, so the cheapest way to look busy was
 * always to say something.
 *
 * The allowance is SHOWN to the agent every turn, not merely enforced. An
 * agent that is refused mid-plan learns nothing except that the world is
 * arbitrary; one that can see it has two messages left before the minute is
 * out can decide which two are worth sending.
 */

/** Messages allowed per agent, per window. */
export const CHAT_ALLOWANCE = 3;
/** The rolling window the allowance is counted over. */
export const CHAT_WINDOW_MS = 60_000;

export interface Voice {
  /** Consume one message. False when the allowance is spent. */
  trySpeak: (now?: number) => boolean;
  /** How many are left right now. */
  remaining: (now?: number) => number;
  /** Milliseconds until at least one more message is allowed. */
  waitMs: (now?: number) => number;
  /** A line for the prompt, or nothing when there is plenty left. */
  describe: (now?: number) => string[];
}

export function createVoice(
  allowance = CHAT_ALLOWANCE,
  windowMs = CHAT_WINDOW_MS,
): Voice {
  // Timestamps of messages still inside the window.
  let spoken: number[] = [];

  function prune(now: number): void {
    spoken = spoken.filter((at) => now - at < windowMs);
  }

  return {
    trySpeak(now = Date.now()) {
      prune(now);
      if (spoken.length >= allowance) return false;
      spoken.push(now);
      return true;
    },

    remaining(now = Date.now()) {
      prune(now);
      return Math.max(0, allowance - spoken.length);
    },

    waitMs(now = Date.now()) {
      prune(now);
      if (spoken.length < allowance) return 0;
      const oldest = spoken[0];
      if (oldest === undefined) return 0;
      return Math.max(0, windowMs - (now - oldest));
    },

    describe(now = Date.now()) {
      prune(now);
      const left = Math.max(0, allowance - spoken.length);

      if (left === 0) {
        const seconds = Math.ceil(
          Math.max(0, windowMs - (now - (spoken[0] ?? now))) / 1000,
        );
        return [
          `You have used all ${allowance} of your messages for this minute and ` +
            `cannot speak for another ${seconds}s. Do something instead; you can ` +
            'talk about it afterwards.',
        ];
      }

      // Silence when there is plenty left: a budget mentioned every turn
      // becomes something to spend rather than something to notice.
      if (left >= allowance) return [];

      return [
        `You have ${left} message${left === 1 ? '' : 's'} left this minute. ` +
          'Spend them on things the others cannot work out for themselves.',
      ];
    },
  };
}
