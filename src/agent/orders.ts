/**
 * A standing order from the operator.
 *
 * Everything else the operator can say is a nudge: `agent tell` drops one
 * message into the next decision and is then gone, and ordinary chat competes
 * with whatever else the agent had in mind. Neither survives the agent
 * deciding, two turns later, that its own goal is more interesting -- which is
 * exactly what "come to me and stay put" ran into.
 *
 * An order is different in one way that matters: it PERSISTS until it is
 * lifted. It sits at the top of every prompt, outranks the agent's own goal,
 * and stays there through interruptions, hunger and new ideas.
 *
 * THIS IS THE STRONGEST INTERVENTION IN THE SYSTEM, and it is recorded like
 * one. The brief is emphatic that a run where the operator silently steered
 * the agents is not a record of emergent behaviour: an order is written to
 * telemetry when given and when lifted, so any analysis can carve out the
 * period where the agents were not deciding for themselves.
 *
 * Survival is deliberately exempt. An agent that stands still while starving
 * because it was told to stay put is obeying the letter of an instruction the
 * operator did not mean, and the resulting death teaches nothing.
 */

export interface Order {
  text: string;
  from: string;
  at: string;
}

export interface Orders {
  /** Place a standing order, replacing any current one. */
  give: (text: string, from: string) => Order | null;
  /** Lift it. Returns the order that was lifted, or null if there was none. */
  release: () => Order | null;
  current: () => Order | null;
}

/** Long enough for a real instruction, short enough to stay readable. */
const MAX_ORDER_LENGTH = 300;

export function createOrders(): Orders {
  let order: Order | null = null;

  return {
    give(text, from) {
      const trimmed = text.trim().slice(0, MAX_ORDER_LENGTH);
      if (trimmed === '') return null;

      order = { text: trimmed, from, at: new Date().toISOString() };
      return order;
    },

    release() {
      const lifted = order;
      order = null;
      return lifted;
    },

    current: () => order,
  };
}

/**
 * Renders the standing order for the prompt.
 *
 * Deliberately blunt and deliberately first. This is the one place in the
 * system that overrides the agent's own judgement, so hedging it would defeat
 * the point -- an operator who says "stay put" and gets a considered opinion
 * about why moving is better has not been listened to.
 */
export function describeOrder(order: Order | null): string[] {
  if (order === null) return [];

  return [
    '*** STANDING ORDER ***',
    `${order.from} has told you: "${order.text}"`,
    'This came from a person and it overrides your own goal and plans. Do it, ' +
      'and keep doing it, until they tell you otherwise -- not until you think ' +
      'it is done, and not until something more interesting comes up. If it ' +
      'says to stay somewhere, stay there and call no movement tools.',
    'The one exception is staying alive: eat if you are starving and defend ' +
      'yourself if you are attacked. Say so in chat if the order is stopping ' +
      'you doing something that matters.',
    '',
  ];
}
