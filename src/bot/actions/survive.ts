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
 * afterwards rather than trusted. It also walks to the target if needed, like
 * mine_block and craft_item already do -- a model planning an eight-block wall
 * should not have to interleave move_to between every piece.
 *
 * `giveItem` exists because nothing else in the tool surface lets one agent
 * actually help another. Watched live: three agents spent several minutes
 * promising food to a fourth who was starving -- "I have bread", "take a
 * berry", "I'll bring it to the base" -- and every single handoff failed
 * because there was no way to carry out the promise, only to talk about it.
 * The hungry agent died mid-conversation. `bot.toss` drops the stack at the
 * giver's own feet rather than throwing it toward anyone, so this is only
 * real if the two are standing close together first, which is why it walks
 * over the same way placeBlock and craftItem do.
 */

import type { Bot } from 'mineflayer';
import { Vec3 } from 'vec3';

import { navigateTo } from './movement.ts';
import type { ActionContext } from './run.ts';
import { ActionFailure } from './run.ts';
import type { ActionResult } from './types.ts';
import { toPosition } from './types.ts';

/**
 * Above mineflayer's own 5s placement ack window, plus enough slack to walk a
 * few blocks first now that place_block does that itself (see below).
 *
 * It was 20s, and 85 of 131 placements burned the whole budget before failing.
 * A placement either lands within a few seconds or it is not going to, and a
 * fast failure is worth far more to the agent than a slow one: it gets the
 * feedback while the situation is still the one it decided about.
 */
export const DEFAULT_PLACE_TIMEOUT_MS = 12_000;
export const DEFAULT_EAT_TIMEOUT_MS = 15_000;
export const DEFAULT_GIVE_TIMEOUT_MS = 12_000;

/**
 * How close the giver must be before tossing.
 *
 * `bot.toss` is a window transaction, not a directional throw -- the item
 * appears at the GIVER'S feet, not carried toward the recipient. Vanilla item
 * pickup only reaches roughly a block, so this has to be tight enough that the
 * drop is actually within the recipient's reach, not just "nearby" by the
 * standard of place_block or mine_block.
 */
const GIVE_RANGE = 2;

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

/**
 * mineflayer's `bot.consume()` waits at most 2,500ms (hard-coded in its own
 * source, independent of any timeout given here) for a server packet
 * confirming the eating animation finished, then throws "Promise timed out."
 * if it does not arrive in time.
 *
 * Measured live across four agents on one server: real completions cluster
 * around 1.9s and this throws on roughly HALF of all genuine eat attempts --
 * confirmed by checking inventory snapshots across the failures, which showed
 * the food item's count and the bot's hunger both unchanged, so this is not
 * the same class of bug as craft/place (work done but reported as failed).
 * The eat itself is genuinely still in flight when mineflayer gives up on it.
 * Retrying immediately works almost every time, which is what this does.
 */
const EAT_ATTEMPTS = 3;

export function createSurviveActions(ctx: ActionContext) {
  const { bot, runner } = ctx;

  function findItem(name: string) {
    return bot.inventory.items().find((i) => i.name === name) ?? null;
  }

  function countItem(name: string): number {
    return bot.inventory
      .items()
      .filter((i) => i.name === name)
      .reduce((sum, i) => sum + i.count, 0);
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
     * Hand an item to a named player by walking to them and dropping it.
     *
     * There is no protocol-level "give" -- this is a normal drop, made real
     * only by standing close enough first. `not_found` covers both "no such
     * player" and "was visible a moment ago but is not now", since mineflayer
     * cannot tell those apart any better than the agent could by eye.
     *
     * Verified live with two throwaway bots: even navigated to within a
     * couple of blocks, a dropped stack picks up a small random velocity and
     * can roll a further block or two on uneven ground before it settles --
     * confirmed by watching one land nearly 3m from a stationary recipient
     * standing on a slope. Vanilla pickup is automatic once someone's hitbox
     * actually reaches it, so this is honest about giving it a NAME
     * ("dropped near X") rather than a GUARANTEE ("X now has it"), and the
     * result says so.
     */
    async giveItem(
      itemName: string,
      count: number,
      toUsername: string,
      timeoutMs = DEFAULT_GIVE_TIMEOUT_MS,
    ): Promise<ActionResult> {
      return runner.run(
        { action: 'give_item', eventType: 'item_given', timeoutMs },
        async (signal) => {
          if (!Number.isInteger(count) || count < 1) {
            throw new ActionFailure('invalid_argument', 'count must be a positive integer');
          }

          const have = countItem(itemName);
          if (have === 0) {
            throw new ActionFailure('insufficient_items', `no ${itemName} in inventory`);
          }
          const amount = Math.min(count, have);

          const target = bot.players[toUsername]?.entity;
          if (target === undefined || target === null) {
            throw new ActionFailure(
              'not_found',
              `cannot see ${toUsername} -- they may be out of render distance, in another dimension, or offline`,
            );
          }

          if (bot.entity.position.distanceTo(target.position) > GIVE_RANGE) {
            await navigateTo(
              bot,
              target.position.x,
              target.position.y,
              target.position.z,
              1,
              Math.max(5_000, timeoutMs - 4_000),
              signal,
            );

            // Re-read: they may have walked off while this was approaching,
            // which the giver cannot have known when it decided to come here.
            const current = bot.players[toUsername]?.entity;
            if (current === undefined || current === null) {
              throw new ActionFailure(
                'not_found',
                `${toUsername} is no longer visible -- they may have moved away`,
              );
            }
            const distance = bot.entity.position.distanceTo(current.position);
            if (distance > GIVE_RANGE) {
              throw new ActionFailure(
                'unreachable',
                `could not get close enough to ${toUsername} to hand it over ` +
                  `(${distance.toFixed(1)}m away -- stand within ${GIVE_RANGE}m of each other)`,
              );
            }
          }

          const item = findItem(itemName);
          if (item === null) {
            // Only reachable if something else consumed it while walking over,
            // which the action mutex should prevent -- but trust the inventory
            // over the assumption.
            throw new ActionFailure('insufficient_items', `no ${itemName} in inventory`);
          }

          try {
            await bot.lookAt(target.position.offset(0, 1, 0), true);
          } catch {
            /* not fatal; the drop still lands at the giver's feet either way */
          }

          const before = countItem(itemName);
          try {
            await bot.toss(item.type, null, amount);
          } catch (err) {
            throw new ActionFailure(
              'failed',
              `could not drop ${itemName}: ${err instanceof Error ? err.message : String(err)}`,
            );
          }

          await sleep(250);

          // Verified by change, same as every other action here: this drops
          // the stack rather than confirming it was PICKED UP, since that
          // depends on what the recipient does next and is not this action's
          // to promise.
          const given = before - countItem(itemName);
          if (given <= 0) {
            throw new ActionFailure('failed', `dropping ${itemName} had no effect`);
          }

          return {
            item: itemName,
            given,
            // Dropped, not delivered -- see the block comment above this
            // function. Told plainly rather than implied, since "given: 3"
            // alone reads as "they have it now", which this cannot promise.
            note: `dropped near ${toUsername}; it may have scattered a little on landing -- they may need collect_items to actually pick it up`,
            to: toUsername,
            ...(given < amount ? { short: amount - given } : {}),
          };
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
        async (signal) => {
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

          // Walk over rather than refuse. mine_block and craft_item have always
          // done this; place_block did not, and it showed: a batch planning a
          // multi-block wall would place the first few reachable pieces, then
          // fail the rest with "9.4m away -- move closer first" because the
          // model had not interleaved a move_to. That is real reasoning the
          // model should not have to do for every single block of a structure.
          if (bot.entity.position.distanceTo(target) > 4) {
            const nav = await navigateTo(
              bot,
              target.x + 0.5,
              target.y,
              target.z + 0.5,
              3,
              Math.max(5_000, timeoutMs - 4_000),
              signal,
            );

            // Arriving is what matters, not pathfinder's verdict -- a wedge
            // just short of the spot can still leave it in reach.
            if (bot.entity.position.distanceTo(target) > 5) {
              throw new ActionFailure(
                'unreachable',
                `cannot get within reach of ${target.x},${target.y},${target.z} ` +
                  `(${nav.outcome}, ${bot.entity.position.distanceTo(target).toFixed(1)}m away)`,
              );
            }
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
            // Something is standing in that space that has no collision box, so
            // it passed the "is it empty" check above, but the server will not
            // let a block replace it either. Saplings, flowers, torches and
            // crops all behave this way -- grass and ferns, which ARE
            // replaceable, do not. minecraft-data exposes no flag separating
            // them, so the world is asked instead of guessed at.
            //
            // This mattered: one such placement was retried 110 times across
            // seven runs against a spruce_sapling, because "the block is still
            // spruce_sapling" reads as a transient glitch rather than as
            // "there is a sapling there and you must break it first".
            if (before !== 'air' && placed !== null && placed.name === before) {
              throw new ActionFailure(
                'blocked',
                `a ${before} is in that space -- it has no collision so it looks empty, ` +
                  `but nothing can be placed over it. Mine the ${before} first, then place.`,
              );
            }

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
          const countBefore = countItem(chosen.item.name);
          await bot.equip(chosen.item, 'hand');

          // See EAT_ATTEMPTS: consume() throws on a hard-coded 2.5s internal
          // timeout that real eating regularly exceeds, so the exception is
          // not trusted and the world is checked instead -- either signal
          // (hunger restored, or the item actually consumed) counts as done.
          let consumeError: string | null = null;
          for (let attempt = 0; attempt < EAT_ATTEMPTS; attempt++) {
            try {
              await bot.consume();
            } catch (err) {
              consumeError = err instanceof Error ? err.message : String(err);
            }

            await sleep(300);
            if (bot.food > foodBefore || countItem(chosen.item.name) < countBefore) {
              consumeError = null;
              break;
            }
          }

          if (bot.food <= foodBefore && countItem(chosen.item.name) >= countBefore) {
            throw new ActionFailure(
              'failed',
              consumeError === null
                ? `eating ${chosen.item.name} had no effect`
                : `eating ${chosen.item.name} did not complete (${consumeError})`,
            );
          }

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
