/**
 * The test arena: a small, known, resettable place for scenario tests.
 *
 * WHERE. A glass platform in the sky at x=25000, z=25000, in the same world as
 * the experiment. A separate test world would mean running a second server
 * alongside the first, which a laptop cannot comfortably do -- and scenarios
 * are most useful exactly when agents are running. Twenty-five thousand blocks
 * is far past anywhere an agent will walk, and nothing here touches global
 * state: no gamerules, no time of day, no weather. `--cleanup` removes it.
 *
 * WHY GLASS AND BARRIERS. Mobs cannot spawn on glass, so a test is never
 * decided by a zombie wandering in. Barrier walls keep bots on the platform
 * without being something pathfinding confuses for terrain worth climbing.
 * Being in the sky means no caves, trees or hills: the only geometry in a test
 * is the geometry the test built.
 *
 * Every scenario starts from reset(): cleared volume, fresh floor and walls, no
 * dropped items. A test that depends on what the previous test left behind is
 * not measuring what it claims to.
 */

import mineflayer from 'mineflayer';
import type { Bot } from 'mineflayer';
import { Vec3 } from 'vec3';

import { loadConfig } from '../config.ts';
import { createActions } from '../bot/actions/index.ts';
import type { Actions } from '../bot/actions/index.ts';
import { createLogger } from '../util/log.ts';
import type { Rcon } from './rcon.ts';

/** Centre of the platform. */
export const ARENA = { x: 25000, y: 200, z: 25000 } as const;
/** Blocks from the centre to the inner edge of each wall. */
export const ARENA_HALF = 18;
/** Clear space above the floor. */
const ARENA_HEADROOM = 10;

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

export interface Point {
  x: number;
  y: number;
  z: number;
}

/** A point on the arena floor, relative to the centre. `y` is the standing level. */
export function at(dx: number, dz: number, dy = 0): Point {
  return { x: ARENA.x + dx, y: ARENA.y + 1 + dy, z: ARENA.z + dz };
}

export interface ScenarioBot {
  bot: Bot;
  actions: Actions;
  name: string;
}

export interface Arena {
  rcon: Rcon;
  /** Run a command, failing loudly: a silently failed setup is a false result. */
  run: (command: string) => Promise<string>;
  reset: () => Promise<void>;
  spawn: (name: string, where: Point) => Promise<ScenarioBot>;
  teleport: (name: string, where: Point) => Promise<void>;
  give: (name: string, item: string, count: number) => Promise<void>;
  setBlock: (where: Point, block: string) => Promise<void>;
  fill: (from: Point, to: Point, block: string) => Promise<void>;
  /** Disconnect every bot this arena spawned. */
  releaseBots: () => Promise<void>;
  cleanup: () => Promise<void>;
}

/** Messages that mean a command did not do what was asked. */
const COMMAND_FAILED =
  /unknown|incorrect|expected|not loaded|no player was found|no entity was found|invalid|cannot|could not|too many blocks/i;

function coords(p: Point): string {
  return `${Math.floor(p.x)} ${Math.floor(p.y)} ${Math.floor(p.z)}`;
}

export async function createArena(rcon: Rcon): Promise<Arena> {
  const bots = new Map<string, ScenarioBot>();

  async function run(command: string): Promise<string> {
    const output = await rcon.command(command);
    // "No items were found" and "nothing changed" are fine -- the arena was
    // already in the state asked for. Anything else that sounds like an error
    // is one.
    if (COMMAND_FAILED.test(output) && !/no items|no entity was found|no blocks were filled|already/i.test(output)) {
      throw new Error(`server rejected "${command}": ${output}`);
    }
    return output;
  }

  const x1 = ARENA.x - ARENA_HALF - 1;
  const x2 = ARENA.x + ARENA_HALF + 1;
  const z1 = ARENA.z - ARENA_HALF - 1;
  const z2 = ARENA.z + ARENA_HALF + 1;
  const floor = ARENA.y;
  const top = ARENA.y + ARENA_HEADROOM;

  /**
   * Chunks this far out have usually never been generated. forceload creates
   * and keeps them, but not instantly, so the first fill is retried until the
   * server agrees the area is loaded.
   */
  async function ensureLoaded(): Promise<void> {
    await rcon.command(`forceload add ${x1} ${z1} ${x2} ${z2}`);
    for (let attempt = 0; attempt < 40; attempt++) {
      const output = await rcon.command(`setblock ${ARENA.x} ${floor - 1} ${ARENA.z} minecraft:air`);
      if (!/not loaded/i.test(output)) return;
      await sleep(500);
    }
    throw new Error('the arena chunks never finished loading');
  }

  let loaded = false;

  async function teleport(name: string, where: Point): Promise<void> {
    await run(`tp ${name} ${where.x + 0.5} ${where.y} ${where.z + 0.5}`);
    const entry = bots.get(name);
    if (entry === undefined) return;

    // A teleport is not done until the bot has both arrived and received the
    // chunks it is standing in -- acting before that means pathfinding and
    // placement against a world the bot cannot see yet.
    const target = new Vec3(where.x + 0.5, where.y, where.z + 0.5);
    for (let i = 0; i < 60; i++) {
      const here = entry.bot.entity?.position;
      const ground = entry.bot.blockAt(new Vec3(where.x, where.y - 1, where.z));
      if (here !== undefined && here.distanceTo(target) < 1.5 && ground !== null && ground.name !== 'air') {
        await sleep(400);
        return;
      }
      await sleep(250);
    }
    throw new Error(`${name} did not arrive at ${coords(where)} after teleporting`);
  }

  /**
   * A known starting state for a bot, whether it is new or reused from the
   * previous scenario: empty inventory, full health and food, no effects, and
   * no movement left over from whatever it was doing before.
   */
  async function prepare(entry: ScenarioBot): Promise<void> {
    try {
      entry.bot.pathfinder?.setGoal(null);
    } catch {
      /* no goal to clear */
    }
    entry.bot.clearControlStates();

    await run(`gamemode survival ${entry.name}`);
    await run(`clear ${entry.name}`);
    await run(`effect clear ${entry.name}`);
    await run(`effect give ${entry.name} minecraft:instant_health 1 10 true`);
    await run(`effect give ${entry.name} minecraft:saturation 1 20 true`);
  }

  async function spawn(name: string, where: Point): Promise<ScenarioBot> {
    const existing = bots.get(name);
    if (existing !== undefined) {
      await prepare(existing);
      await teleport(name, where);
      return existing;
    }

    const config = loadConfig();
    const bot = mineflayer.createBot({
      host: config.host,
      port: config.port,
      username: name,
      version: config.version,
      auth: 'offline',
      logErrors: false,
    });

    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`${name} did not spawn within 30s`)), 30_000);
      bot.once('spawn', () => {
        clearTimeout(timer);
        resolve();
      });
      bot.once('kicked', (reason) => {
        clearTimeout(timer);
        reject(new Error(`${name} was kicked: ${JSON.stringify(reason)}`));
      });
      bot.once('error', (err) => {
        clearTimeout(timer);
        reject(err);
      });
    });

    // Telemetry off: scenario bots are apparatus, not subjects, and must not
    // appear in the research record next to the real agents.
    const actions = createActions(bot, createLogger(name, () => {}));
    const entry = { bot, actions, name };
    bots.set(name, entry);

    await prepare(entry);
    await teleport(name, where);
    return entry;
  }


  async function fill(from: Point, to: Point, block: string): Promise<void> {
    await run(`fill ${coords(from)} ${coords(to)} ${block}`);
  }

  return {
    rcon,
    run,

    async reset() {
      if (!loaded) {
        await ensureLoaded();
        loaded = true;
      }

      // Items and mobs first, so nothing falls through the floor mid-rebuild.
      await run(
        `kill @e[type=!player,x=${x1},y=${floor - 2},z=${z1},dx=${x2 - x1},dy=${top - floor + 4},dz=${z2 - z1}]`,
      );

      // /fill is capped at 32,768 blocks per call, so the volume is cleared in
      // horizontal slices rather than as one box.
      for (let y = floor + 1; y <= top; y += 4) {
        await run(`fill ${x1} ${y} ${z1} ${x2} ${Math.min(top, y + 3)} ${z2} minecraft:air`);
      }
      await run(`fill ${x1} ${floor} ${z1} ${x2} ${floor} ${z2} minecraft:glass`);

      // Walls three high on all four sides.
      for (const [ax, az, bx, bz] of [
        [x1, z1, x2, z1],
        [x1, z2, x2, z2],
        [x1, z1, x1, z2],
        [x2, z1, x2, z2],
      ] as const) {
        await run(`fill ${ax} ${floor + 1} ${az} ${bx} ${floor + 3} ${bz} minecraft:barrier`);
      }
    },

    spawn,
    teleport,

    async give(name, item, count) {
      await run(`give ${name} minecraft:${item} ${count}`);
      // The inventory update is its own packet; give it a moment to land.
      await sleep(400);
    },

    async setBlock(where, block) {
      await run(`setblock ${coords(where)} minecraft:${block}`);
    },

    fill: (from, to, block) => fill(from, to, `minecraft:${block}`),

    async releaseBots() {
      for (const { bot } of bots.values()) {
        try {
          bot.quit('scenario finished');
        } catch {
          /* already gone */
        }
      }
      bots.clear();
      await sleep(500);
    },

    async cleanup() {
      await run(`kill @e[type=!player,x=${x1},y=${floor - 2},z=${z1},dx=${x2 - x1},dy=${top - floor + 4},dz=${z2 - z1}]`);
      for (let y = floor; y <= top; y += 4) {
        await run(`fill ${x1} ${y} ${z1} ${x2} ${Math.min(top, y + 3)} ${z2} minecraft:air`);
      }
      await rcon.command(`forceload remove ${x1} ${z1} ${x2} ${z2}`);
    },
  };
}
