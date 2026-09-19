/**
 * The scenarios: small, repeatable situations with a clear pass or fail.
 *
 * Each one exists because the thing it tests has actually gone wrong in a real
 * session, and the comment on each says when. That is the bar for adding one:
 * a scenario that guards against something that has never happened is a cost
 * with no evidence behind it.
 *
 * TWO KINDS.
 *
 * Action scenarios drive the action layer directly -- no model, no money, and
 * as deterministic as a Minecraft server allows. They answer "does the body
 * work": can it hand something over, get round a wall, keep up with a moving
 * target. These catch execution bugs, which replay by design cannot.
 *
 * Live scenarios run the whole agent loop against a real model, and only with
 * --live. They answer "does the agent do the obvious thing": come when called,
 * feed someone starving. A few cents each, and not deterministic -- a model
 * can fail a sensible scenario on a bad draw -- so read one failure as a
 * prompt to look, and repeated failures as a finding.
 */

import type { Bot } from 'mineflayer';
import { Vec3 } from 'vec3';

import { createAgent } from '../agent/agent.ts';
import type { Agent } from '../agent/agent.ts';
import type { AgentIdentity } from '../agent/identity.ts';
import { createHearing } from '../agent/hearing.ts';
import { createInbox } from '../agent/inbox.ts';
import { createOrders } from '../agent/orders.ts';
import { createPlaces } from '../agent/places.ts';
import { createBudget, DEFAULT_LIMITS } from '../ai/budget.ts';
import type { AiProvider } from '../ai/provider.ts';
import { observeEntities } from '../bot/observations.ts';
import { createLogger } from '../util/log.ts';
import type { Arena, Point, ScenarioBot } from './arena.ts';
import { ARENA, at } from './arena.ts';

export type Verdict = 'pass' | 'fail' | 'skip';

export interface Outcome {
  verdict: Verdict;
  detail: string;
}

export interface ScenarioContext {
  arena: Arena;
  /** Only present for live scenarios. */
  provider: AiProvider | null;
}

export interface Scenario {
  id: string;
  title: string;
  /** Needs a real model and costs money; only runs with --live. */
  live: boolean;
  timeoutMs: number;
  run: (ctx: ScenarioContext) => Promise<Outcome>;
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

const pass = (detail: string): Outcome => ({ verdict: 'pass', detail });
const fail = (detail: string): Outcome => ({ verdict: 'fail', detail });

export function countItem(bot: Bot, name: string): number {
  return bot.inventory
    .items()
    .filter((i) => i.name === name)
    .reduce((sum, i) => sum + i.count, 0);
}

async function until(check: () => boolean, timeoutMs: number, stepMs = 250): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (check()) return true;
    await sleep(stepMs);
  }
  return check();
}

function distance(bot: Bot, p: Point): number {
  const here = bot.entity.position;
  return Math.hypot(here.x - (p.x + 0.5), here.z - (p.z + 0.5));
}

function describeFailure(result: { ok: boolean; error?: { code: string; message: string } }): string {
  return result.ok ? 'ok' : `[${result.error?.code}] ${result.error?.message}`;
}

// --- action scenarios -------------------------------------------------------------

/**
 * Handing something over, standing side by side.
 *
 * 12 of 37 agent-to-agent handovers in one session were never picked up. This
 * is the mechanical floor under that: if it fails with both parties adjacent
 * and cooperative, no amount of prompting fixes the agents.
 */
const handoverAdjacent: Scenario = {
  id: 'handover_adjacent',
  title: 'give_item then collect_items, standing together',
  live: false,
  timeoutMs: 60_000,
  async run({ arena }) {
    const a = await arena.spawn('ScenAlpha', at(-2, 0));
    const b = await arena.spawn('ScenBravo', at(2, 0));
    await arena.give(a.name, 'bread', 3);

    const give = await a.actions.giveItem('bread', 3, b.name);
    if (!give.ok) return fail(`give_item: ${describeFailure(give)}`);

    const collect = await b.actions.collectNearbyItems(8);
    await until(() => countItem(b.bot, 'bread') >= 3, 3_000);

    const got = countItem(b.bot, 'bread');
    return got >= 3
      ? pass(`Bravo received all 3 bread (collect: ${describeFailure(collect)})`)
      : fail(`Bravo ended with ${got}/3 bread; collect_items said ${describeFailure(collect)}`);
  },
};

/**
 * Handing something over from across the arena.
 *
 * give_item used to refuse arrivals at 2.6m, 4.2m, 5.1m and 6.3m because the
 * pathfinder does not stop on a precise spot. The giver has to walk here.
 */
const handoverWalks: Scenario = {
  id: 'handover_walks',
  title: 'give_item walks 14 blocks to the recipient first',
  live: false,
  timeoutMs: 90_000,
  async run({ arena }) {
    const a = await arena.spawn('ScenAlpha', at(-8, -8));
    const b = await arena.spawn('ScenBravo', at(4, 4));
    await arena.give(a.name, 'bread', 2);

    const give = await a.actions.giveItem('bread', 2, b.name);
    if (!give.ok) return fail(`give_item: ${describeFailure(give)}`);

    await b.actions.collectNearbyItems(10);
    await until(() => countItem(b.bot, 'bread') >= 2, 3_000);
    const got = countItem(b.bot, 'bread');
    return got >= 2 ? pass(`delivered across the arena`) : fail(`Bravo ended with ${got}/2 bread`);
  },
};

/**
 * A dropped stack is named in the recipient's observation.
 *
 * Recipients used to see a dropped stack as the bare word "Item", which is
 * most of why handovers went uncollected. Verified by unit test against fake
 * entities; this is the check that it holds against a real server's metadata.
 */
const dropIsNamed: Scenario = {
  id: 'drop_is_named',
  title: 'a dropped stack appears by name in the observation',
  live: false,
  timeoutMs: 30_000,
  async run({ arena }) {
    const a = await arena.spawn('ScenAlpha', at(-1, 0));
    const b = await arena.spawn('ScenBravo', at(2, 0));
    await arena.give(a.name, 'bread', 2);

    const bread = a.bot.inventory.items().find((i) => i.name === 'bread');
    if (bread === undefined) return fail('setup: Alpha never received bread');
    await a.bot.toss(bread.type, null, 2);

    const seen = await until(
      () => observeEntities(b.bot, 16, 8).entities.some((e) => e.drop?.name === 'bread'),
      5_000,
    );
    if (seen) return pass('Bravo sees "2x bread (on the ground)", not "Item"');

    const names = observeEntities(b.bot, 16, 8).entities.map((e) => e.name);
    return fail(`the drop was not named; Bravo saw: ${names.join(', ') || 'nothing'}`);
  },
};

/**
 * Walking around an obstacle rather than into it.
 *
 * move_to was 54% in the last session, and "timeout after 1 attempt(s)" at
 * 6-16m short was its most common failure. A wall with a gap at one end is the
 * smallest version of "the straight line does not work".
 */
const moveAroundWall: Scenario = {
  id: 'move_around_wall',
  title: 'move_to finds the gap in a wall',
  live: false,
  timeoutMs: 90_000,
  async run({ arena }) {
    await arena.fill(at(0, -18), at(0, 12, 2), 'stone');
    const a = await arena.spawn('ScenAlpha', at(-8, 0));
    const target = at(8, 0);

    const move = await a.actions.moveTo(target.x, target.y, target.z, 1);
    const left = distance(a.bot, target);
    return move.ok && left <= 2
      ? pass(`arrived ${left.toFixed(1)}m from the target in ${(move.durationMs / 1000).toFixed(1)}s`)
      : fail(`${describeFailure(move)}; ended ${left.toFixed(1)}m away`);
  },
};

/** Climbing onto raised ground: the smallest terrain a real map is full of. */
const moveStepUp: Scenario = {
  id: 'move_step_up',
  title: 'move_to climbs a one-block step',
  live: false,
  timeoutMs: 60_000,
  async run({ arena }) {
    await arena.fill(at(6, -2), at(10, 2), 'stone');
    const a = await arena.spawn('ScenAlpha', at(-6, 0));
    const target = at(8, 0, 1);

    const move = await a.actions.moveTo(target.x, target.y, target.z, 1);
    const onTop = a.bot.entity.position.y >= ARENA.y + 2 - 0.1;
    return move.ok && onTop
      ? pass('climbed the step and arrived')
      : fail(`${describeFailure(move)}; y=${a.bot.entity.position.y.toFixed(1)}`);
  },
};

/**
 * Following someone who is walking away.
 *
 * follow_player was the worst action in the system at 37.5%, and it never used
 * the retry logic at all until it was rewritten. A moving target is the case
 * that needs recovery most.
 */
const followMoving: Scenario = {
  id: 'follow_moving_target',
  title: 'follow_player keeps up with someone walking away',
  live: false,
  timeoutMs: 90_000,
  async run({ arena }) {
    const a = await arena.spawn('ScenAlpha', at(-14, -14));
    const b = await arena.spawn('ScenBravo', at(-8, -8));
    const destination = at(14, 14);

    const walking = b.actions.moveTo(destination.x, destination.y, destination.z, 1);
    const follow = await a.actions.followPlayer(b.name, 3);
    await walking;

    return follow.ok
      ? pass(`caught up (${JSON.stringify(follow.detail)})`)
      : fail(describeFailure(follow));
  },
};

/**
 * Building a small wall, including blocks it has to reach for.
 *
 * place_block has been the least reliable action for most of this project. Ten
 * blocks in two rows is a structure's worth of placements in one go.
 */
const placeWall: Scenario = {
  id: 'place_wall',
  title: 'place_block builds a 5x2 wall',
  live: false,
  timeoutMs: 120_000,
  async run({ arena }) {
    const a = await arena.spawn('ScenAlpha', at(0, 0));
    await arena.give(a.name, 'cobblestone', 10);

    const spots: Point[] = [];
    for (const dy of [0, 1]) for (let dx = -2; dx <= 2; dx++) spots.push(at(dx, 3, dy));

    const failures: string[] = [];
    for (const spot of spots) {
      const placed = await a.actions.placeBlock('cobblestone', spot.x, spot.y, spot.z);
      if (!placed.ok) failures.push(`${spot.x - ARENA.x},${spot.y - ARENA.y},${spot.z - ARENA.z}: ${describeFailure(placed)}`);
    }

    // The world decides, not the action's own report -- the same rule every
    // action in this project follows.
    const standing = spots.filter((s) => a.bot.blockAt(new Vec3(s.x, s.y, s.z))?.name === 'cobblestone');
    return failures.length === 0 && standing.length === spots.length
      ? pass('all 10 blocks placed and standing')
      : fail(`${standing.length}/10 standing; ${failures.length} placement(s) failed${failures[0] === undefined ? '' : `, first: ${failures[0]}`}`);
  },
};

/**
 * Trying to build over a sapling.
 *
 * One placement was refused 110 times across seven runs against a sapling,
 * because the refusal read as a glitch. It must now fail FAST and SAY WHY.
 */
const placeOverSapling: Scenario = {
  id: 'place_over_sapling',
  title: 'place_block over a sapling fails with an actionable reason',
  live: false,
  timeoutMs: 45_000,
  async run({ arena }) {
    const spot = at(3, 0);
    await arena.setBlock({ ...spot, y: spot.y - 1 }, 'dirt');
    await arena.setBlock(spot, 'oak_sapling');
    const a = await arena.spawn('ScenAlpha', at(0, 0));
    await arena.give(a.name, 'dirt', 1);

    const placed = await a.actions.placeBlock('dirt', spot.x, spot.y, spot.z);
    if (placed.ok) return fail('the placement succeeded over a sapling -- the server allowed it');
    return placed.error?.code === 'blocked' && /mine/i.test(placed.error.message)
      ? pass(`refused with: ${placed.error.message.slice(0, 70)}`)
      : fail(`refused, but unhelpfully: ${describeFailure(placed)}`);
  },
};

/** Mining a small column of logs and ending up holding them. */
const mineLogs: Scenario = {
  id: 'mine_logs',
  title: 'mine_block mines and collects 3 logs',
  live: false,
  timeoutMs: 90_000,
  async run({ arena }) {
    for (const dy of [0, 1, 2]) await arena.setBlock(at(4, 0, dy), 'oak_log');
    const a = await arena.spawn('ScenAlpha', at(0, 0));

    const mined = await a.actions.mineBlock('oak_log', 3, 16);
    await until(() => countItem(a.bot, 'oak_log') >= 3, 3_000);
    const got = countItem(a.bot, 'oak_log');
    return got >= 3 ? pass(`holding ${got} oak_log`) : fail(`holding ${got}/3; mine_block said ${describeFailure(mined)}`);
  },
};

/**
 * From logs to a pickaxe: planks, sticks, a table placed, then the pickaxe.
 *
 * Crafting has lost materials before (a failed craft stranded items in the
 * grid) and reported real work as failure. The chain exercises both the 2x2
 * inventory grid and walking to a placed table.
 */
const craftChain: Scenario = {
  id: 'craft_to_pickaxe',
  title: 'craft planks, sticks and a table, place it, craft a pickaxe',
  live: false,
  timeoutMs: 120_000,
  async run({ arena }) {
    const a = await arena.spawn('ScenAlpha', at(0, 0));
    await arena.give(a.name, 'oak_log', 3);

    const steps: Array<[string, () => ReturnType<ScenarioBot['actions']['craftItem']>]> = [
      ['oak_planks x12', () => a.actions.craftItem('oak_planks', 12)],
      ['stick x4', () => a.actions.craftItem('stick', 4)],
      ['crafting_table', () => a.actions.craftItem('crafting_table', 1)],
    ];
    for (const [label, step] of steps) {
      const result = await step();
      if (!result.ok) return fail(`${label}: ${describeFailure(result)}`);
    }

    const table = at(2, 0);
    const placed = await a.actions.placeBlock('crafting_table', table.x, table.y, table.z);
    if (!placed.ok) return fail(`placing the table: ${describeFailure(placed)}`);

    const pickaxe = await a.actions.craftItem('wooden_pickaxe', 1);
    return countItem(a.bot, 'wooden_pickaxe') >= 1
      ? pass('crafted a wooden pickaxe from three logs')
      : fail(`wooden_pickaxe: ${describeFailure(pickaxe)}`);
  },
};

/**
 * Eating when hungry.
 *
 * mineflayer's consume() gives up after 2.5s regardless of any timeout passed
 * in, and did so on roughly half of all genuine eat attempts until eat_food
 * learned to retry.
 */
const eatWhenHungry: Scenario = {
  id: 'eat_restores_food',
  title: 'eat_food restores hunger',
  live: false,
  timeoutMs: 60_000,
  async run({ arena }) {
    const a = await arena.spawn('ScenAlpha', at(0, 0));
    await arena.run(`effect give ${a.name} minecraft:hunger 30 80 true`);
    const hungry = await until(() => a.bot.food <= 15, 25_000, 500);
    await arena.run(`effect clear ${a.name}`);
    if (!hungry) return { verdict: 'skip', detail: `could not make the bot hungry (food ${a.bot.food})` };

    await arena.give(a.name, 'bread', 2);
    const before = a.bot.food;
    const ate = await a.actions.eatFood();
    await until(() => a.bot.food > before, 2_000);
    return a.bot.food > before
      ? pass(`food ${before} -> ${a.bot.food}`)
      : fail(`food stayed at ${a.bot.food}; eat_food said ${describeFailure(ate)}`);
  },
};

/**
 * Surfacing before drowning, while busy.
 *
 * 28 of 33 deaths in the 2026-09-16 session were drownings. The bot starts at
 * the bottom of a six-deep pool with nothing telling it to come up.
 */
const surfaceForAir: Scenario = {
  id: 'surface_for_air',
  title: 'a bot underwater swims up before it drowns',
  live: false,
  timeoutMs: 90_000,
  async run({ arena }) {
    await arena.fill(at(-3, -3), at(3, 3, 6), 'glass');
    await arena.fill(at(-2, -2), at(2, 2, 5), 'water');
    await arena.fill(at(-2, -2, 6), at(2, 2, 6), 'air'); // fill makes a solid box: open the lid
    const a = await arena.spawn('ScenAlpha', at(0, 0));

    const reflexes: string[] = [];
    a.actions.onReflex((what) => reflexes.push(what));
    let died = false;
    a.bot.once('death', () => {
      died = true;
    });

    // Busy and standing still on the bottom: smelting at a furnace on the
    // pool floor. An idle bot treads water by itself, and a moving one may or
    // may not go under depending on its path, so neither reliably tests the
    // case the reflex exists for -- an action holding the bot down.
    await arena.setBlock(at(1, 0), 'furnace');
    await arena.give(a.name, 'beef', 8);
    await arena.give(a.name, 'coal', 1);
    const busy = a.actions.smeltItem('beef', 8);
    // Unaided, a bot at the bottom drowns in about 25s; give it longer.
    // Sampling starts after a moment: mineflayer reports 0 air until the
    // server first sends the real value, which is not the bot drowning.
    let lowest = 20;
    let lowestHealth = a.bot.health;
    const sampleFrom = Date.now() + 1_500;
    const watch = setInterval(() => {
      if (Date.now() < sampleFrom) return;
      lowest = Math.min(lowest, a.bot.oxygenLevel);
      lowestHealth = Math.min(lowestHealth, a.bot.health);
    }, 250);
    await until(() => died, 35_000, 250);
    clearInterval(watch);
    const move = await busy;

    if (died) return fail(`drowned (reflexes: ${reflexes.length}, move: ${describeFailure(move)})`);
    if (reflexes.some((r) => r.includes('could not reach air'))) return fail(`reflex gave up: ${reflexes.join(' / ')}`);
    // Air at zero is drowning. Health alone would mislead: a bump against the
    // pool wall on arrival cost a point once, with air never below 16.
    if (lowest <= 0) return fail(`ran out of air (health fell to ${lowestHealth})`);
    // Either the reflex pulled it up mid-move, or, once idle, it kept itself
    // afloat before air ran low. Both are the point: it did not drown.
    if (reflexes.length === 0) return fail(`the reflex never fired; smelt_item ended ${describeFailure(move)}`);
    return pass(`alive, air never below ${lowest}/20; reflex fired and smelt_item ended ${describeFailure(move)}`);
  },
};

/** Hunting: the only reliable food there is, and absent until 2026-09-16. */
const huntCow: Scenario = {
  id: 'hunt_cow',
  title: 'attack_entity kills a cow and its meat can be collected',
  live: false,
  timeoutMs: 60_000,
  async run({ arena }) {
    const a = await arena.spawn('ScenAlpha', at(-4, 0));
    const refused = await a.actions.attackEntity('ScenAlpha');
    if (refused.ok || refused.error?.code !== 'invalid_argument') {
      return fail(`attacking a player was not refused: ${describeFailure(refused)}`);
    }

    const cow = at(5, 0);
    await arena.run(`summon minecraft:cow ${cow.x} ${cow.y} ${cow.z}`);
    await sleep(1_000);

    const attack = await a.actions.attackEntity('cow');
    if (!attack.ok) return fail(`attack_entity: ${describeFailure(attack)}`);
    await sleep(1_000);
    await a.actions.collectNearbyItems(10);
    await until(() => countItem(a.bot, 'beef') > 0, 3_000);
    const beef = countItem(a.bot, 'beef');
    return beef > 0
      ? pass(`killed in ${String(attack.detail['hits'])} hit(s), collected ${beef} beef`)
      : fail(`killed the cow but collected no beef`);
  },
};

/** Cooking: raw beef restores 3 hunger, cooked 8. */
const smeltBeef: Scenario = {
  id: 'smelt_beef',
  title: 'smelt_item places a carried furnace and cooks beef',
  live: false,
  timeoutMs: 90_000,
  async run({ arena }) {
    const a = await arena.spawn('ScenAlpha', at(0, 0));
    await arena.give(a.name, 'beef', 3);
    await arena.give(a.name, 'coal', 1);
    await arena.give(a.name, 'furnace', 1);

    const smelt = await a.actions.smeltItem('beef', 3);
    const cooked = countItem(a.bot, 'cooked_beef');
    return cooked === 3
      ? pass(`3 cooked_beef in ${(smelt.durationMs / 1000).toFixed(1)}s`)
      : fail(`holding ${cooked}/3 cooked_beef; smelt_item said ${describeFailure(smelt)} ${JSON.stringify(smelt.detail)}`);
  },
};

/** A handover that does not need both people there at once. */
const chestRoundTrip: Scenario = {
  id: 'chest_round_trip',
  title: 'store_items and take_items move bread through a chest',
  live: false,
  timeoutMs: 60_000,
  async run({ arena }) {
    await arena.setBlock(at(4, 0), 'chest');
    const a = await arena.spawn('ScenAlpha', at(-4, 0));
    await arena.give(a.name, 'bread', 5);

    const store = await a.actions.storeItems('bread', null);
    if (!store.ok) return fail(`store_items: ${describeFailure(store)}`);
    if (countItem(a.bot, 'bread') !== 0) return fail(`still holding ${countItem(a.bot, 'bread')} bread after storing all`);

    const look = await a.actions.takeItems(null, null);
    const take = await a.actions.takeItems('bread', 2);
    const held = countItem(a.bot, 'bread');
    return take.ok && held === 2
      ? pass(`stored 5, looked (${String(look.detail['contents'])}), took back 2`)
      : fail(`holding ${held}/2 bread; take_items said ${describeFailure(take)}`);
  },
};

/** Placing into your own space: it used to refuse and cost a whole turn. */
const placeStepsAside: Scenario = {
  id: 'place_steps_aside',
  title: 'place_block steps aside to place where the bot is standing',
  live: false,
  timeoutMs: 45_000,
  async run({ arena }) {
    const spot = at(0, 0);
    const a = await arena.spawn('ScenAlpha', spot);
    await arena.give(a.name, 'cobblestone', 1);

    const place = await a.actions.placeBlock('cobblestone', spot.x, spot.y, spot.z);
    const block = a.bot.blockAt(new Vec3(spot.x, spot.y, spot.z));
    return place.ok && block?.name === 'cobblestone'
      ? pass('stepped aside and placed it')
      : fail(`place_block said ${describeFailure(place)}; the spot holds ${block?.name ?? 'nothing loaded'}`);
  },
};

/** Re-placing what is already there is not a failure; placing into the ground says where the air is. */
const placeOccupied: Scenario = {
  id: 'place_occupied',
  title: 'place_block: same block already there is ok; a different one points at the air above',
  live: false,
  timeoutMs: 30_000,
  async run({ arena }) {
    const spot = at(3, 0);
    await arena.setBlock(spot, 'cobblestone');
    const a = await arena.spawn('ScenAlpha', at(0, 0));
    await arena.give(a.name, 'cobblestone', 1);
    await arena.give(a.name, 'dirt', 1);

    const same = await a.actions.placeBlock('cobblestone', spot.x, spot.y, spot.z);
    if (!same.ok || same.detail['alreadyThere'] !== true) return fail(`same block: ${describeFailure(same)}`);
    if (countItem(a.bot, 'cobblestone') !== 1) return fail('a cobblestone was used up placing nothing');

    const other = await a.actions.placeBlock('dirt', spot.x, spot.y, spot.z);
    const hinted = !other.ok && other.error?.message.includes(`${spot.x},${spot.y + 1},${spot.z}`) === true;
    return hinted
      ? pass('already-there was ok and free; the occupied spot named the air above it')
      : fail(`different block: ${describeFailure(other)}`);
  },
};

/** "no wheat" used to be all it said, 46 times in one session, with cows in sight. */
const notFoundSuggests: Scenario = {
  id: 'not_found_suggests',
  title: 'mine_block not_found for a crop names huntable animals nearby',
  live: false,
  timeoutMs: 30_000,
  async run({ arena }) {
    const a = await arena.spawn('ScenAlpha', at(0, 0));
    const cow = at(6, 0);
    await arena.run(`summon minecraft:cow ${cow.x} ${cow.y} ${cow.z}`);
    await sleep(1_000);

    const mine = await a.actions.mineBlock('wheat', 1, 16);
    return !mine.ok && mine.error?.code === 'not_found' && mine.error.message.includes('cow')
      ? pass(mine.error.message)
      : fail(`mine_block said ${describeFailure(mine)}`);
  },
};

// --- live scenarios ----------------------------------------------------------------

interface LiveAgent {
  agent: Agent;
  bot: ScenarioBot;
  done: Promise<void>;
}

/**
 * Run real agents in the arena, with chat routed privately between them.
 *
 * Privately, because chat is global: a scenario agent's name is not in
 * config/agents/, so anything it said in the shared world would reach the real
 * agents as a person, with the authority to give them standing orders.
 */
async function startAgents(
  arena: Arena,
  provider: AiProvider,
  specs: Array<{ username: string; where: Point; role?: string }>,
): Promise<LiveAgent[]> {
  const names = specs.map((s) => s.username);
  const live: LiveAgent[] = [];

  for (const spec of specs) {
    const bot = await arena.spawn(spec.username, spec.where);
    const identity: AgentIdentity = {
      id: spec.username.toLowerCase(),
      username: spec.username,
      description: 'You are taking part in a short test in a small walled arena.',
      traits: ['cooperative'],
      interests: [],
      values: [],
      role: spec.role ?? null,
      model: null,
    };

    const agent: Agent = createAgent({
      identity,
      provider,
      budget: createBudget({ ...DEFAULT_LIMITS, maxUsd: 0.15, maxDurationMs: 5 * 60_000 }),
      inbox: createInbox(),
      hearing: createHearing(spec.username, { agentNames: names }),
      places: createPlaces(identity.id),
      orders: createOrders(),
      log: createLogger(identity.id, () => {}),
      intervalMs: 6_000,
      say: (message) => {
        for (const other of live) {
          if (other.bot.name === spec.username) continue;
          const d = other.bot.bot.entity.position.distanceTo(bot.bot.entity.position);
          other.agent.hear(spec.username, message, Math.round(d));
        }
      },
    });

    live.push({ agent, bot, done: agent.run(bot.bot, bot.actions) });
  }

  return live;
}

async function stopAgents(live: readonly LiveAgent[]): Promise<void> {
  for (const l of live) l.agent.stop('scenario finished');
  await Promise.race([Promise.all(live.map((l) => l.done)), sleep(20_000)]);
}

/**
 * "Everyone, come to me."
 *
 * Reached nobody at one point: making only directed messages wake an agent
 * fixed a chat storm and silently broke addressing the group, because
 * "Everyone" names no one.
 */
const agentsAnswerGroupCall: Scenario = {
  id: 'agents_answer_group_call',
  title: 'two agents come when a person says "everyone, come to me"',
  live: true,
  timeoutMs: 150_000,
  async run({ arena, provider }) {
    if (provider === null) return { verdict: 'skip', detail: 'needs --live' };

    const operator = await arena.spawn('ScenOperator', at(12, 12));
    const live = await startAgents(arena, provider, [
      { username: 'ScenAgentA', where: at(-12, -12) },
      { username: 'ScenAgentB', where: at(-12, 10) },
    ]);

    try {
      await sleep(3_000);
      for (const l of live) {
        const d = l.bot.bot.entity.position.distanceTo(operator.bot.entity.position);
        l.agent.hear('ScenOperator', 'Everyone, come to me and stay here.', Math.round(d));
      }

      const arrived = await until(
        () => live.every((l) => l.bot.bot.entity.position.distanceTo(operator.bot.entity.position) <= 6),
        110_000,
        1_000,
      );
      const distances = live.map(
        (l) => `${l.bot.name} ${l.bot.bot.entity.position.distanceTo(operator.bot.entity.position).toFixed(1)}m`,
      );
      return arrived ? pass(`both came: ${distances.join(', ')}`) : fail(`not everyone came: ${distances.join(', ')}`);
    } finally {
      await stopAgents(live);
    }
  },
};

/**
 * Feeding someone who is starving.
 *
 * Dmitri died mid-conversation while three agents promised him food -- first
 * because nothing could actually hand it over, later because what was handed
 * over was never picked up. The whole chain, done by the agents themselves.
 */
const agentFeedsHungryPeer: Scenario = {
  id: 'agent_feeds_hungry_peer',
  title: 'an agent with bread feeds a starving one',
  live: true,
  timeoutMs: 200_000,
  async run({ arena, provider }) {
    if (provider === null) return { verdict: 'skip', detail: 'needs --live' };

    const live = await startAgents(arena, provider, [
      { username: 'ScenAgentA', where: at(-6, 0) },
      { username: 'ScenAgentB', where: at(6, 0) },
    ]);
    const [giver, hungry] = live;
    if (giver === undefined || hungry === undefined) return fail('setup: agents did not start');

    try {
      await arena.give(giver.bot.name, 'bread', 6);
      await arena.run(`effect give ${hungry.bot.name} minecraft:hunger 20 120 true`);
      await until(() => hungry.bot.bot.food <= 6, 20_000, 500);
      await arena.run(`effect clear ${hungry.bot.name}`);
      const low = hungry.bot.bot.food;

      const fed = await until(
        () => hungry.bot.bot.food > low + 2 || countItem(hungry.bot.bot, 'bread') > 0,
        160_000,
        1_000,
      );
      return fed
        ? pass(`food ${low} -> ${hungry.bot.bot.food}, holding ${countItem(hungry.bot.bot, 'bread')} bread`)
        : fail(`still starving at food ${hungry.bot.bot.food}; giver holds ${countItem(giver.bot.bot, 'bread')} bread`);
    } finally {
      await stopAgents(live);
    }
  },
};

/**
 * Being attacked, and answering.
 *
 * On 2026-09-16 one skeleton killed all four agents in 29 seconds while each
 * was mid-conversation: nothing woke them for damage above half health, and
 * nothing let them fight. A husk because, unlike a zombie, it does not burn
 * in the arena's permanent daylight.
 */
const agentFightsBack: Scenario = {
  id: 'agent_fights_back',
  title: 'an agent attacked by a husk fights back and survives',
  live: true,
  timeoutMs: 150_000,
  async run({ arena, provider }) {
    if (provider === null) return { verdict: 'skip', detail: 'needs --live' };

    const live = await startAgents(arena, provider, [{ username: 'ScenAgentA', where: at(-6, 0) }]);
    const [agent] = live;
    if (agent === undefined) return fail('setup: agent did not start');

    try {
      await arena.give(agent.bot.name, 'stone_sword', 1);
      // Counted, so a husk dying of anything else cannot pass for a fight.
      const attacks: string[] = [];
      const attackEntity = agent.bot.actions.attackEntity;
      agent.bot.actions.attackEntity = async (target, timeoutMs) => {
        const result = await attackEntity(target, timeoutMs);
        attacks.push(`${target}:${result.ok ? 'ok' : (result.error?.code ?? 'failed')}`);
        return result;
      };
      let died = false;
      agent.bot.bot.once('death', () => {
        died = true;
      });
      const husk = at(4, 0);
      await arena.run(`summon minecraft:husk ${husk.x} ${husk.y} ${husk.z}`);
      await sleep(1_500);

      // Asked of the server: mineflayer can keep a dead mob in its entity
      // list (seen with a cow in hunt_cow), which would read as still alive.
      let huskAlive = true;
      const deadline = Date.now() + 110_000;
      while (Date.now() < deadline && !died && huskAlive) {
        await sleep(2_000);
        const found = await arena.rcon.command(
          `execute if entity @e[type=minecraft:husk,x=${ARENA.x},y=${ARENA.y + 1},z=${ARENA.z},distance=..40]`,
        );
        huskAlive = /passed/i.test(found);
      }
      const over = !huskAlive;

      if (died) return fail(`the agent was killed by the husk (attacks: ${attacks.join(', ') || 'none'})`);
      if (!over) return fail(`husk still alive after 110s; agent health ${agent.bot.bot.health}`);
      if (attacks.length === 0) return fail('the husk died, but not from anything the agent did');
      return pass(`husk killed with attack_entity (${attacks.join(', ')}); agent at ${agent.bot.bot.health}/20 health`);
    } finally {
      await stopAgents(live);
    }
  },
};

export const SCENARIOS: readonly Scenario[] = [
  handoverAdjacent,
  handoverWalks,
  dropIsNamed,
  moveAroundWall,
  moveStepUp,
  followMoving,
  placeWall,
  placeOverSapling,
  mineLogs,
  craftChain,
  eatWhenHungry,
  surfaceForAir,
  huntCow,
  smeltBeef,
  chestRoundTrip,
  placeStepsAside,
  placeOccupied,
  notFoundSuggests,
  agentsAnswerGroupCall,
  agentFeedsHungryPeer,
  agentFightsBack,
];

/** What a verdict change between runs means, in one word. */
export function describeChange(previous: Verdict | null, now: Verdict): string | null {
  if (previous === null || previous === now) return null;
  if (previous === 'pass' && now === 'fail') return 'REGRESSED';
  if (previous === 'fail' && now === 'pass') return 'fixed';
  return null;
}
