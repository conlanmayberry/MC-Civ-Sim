/**
 * Crafting.
 *
 * Three things make this more than a call to `bot.craft`:
 *
 * ITEMS vs REPETITIONS. `bot.craft(recipe, count)` runs the recipe `count`
 * TIMES, while `bot.recipesFor(id, meta, minResultCount, table)` filters by the
 * number of resulting ITEMS. Conflating them is not a rounding error: asking
 * for "4 sticks" ran the recipe four times, wanted eight planks, found seven,
 * and left mineflayer waiting forever on a slot update that never came
 * ("Event updateSlot:0 did not fire"). This module takes a count of ITEMS --
 * which is what a caller, and later a model, actually means -- and converts.
 *
 * The 2x2 / 3x3 distinction. `bot.recipesFor(id, null, count, table)` returns
 * only recipes craftable RIGHT NOW with what is in the inventory, and the last
 * argument decides whether 3x3 recipes count. So we ask twice: first without a
 * table (inventory grid), then with. Only if the 3x3 answer is non-empty and the
 * 2x2 answer is empty do we actually need a table -- asking in that order avoids
 * walking to a table to craft sticks.
 *
 * Telling "no recipe" from "not enough materials". Both come back as an empty
 * array, which would collapse two very different situations into one unhelpful
 * error. `bot.recipesAll` ignores the inventory, so if it returns recipes and
 * `recipesFor` does not, the difference is materials -- and that is the
 * `insufficient_items` an agent can actually act on.
 */

import type { Bot } from 'mineflayer';
import type { Block } from 'prismarine-block';

import { navigateTo } from './movement.ts';
import type { ActionContext } from './run.ts';
import { ActionFailure } from './run.ts';
import type { ActionResult } from './types.ts';
import { toPosition } from './types.ts';

const TABLE_SEARCH_RADIUS = 32;
/** Poll the inventory this many times before believing a craft produced nothing. */
const INVENTORY_SETTLE_ATTEMPTS = 6;
const INVENTORY_SETTLE_MS = 150;

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
/** Crafting tables must be within interaction reach to use. */
const TABLE_REACH = 3;

export const DEFAULT_CRAFT_TIMEOUT_MS = 45_000;

function inventoryCount(bot: Bot, name: string): number {
  return bot.inventory
    .items()
    .filter((i) => i.name === name)
    .reduce((sum, i) => sum + i.count, 0);
}

export function createCraftActions(ctx: ActionContext) {
  const { bot, runner } = ctx;

  return {
    /** Craft `count` of an item by name, finding a crafting table if needed. */
    async craftItem(
      itemName: string,
      count = 1,
      timeoutMs = DEFAULT_CRAFT_TIMEOUT_MS,
    ): Promise<ActionResult> {
      return runner.run(
        { action: 'craft_item', eventType: 'item_crafted', timeoutMs },
        async (signal) => {
          const item = bot.registry.itemsByName[itemName];
          if (item === undefined) {
            throw new ActionFailure('invalid_argument', `no such item: ${itemName}`);
          }

          if (!Number.isInteger(count) || count < 1) {
            throw new ActionFailure('invalid_argument', `count must be a positive integer`);
          }

          const before = inventoryCount(bot, itemName);

          // `count` here is a number of ITEMS, and recipesFor filters by items
          // the inventory can actually supply -- so a recipe coming back is
          // already proof the materials exist.
          // Inventory grid first: cheapest, and most early recipes fit.
          let recipe = bot.recipesFor(item.id, null, count, null)[0];
          let table: Block | null = null;

          if (recipe === undefined) {
            const tableRecipe = bot.recipesFor(item.id, null, count, true)[0];

            if (tableRecipe === undefined) {
              // Nothing craftable either way -- distinguish why.
              const anyRecipe = bot.recipesAll(item.id, null, true);
              throw anyRecipe.length === 0
                ? new ActionFailure('invalid_argument', `${itemName} has no crafting recipe`)
                : new ActionFailure(
                    'insufficient_items',
                    `missing materials for ${itemName} (${anyRecipe.length} recipe(s) exist)`,
                  );
            }

            table = bot.findBlock({
              matching: bot.registry.blocksByName['crafting_table']?.id ?? -1,
              maxDistance: TABLE_SEARCH_RADIUS,
            });
            if (table === null) {
              throw new ActionFailure(
                'not_found',
                `${itemName} needs a crafting table and none is within ${TABLE_SEARCH_RADIUS} blocks`,
              );
            }

            if (bot.entity.position.distanceTo(table.position) > TABLE_REACH) {
              const nav = await navigateTo(
                bot,
                table.position.x,
                table.position.y,
                table.position.z,
                TABLE_REACH - 1,
                Math.max(5_000, timeoutMs - 5_000),
                signal,
              );
              if (!nav.ok && bot.entity.position.distanceTo(table.position) > TABLE_REACH) {
                throw new ActionFailure(
                  'unreachable',
                  `could not reach the crafting table: ${nav.outcome}, ${nav.remaining}m short`,
                );
              }
            }

            recipe = tableRecipe;
          }

          // Convert items -> repetitions. A stick recipe yields 4 per craft, so
          // asking for 4 sticks is ONE repetition, not four.
          const perCraft = Math.max(1, recipe.result?.count ?? 1);
          const times = Math.ceil(count / perCraft);

          await bot.craft(recipe, times, table ?? undefined);

          // bot.craft resolves when the crafting transaction is acknowledged,
          // which can be before the resulting inventory update arrives -- fast
          // crafts finish in tens of milliseconds. Counting immediately reports
          // a real success as "produced nothing", so wait for the inventory to
          // actually reflect it before judging.
          let gained = 0;
          for (let attempt = 0; attempt < INVENTORY_SETTLE_ATTEMPTS; attempt++) {
            await sleep(INVENTORY_SETTLE_MS);
            gained = inventoryCount(bot, itemName) - before;
            if (gained > 0) break;
          }

          if (gained <= 0) {
            // Genuinely nothing: the window closed early or the materials went
            // elsewhere. Report it rather than claiming a success the inventory
            // contradicts.
            throw new ActionFailure('failed', `crafting ${itemName} produced nothing`);
          }

          return {
            item: itemName,
            requested: count,
            crafts: times,
            perCraft,
            gained,
            usedCraftingTable: table !== null,
            ...(table === null ? {} : { tableAt: toPosition(table.position) }),
          };
        },
      );
    },
  };
}

export type CraftActions = ReturnType<typeof createCraftActions>;
