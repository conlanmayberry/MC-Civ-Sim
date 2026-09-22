/**
 * Beds: getting through the night, and choosing where to wake up after dying.
 *
 * Night was the most dangerous part of every session: the skeleton that killed
 * all four agents on 2026-09-16 came at night, and the prompt could only say
 * "it is dark; hostile mobs spawn". A bed answers that twice over. At night,
 * sleeping skips it -- once everyone online is asleep. At any time, using a bed
 * makes it the respawn point, so dying stops meaning a long walk back from
 * world spawn to wherever the agent's things and friends are.
 *
 * mineflayer's bot.sleep refuses outright in daytime, before it sends anything,
 * so the daytime path uses the bed the way a player does -- which the server
 * answers by setting the spawn point.
 */

import type { Bot } from 'mineflayer';
import type { Block } from 'prismarine-block';
import { Vec3 } from 'vec3';

import { navigateTo } from './movement.ts';
import type { ActionContext } from './run.ts';
import { ActionFailure } from './run.ts';
import type { ActionResult } from './types.ts';
import { toPosition } from './types.ts';

const SEARCH_RADIUS = 16;
const WALK_BUDGET_MS = 20_000;
export const DEFAULT_SLEEP_TIMEOUT_MS = 35_000;
/** How long to listen for the server confirming the respawn point. */
const RESPAWN_CONFIRM_MS = 1_500;
/** Vanilla lets players sleep from tick 12542 until 23459, or in a thunderstorm. */
const SLEEP_FROM = 12_542;
const SLEEP_UNTIL = 23_459;

/** Player-command id for leaving a bed from 1.21.6 on (see leaveBed). */
const LEAVE_BED_SINCE_1_21_6 = 0;
const LEAVE_BED_WAIT_MS = 2_000;

const HORIZONTAL: Array<[number, number]> = [[1, 0], [-1, 0], [0, 1], [0, -1]];

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

export function canSleepNow(timeOfDay: number, thundering: boolean): boolean {
  return thundering || (timeOfDay >= SLEEP_FROM && timeOfDay < SLEEP_UNTIL);
}

/** "You may not rest now; there are monsters nearby" and friends, in a sentence the model can act on. */
export function explainSleepRefusal(message: string): string {
  if (/monster/i.test(message)) {
    return 'monsters are too close to sleep -- deal with them or put walls between you and them first';
  }
  if (/occupied/i.test(message)) return 'someone is already in that bed';
  if (/too far|obstructed/i.test(message)) return 'the bed is out of reach or blocked';
  if (/night|day/i.test(message)) return 'you can only sleep at night or in a thunderstorm';
  return message;
}

/**
 * Get out of bed, and wait until the server agrees.
 *
 * mineflayer's bot.wake() does not work on this server version. It sends
 * player-command action 2, which was "leave bed" until 1.21.6 moved sneaking
 * out of that packet and renumbered the rest; on 1.21.8, 2 is "stop
 * sprinting", and the bot stays in bed. Measured with the server as the
 * judge: action 0 clears the sleeping position and the sleeping pose, 2 does
 * nothing. Once the bot really is up, mineflayer's own flag follows.
 */
export async function leaveBed(bot: Bot): Promise<boolean> {
  if (!bot.isSleeping) return true;
  const renumbered = bot.registry.version['>=']('1.21.6');
  if (renumbered) {
    bot._client.write('entity_action', { entityId: bot.entity.id, actionId: LEAVE_BED_SINCE_1_21_6, jumpBoost: 0 });
  } else {
    await bot.wake();
  }
  const until = Date.now() + LEAVE_BED_WAIT_MS;
  while (bot.isSleeping && Date.now() < until) await sleep(100);
  return !bot.isSleeping;
}

export function createRestActions(ctx: ActionContext) {
  const { bot, runner } = ctx;

  function isBed(block: Block | null): block is Block {
    return block !== null && block.name.endsWith('_bed');
  }

  function nearestBed(): Block | null {
    const ids = Object.values(bot.registry.blocksByName)
      .filter((b) => b.name.endsWith('_bed'))
      .map((b) => b.id);
    return bot.findBlock({ matching: ids, maxDistance: SEARCH_RADIUS });
  }

  function isOpen(position: Vec3): boolean {
    const block = bot.blockAt(position);
    return block !== null && block.boundingBox === 'empty' && !block.name.includes('water');
  }

  /**
   * Put a carried bed down. A bed is two blocks long: the foot where it is
   * placed, and the head one block further in the direction the player faces.
   * mineflayer's placeBlock turns the bot to face the block it clicks, so the
   * bed always extends straight away from the bot -- which is why only the
   * four straight-line directions are tried, with room checked two and three
   * blocks out.
   */
  async function placeCarriedBed(): Promise<Block | null> {
    const item = bot.inventory.items().find((i) => i.name.endsWith('_bed'));
    if (item === undefined) return null;
    const feet = bot.entity.position.floored();

    for (const [dx, dz] of HORIZONTAL) {
      const foot = feet.offset(dx * 2, 0, dz * 2);
      const head = feet.offset(dx * 3, 0, dz * 3);
      const floorA = bot.blockAt(foot.offset(0, -1, 0));
      const floorB = bot.blockAt(head.offset(0, -1, 0));
      if (floorA === null || floorA.boundingBox !== 'block' || floorB?.boundingBox !== 'block') continue;
      if (!isOpen(foot) || !isOpen(head) || !isOpen(feet.offset(dx, 0, dz))) continue;

      await bot.equip(item, 'hand');
      try {
        await bot.placeBlock(floorA, new Vec3(0, 1, 0));
      } catch {
        // The world is the verdict.
      }
      await sleep(300);
      const placed = bot.blockAt(foot);
      if (isBed(placed)) return placed;
    }
    return null;
  }

  return {
    /** Sleep in the nearest bed at night; by day, make it the respawn point. */
    async sleepInBed(timeoutMs = DEFAULT_SLEEP_TIMEOUT_MS): Promise<ActionResult> {
      return runner.run({ action: 'sleep_in_bed', eventType: 'observation', timeoutMs }, async (signal) => {
        if (bot.game.dimension !== 'overworld' && !String(bot.game.dimension).includes('overworld')) {
          throw new ActionFailure('blocked', 'beds explode outside the overworld -- do not sleep here');
        }
        if (bot.isSleeping) return { sleeping: true, note: 'you are already asleep' };

        let bed = nearestBed();
        let placedOne = false;
        if (bed === null) {
          bed = await placeCarriedBed();
          placedOne = bed !== null;
        }
        if (bed === null) {
          throw new ActionFailure(
            'not_found',
            `no bed within ${SEARCH_RADIUS} blocks and none carried (or no two-block flat space to put one) -- ` +
              'a bed is crafted from 3 wool of one colour and 3 planks; sheep drop wool',
          );
        }

        const p = bed.position;
        if (bot.entity.position.distanceTo(p.offset(0.5, 0.5, 0.5)) > 3) {
          await navigateTo(bot, p.x + 0.5, p.y, p.z + 0.5, 2, WALK_BUDGET_MS, signal);
        }
        if (bot.entity.position.distanceTo(p.offset(0.5, 0.5, 0.5)) > 4) {
          throw new ActionFailure('unreachable', `could not get to the bed at ${p.x},${p.y},${p.z}`);
        }

        const base = { bed: toPosition(p), bedKind: bed.name, placedJustNow: placedOne };

        if (canSleepNow(bot.time.timeOfDay, bot.thunderState > 0)) {
          try {
            await bot.sleep(bed);
          } catch (err) {
            throw new ActionFailure('blocked', explainSleepRefusal(err instanceof Error ? err.message : String(err)), base);
          }
          return {
            ...base,
            sleeping: true,
            respawnPoint: true,
            note:
              'asleep. The night passes only once everyone online is asleep; until then you lie here. ' +
              'This bed is now where you respawn. Any other action gets you up.',
          };
        }

        // Daytime: use it the way a player does. The server refuses the sleep
        // but sets the respawn point. It only SAYS "Respawn point set" when
        // that changes, though -- measured in the arena, a bed that already
        // was the respawn point got just "You can sleep only at night". Either
        // reply means the bed was used, and using a bed by day always leaves
        // the respawn point on it.
        let changed = false;
        let answered = false;
        const listen = (message: string): void => {
          if (/respawn point set/i.test(message)) changed = true;
          if (/only at night|respawn point set/i.test(message)) answered = true;
        };
        bot.on('messagestr', listen);
        try {
          await bot.activateBlock(bed);
          const until = Date.now() + RESPAWN_CONFIRM_MS;
          while (!changed && Date.now() < until) await sleep(100);
        } catch {
          // Reported below.
        } finally {
          bot.removeListener('messagestr', listen);
        }
        return {
          ...base,
          sleeping: false,
          respawnPoint: answered,
          note: !answered
            ? 'it is day, so you cannot sleep yet. The server did not answer, so your respawn point may not have changed.'
            : `it is day, so you cannot sleep yet -- but this bed ${changed ? 'is now' : 'already was'} where you respawn. ` +
              'Sleeping needs night or a thunderstorm.',
        };
      });
    },
  };
}

export type RestActions = ReturnType<typeof createRestActions>;
