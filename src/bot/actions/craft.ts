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
/**
 * How close mineflayer needs to be for the table window to open.
 *
 * Measured from the eye to the block centre, like canDigBlock -- not feet to
 * corner. Getting this wrong produced "Event windowOpen did not fire": the
 * distance check passed, the craft went ahead, and the server ignored it
 * because the bot was actually out of range.
 */
const TABLE_INTERACT_RANGE = 3.5;
/** Poll the inventory this many times before believing a craft produced nothing. */
const INVENTORY_SETTLE_ATTEMPTS = 6;
const INVENTORY_SETTLE_MS = 150;

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
/** Goal range when walking to a table -- comfortably inside interaction range. */
const TABLE_REACH = 2;

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

            // Bound to a const so the null check narrows inside the closure
            // below; `table` is a let and TypeScript cannot carry narrowing
            // into a callback that could, in principle, run later.
            const foundTable = table;

            // Eye to block centre, matching how the server measures reach.
            const rangeTo = (): number =>
              bot.entity.position
                .offset(0, 1.62, 0)
                .distanceTo(foundTable.position.offset(0.5, 0.5, 0.5));

            if (rangeTo() > TABLE_INTERACT_RANGE) {
              const nav = await navigateTo(
                bot,
                foundTable.position.x,
                foundTable.position.y,
                foundTable.position.z,
                TABLE_REACH,
                Math.max(5_000, timeoutMs - 5_000),
                signal,
              );

              // Arriving is what matters, not pathfinder's verdict -- a wedge
              // one block from the table still leaves it usable.
              if (rangeTo() > TABLE_INTERACT_RANGE) {
                throw new ActionFailure(
                  'unreachable',
                  `cannot reach the crafting table at ${foundTable.position.x},${foundTable.position.y},${foundTable.position.z} ` +
                    `(${nav.outcome}, ${rangeTo().toFixed(1)}m away). ` +
                    `If you have planks, placing a new table beside you is quicker than walking to this one.`,
                );
              }
            }

            // Face it before opening. The window request is sent from where the
            // bot is looking, and an unsettled rotation is one way windowOpen
            // never fires.
            try {
              await bot.lookAt(foundTable.position.offset(0.5, 0.5, 0.5), true);
            } catch {
              /* not fatal */
            }

            recipe = tableRecipe;
          }

          // Convert items -> repetitions. A stick recipe yields 4 per craft, so
          // asking for 4 sticks is ONE repetition, not four.
          const perCraft = Math.max(1, recipe.result?.count ?? 1);
          const times = Math.ceil(count / perCraft);
          let craftError: string | null = null;

          // A window left open from an earlier failure holds items hostage in
          // its grid; starting a new craft on top of that is how materials
          // disappear.
          if (bot.currentWindow !== null) {
            try {
              await bot.closeWindow(bot.currentWindow);
              await sleep(200);
            } catch {
              /* nothing better to try */
            }
          }

          try {
            await bot.craft(recipe, times, table ?? undefined);
          } catch (err) {
            const message = err instanceof Error ? err.message : String(err);
            // Translate mineflayer's internals into something an agent can act
            // on. "Event windowOpen did not fire" tells it nothing; "the table
            // did not open, place one next to you" tells it what to try.
            if (/windowOpen/i.test(message)) {
              throw new ActionFailure(
                'blocked',
                'the crafting table did not open -- you may be too far from it. ' +
                  'Move right next to it, or place a new table beside you.',
              );
            }

            // Do NOT trust this exception. mineflayer throws when it does not
            // observe the slot update it expected, but the craft frequently
            // happened anyway -- and worse, ingredients can be sitting in the
            // grid where they no longer show in the inventory. Close the window
            // to get them back, then let the inventory decide the outcome.
            craftError = message;
          }

          if (bot.currentWindow !== null) {
            try {
              // Closing returns anything left in the grid. Without this, a
              // failed craft silently destroys the materials it staged --
              // observed as 10 planks becoming 0 while producing one item.
              await bot.closeWindow(bot.currentWindow);
              await sleep(250);
            } catch {
              /* nothing better to try */
            }
          }

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
            throw new ActionFailure(
              'failed',
              craftError === null
                ? `crafting ${itemName} produced nothing`
                : `crafting ${itemName} produced nothing (${craftError})`,
            );
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
