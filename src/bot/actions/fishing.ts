/**
 * Fishing: food from water without going into it.
 *
 * attack_entity refuses fish, and for good reason -- 49 hunts after cod and
 * salmon on 2026-09-22 landed no hits at all and pulled agents into deep
 * water, where the surfacing reflex had to rescue them. But the base sits on a
 * lake, the animals nearby get hunted out, and the agents were eating rotten
 * flesh. A rod turns the water from a hazard into the larder: the agent stands
 * on the bank and the fish comes to it.
 *
 * A rod is three sticks and two string, and string comes off spiders -- which
 * attack_entity can now handle.
 */

import type { Block } from 'prismarine-block';

import { navigateTo } from './movement.ts';
import type { ActionContext } from './run.ts';
import { ActionFailure } from './run.ts';
import type { ActionResult } from './types.ts';
import { toPosition } from './types.ts';

const ROD = 'fishing_rod';
const WATER_SEARCH = 12;
/** Vanilla: a bite takes 5-30 seconds without a Lure rod. */
const BITE_TIMEOUT_MS = 40_000;
const MAX_CASTS = 5;
/** How far the float dips when a fish takes it; wave noise is a twentieth of this. */
const BITE_DIP = 0.2;
const POLL_MS = 150;
/** Time for the cast to land and settle before its resting height means anything. */
const SETTLE_MS = 2_000;
const CATCH_PICKUP_MS = 8_000;
const CATCH_PICKUP_RANGE = 12;
/** Kept back from the budget so the action reports rather than being timed out. */
const RESERVE_MS = 8_000;
const WALK_BUDGET_MS = 15_000;
/** Close enough to cast into it, and far enough to stand dry. */
const CAST_RANGE = 5;

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

export function createFishingActions(ctx: ActionContext) {
  const { bot, runner } = ctx;

  /** Open water to cast into: a water block with air above it. */
  function nearestWater(): Block | null {
    const water = bot.registry.blocksByName['water']?.id;
    if (water === undefined) return null;
    for (const position of bot.findBlocks({ matching: water, maxDistance: WATER_SEARCH, count: 30 })) {
      const above = bot.blockAt(position.offset(0, 1, 0));
      if (above !== null && above.boundingBox === 'empty' && above.name !== 'water') {
        return bot.blockAt(position);
      }
    }
    return null;
  }

  function countItem(name: string): number {
    return bot.inventory
      .items()
      .filter((i) => i.name === name)
      .reduce((sum, i) => sum + i.count, 0);
  }

  /**
   * Cast, watch the float, and reel in when a fish takes it.
   *
   * Not bot.fish(): mineflayer decides a fish has bitten when it sees a
   * particle packet of type "fishing" or "bubble" with exactly 6 particles
   * near the bobber, and this server sends "splash" with two or three. Traced
   * in the arena -- the bobber sat in the water for 40 seconds while
   * mineflayer waited for a packet that never came.
   *
   * What a player watches for works instead: the float dips underwater.
   */
  async function castAndWait(signal: AbortSignal): Promise<boolean> {
    bot.activateItem();
    const deadline = Date.now() + BITE_TIMEOUT_MS;
    let resting: number | null = null;
    const settledAt = Date.now() + SETTLE_MS;

    while (Date.now() < deadline && !signal.aborted) {
      await sleep(POLL_MS);
      const bobber = Object.values(bot.entities).find((e) => e.name === 'fishing_bobber');
      if (bobber === undefined) continue;
      if (Date.now() < settledAt) continue;
      if (resting === null) {
        resting = bobber.position.y;
        continue;
      }
      if (bobber.position.y < resting - BITE_DIP) {
        bot.activateItem();
        return true;
      }
      // Drift with the water, slowly, rather than treating a wave as a bite.
      resting = resting * 0.9 + bobber.position.y * 0.1;
    }

    // Reel the line back in, so the next cast starts from nothing.
    bot.activateItem();
    await sleep(300);
    return false;
  }

  /** Walk over what was caught if it did not fly all the way home. */
  async function collectCatch(signal: AbortSignal): Promise<void> {
    const deadline = Date.now() + CATCH_PICKUP_MS;
    for (let visited = 0; visited < 2 && Date.now() < deadline && !signal.aborted; visited++) {
      const drop = Object.values(bot.entities)
        .filter((e) => e.name === 'item')
        // Shallow water is fine to step into -- a catch often lands at the
        // water's edge. Deep water is not: wading in after a fish is exactly
        // what fishing is meant to avoid, and an arena run swam out for one.
        .filter((e) => {
          const at = e.position.floored();
          if (bot.blockAt(at)?.name !== 'water') return true;
          return bot.blockAt(at.offset(0, -1, 0))?.name !== 'water';
        })
        .map((e) => ({ e, d: e.position.distanceTo(bot.entity.position) }))
        .filter(({ d }) => d <= CATCH_PICKUP_RANGE)
        .sort((a, b) => a.d - b.d)[0];
      if (drop === undefined) return;
      const at = drop.e.position;
      await navigateTo(bot, at.x, at.y, at.z, 0, Math.max(2_000, deadline - Date.now()), signal);
      await sleep(400);
    }
  }

  return {
    /** Cast into nearby water and reel in whatever bites. */
    async fish(requested = 1, timeoutMs?: number): Promise<ActionResult> {
      const casts = Math.max(1, Math.min(MAX_CASTS, Math.trunc(requested)));
      const budget = timeoutMs ?? WALK_BUDGET_MS + casts * BITE_TIMEOUT_MS + 5_000;
      return runner.run({ action: 'fish', eventType: 'item_collected', timeoutMs: budget }, async (signal) => {
        const rod = bot.inventory.items().find((i) => i.name === ROD);
        if (rod === undefined) {
          throw new ActionFailure(
            'insufficient_items',
            'no fishing_rod -- craft one from 3 sticks and 2 string at a crafting table (spiders drop string)',
          );
        }

        const water = nearestWater();
        if (water === null) {
          throw new ActionFailure('not_found', `no open water within ${WATER_SEARCH} blocks`);
        }

        // Stand back from the edge rather than in it: the point of fishing is
        // to stay out of the water.
        const p = water.position;
        if (bot.entity.position.distanceTo(p.offset(0.5, 0.5, 0.5)) > CAST_RANGE) {
          await navigateTo(bot, p.x, p.y + 1, p.z, CAST_RANGE - 1, WALK_BUDGET_MS, signal);
        }
        const distance = bot.entity.position.distanceTo(p.offset(0.5, 0.5, 0.5));
        if (distance > CAST_RANGE + 2) {
          throw new ActionFailure('unreachable', `could not get to the water at ${p.x},${p.y},${p.z} (${distance.toFixed(1)}m)`);
        }

        await bot.equip(rod, 'hand');

        const before = bot.inventory.items().reduce((n, i) => n + i.count, 0);
        const caught: string[] = [];
        let bites = 0;

        // Keeps fishing until it has what was asked for or the budget runs
        // out. A dip in the float is not always a fish: a wave can look like
        // one, and the line comes up empty. That is a false alarm to cast
        // again after, not a failure -- which is what a person does.
        const until = Date.now() + budget - RESERVE_MS;
        let landed = 0;
        let falseAlarms = 0;

        while (landed < casts && Date.now() < until && !signal.aborted) {
          const held = bot.inventory.items().reduce((n, i) => n + i.count, 0);
          if (!(await castAndWait(signal))) break;
          bites++;

          // What was caught flies at the bot and is picked up on the way --
          // unless something is in the way, which in the arena was the wall of
          // the pool and outdoors is any bank it clips. Walk over it.
          await sleep(1_200);
          if (bot.inventory.items().reduce((n, i) => n + i.count, 0) <= held) await collectCatch(signal);

          if (bot.inventory.items().reduce((n, i) => n + i.count, 0) > held) {
            landed++;
            for (const item of bot.inventory.items()) {
              if (!caught.includes(item.name) && item.name !== ROD) caught.push(item.name);
            }
          } else {
            falseAlarms++;
          }
        }

        const gainedTotal = bot.inventory.items().reduce((n, i) => n + i.count, 0) - before;
        if (gainedTotal <= 0 && bites === 0) {
          throw new ActionFailure('timeout', `cast into the water at ${p.x},${p.y},${p.z}, but nothing bit`, {
            water: toPosition(p),
          });
        }
        if (gainedTotal <= 0) {
          throw new ActionFailure(
            'failed',
            `${bites} bite(s), but the catch is not in your inventory -- it may have landed in the water, ` +
              'where picking it up would mean swimming. Fish from a bank you can stand on.',
            { water: toPosition(p) },
          );
        }
        return {
          casts: bites,
          ...(falseAlarms > 0 ? { emptyLines: falseAlarms } : {}),
          caught: caught.join(', ') || 'something',
          items: gainedTotal,
          water: toPosition(p),
          rodLeft: countItem(ROD),
          note: 'raw fish restores little; smelt_item cooks it for more than twice as much',
        };
      });
    },
  };
}

export type FishingActions = ReturnType<typeof createFishingActions>;
