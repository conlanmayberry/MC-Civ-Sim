/**
 * Farming: tilling, planting, and knowing when a crop is ready.
 *
 * Hunting feeds an agent until the animals nearby are gone; a field feeds it
 * indefinitely. Harvesting existed before this -- mine_block on "wheat" -- but
 * it dug the nearest wheat at ANY stage of growth, and unripe wheat drops only
 * a seed and is gone. An agent that tended a field that way would have eaten
 * it green. Sweet berry bushes were worse: mining one destroys the bush, when
 * picking it (using it, as a player does) leaves it to fruit again.
 *
 * So harvesting takes only ripe crops and replants behind itself, berries are
 * picked rather than dug, and planting is one call that tills the ground too.
 */

import type { Bot } from 'mineflayer';
import type { Block } from 'prismarine-block';
import { Vec3 } from 'vec3';

import { navigateTo } from './movement.ts';
import type { ActionContext } from './run.ts';
import { ActionFailure } from './run.ts';
import type { ActionResult } from './types.ts';
import { toPosition } from './types.ts';

/** What each planting item grows into. Carrots and potatoes are their own seed. */
export const SEED_TO_CROP: Readonly<Record<string, string>> = {
  wheat_seeds: 'wheat',
  carrot: 'carrots',
  potato: 'potatoes',
  beetroot_seeds: 'beetroots',
};

/** Growth stage at which each crop is ready. */
export const RIPE_AGE: Readonly<Record<string, number>> = {
  wheat: 7,
  carrots: 7,
  potatoes: 7,
  beetroots: 3,
  nether_wart: 3,
  cocoa: 2,
  // Berries can be picked from stage 2; stage 3 gives more.
  sweet_berry_bush: 2,
};

/** Crops that are picked by using them, leaving the plant, rather than dug up. */
export const PICKED_NOT_DUG = new Set(['sweet_berry_bush']);

const TILLABLE = new Set(['dirt', 'grass_block', 'dirt_path', 'rooted_dirt']);
const HOES = ['netherite_hoe', 'diamond_hoe', 'iron_hoe', 'stone_hoe', 'golden_hoe', 'wooden_hoe'];
/** Vanilla: water within four blocks horizontally keeps farmland moist. */
const HYDRATION_RANGE = 4;
const FIELD_RADIUS = 8;
const WALK_BUDGET_MS = 12_000;
const USE_RANGE = 4;
export const DEFAULT_PLANT_TIMEOUT_MS = 60_000;

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/** A block's growth stage, or null for anything that does not grow. */
export function cropAge(block: { getProperties: () => Record<string, unknown> }): number | null {
  const age = block.getProperties()['age'];
  if (typeof age === 'number') return age;
  if (typeof age === 'string' && /^\d+$/.test(age)) return Number(age);
  return null;
}

/** Ripe means harvesting it yields food, not just a seed. */
export function isRipe(name: string, age: number | null): boolean {
  const ripe = RIPE_AGE[name];
  return ripe === undefined || (age !== null && age >= ripe);
}

export interface CropSummary {
  name: string;
  total: number;
  ripe: number;
  /** The furthest-grown unripe stage, "5/7", for when nothing is ripe yet. */
  mostGrown: string | null;
}

/** Crops within a radius, with how many are ready. */
export function observeCrops(bot: Bot, radius: number): CropSummary[] {
  // Feeds every observation, which must never throw.
  if (typeof bot.findBlocks !== 'function' || bot.registry === undefined) return [];
  const ids = Object.keys(RIPE_AGE)
    .map((name) => bot.registry.blocksByName[name]?.id)
    .filter((id): id is number => id !== undefined);
  const summaries = new Map<string, CropSummary & { best: number }>();
  for (const position of bot.findBlocks({ matching: ids, maxDistance: radius, count: 256 })) {
    const block = bot.blockAt(position);
    if (block === null) continue;
    const age = cropAge(block);
    const entry = summaries.get(block.name) ?? { name: block.name, total: 0, ripe: 0, mostGrown: null, best: -1 };
    entry.total++;
    if (isRipe(block.name, age)) entry.ripe++;
    else if (age !== null && age > entry.best) {
      entry.best = age;
      entry.mostGrown = `${age}/${RIPE_AGE[block.name] ?? '?'}`;
    }
    summaries.set(block.name, entry);
  }
  return [...summaries.values()].map(({ best: _best, ...rest }) => rest);
}

export function createFarmingActions(ctx: ActionContext) {
  const { bot, runner } = ctx;

  function findItem(name: string) {
    return bot.inventory.items().find((i) => i.name === name) ?? null;
  }

  function count(name: string): number {
    return bot.inventory
      .items()
      .filter((i) => i.name === name)
      .reduce((sum, i) => sum + i.count, 0);
  }

  function isEmpty(position: Vec3): boolean {
    const block = bot.blockAt(position);
    return block !== null && block.boundingBox === 'empty' && !block.name.includes('water');
  }

  function hydrated(soil: Vec3): boolean {
    for (let dx = -HYDRATION_RANGE; dx <= HYDRATION_RANGE; dx++) {
      for (let dz = -HYDRATION_RANGE; dz <= HYDRATION_RANGE; dz++) {
        for (const dy of [0, 1]) {
          const block = bot.blockAt(soil.offset(dx, dy, dz));
          if (block !== null && block.name === 'water') return true;
        }
      }
    }
    return false;
  }

  /**
   * Ground to plant on, best first: already-tilled farmland, then soil that
   * water will keep moist, then any tillable soil -- nearest first within each.
   */
  function fieldSpots(centre: Vec3, needed: number): Block[] {
    const ids = [...TILLABLE, 'farmland']
      .map((name) => bot.registry.blocksByName[name]?.id)
      .filter((id): id is number => id !== undefined);
    const feet = bot.entity.position.floored();
    const spots: Array<{ block: Block; rank: number; distance: number }> = [];
    for (const position of bot.findBlocks({ matching: ids, maxDistance: FIELD_RADIUS, count: 200, point: centre })) {
      const block = bot.blockAt(position);
      if (block === null || !isEmpty(position.offset(0, 1, 0))) continue;
      // Not the block underfoot: tilling it is allowed, but standing on
      // farmland tramples it back to dirt the first time the bot jumps.
      if (position.x === feet.x && position.z === feet.z && position.y === feet.y - 1) continue;
      const rank = block.name === 'farmland' ? 0 : hydrated(position) ? 1 : 2;
      spots.push({ block, rank, distance: position.distanceTo(centre) });
    }
    return spots
      .sort((a, b) => a.rank - b.rank || a.distance - b.distance)
      .slice(0, needed * 2)
      .map((s) => s.block);
  }

  async function reach(position: Vec3, signal: AbortSignal): Promise<boolean> {
    if (bot.entity.position.distanceTo(position.offset(0.5, 0.5, 0.5)) <= USE_RANGE) return true;
    await navigateTo(bot, position.x + 0.5, position.y + 1, position.z + 0.5, 2, WALK_BUDGET_MS, signal);
    return bot.entity.position.distanceTo(position.offset(0.5, 0.5, 0.5)) <= USE_RANGE + 0.5;
  }

  return {
    /**
     * Plant seeds (or carrots, potatoes) on nearby ground, tilling it first
     * with a hoe where it is not already farmland.
     */
    async plantCrop(
      seedName: string,
      requested: number,
      near: { x: number; z: number } | null = null,
      timeoutMs = DEFAULT_PLANT_TIMEOUT_MS,
    ): Promise<ActionResult> {
      return runner.run({ action: 'plant_crop', eventType: 'block_placed', timeoutMs }, async (signal) => {
        const crop = SEED_TO_CROP[seedName];
        if (crop === undefined) {
          throw new ActionFailure(
            'invalid_argument',
            `${seedName} is not something to plant -- use one of ${Object.keys(SEED_TO_CROP).join(', ')}`,
          );
        }
        const have = count(seedName);
        if (have === 0) {
          throw new ActionFailure(
            'insufficient_items',
            `no ${seedName} in inventory` +
              (seedName === 'wheat_seeds' ? ' -- breaking short_grass or tall_grass sometimes drops them' : ''),
          );
        }
        const wanted = Math.max(1, Math.min(have, Math.trunc(requested)));
        const centre = near === null ? bot.entity.position.floored() : new Vec3(near.x, bot.entity.position.y, near.z);

        const spots = fieldSpots(centre, wanted);
        if (spots.length === 0) {
          throw new ActionFailure(
            'not_found',
            `no dirt or grass with open air above it within ${FIELD_RADIUS} blocks of ${centre.x},${centre.z}`,
          );
        }
        const hoeName = HOES.find((h) => count(h) > 0) ?? null;
        if (hoeName === null && !spots.some((s) => s.name === 'farmland')) {
          throw new ActionFailure(
            'no_tool',
            'tilling ground needs a hoe -- craft a wooden_hoe from 2 planks and 2 sticks at a crafting table',
          );
        }

        const planted: Array<ReturnType<typeof toPosition>> = [];
        let dry = 0;
        const deadline = Date.now() + timeoutMs - 3_000;

        for (const spot of spots) {
          if (planted.length >= wanted || signal.aborted || Date.now() > deadline) break;
          if (count(seedName) === 0) break;
          if (!(await reach(spot.position, signal))) continue;

          let soil = bot.blockAt(spot.position);
          if (soil === null) continue;
          if (soil.name !== 'farmland') {
            if (hoeName === null) continue;
            const hoe = findItem(hoeName);
            if (hoe === null) continue;
            await bot.equip(hoe, 'hand');
            try {
              await bot.activateBlock(soil, new Vec3(0, 1, 0));
            } catch {
              // The world is the verdict, checked below.
            }
            await sleep(250);
            soil = bot.blockAt(spot.position);
            if (soil === null || soil.name !== 'farmland') continue;
          }

          const seeds = findItem(seedName);
          if (seeds === null) break;
          await bot.equip(seeds, 'hand');
          try {
            await bot.activateBlock(soil, new Vec3(0, 1, 0));
          } catch {
            // As above.
          }
          await sleep(250);
          const above = bot.blockAt(spot.position.offset(0, 1, 0));
          if (above !== null && above.name === crop) {
            planted.push(toPosition(above.position));
            if (!hydrated(spot.position)) dry++;
          }
        }

        if (planted.length === 0) {
          throw new ActionFailure('failed', `could not plant any ${seedName} -- the ground or the seeds were refused`);
        }
        return {
          crop,
          planted: planted.length,
          requested: wanted,
          positions: planted.slice(0, 8),
          ...(dry > 0 ? { dryPlots: dry } : {}),
          note:
            `${crop} ripens in roughly 5-30 minutes, faster on moist ground` +
            (dry > 0 ? ` (${dry} plot(s) have no water within 4 blocks and will grow slowly)` : '') +
            '. mine_block harvests only ripe ones and replants them.',
        };
      });
    },
  };
}

export type FarmingActions = ReturnType<typeof createFarmingActions>;
