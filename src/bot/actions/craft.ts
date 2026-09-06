/**
 * Crafting.
 *
 * Two things make this more than a call to `bot.craft`:
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

          const before = inventoryCount(bot, itemName);

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

          await bot.craft(recipe, count, table ?? undefined);

          const gained = inventoryCount(bot, itemName) - before;
          if (gained <= 0) {
            // craft() resolving without producing anything means the window
            // closed early or materials vanished. Report it rather than
            // claiming a success the inventory contradicts.
            throw new ActionFailure('failed', `crafting ${itemName} produced nothing`);
          }

          return {
            item: itemName,
            requested: count,
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
