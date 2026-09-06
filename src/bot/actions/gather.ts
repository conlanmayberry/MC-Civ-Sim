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

import { canHarvest } from '../harvest.ts';
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
/** How many candidate blocks to consider before giving up on a target. */
const CANDIDATES = 12;
/** Drops take a moment to spawn before they can be collected. */
const DROP_SETTLE_MS = 350;
/** Let residual movement bleed off before swinging, so the dig is not aborted. */
const DIG_SETTLE_MS = 250;
/** Stop sweeping after this many drops, so one action cannot run away. */
const MAX_DROPS_PER_SWEEP = 12;

export const DEFAULT_MINE_TIMEOUT_MS = 90_000;
export const DEFAULT_COLLECT_TIMEOUT_MS = 30_000;

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

function inventoryCount(bot: Bot, name: string): number {
  return bot.inventory
    .items()
    .filter((i) => i.name === name)
    .reduce((sum, i) => sum + i.count, 0);
}

function totalItems(bot: Bot): number {
  return bot.inventory.items().reduce((sum, i) => sum + i.count, 0);
}

export function createGatherActions(ctx: ActionContext) {
  const { bot, runner } = ctx;

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

    while (Date.now() < deadline && !signal.aborted && visited < MAX_DROPS_PER_SWEEP) {
      const nearest = Object.values(bot.entities)
        // `objectType` is deprecated in prismarine-entity and prints a stack
        // trace on every access; `name` alone identifies dropped items.
        .filter((e) => e.name === 'item')
        .filter((e) => bot.entity.position.distanceTo(e.position) <= radius)
        .sort(
          (a, b) =>
            bot.entity.position.distanceTo(a.position) - bot.entity.position.distanceTo(b.position),
        )[0];

      if (nearest === undefined) break;

      const target = nearest.position.clone();
      const nav = await navigateTo(
        bot,
        target.x,
        target.y,
        target.z,
        1,
        Math.max(4_000, Math.min(12_000, deadline - Date.now())),
        signal,
      );
      visited++;

      // An unreachable drop may be in a wall or across a ravine. Give up on the
      // sweep rather than retry it forever -- the items already collected are
      // still a real result.
      if (!nav.ok) break;
      await sleep(DROP_SETTLE_MS);
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

          const before = inventoryCount(bot, blockName);
          const positions: Array<Record<string, number>> = [];
          const deadline = Date.now() + timeoutMs - 3_000;

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
            const candidates = bot
              .findBlocks({ matching: wanted.id, maxDistance: searchRadius, count: CANDIDATES })
              .map((pos) => bot.blockAt(pos))
              .filter((b): b is Block => b !== null && b.name === blockName);

            if (candidates.length === 0) {
              // Partial success is still success: report what we got.
              if (positions.length > 0) break;
              throw new ActionFailure('not_found', `no ${blockName} within ${searchRadius} blocks`);
            }

            let fresh: Block | null = null;
            let lastReachError = '';
            for (const candidate of candidates) {
              if (Date.now() > deadline || signal.aborted) break;
              try {
                await approach(candidate, Math.max(5_000, deadline - Date.now()), signal);
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

          const sweep = await sweepDrops(6, Math.min(8_000, Math.max(2_000, deadline - Date.now())), signal);

          return {
            block: blockName,
            requested: count,
            mined: positions.length,
            positions,
            gained: inventoryCount(bot, blockName) - before,
            dropsVisited: sweep['dropsVisited'],
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
