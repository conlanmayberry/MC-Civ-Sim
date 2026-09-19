/**
 * Furnaces and chests: cooking, smelting, and keeping things somewhere.
 *
 * Cooking matters because hunting alone is a thin diet. Raw beef restores 3
 * hunger; cooked, 8. With only raw meat an agent spends a large share of its
 * turns eating, and the 2026-09-16 session showed where that goes -- agents
 * that ran out of food spent their remaining turns asking each other for some.
 *
 * Chests matter because the only way to share anything was give_item, which is
 * a drop that the recipient has to notice and pick up before it despawns. 4
 * of 4 handovers to Alice in that session were never collected. A chest is a
 * handover that does not need both people in the same place at the same time,
 * and a stockpile a group can build up -- which is most of what a settlement is.
 */

import type { Block } from 'prismarine-block';
import { Vec3 } from 'vec3';

import { navigateTo } from './movement.ts';
import type { ActionContext } from './run.ts';
import { ActionFailure } from './run.ts';
import type { ActionResult } from './types.ts';
import { toPosition } from './types.ts';

const SEARCH_RADIUS = 16;
const USE_RANGE = 2;
const WALK_BUDGET_MS = 20_000;
/** Vanilla: 10s an item in a furnace, 5s in a smoker or blast furnace. */
const FURNACE_ITEM_MS = 10_000;
const FAST_ITEM_MS = 5_000;
/** The longest smelt_item waits at the furnace before leaving the rest cooking. */
const MAX_WAIT_MS = 60_000;
const POLL_MS = 500;
const STORAGE = ['chest', 'trapped_chest', 'barrel'];

/**
 * Fuel, best use first, with how many items one unit smelts. Planks before
 * logs on purpose: a log makes four planks, which smelt six items between
 * them against a log's one and a half.
 */
const FUELS: Array<{ match: (name: string) => boolean; perUnit: number }> = [
  { match: (n) => n === 'coal' || n === 'charcoal', perUnit: 8 },
  { match: (n) => n.endsWith('_planks'), perUnit: 1.5 },
  { match: (n) => n === 'stick', perUnit: 0.5 },
  { match: (n) => n.endsWith('_log') || n.endsWith('_wood') || n.endsWith('_stem'), perUnit: 1.5 },
  { match: (n) => n === 'coal_block', perUnit: 80 },
  { match: (n) => n === 'blaze_rod', perUnit: 12 },
];

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/** Inventory as name -> count, for describing what changed. */
function tally(items: Array<{ name: string; count: number }>): Record<string, number> {
  const out: Record<string, number> = {};
  for (const item of items) out[item.name] = (out[item.name] ?? 0) + item.count;
  return out;
}

/** "12x cobblestone, 4x bread, ..." -- the first dozen kinds, most first. */
export function describeContents(items: Array<{ name: string; count: number }>): string {
  const entries = Object.entries(tally(items)).sort((a, b) => b[1] - a[1]);
  if (entries.length === 0) return 'empty';
  const shown = entries.slice(0, 12).map(([name, count]) => `${count}x ${name}`);
  return entries.length > 12 ? `${shown.join(', ')}, and ${entries.length - 12} more kinds` : shown.join(', ');
}

function countIn(items: Array<{ name: string; count: number }>, name: string): number {
  return items.filter((i) => i.name === name).reduce((sum, i) => sum + i.count, 0);
}

/** How many units of a fuel are needed to smelt `items` items. */
export function fuelUnitsFor(items: number, perUnit: number): number {
  return Math.max(1, Math.ceil(items / perUnit));
}

export function createContainerActions(ctx: ActionContext) {
  const { bot, runner } = ctx;

  function count(name: string): number {
    return bot.inventory
      .items()
      .filter((i) => i.name === name)
      .reduce((sum, i) => sum + i.count, 0);
  }

  function nearestBlock(names: string[]): Block | null {
    const ids = names.map((n) => bot.registry.blocksByName[n]?.id).filter((id): id is number => id !== undefined);
    if (ids.length === 0) return null;
    return bot.findBlock({ matching: ids, maxDistance: SEARCH_RADIUS });
  }

  async function walkTo(block: Block, signal: AbortSignal): Promise<void> {
    if (bot.entity.position.distanceTo(block.position.offset(0.5, 0.5, 0.5)) <= USE_RANGE + 1.5) return;
    const p = block.position;
    await navigateTo(bot, p.x + 0.5, p.y, p.z + 0.5, USE_RANGE, WALK_BUDGET_MS, signal);
    const distance = bot.entity.position.distanceTo(p.offset(0.5, 0.5, 0.5));
    if (distance > 4.5) {
      throw new ActionFailure('unreachable', `could not get to the ${block.name} at ${p.x},${p.y},${p.z} (${distance.toFixed(1)}m away)`);
    }
  }

  /** Put a carried furnace down on open ground next to us. */
  async function placeCarriedFurnace(): Promise<Block | null> {
    const item = bot.inventory.items().find((i) => i.name === 'furnace');
    if (item === undefined) return null;
    const feet = bot.entity.position.floored();
    for (const [dx, dz] of [[2, 0], [-2, 0], [0, 2], [0, -2], [1, 1], [-1, -1], [1, -1], [-1, 1]]) {
      const spot = feet.offset(dx ?? 0, 0, dz ?? 0);
      const floor = bot.blockAt(spot.offset(0, -1, 0));
      const space = bot.blockAt(spot);
      if (floor === null || floor.boundingBox !== 'block' || space === null || space.boundingBox !== 'empty') continue;
      await bot.equip(item, 'hand');
      try {
        await bot.placeBlock(floor, new Vec3(0, 1, 0));
      } catch {
        // mineflayer's placement ack is unreliable; the world is the truth.
      }
      await sleep(300);
      const placed = bot.blockAt(spot);
      if (placed !== null && placed.name === 'furnace') return placed;
    }
    return null;
  }

  return {
    /**
     * Cook or smelt items in a furnace: nearby, or the one being carried.
     *
     * Waits at the furnace for up to a minute and takes out what is done. What
     * is not done by then keeps cooking, and a later call collects it.
     */
    async smeltItem(itemName: string, requested: number, timeoutMs?: number): Promise<ActionResult> {
      const wanted = Math.max(1, Math.min(64, Math.trunc(requested)));
      const budget = timeoutMs ?? Math.min(MAX_WAIT_MS, wanted * FURNACE_ITEM_MS + 3_000) + WALK_BUDGET_MS + 8_000;
      return runner.run({ action: 'smelt_item', eventType: 'item_crafted', timeoutMs: budget }, async (signal) => {
        const input = bot.inventory.items().find((i) => i.name === itemName);

        const isFood = bot.registry.foodsByName[itemName] !== undefined;
        const kinds = isFood ? ['smoker', 'furnace'] : itemName.startsWith('raw_') || itemName.endsWith('_ore') ? ['blast_furnace', 'furnace'] : ['furnace'];
        let block = nearestBlock(kinds);
        let placedOne = false;
        if (block === null) {
          block = await placeCarriedFurnace();
          placedOne = block !== null;
        }
        if (block === null) {
          throw new ActionFailure(
            'not_found',
            `no furnace within ${SEARCH_RADIUS} blocks and none carried -- craft one from 8 cobblestone at a crafting table, then place_block it or carry it`,
          );
        }
        await walkTo(block, signal);

        const furnace = await bot.openFurnace(block);
        const perItemMs = block.name === 'furnace' ? FURNACE_ITEM_MS : FAST_ITEM_MS;
        const produced: Record<string, number> = {};
        const takeOutput = async (): Promise<void> => {
          const out = furnace.outputItem();
          if (out === null || out === undefined || out.count === 0) return;
          const taken = await furnace.takeOutput();
          produced[taken.name] = (produced[taken.name] ?? 0) + taken.count;
        };

        try {
          // Whatever finished since last time is ours first.
          await takeOutput();

          const inSlot = furnace.inputItem();
          if (inSlot !== null && inSlot !== undefined && inSlot.name !== itemName) {
            throw new ActionFailure('blocked', `that furnace is busy with ${inSlot.count}x ${inSlot.name}`);
          }

          let loaded = 0;
          if (input !== undefined) {
            const amount = Math.min(wanted, count(itemName));
            // Fuel for what is being added, less what the fuel slot already holds.
            const fuelSlot = furnace.fuelItem();
            let covered = 0;
            if (fuelSlot !== null && fuelSlot !== undefined) {
              const kind = FUELS.find((f) => f.match(fuelSlot.name));
              covered = kind === undefined ? 0 : fuelSlot.count * kind.perUnit;
            }
            if (covered < amount) {
              const fuel = FUELS.flatMap((f) =>
                bot.inventory
                  .items()
                  .filter((i) => i.name !== itemName && f.match(i.name))
                  .map((i) => ({ item: i, perUnit: f.perUnit })),
              )[0];
              if (fuel === undefined && covered === 0) {
                throw new ActionFailure(
                  'insufficient_items',
                  'nothing to burn -- a furnace needs fuel: coal, charcoal, planks, logs or sticks',
                );
              }
              if (fuel !== undefined) {
                const units = Math.min(count(fuel.item.name), fuelUnitsFor(amount - covered, fuel.perUnit));
                await furnace.putFuel(fuel.item.type, null, units);
              }
            }
            await furnace.putInput(input.type, null, amount);
            loaded = amount;
          } else if (Object.keys(produced).length === 0 && (inSlot === null || inSlot === undefined)) {
            throw new ActionFailure('insufficient_items', `no ${itemName} in inventory, and nothing waiting in the furnace`);
          }

          // Wait for it, taking each finished item out so the output slot
          // never fills and stalls the furnace.
          const waitUntil = Date.now() + Math.min(MAX_WAIT_MS, loaded * perItemMs + 3_000, budget - 10_000);
          while (Date.now() < waitUntil && !signal.aborted) {
            await sleep(POLL_MS);
            await takeOutput();
            const remaining = furnace.inputItem();
            if ((remaining === null || remaining === undefined) && (furnace.outputItem() ?? null) === null) break;
            const fuelLeft = furnace.fuelItem();
            if ((fuelLeft === null || fuelLeft === undefined) && furnace.fuel === 0 && furnace.progress === 0) break;
          }
          await takeOutput();

          const stillIn = furnace.inputItem();
          const madeTotal = Object.values(produced).reduce((a, b) => a + b, 0);
          if (madeTotal === 0 && (stillIn === null || stillIn === undefined)) {
            throw new ActionFailure('failed', `nothing came out of the furnace -- ${itemName} may not be smeltable`);
          }
          return {
            item: itemName,
            produced,
            furnace: { ...toPosition(block.position), kind: block.name, placedJustNow: placedOne },
            ...(stillIn !== null && stillIn !== undefined
              ? {
                  stillCooking: stillIn.count,
                  note: `${stillIn.count}x ${stillIn.name} is still in the furnace; call smelt_item again here later to collect it`,
                }
              : {}),
          };
        } finally {
          try {
            furnace.close();
          } catch {
            /* already closed */
          }
        }
      });
    },

    /** Put items into the nearest chest or barrel. */
    async storeItems(itemName: string, requested: number | null, timeoutMs = 30_000): Promise<ActionResult> {
      return runner.run({ action: 'store_items', eventType: 'item_given', timeoutMs }, async (signal) => {
        const have = count(itemName);
        if (have === 0) throw new ActionFailure('insufficient_items', `no ${itemName} in inventory`);
        const amount = Math.min(have, requested ?? have);

        const block = nearestBlock(STORAGE);
        if (block === null) {
          throw new ActionFailure(
            'not_found',
            `no chest or barrel within ${SEARCH_RADIUS} blocks -- craft a chest from 8 planks and place_block it`,
          );
        }
        await walkTo(block, signal);
        const chest = await bot.openContainer(block);
        try {
          const item = bot.inventory.items().find((i) => i.name === itemName);
          if (item === undefined) throw new ActionFailure('insufficient_items', `no ${itemName} in inventory`);
          // Counted on the chest's side: while its window is open the player's
          // own inventory view lags the transfer, and read that way a
          // successful deposit looked like nothing had moved.
          const inChestBefore = countIn(chest.containerItems(), itemName);
          try {
            await chest.deposit(item.type, null, amount);
          } catch (err) {
            const message = err instanceof Error ? err.message : String(err);
            throw new ActionFailure('blocked', `could not put it in: ${message.includes('full') ? 'the chest is full' : message}`);
          }
          const stored = countIn(chest.containerItems(), itemName) - inChestBefore;
          if (stored <= 0) throw new ActionFailure('failed', 'the chest did not accept anything');
          return {
            item: itemName,
            stored,
            chest: toPosition(block.position),
            nowInChest: describeContents(chest.containerItems()),
          };
        } finally {
          try {
            chest.close();
          } catch {
            /* already closed */
          }
        }
      });
    },

    /** Take items out of the nearest chest or barrel -- or just look inside. */
    async takeItems(itemName: string | null, requested: number | null, timeoutMs = 30_000): Promise<ActionResult> {
      return runner.run({ action: 'take_items', eventType: 'item_collected', timeoutMs }, async (signal) => {
        const block = nearestBlock(STORAGE);
        if (block === null) {
          throw new ActionFailure('not_found', `no chest or barrel within ${SEARCH_RADIUS} blocks`);
        }
        await walkTo(block, signal);
        const chest = await bot.openContainer(block);
        try {
          const contents = chest.containerItems();
          if (itemName === null) {
            return { chest: toPosition(block.position), contents: describeContents(contents), took: 0 };
          }
          const available = contents.filter((i) => i.name === itemName).reduce((sum, i) => sum + i.count, 0);
          if (available === 0) {
            throw new ActionFailure(
              'not_found',
              `no ${itemName} in that chest; it holds ${describeContents(contents)}`,
            );
          }
          const type = contents.find((i) => i.name === itemName)?.type ?? 0;
          try {
            await chest.withdraw(type, null, Math.min(available, requested ?? available));
          } catch (err) {
            const message = err instanceof Error ? err.message : String(err);
            throw new ActionFailure('blocked', `could not take it: ${message.includes('full') ? 'your inventory is full' : message}`);
          }
          const took = available - countIn(chest.containerItems(), itemName);
          if (took <= 0) throw new ActionFailure('failed', 'nothing came out of the chest');
          return {
            item: itemName,
            took,
            chest: toPosition(block.position),
            leftInChest: describeContents(chest.containerItems()),
          };
        } finally {
          try {
            chest.close();
          } catch {
            /* already closed */
          }
        }
      });
    },
  };
}

export type ContainerActions = ReturnType<typeof createContainerActions>;

