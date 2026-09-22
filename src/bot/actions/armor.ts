/**
 * Armour: what is worn, what is better, and putting it on.
 *
 * equip_item could already put a chestplate on -- if the model knew to say
 * "torso", which is Mineflayer's word, not Minecraft's. Nothing told the agent
 * what it was wearing, so it could not tell that it was wearing nothing. One
 * call now wears the best of everything carried, and the observation says what
 * is on and how much protection it adds up to.
 */

import type { Bot } from 'mineflayer';

import type { ActionContext } from './run.ts';
import { ActionFailure } from './run.ts';
import type { ActionResult } from './types.ts';

export type ArmorSlot = 'head' | 'torso' | 'legs' | 'feet';

const SLOT_SUFFIX: ReadonlyArray<[string, ArmorSlot]> = [
  ['_helmet', 'head'],
  ['_chestplate', 'torso'],
  ['_leggings', 'legs'],
  ['_boots', 'feet'],
];

/** mineflayer's inventory window: 5 head, 6 chest, 7 legs, 8 feet. */
const SLOT_INDEX: Readonly<Record<ArmorSlot, number>> = { head: 5, torso: 6, legs: 7, feet: 8 };

/** Vanilla armour points per piece, by material then slot. */
const POINTS: Readonly<Record<string, Readonly<Record<ArmorSlot, number>>>> = {
  leather: { head: 1, torso: 3, legs: 2, feet: 1 },
  golden: { head: 2, torso: 5, legs: 3, feet: 1 },
  chainmail: { head: 2, torso: 5, legs: 4, feet: 1 },
  iron: { head: 2, torso: 6, legs: 5, feet: 2 },
  diamond: { head: 3, torso: 8, legs: 6, feet: 3 },
  netherite: { head: 3, torso: 8, legs: 6, feet: 3 },
  turtle: { head: 2, torso: 0, legs: 0, feet: 0 },
};
/** Toughness breaks ties: diamond and netherite have the same points. */
const TOUGHNESS: Readonly<Record<string, number>> = { diamond: 2, netherite: 3 };

export function armorSlotFor(itemName: string): ArmorSlot | null {
  for (const [suffix, slot] of SLOT_SUFFIX) {
    if (itemName.endsWith(suffix)) return slot;
  }
  return null;
}

/** Armour points a piece gives, or 0 for anything that is not armour. */
export function armorPoints(itemName: string): number {
  const slot = armorSlotFor(itemName);
  if (slot === null) return 0;
  const material = itemName.slice(0, itemName.lastIndexOf('_'));
  return POINTS[material]?.[slot] ?? 0;
}

/** For choosing between pieces: points first, then toughness. */
function rank(itemName: string): number {
  const material = itemName.slice(0, itemName.lastIndexOf('_'));
  return armorPoints(itemName) * 10 + (TOUGHNESS[material] ?? 0);
}

export interface Worn {
  head: string | null;
  torso: string | null;
  legs: string | null;
  feet: string | null;
  points: number;
}

export function wornArmor(bot: Bot): Worn {
  // Optional-chained throughout: this feeds every observation, and the
  // inventory is not always there at the edges of a bot's lifecycle.
  const read = (slot: ArmorSlot): string | null => bot.inventory?.slots?.[SLOT_INDEX[slot]]?.name ?? null;
  const worn = { head: read('head'), torso: read('torso'), legs: read('legs'), feet: read('feet') };
  const points = Object.values(worn).reduce((sum, name) => sum + (name === null ? 0 : armorPoints(name)), 0);
  return { ...worn, points };
}

/** "iron_chestplate, leather_boots (armour 8/20)" -- or that there is none. */
export function describeArmor(worn: Worn): string {
  const pieces = [worn.head, worn.torso, worn.legs, worn.feet].filter((n): n is string => n !== null);
  return pieces.length === 0 ? 'no armour' : `${pieces.join(', ')} (armour ${worn.points}/20)`;
}

export function createArmorActions(ctx: ActionContext) {
  const { bot, runner } = ctx;

  return {
    /** Put on the best armour carried, in every slot where it beats what is worn. */
    async wearArmor(): Promise<ActionResult> {
      return runner.run({ action: 'wear_armor', eventType: 'observation', timeoutMs: 15_000 }, async () => {
        const carried = bot.inventory.items().filter((i) => armorSlotFor(i.name) !== null);
        const before = wornArmor(bot);
        if (carried.length === 0 && before.points === 0) {
          throw new ActionFailure(
            'insufficient_items',
            'you carry no armour -- leather pieces are crafted from cow leather, iron pieces from iron_ingot (smelt raw_iron)',
          );
        }

        const changed: string[] = [];
        for (const slot of ['head', 'torso', 'legs', 'feet'] as const) {
          const best = carried
            .filter((i) => armorSlotFor(i.name) === slot)
            .sort((a, b) => rank(b.name) - rank(a.name))[0];
          if (best === undefined) continue;
          const current = before[slot];
          if (current !== null && rank(current) >= rank(best.name)) continue;
          try {
            await bot.equip(best, slot);
            changed.push(best.name);
          } catch (err) {
            throw new ActionFailure(
              'failed',
              `could not put on ${best.name}: ${err instanceof Error ? err.message : String(err)}`,
            );
          }
        }

        const after = wornArmor(bot);
        return {
          putOn: changed,
          wearing: describeArmor(after),
          armorPoints: after.points,
          ...(changed.length === 0 ? { note: 'already wearing the best armour you carry' } : {}),
        };
      });
    },
  };
}

export type ArmorActions = ReturnType<typeof createArmorActions>;
