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
 * ONE REPETITION AT A TIME. `bot.craft` does not check it can afford the
 * repetitions it was asked for. Measured by tests/probe-crafting.ts on 1.21.8:
 * a single repetition is reliable and takes ~170ms, while two repetitions with
 * materials for one performs the first, throws on the second, and reports the
 * whole call as a failure -- discarding what it just made. So each repetition
 * is done and verified separately, which turns "produced nothing" into "made 4
 * of the 8 you asked for".
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

/**
 * How many times to re-attempt a repetition the server silently rejected.
 *
 * Found by the scenario harness on its first run: crafting at a crafting table
 * "produced nothing", with no error, most of the time. mineflayer's craft does
 * not wait for the server to confirm -- it writes the result into its own copy
 * of the window and resolves -- so a rejected click sequence looks exactly
 * like a craft that happened, until the server resyncs the inventory back.
 * Almost certainly the same bug behind "crafting wooden_hoe produced nothing"
 * in a live session, and part of craft_item's 49% success rate.
 *
 * ROOT CAUSE NOT CONFIRMED, and the measurements say what it is not. Measured
 * against a live 1.21.8 server: not a race with the window's contents
 * (mineflayer already waits for them), not time-dependent (a 2.5s wait before
 * crafting changed nothing), not client inventory desync (a forced resync
 * changed nothing). What it is: a per-attempt rejection that clears after a
 * few tries -- 14 trials needed 1, 1, 2, 2, 3, 3, 4, 4, 4, 4, 5, 7, 7 and 8
 * attempts. Eight retries covers every one observed; the scenario test
 * `craft_to_pickaxe` will say if that stops being enough.
 *
 * Only ever retried when NOTHING was consumed (see inventorySignature below).
 * The standing rule here is that a failed repetition must not be repeated,
 * because failed crafts have stranded materials before; a rejection that left
 * the inventory untouched has nothing to strand.
 */
const SILENT_REJECT_RETRIES = 8;
const SILENT_REJECT_PAUSE_MS = 150;

/** The whole inventory as one comparable string, to tell "rejected" from "consumed". */
function inventorySignature(bot: Bot): string {
  const counts = new Map<string, number>();
  for (const item of bot.inventory.items()) {
    counts.set(item.name, (counts.get(item.name) ?? 0) + item.count);
  }
  return [...counts.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([name, count]) => `${name}:${count}`)
    .join(',');
}

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

          // `count` here is a number of ITEMS. Ask for ONE, not for `count`:
          // getting a recipe back for a large count is not the guarantee it
          // looks like, and the loop below re-checks before every repetition
          // anyway.
          // Inventory grid first: cheapest, and most early recipes fit.
          let recipe = bot.recipesFor(item.id, null, 1, null)[0];
          let table: Block | null = null;

          if (recipe === undefined) {
            const tableRecipe = bot.recipesFor(item.id, null, 1, true)[0];

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

          // ONE REPETITION AT A TIME, re-checked before each.
          //
          // `bot.craft(recipe, n)` does not verify it can afford n. Measured on
          // 1.21.8: one repetition is reliable and takes ~170ms, while two
          // repetitions with materials for one performs the first, throws
          // "missing ingredient" on the second, and reports the whole call as a
          // failure -- discarding the four sticks it just made. In a live run
          // that surfaced as "crafting stick produced nothing", twice, while
          // the planks quietly went down by two each time.
          //
          // Doing them one at a time makes a shortfall a partial success rather
          // than a total failure, and bounds what a single bad repetition can
          // strand in the crafting grid.
          let crafted = 0;
          let done = 0;
          let craftError: string | null = null;
          let silentRejects = 0;

          for (let rep = 0; rep < times; rep++) {
            if (signal.aborted) break;
            const inventoryBefore = inventorySignature(bot);

            // Re-resolve every time: the inventory has changed since the last
            // repetition, and this is the check that "can I still afford it?"
            // actually depends on.
            const next =
              table === null
                ? bot.recipesFor(item.id, null, 1, null)[0]
                : bot.recipesFor(item.id, null, 1, true)[0];

            if (next === undefined) {
              // Out of materials. Not an error if something was made -- the
              // agent asked for more than it could afford, and the honest
              // answer is how many it got.
              break;
            }

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
              await bot.craft(next, 1, table ?? undefined);
            } catch (err) {
              const message = err instanceof Error ? err.message : String(err);
              // Translate mineflayer's internals into something an agent can
              // act on. "Event windowOpen did not fire" tells it nothing; "the
              // table did not open, place one next to you" tells it what to
              // try. Thrown immediately: no amount of repeating fixes reach.
              if (/windowOpen/i.test(message)) {
                throw new ActionFailure(
                  'blocked',
                  'the crafting table did not open -- you may be too far from it. ' +
                    'Move right next to it, or place a new table beside you.',
                );
              }
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

            // bot.craft resolves when the transaction is acknowledged, which
            // can be before the inventory update arrives. Counting immediately
            // reports a real success as "produced nothing", so wait for the
            // inventory to actually reflect it before judging.
            let after = crafted;
            for (let attempt = 0; attempt < INVENTORY_SETTLE_ATTEMPTS; attempt++) {
              await sleep(INVENTORY_SETTLE_MS);
              after = inventoryCount(bot, itemName) - before;
              if (after > crafted) break;
            }

            if (after <= crafted) {
              // Rejected without consuming anything: the server refused the
              // clicks and put the inventory back exactly as it was. Nothing
              // can be stranded by trying again, and trying again works -- see
              // SILENT_REJECT_RETRIES.
              if (
                craftError === null &&
                silentRejects < SILENT_REJECT_RETRIES &&
                inventorySignature(bot) === inventoryBefore
              ) {
                silentRejects++;
                await sleep(SILENT_REJECT_PAUSE_MS);
                rep--;
                continue;
              }

              // Otherwise something was consumed or the craft errored.
              // Repeating it would fail the same way and strand more
              // materials, so stop and report.
              break;
            }

            crafted = after;
            done++;
          }

          if (crafted <= 0) {
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
            gained: crafted,
            crafts: done,
            perCraft,
            // Said plainly, because "gained 4" against "requested 8" is
            // otherwise something the agent has to notice for itself.
            ...(crafted < count
              ? {
                  short: count - crafted,
                  note: `made ${crafted} of the ${count} you asked for -- ${
                    craftError === null ? 'ran out of materials' : craftError
                  }`,
                }
              : {}),
            usedCraftingTable: table !== null,
            ...(table === null ? {} : { tableAt: toPosition(table.position) }),
          };
        },
      );
    },
  };
}

export type CraftActions = ReturnType<typeof createCraftActions>;
