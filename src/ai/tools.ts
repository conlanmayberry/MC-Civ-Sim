/**
 * The model's tool surface: exactly the actions in src/bot/actions/index.ts,
 * and nothing else.
 *
 * This file IS the security boundary for principle 16 of the project brief.
 * There is no tool that runs code, reads a file, spawns a process or reaches
 * the host. Whatever the model decides, the worst it can do is play Minecraft
 * badly in a world we can delete. give_item included: it is a normal item
 * drop made real by physical proximity, not a wire transfer -- it can no more
 * reach outside the world than place_block can.
 *
 * That closed surface is also why player chat reaching an agent's observations
 * is safe to allow. Someone can try to talk an agent into something -- and
 * Stage 9 is explicitly about studying misinformation between agents, so that
 * is a subject of the experiment rather than a hole in it.
 *
 * STRICT MODE SHAPES THESE SCHEMAS. With `strict: true` the API requires
 * `additionalProperties: false` and *every* property listed in `required`. Our
 * actions have genuinely optional arguments (counts, radii), so those are
 * declared nullable -- `['integer','null']` -- rather than omitted from
 * `required`. Passing null then means "use the default", which the adapters
 * below translate.
 */

import type { Actions, ActionResult } from '../bot/actions/index.ts';
import type { ToolSchema } from './provider.ts';

/** Shorthand for a strict-mode object schema. */
function object(properties: Record<string, unknown>): Record<string, unknown> {
  return {
    type: 'object',
    properties,
    // Strict mode: all keys required, nothing extra. Optionality is expressed
    // in the types, not by leaving a key out of `required`.
    required: Object.keys(properties),
    additionalProperties: false,
  };
}

const int = (description: string): Record<string, unknown> => ({ type: 'integer', description });
const nullableInt = (description: string): Record<string, unknown> => ({
  type: ['integer', 'null'],
  description: `${description} Pass null for the default.`,
});
const str = (description: string): Record<string, unknown> => ({ type: 'string', description });
const nullableStr = (description: string): Record<string, unknown> => ({
  type: ['string', 'null'],
  description: `${description} Pass null for the default.`,
});

export const TOOL_SCHEMAS: readonly ToolSchema[] = [
  {
    name: 'move_to',
    description:
      'Walk to a coordinate. Fails with unreachable if no route exists or the ' +
      'path is blocked; that is normal in dense terrain, so try somewhere else ' +
      'rather than repeating the same destination.',
    parameters: object({
      x: int('Target X.'),
      y: int('Target Y.'),
      z: int('Target Z.'),
      range: nullableInt('How close to get, in blocks. Default 1.'),
    }),
  },
  {
    name: 'follow_player',
    description: 'Walk towards a named player until within range.',
    parameters: object({
      username: str('Exact player name.'),
      range: nullableInt('How close to get, in blocks. Default 3.'),
    }),
  },
  {
    name: 'stop_movement',
    description: 'Stop moving and clear the current navigation goal.',
    parameters: object({}),
  },
  {
    name: 'mine_block',
    description:
      'Find the nearest blocks of a type, walk to one and mine it, then pick up ' +
      'the drops. Fails with no_tool if mining it bare-handed would drop ' +
      'nothing -- get the right tool first.',
    parameters: object({
      block: str('Block name, e.g. spruce_log, stone, iron_ore.'),
      count: nullableInt('How many to mine. Default 1.'),
      searchRadius: nullableInt('How far to look, in blocks. Default 32.'),
    }),
  },
  {
    name: 'collect_items',
    description: 'Walk over nearby dropped items to pick them up.',
    parameters: object({
      radius: nullableInt('Search radius in blocks. Default 12.'),
    }),
  },
  {
    name: 'craft_item',
    description:
      'Craft a number of ITEMS (not repetitions of the recipe). Uses the 2x2 ' +
      'inventory grid when possible, otherwise finds and walks to a crafting ' +
      'table. Fails with insufficient_items if materials are missing.',
    parameters: object({
      item: str('Item name, e.g. stick, spruce_planks, crafting_table.'),
      count: nullableInt('How many items to end up with. Default 1.'),
    }),
  },
  {
    name: 'place_block',
    description:
      'Place a block from the inventory at a coordinate. The spot must be empty ' +
      'and have something solid adjacent to place against.',
    parameters: object({
      item: str('Item name to place, e.g. crafting_table.'),
      x: int('Target X.'),
      y: int('Target Y.'),
      z: int('Target Z.'),
    }),
  },
  {
    name: 'eat_food',
    description:
      'Eat the best available food. Fails with blocked if not hungry, or ' +
      'insufficient_items if carrying no food.',
    parameters: object({}),
  },
  {
    name: 'equip_item',
    description: 'Equip an item from the inventory.',
    parameters: object({
      item: str('Item name.'),
      destination: nullableStr("One of hand, head, torso, legs, feet, off-hand. Default hand."),
    }),
  },
  {
    name: 'give_item',
    description:
      'Hand an item to a named player by walking to them and dropping it. ' +
      'You must be standing close together for this to actually reach them -- ' +
      'it is a normal drop, not a throw, so promising to give something and ' +
      'then staying where you are does not work. It drops the item near them, ' +
      'not into their inventory directly -- it can scatter a little on landing, ' +
      'so they may still need collect_items on their end. Fails with not_found ' +
      'if you cannot see them right now.',
    parameters: object({
      item: str('Item name, e.g. bread, spruce_planks.'),
      count: int('How many to give.'),
      username: str('Exact name of the player or agent to give it to.'),
    }),
  },
  {
    name: 'set_goal',
    description:
      'State what you are working on. It is shown to you every turn and ' +
      'persists until you change it, so use it for anything spanning more than ' +
      'one turn. Change it when you genuinely change your mind, not because ' +
      'something interrupted you. Setting the goal you already have does ' +
      'nothing -- you do not need to repeat it.',
    parameters: object({
      goal: str('A short description, e.g. "build a shelter before nightfall".'),
    }),
  },
  {
    name: 'remember_place',
    description:
      'Write down where something is, by name -- your shelter, a cave mouth, ' +
      'a village, where you left a chest. Every place you have recorded is ' +
      'shown to you with its distance every turn. Without this you have no way ' +
      'to know where anything is once you have walked away from it. Recording ' +
      'a name you already used updates it -- but doing that with the same ' +
      'place again accomplishes nothing, since it is already what you know.',
    parameters: object({
      name: str('A short name you will recognise later, e.g. "shelter", "iron cave".'),
      note: nullableStr('Why it matters, in a few words.'),
      x: nullableInt('Leave null to record where you are standing.'),
      y: nullableInt('Leave null to record where you are standing.'),
      z: nullableInt('Leave null to record where you are standing.'),
    }),
  },
  {
    name: 'send_chat',
    description:
      'Say something in Minecraft chat. Other players and agents will see it. ' +
      'Use this to communicate, not to think out loud. You get only a few ' +
      'messages a minute, so say things the others could not work out for ' +
      'themselves -- announcing what you are about to do is usually not one.',
    parameters: object({
      message: str('What to say. Keep it under 200 characters.'),
    }),
  },
];

/** null means "not specified"; the action layer applies its own default. */
function optInt(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? Math.trunc(value) : fallback;
}

function reqInt(value: unknown, name: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new Error(`${name} must be a number`);
  }
  return Math.trunc(value);
}

function reqStr(value: unknown, name: string): string {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new Error(`${name} must be a non-empty string`);
  }
  return value.trim();
}

const EQUIP_DESTINATIONS = ['hand', 'head', 'torso', 'legs', 'feet', 'off-hand'] as const;
type EquipDestination = (typeof EQUIP_DESTINATIONS)[number];

/**
 * Dispatch a model-proposed tool call to the action layer.
 *
 * Exact-match on name, arguments validated before use. A call the model
 * invented, or arguments of the wrong shape, produce a normal failed
 * ActionResult -- which the model then sees and can correct. That is much more
 * useful to it than an exception, and it is the same contract every other
 * caller gets (ADR-007).
 */
export async function invokeTool(
  actions: Actions,
  sendChat: (message: string) => boolean | void,
  name: string,
  args: Record<string, unknown>,
  setGoal: (goal: string) => boolean | void = () => {},
  rememberPlace: (
    name: string,
    note: string,
    at: { x: number; y: number; z: number } | null,
  ) => ActionResult = (name) => ({
    ok: false,
    action: 'remember_place',
    durationMs: 0,
    detail: { name },
    error: { code: 'failed', message: 'this agent cannot remember places' },
  }),
): Promise<ActionResult> {
  const fail = (message: string): ActionResult => ({
    ok: false,
    action: name,
    durationMs: 0,
    detail: {},
    error: { code: 'invalid_argument', message },
  });

  try {
    switch (name) {
      case 'move_to':
        return await actions.moveTo(
          reqInt(args['x'], 'x'),
          reqInt(args['y'], 'y'),
          reqInt(args['z'], 'z'),
          optInt(args['range'], 1),
        );

      case 'follow_player':
        return await actions.followPlayer(
          reqStr(args['username'], 'username'),
          optInt(args['range'], 3),
        );

      case 'stop_movement':
        return actions.stop();

      case 'mine_block':
        return await actions.mineBlock(
          reqStr(args['block'], 'block'),
          optInt(args['count'], 1),
          optInt(args['searchRadius'], 32),
        );

      case 'collect_items':
        return await actions.collectNearbyItems(optInt(args['radius'], 12));

      case 'craft_item':
        return await actions.craftItem(reqStr(args['item'], 'item'), optInt(args['count'], 1));

      case 'place_block':
        return await actions.placeBlock(
          reqStr(args['item'], 'item'),
          reqInt(args['x'], 'x'),
          reqInt(args['y'], 'y'),
          reqInt(args['z'], 'z'),
        );

      case 'eat_food':
        return await actions.eatFood();

      case 'equip_item': {
        const raw = args['destination'];
        const destination: EquipDestination =
          typeof raw === 'string' && (EQUIP_DESTINATIONS as readonly string[]).includes(raw)
            ? (raw as EquipDestination)
            : 'hand';
        return await actions.equipItem(reqStr(args['item'], 'item'), destination);
      }

      case 'give_item':
        return await actions.giveItem(
          reqStr(args['item'], 'item'),
          reqInt(args['count'], 'count'),
          reqStr(args['username'], 'username'),
        );

      case 'set_goal': {
        const goal = reqStr(args['goal'], 'goal').slice(0, 200);
        const changed = setGoal(goal) !== false;
        return {
          ok: true,
          action: 'set_goal',
          durationMs: 0,
          detail: changed
            ? { goal }
            : {
                goal,
                // Not a failure -- nothing went wrong -- but the model spent a
                // whole turn restating a goal it already had, six times in one
                // run. It cannot tell that from a successful change unless the
                // result says so.
                unchanged: true,
                note: 'that was already your goal, so this turn did nothing; it is shown to you every turn without being set',
              },
        };
      }

      case 'remember_place': {
        const name = reqStr(args['name'], 'name');
        const note = typeof args['note'] === 'string' ? args['note'].slice(0, 80) : '';
        // All three coordinates or none. Two out of three is a mistake, and
        // filling the third from the agent's own position would record a place
        // that is neither where it meant nor where it stands.
        const given = ['x', 'y', 'z'].filter(
          (k) => typeof args[k] === 'number' && Number.isFinite(args[k]),
        );
        if (given.length !== 0 && given.length !== 3) {
          return fail('give all three of x, y and z, or none of them to use where you are');
        }

        return rememberPlace(
          name,
          note,
          given.length === 3
            ? {
                x: reqInt(args['x'], 'x'),
                y: reqInt(args['y'], 'y'),
                z: reqInt(args['z'], 'z'),
              }
            : null,
        );
      }

      case 'send_chat': {
        const message = reqStr(args['message'], 'message');
        // A refusal is a normal failed result, not an exception: the model
        // sees it, and seeing "you are out of messages" is what teaches it to
        // spend the next one on something worth saying.
        if (sendChat(message) === false) {
          return {
            ok: false,
            action: 'send_chat',
            durationMs: 0,
            detail: { message },
            error: {
              code: 'blocked',
              message:
                'you have used your messages for this minute -- say nothing for now and act instead',
            },
          };
        }
        return { ok: true, action: 'send_chat', durationMs: 0, detail: { message } };
      }

      default:
        // The model named a tool that does not exist. Tell it so, rather than
        // throwing -- it can pick a real one next cycle.
        return fail(`no such tool: ${name}`);
    }
  } catch (err) {
    return fail(err instanceof Error ? err.message : String(err));
  }
}
