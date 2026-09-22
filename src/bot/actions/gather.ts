/**
 * Gathering: mine a block, then pick up what it dropped.
 *
 * Mining has the most ways to fail quietly, so each becomes a distinct error
 * code rather than a silent no-op:
 *
 *   not_found    no such block within range
 *   unreachable  could not path to it (including the ADR-006 wedge)
 *   no_tool      breakable, but would drop nothing with what we hold
 *   blocked      mineflayer refuses to dig it (bedrock, protection)
 *
 * The `no_tool` check matters more than it looks. An agent that mines stone
 * bare-handed "succeeds" and receives nothing, which teaches it something false
 * about the world -- worse than an honest refusal.
 *
 * Both actions walk around, and both already hold the action mutex, so they use
 * `navigateTo` rather than the `moveTo` action. Calling the action here would
 * deadlock against our own mutex and return `interrupted`.
 */

import type { Bot } from 'mineflayer';
import type { Block } from 'prismarine-block';
import { Vec3 } from 'vec3';

import { canHarvest } from '../harvest.ts';
import { PICKED_NOT_DUG, RIPE_AGE, cropAge, isRipe } from './farming.ts';
import { navigateTo } from './movement.ts';
import type { ActionContext } from './run.ts';
import { ActionFailure } from './run.ts';
import type { ActionResult } from './types.ts';
import { round2, toPosition } from './types.ts';

/**
 * Goal range when walking to a block we intend to dig.
 *
 * Deliberately tighter than mineflayer's 5.1 reach limit. `bot.canDigBlock`
 * measures EYE LEVEL (position + 1.65) to BLOCK CENTRE (+0.5), not feet to
 * corner -- so a block four blocks below reads as 4.0 by the naive metric and
 * 5.15 by mineflayer's, and the dig gets refused after a "successful" approach.
 * Rather than reimplement their arithmetic, we get comfortably close and then
 * ask `canDigBlock` itself.
 */
const APPROACH_RANGE = 2;
const DEFAULT_SEARCH_RADIUS = 32;
/**
 * How many candidate blocks to try before giving up.
 *
 * Twelve, each with its own pathfinding attempt and wedge retries, is how the
 * 90s budget disappeared. Four is enough to get past "the nearest one is
 * through a wall" without spending the whole turn proving a spot is bad.
 */
const CANDIDATES = 4;
/** Drops take a moment to spawn before they can be collected. */
const DROP_SETTLE_MS = 350;
/** Let residual movement bleed off before swinging, so the dig is not aborted. */
const DIG_SETTLE_MS = 250;
/**
 * Tries per drop before leaving it.
 *
 * Two was not enough: a handover collected nothing about one run in five,
 * because both tries were spent "arriving" at an item the bot already stood
 * beside while vanilla's post-toss pickup delay was still running.
 */
const DROP_ATTEMPTS = 3;
/** Close enough that stepping, not pathfinding, is what is missing. */
const NUDGE_RANGE = 3;
const NUDGE_MS = 450;
/** Stop sweeping after this many drops, so one action cannot run away. */
const MAX_DROPS_PER_SWEEP = 12;

/**
 * Was 90s, and eight attempts burned every second of it before giving up.
 *
 * A mine that has not started after this long is stuck on approach, and the
 * agent is better served by a quick failure it can act on than by a minute and
 * a half of silence -- especially now that it batches several actions into one
 * decision, where a single stuck call consumes the whole turn.
 */
export const DEFAULT_MINE_TIMEOUT_MS = 45_000;

/** How many blocks of a crop to look at, to find ripe ones among the green. */
const CROP_SEARCH = 64;
/** The item that replants a harvested crop. */
const CROP_SEED: Readonly<Record<string, string>> = {
  wheat: 'wheat_seeds',
  carrots: 'carrot',
  potatoes: 'potato',
  beetroots: 'beetroot_seeds',
};

/** Blocks agents go looking for as food. */
const FOOD_BLOCKS = new Set([
  'wheat', 'carrots', 'potatoes', 'beetroots', 'sweet_berry_bush', 'melon', 'pumpkin', 'hay_block', 'cocoa',
]);
const FOOD_ANIMALS = new Set(['cow', 'pig', 'sheep', 'chicken', 'rabbit', 'mooshroom', 'goat']);
/** Block names that come in kinds worth offering one another as substitutes. */
const FAMILIES = new Set(['log', 'planks', 'ore', 'wool', 'leaves', 'stone', 'sand', 'terracotta']);
const ALTERNATIVE_RADIUS = 32;
/** Time mine_block keeps back from digging for collecting what it dug. */
const SWEEP_RESERVE_MS = 6_000;
export const DEFAULT_COLLECT_TIMEOUT_MS = 30_000;

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/**
 * A snapshot of every stack, for diffing.
 *
 * Counting the BLOCK's name was wrong and quietly damaging: mining stone with
 * a pickaxe yields cobblestone, coal_ore yields coal, grass_block yields dirt.
 * A successful mine therefore reported gained=0, which tells an agent that the
 * block is unobtainable -- exactly the false lesson the no_tool check exists to
 * prevent, arriving by another route.
 */
function inventorySnapshot(bot: Bot): Map<string, number> {
  const counts = new Map<string, number>();
  for (const item of bot.inventory.items()) {
    counts.set(item.name, (counts.get(item.name) ?? 0) + item.count);
  }
  return counts;
}

/** What actually appeared in the inventory between two snapshots. */
function inventoryGained(
  before: Map<string, number>,
  after: Map<string, number>,
): Record<string, number> {
  const gained: Record<string, number> = {};
  for (const [name, count] of after) {
    const delta = count - (before.get(name) ?? 0);
    if (delta > 0) gained[name] = delta;
  }
  return gained;
}

function totalItems(bot: Bot): number {
  return bot.inventory.items().reduce((sum, i) => sum + i.count, 0);
}

export function createGatherActions(ctx: ActionContext) {
  const { bot, runner } = ctx;

  /**
   * What IS around, when what was asked for is not.
   *
   * 46 mine_block calls in one session searched for crops that did not exist
   * -- wheat, carrots, potatoes, hay -- at radii from 8 to 150, while cows and
   * sheep wandered past. "not found" alone says to look harder; this says what
   * to do instead.
   */
  function describeAlternatives(blockName: string): string {
    const parts: string[] = [];

    if (FOOD_BLOCKS.has(blockName)) {
      const animals = Object.values(bot.entities)
        .filter((e) => e.name !== undefined && FOOD_ANIMALS.has(e.name) && e.isValid)
        .map((e) => ({ name: e.name as string, distance: e.position.distanceTo(bot.entity.position) }))
        .filter((a) => a.distance <= ALTERNATIVE_RADIUS)
        .sort((a, b) => a.distance - b.distance)
        .slice(0, 4);
      if (animals.length > 0) {
        parts.push(
          `animals you could hunt for food instead: ${animals.map((a) => `${a.name} ${Math.round(a.distance)}m`).join(', ')} (attack_entity)`,
        );
      }
    }

    // Same family, different kind: no oak_log, but spruce_log in sight.
    const suffix = blockName.split('_').at(-1) ?? '';
    if (FAMILIES.has(suffix)) {
      const relatives = Object.values(bot.registry.blocksByName).filter(
        (b) => b.name !== blockName && b.name.endsWith(`_${suffix}`),
      );
      const ids = new Set(relatives.map((b) => b.id));
      const seen = new Map<string, number>();
      for (const position of bot.findBlocks({ matching: [...ids], maxDistance: ALTERNATIVE_RADIUS, count: 40 })) {
        const block = bot.blockAt(position);
        if (block === null) continue;
        const distance = position.distanceTo(bot.entity.position);
        if (!seen.has(block.name) || distance < (seen.get(block.name) ?? Infinity)) seen.set(block.name, distance);
      }
      if (seen.size > 0) {
        parts.push(
          `similar blocks nearby: ${[...seen.entries()]
            .sort((a, b) => a[1] - b[1])
            .slice(0, 4)
            .map(([name, d]) => `${name} ${Math.round(d)}m`)
            .join(', ')}`,
        );
      }
    }

    return parts.join('; ');
  }

  async function approach(block: Block, timeoutMs: number, signal: AbortSignal): Promise<void> {
    // mineflayer's own reach test is the only one that matters -- it is what
    // bot.dig will consult.
    if (bot.canDigBlock(block)) return;

    const nav = await navigateTo(
      bot,
      block.position.x,
      block.position.y,
      block.position.z,
      APPROACH_RANGE,
      timeoutMs,
      signal,
    );

    // Pathfinder's verdict is not the criterion: a wedge two blocks from the
    // target still leaves the block perfectly diggable. Re-ask.
    if (bot.canDigBlock(block)) return;

    throw new ActionFailure(
      nav.outcome === 'timeout' ? 'timeout' : 'unreachable',
      `could not get within reach of ${block.name}: ${nav.outcome}` +
        `${nav.detail === '' ? '' : ` (${nav.detail})`}, ${nav.remaining}m short`,
    );
  }

  /** Walk over nearby drops. Assumes the caller holds the mutex. */
  async function sweepDrops(
    radius: number,
    timeoutMs: number,
    signal: AbortSignal,
  ): Promise<Record<string, unknown>> {
    const deadline = Date.now() + timeoutMs;
    const before = totalItems(bot);
    let visited = 0;
    // Drops walked to that are still lying there. Traced in the arena: two
    // logs at 1.4m and 1.6m, the bot "arriving" at each in turn and picking up
    // neither, ten times over -- a sweep that reported success and collected
    // one of three logs. Two tries each, then leave it.
    const attempts = new Map<number, number>();

    while (Date.now() < deadline && !signal.aborted && visited < MAX_DROPS_PER_SWEEP) {
      const nearest = Object.values(bot.entities)
        // `objectType` is deprecated in prismarine-entity and prints a stack
        // trace on every access; `name` alone identifies dropped items.
        .filter((e) => e.name === 'item')
        .filter((e) => (attempts.get(e.id) ?? 0) < DROP_ATTEMPTS)
        .filter((e) => bot.entity.position.distanceTo(e.position) <= radius)
        .sort(
          (a, b) =>
            bot.entity.position.distanceTo(a.position) - bot.entity.position.distanceTo(b.position),
        )[0];

      if (nearest === undefined) break;

      const target = nearest.position.clone();
      attempts.set(nearest.id, (attempts.get(nearest.id) ?? 0) + 1);
      // Strictly inside the deadline. This used to be at least 4s whatever was
      // left, which ran the action into the runner's own timeout -- and a
      // runner timeout throws away everything already picked up from the
      // report (collect_items "exceeded 30000ms", 19 times).
      const budget = (): number => Math.min(12_000, deadline - Date.now());
      if (budget() < 1_500) break;
      // Onto the drop's own block, not merely near it. Range 1 counts as
      // arrived from a neighbouring block, which is often just outside
      // vanilla's pickup box. Range 1 remains the fallback for a drop whose
      // block cannot be stood in.
      let nav = await navigateTo(bot, target.x, target.y, target.z, 0, budget(), signal);
      if (!nav.ok && !signal.aborted && budget() >= 1_500) {
        nav = await navigateTo(bot, target.x, target.y, target.z, 1, budget(), signal);
      }
      visited++;

      // An unreachable drop may be in a wall or across a ravine. Give up on the
      // sweep rather than retry it forever -- the items already collected are
      // still a real result.
      if (!nav.ok) break;
      await sleep(DROP_SETTLE_MS);

      // Arrived, and it is still lying there. Walking is not what is missing:
      // either the hitbox is a few tenths short of the item, or the item is
      // inside vanilla's two-second pickup delay after being tossed. Lean
      // into it for a moment rather than re-running the pathfinder, which
      // arrives instantly from where it already stands and changes nothing.
      const stillThere = bot.entities[nearest.id];
      if (stillThere !== undefined && stillThere.position.distanceTo(bot.entity.position) <= NUDGE_RANGE) {
        try {
          await bot.lookAt(stillThere.position, true);
          bot.setControlState('forward', true);
          await sleep(NUDGE_MS);
        } finally {
          bot.setControlState('forward', false);
        }
        await sleep(DROP_SETTLE_MS);
      }
    }

    return {
      dropsVisited: visited,
      itemsGained: totalItems(bot) - before,
      position: toPosition(bot.entity.position),
      radius: round2(radius),
    };
  }

  return {
    /**
     * Mine the nearest block of a given name, `count` times.
     *
     * Re-searches on each iteration: a tree is several blocks and the nearest
     * log changes as it comes down.
     */
    async mineBlock(
      blockName: string,
      count = 1,
      searchRadius = DEFAULT_SEARCH_RADIUS,
      timeoutMs = DEFAULT_MINE_TIMEOUT_MS,
    ): Promise<ActionResult> {
      return runner.run(
        { action: 'mine_block', eventType: 'block_mined', timeoutMs },
        async (signal) => {
          const wanted = bot.registry.blocksByName[blockName];
          if (wanted === undefined) {
            throw new ActionFailure('invalid_argument', `no such block: ${blockName}`);
          }

          const before = inventorySnapshot(bot);
          const positions: Array<Record<string, number>> = [];
          // Two deadlines: digging stops at the first, leaving the rest for
          // picking up what was dug. Overrunning into the runner's timeout
          // discards the whole result -- "exceeded 45000ms" nine times in one
          // session, including runs that had already mined blocks.
          const finish = Date.now() + timeoutMs - 1_500;
          const deadline = finish - SWEEP_RESERVE_MS;

          for (let i = 0; i < count; i++) {
            if (signal.aborted) break;
            if (Date.now() > deadline) {
              if (positions.length === 0) throw new ActionFailure('timeout', 'ran out of time');
              break;
            }

            // Several candidates, not just the nearest. The closest block by
            // straight-line distance is often the least reachable -- through a
            // wall, up a cliff, inside a trunk. In a dense forest some log is
            // always reachable; insisting on the nearest one is what made this
            // fail where a person would simply walk to a different tree.
            // Crops: only ripe ones. Digging unripe wheat yields a seed and
            // destroys the plant, so the nearest four could all be green while
            // ripe ones stand further off -- look wider, then keep the ripe.
            const isCrop = RIPE_AGE[blockName] !== undefined;
            const found = bot
              .findBlocks({ matching: wanted.id, maxDistance: searchRadius, count: isCrop ? CROP_SEARCH : CANDIDATES })
              .map((pos) => bot.blockAt(pos))
              .filter((b): b is Block => b !== null && b.name === blockName);
            const candidates = isCrop
              ? found.filter((b) => isRipe(b.name, cropAge(b))).slice(0, CANDIDATES)
              : found;

            if (candidates.length === 0) {
              // Partial success is still success: report what we got.
              if (positions.length > 0) break;
              if (found.length > 0) {
                const furthest = Math.max(...found.map((b) => cropAge(b) ?? 0));
                throw new ActionFailure(
                  'not_found',
                  `${found.length} ${blockName} within ${searchRadius} blocks, but none ripe yet ` +
                    `(furthest along: stage ${furthest}/${RIPE_AGE[blockName]}) -- harvesting now would destroy them for a seed`,
                );
              }
              const alternatives = describeAlternatives(blockName);
              throw new ActionFailure(
                'not_found',
                `no ${blockName} within ${searchRadius} blocks${alternatives === '' ? '' : ` -- ${alternatives}`}`,
              );
            }

            let fresh: Block | null = null;
            let lastReachError = '';
            for (const candidate of candidates) {
              if (Date.now() > deadline || signal.aborted) break;
              try {
                const left = deadline - Date.now();
                if (left < 2_000) break;
                await approach(candidate, left, signal);
              } catch (err) {
                lastReachError = err instanceof Error ? err.message : String(err);
                continue; // Try the next tree.
              }
              // Re-read after walking: it may have changed (another agent, a
              // falling block, gravity on our own earlier dig).
              const reread = bot.blockAt(candidate.position);
              if (reread !== null && reread.name === blockName && bot.canDigBlock(reread)) {
                fresh = reread;
                break;
              }
            }

            if (fresh === null) {
              if (positions.length > 0) break;
              if (deadline - Date.now() < 2_000 && lastReachError === '') {
                throw new ActionFailure('timeout', `ran out of time walking to the nearest ${blockName}`);
              }
              throw new ActionFailure(
                'unreachable',
                `none of the ${candidates.length} nearest ${blockName} could be reached` +
                  `${lastReachError === '' ? '' : ` (last: ${lastReachError})`}`,
              );
            }

            const tool = bot.pathfinder.bestHarvestTool(fresh);
            const harvest = canHarvest(
              { name: fresh.name, harvestTools: fresh.harvestTools },
              tool === null ? null : { name: tool.name, type: tool.type },
            );
            if (!harvest.ok) throw new ActionFailure('no_tool', harvest.reason ?? 'wrong tool');

            if (tool !== null) await bot.equip(tool, 'hand');

            if (!fresh.diggable) {
              throw new ActionFailure('blocked', `${fresh.name} is not diggable`);
            }

            // Come to a complete stop before digging. Residual pathfinder
            // movement carries the bot out of reach mid-swing, which mineflayer
            // reports as the rather opaque "Digging aborted".
            bot.pathfinder.setGoal(null);
            bot.clearControlStates();
            await sleep(DIG_SETTLE_MS);

            if (!bot.canDigBlock(fresh)) {
              // Reach, not permission -- settling can drift us just outside it.
              throw new ActionFailure(
                'unreachable',
                `${fresh.name} slipped out of reach before digging`,
              );
            }

            // Berries are picked, as a player picks them, leaving the bush to
            // fruit again. Digging it gave the same berries once and then
            // nothing, ever, from that bush.
            if (PICKED_NOT_DUG.has(fresh.name)) {
              const picked = fresh;
              try {
                await bot.activateBlock(picked);
              } catch {
                // Verified from the world below.
              }
              await sleep(DROP_SETTLE_MS);
              const after = bot.blockAt(picked.position);
              if (after === null || after.name !== picked.name || (cropAge(after) ?? 0) >= (cropAge(picked) ?? 0)) {
                if (positions.length > 0) break;
                throw new ActionFailure('failed', `picking the ${picked.name} did nothing`);
              }
              positions.push({ x: picked.position.x, y: picked.position.y, z: picked.position.z });
              continue;
            }

            try {
              await bot.dig(fresh);
            } catch (err) {
              const message = err instanceof Error ? err.message : String(err);
              // Whatever went wrong on this block, logs already in the
              // inventory are a real result -- report them rather than
              // discarding the whole action.
              if (positions.length > 0) break;
              throw new ActionFailure(
                message.includes('aborted') ? 'interrupted' : 'failed',
                `digging ${fresh.name} failed: ${message}`,
              );
            }

            positions.push({ x: fresh.position.x, y: fresh.position.y, z: fresh.position.z });
            await sleep(DROP_SETTLE_MS);
          }

          const sweep = await sweepDrops(6, Math.min(8_000, finish - Date.now()), signal);

          // Replant behind the harvest, as a farmer does: the seeds just came
          // out of the crop. A field that is harvested and left bare is a field
          // the agent has to remember to replant, and the next harvest
          // depends on it remembering.
          let replanted = 0;
          const seed = CROP_SEED[blockName];
          if (seed !== undefined && !PICKED_NOT_DUG.has(blockName)) {
            for (const spot of positions) {
              if (signal.aborted || Date.now() > finish) break;
              const item = bot.inventory.items().find((i) => i.name === seed);
              if (item === undefined) break;
              const soil = bot.blockAt(new Vec3(spot['x'] ?? 0, (spot['y'] ?? 0) - 1, spot['z'] ?? 0));
              const space = bot.blockAt(new Vec3(spot['x'] ?? 0, spot['y'] ?? 0, spot['z'] ?? 0));
              if (soil === null || soil.name !== 'farmland' || space === null || space.boundingBox !== 'empty') continue;
              if (bot.entity.position.distanceTo(soil.position.offset(0.5, 0.5, 0.5)) > 4.5) continue;
              try {
                await bot.equip(item, 'hand');
                await bot.activateBlock(soil, new Vec3(0, 1, 0));
              } catch {
                continue;
              }
              await sleep(150);
              if (bot.blockAt(space.position)?.name === blockName) replanted++;
            }
          }

          // Report what was actually collected, by item name. The model needs
          // to know it got cobblestone rather than stone -- otherwise it looks
          // for "stone" in its inventory, fails to find it, and concludes the
          // mining did not work.
          const gained = inventoryGained(before, inventorySnapshot(bot));
          const totalGained = Object.values(gained).reduce((a, b) => a + b, 0);

          return {
            block: blockName,
            requested: count,
            mined: positions.length,
            positions,
            gained,
            totalGained,
            dropsVisited: sweep['dropsVisited'],
            ...(replanted > 0 ? { replanted } : {}),
          };
        },
      );
    },

    /** Walk over nearby dropped items to pick them up. */
    async collectNearbyItems(
      radius = 12,
      timeoutMs = DEFAULT_COLLECT_TIMEOUT_MS,
    ): Promise<ActionResult> {
      return runner.run(
        { action: 'collect_items', eventType: 'item_collected', timeoutMs },
        async (signal) => sweepDrops(radius, timeoutMs - 1_000, signal),
      );
    },
  };
}

export type GatherActions = ReturnType<typeof createGatherActions>;
