/**
 * What an agent has heard.
 *
 * Added after discovering agents were deaf: chat woke them for a decision, but
 * the message content never reached the observation, so an agent could be
 * spoken to and have no idea what was said. The only channel that worked was
 * `agent tell`, which is an operator instruction rather than a conversation.
 *
 * PROXIMITY IS A HOOK, NOT DECORATION. Minecraft chat is global, so by default
 * every agent hears everything -- which directly contradicts the brief's
 * requirement that agents not have access to conversations they did not
 * participate in. Stage 9 wants to study rumour and misinformation, and that is
 * impossible if everyone hears everything perfectly. `radius` exists so hearing
 * can be restricted to what is plausible later, without rewriting this then.
 */

export interface HeardMessage {
  from: string;
  text: string;
  at: string;
  /** Metres to the speaker, or null when they could not be located. */
  distance: number | null;
  /** Addressed to this agent: by name, as part of "everyone", or by a person. */
  directed: boolean;
  /** Said by a person rather than by another agent. */
  fromOperator: boolean;
}

export interface HearingOptions {
  /** Beyond this many blocks, a message is not heard. Infinity = vanilla global chat. */
  radius?: number;
  /** How many recent messages to remember. */
  keep?: number;
  /**
   * Usernames belonging to other agents. Anyone else speaking is a person.
   *
   * A human in this world is the operator, not another participant, and their
   * messages always reach an agent -- otherwise a rule aimed at agents
   * chattering among themselves also silences the person running the
   * experiment.
   */
  agentNames?: Iterable<string>;
}

export interface Hearing {
  /** Record a message. Returns it if heard, or null if out of range. */
  hear: (from: string, text: string, distance: number | null) => HeardMessage | null;
  /** Recent messages, oldest first. */
  recent: () => HeardMessage[];
  /** Anything heard since the last call, clearing the marker. */
  takeNew: () => HeardMessage[];
  pendingCount: () => number;
}

const DEFAULT_KEEP = 8;

/**
 * Does this message name the agent?
 *
 * Word-boundary matched so "Alice" is directed but "malice" is not, and
 * case-insensitive because nobody types names carefully in chat.
 */
export function isDirectedAt(username: string, text: string): boolean {
  const escaped = username.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`\\b${escaped}\\b`, 'i').test(text);
}

/**
 * Words that address the whole group.
 *
 * "Everyone, come to me" names nobody, so once only directed messages woke an
 * agent, a message meant for all four woke none of them -- the operator was
 * talking to a room that had quietly stopped listening. Addressing everybody
 * has to count as addressing each of them.
 */
const COLLECTIVE =
  /\b(everyone|everybody|all of you|you all|y'?all|team|guys|folks|anyone|somebody|someone)\b/i;

export function isCollective(text: string): boolean {
  return COLLECTIVE.test(text);
}

export function createHearing(username: string, options: HearingOptions = {}): Hearing {
  const radius = options.radius ?? Number.POSITIVE_INFINITY;
  const keep = options.keep ?? DEFAULT_KEEP;
  const agentNames = new Set(options.agentNames ?? []);

  const heard: HeardMessage[] = [];
  let unreadFrom = 0;

  return {
    hear(from, text, distance) {
      const trimmed = text.trim();
      if (trimmed === '' || from === username) return null;

      // A null distance means the speaker could not be located -- console
      // messages, or a player outside entity-tracking range. Those are heard,
      // since refusing them would silently drop operator messages.
      if (distance !== null && distance > radius) return null;

      // Anyone who is not a known agent is a person. Unknown names default to
      // "person" on purpose: failing to hear the operator is a worse mistake
      // than occasionally treating an agent as one.
      const fromOperator = !agentNames.has(from);

      const message: HeardMessage = {
        from,
        text: trimmed,
        at: new Date().toISOString(),
        distance,
        // A person speaking is always addressing this agent -- they are the
        // operator, and there are only a few listeners. Between agents it
        // takes a name or an explicit "everyone".
        directed: fromOperator || isDirectedAt(username, trimmed) || isCollective(trimmed),
        fromOperator,
      };

      heard.push(message);
      if (heard.length > keep) {
        heard.shift();
        unreadFrom = Math.max(0, unreadFrom - 1);
      }

      return message;
    },

    recent: () => [...heard],

    takeNew() {
      const fresh = heard.slice(unreadFrom);
      unreadFrom = heard.length;
      return fresh;
    },

    pendingCount: () => heard.length - unreadFrom,
  };
}

/** Renders recent chat for the prompt. */
export function describeHearing(messages: HeardMessage[]): string[] {
  if (messages.length === 0) return [];

  const lines = ['Recent chat you heard:'];
  for (const message of messages) {
    const where = message.distance === null ? '' : ` (${message.distance}m away)`;
    const flag = message.fromOperator
      ? '  <-- a person said this to you'
      : message.directed
        ? '  <-- addressed to you'
        : '';
    lines.push(`  <${message.from}>${where} ${message.text}${flag}`);
  }
  return lines;
}
