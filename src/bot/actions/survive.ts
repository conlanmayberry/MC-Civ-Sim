/**
 * Placing, eating and equipping -- the actions that keep an agent alive and let
 * it change the world.
 *
 * `placeBlock` carries the most Minecraft-specific detail. You cannot place a
 * block at a coordinate directly: you place it *against* an existing block, and
 * the face you click decides where it lands. So the work is finding a solid
 * neighbour of the target position and deriving the face vector back towards
 * the empty space. Getting this wrong is the difference between "placed" and a
 * silent no-op, which is why the result is verified against the world
 * afterwards rather than trusted.
 */

import type { Bot } from 'mineflayer';
import { Vec3 } from 'vec3';

import type { ActionContext } from './run.ts';
import { ActionFailure } from './run.ts';
import type { ActionResult } from './types.ts';
import { toPosition } from './types.ts';

/**
 * Just above mineflayer's own 5s placement ack window.
 *
 * It was 20s, and 85 of 131 placements burned the whole budget before failing.
 * A placement either lands within a few seconds or it is not going to, and a
 * fast failure is worth far more to the agent than a slow one: it gets the
 * feedback while the situation is still the one it decided about.
 */
export const DEFAULT_PLACE_TIMEOUT_MS = 9_000;
export const DEFAULT_EAT_TIMEOUT_MS = 15_000;

/** The six neighbours of a block, with the face vector pointing back at it. */
const FACES: Array<{ offset: Vec3; face: Vec3 }> = [
  { offset: new Vec3(0, -1, 0), face: new Vec3(0, 1, 0) },
  { offset: new Vec3(0, 1, 0), face: new Vec3(0, -1, 0) },
  { offset: new Vec3(-1, 0, 0), face: new Vec3(1, 0, 0) },
  { offset: new Vec3(1, 0, 0), face: new Vec3(-1, 0, 0) },
  { offset: new Vec3(0, 0, -1), face: new Vec3(0, 0, 1) },
  { offset: new Vec3(0, 0, 1), face: new Vec3(0, 0, -1) },
];

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

export function createSurviveActions(ctx: ActionContext) {
  const { bot, runner } = ctx;

  function findItem(name: string) {
    return bot.inventory.items().find((i) => i.name === name) ?? null;
  }

  return {
    /** Equip an item from the inventory by name. */
    async equipItem(
      itemName: string,
      destination: 'hand' | 'head' | 'torso' | 'legs' | 'feet' | 'off-hand' = 'hand',
    ): Promise<ActionResult> {
      return runner.run(
        { action: 'equip_item', eventType: 'observation', timeoutMs: 10_000 },
        async () => {
          const item = findItem(itemName);
          if (item === null) {
            throw new ActionFailure('insufficient_items', `no ${itemName} in inventory`);
          }
          await bot.equip(item, destination);
          return { item: itemName, destination };
        },
      );
    },

    /**
     * Place a block at a coordinate.
     *
     * The position must be empty and have at least one solid neighbour to place
     * against.
     */
    async placeBlock(
      itemName: string,
      x: number,
      y: number,
      z: number,
      timeoutMs = DEFAULT_PLACE_TIMEOUT_MS,
    ): Promise<ActionResult> {
      return runner.run(
        { action: 'place_block', eventType: 'block_placed', timeoutMs },
        async () => {
          if (![x, y, z].every(Number.isFinite)) {
            throw new ActionFailure('invalid_argument', 'coordinates must be finite numbers');
          }

          const item = findItem(itemName);
          if (item === null) {
            throw new ActionFailure('insufficient_items', `no ${itemName} in inventory`);
          }

          const target = new Vec3(Math.floor(x), Math.floor(y), Math.floor(z));
          const existing = bot.blockAt(target);
          if (existing === null) {
            throw new ActionFailure('not_found', 'target position is not loaded');
          }
          if (existing.boundingBox !== 'empty') {
            throw new ActionFailure('blocked', `${existing.name} already occupies that position`);
          }
          // Remembered so the placement can be verified by CHANGE rather than
          // by solidity -- see below.
          const before = existing.name;

          // You cannot place a block where you are standing, and the server
          // silently refuses rather than saying so -- which showed up as a
          // timeout. It comes up constantly when an agent walls itself in, so
          // the message says what to do about it.
          const feet = bot.entity.position.floored();
          if (target.equals(feet) || target.equals(feet.offset(0, 1, 0))) {
            throw new ActionFailure(
              'blocked',
              'you are standing there -- move aside before placing a block in your own space',
            );
          }

          // A block is placed against a neighbour's face, not into thin air.
          const anchor = FACES.map((f) => ({
            block: bot.blockAt(target.plus(f.offset)),
            face: f.face,
          })).find((candidate) => candidate.block !== null && candidate.block.boundingBox === 'block');

          if (anchor === undefined || anchor.block === null) {
            throw new ActionFailure(
              'blocked',
              'nothing solid adjacent to place against (all six neighbours are empty)',
            );
          }

          if (bot.entity.position.distanceTo(target) > 5) {
            throw new ActionFailure(
              'unreachable',
              `target is ${bot.entity.position.distanceTo(target).toFixed(1)}m away; move closer first`,
            );
          }

          await bot.equip(item, 'hand');

          // Face the spot before placing. mineflayer looks at it internally,
          // but doing it forcibly first settles the rotation in one tick
          // instead of animating over several while the placement is sent.
          try {
            await bot.lookAt(target.offset(0.5, 0.5, 0.5), true);
          } catch {
            /* not fatal; the placement may still be accepted */
          }

          let placeError: string | null = null;
          try {
            await bot.placeBlock(anchor.block, anchor.face);
          } catch (err) {
            // Not necessarily a failure. mineflayer throws when it does not see
            // the acknowledging block update, which also happens when the ack
            // is merely lost or arrives out of order -- so the world decides,
            // not the exception.
            placeError = err instanceof Error ? err.message : String(err);
          }

          await sleep(250);

          // Verified by CHANGE, not by solidity.
          //
          // Checking `boundingBox === 'empty'` meant a torch could never
          // succeed: torches have no collision box, so a perfectly good torch
          // read as "still empty, so nothing was placed". The agent was told
          // its light had failed, tried again, and was told the same thing
          // seven times running while standing in a lit shelter -- which is
          // most of why its shelters end up unfinished. The same was true of
          // every non-solid block: saplings, carpets, redstone, signs, plants.
          const placed = bot.blockAt(target);
          const changed = placed !== null && placed.name !== before && placed.name !== 'air';
          if (!changed) {
            throw new ActionFailure(
              'failed',
              placeError === null
                ? 'the server did not accept the placement'
                : `placement rejected: ${placeError}`,
            );
          }

          return {
            item: itemName,
            placed: placed.name,
            at: toPosition(target),
            against: toPosition(anchor.block.position),
          };
        },
      );
    },

    /**
     * Eat the best available food.
     *
     * "Best" is the highest food value that does not overshoot what is missing,
     * falling back to the highest available -- wasting a steak to top up half a
     * hunger point is a real cost when food is scarce.
     */
    async eatFood(timeoutMs = DEFAULT_EAT_TIMEOUT_MS): Promise<ActionResult> {
      return runner.run(
        { action: 'eat_food', eventType: 'item_consumed', timeoutMs },
        async () => {
          if (bot.food >= 20) {
            throw new ActionFailure('blocked', 'not hungry (food is already 20)');
          }

          const foods = bot.registry.foodsByName;
          const edible = bot.inventory
            .items()
            .map((item) => ({ item, food: foods[item.name] }))
            .filter((entry) => entry.food !== undefined);

          if (edible.length === 0) {
            throw new ActionFailure('insufficient_items', 'no food in inventory');
          }

          const missing = 20 - bot.food;
          const sorted = [...edible].sort(
            (a, b) => (b.food?.foodPoints ?? 0) - (a.food?.foodPoints ?? 0),
          );
          const chosen =
            sorted.filter((e) => (e.food?.foodPoints ?? 0) <= missing).at(0) ?? sorted.at(-1);

          if (chosen === undefined) {
            throw new ActionFailure('insufficient_items', 'no food in inventory');
          }

          const foodBefore = bot.food;
          await bot.equip(chosen.item, 'hand');
          await bot.consume();
          await sleep(300);

          return {
            item: chosen.item.name,
            foodBefore,
            foodAfter: bot.food,
            restored: bot.food - foodBefore,
          };
        },
      );
    },
  };
}

export type SurviveActions = ReturnType<typeof createSurviveActions>;
