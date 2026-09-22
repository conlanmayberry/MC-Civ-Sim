/**
 * Attacking a creature: hunting for food, and fighting back.
 *
 * Missing until the 2026-09-16 session made the gap impossible to ignore. Over
 * 91 minutes, four agents between them ate ten sweet berries and nothing else.
 * Dmitri spent twenty minutes at food 0 and one heart; the others spent their
 * turns asking each other for food none of them had. Animals were around --
 * an earlier session's "cow fixation" was agents walking up to cows they had
 * no way to kill. And when a skeleton found the group at night it shot all
 * four dead, one after another, while they stood there.
 *
 * Players are not valid targets. Whether agents should be able to hurt each
 * other is a question about the experiment, not a fix, and it gets decided on
 * its own rather than slipped in alongside hunting.
 */

import type { Bot } from 'mineflayer';
import pathfinderPkg from 'mineflayer-pathfinder';
import type { Entity } from 'prismarine-entity';

import { movementsFor } from './movement.ts';
import type { ActionContext } from './run.ts';
import { ActionFailure } from './run.ts';
import type { ActionResult } from './types.ts';
import { round2, toPosition } from './types.ts';

const { goals } = pathfinderPkg;

/**
 * 45s, not 30. A hit animal runs, and a cow is barely slower than a walking
 * bot: a bare-fisted kill needs ten hits, and the arena measured five landed
 * in 24s with the rest of the budget spent chasing.
 */
export const DEFAULT_ATTACK_TIMEOUT_MS = 45_000;
/**
 * 40, up from 24. On 2026-09-22 about eighty hunts failed "no cow within 24
 * blocks" -- then no sheep, then no chicken, a turn each -- around a base
 * where the nearest animals had been hunted out to further than that.
 */
const SEARCH_RADIUS = 40;
/** How far to look when saying what IS around, after the target is not. */
const IN_SIGHT_RADIUS = 64;

/**
 * Creatures that live in water.
 *
 * Refused as targets: nothing here can catch them from the shore, and chasing
 * one is chasing it into deep water. On 2026-09-22, 49 hunts went after cod
 * and salmon, none landed a hit, and eleven ended in the surfacing reflex.
 */
export const WATER_CREATURES = new Set([
  'cod', 'salmon', 'tropical_fish', 'pufferfish', 'squid', 'glow_squid', 'dolphin', 'axolotl', 'tadpole', 'turtle',
]);
/** Vanilla melee reach is 3; a little under, so swings land from where we stop. */
const REACH = 2.8;
/** Full-strength swing cooldown for fists and swords is ~0.6s. */
const SWING_MS = 650;
const TICK_MS = 150;
/** Drops appearing this close to the target mean it died. */
const DROP_NEAR = 2.5;
/** How long to spend walking over the drops after a kill. */
const PICKUP_MS = 6_000;
/** It got this far away mid-fight: it is fleeing faster than we follow. */
const LOST_DISTANCE = 32;

/** Best first. Anything is better than a fist. */
const WEAPONS = [
  'netherite_sword', 'diamond_sword', 'iron_sword', 'stone_sword', 'golden_sword', 'wooden_sword',
  'netherite_axe', 'diamond_axe', 'iron_axe', 'stone_axe', 'golden_axe', 'wooden_axe',
];

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/** Entity kinds worth naming as something to hunt or fight. Not players, items or bats. */
const HUNTABLE_KINDS = new Set(['animal', 'hostile', 'passive', 'mob']);

/** Standing in water at least two deep: reaching it means swimming. */
export function inDeepWater(bot: Bot, entity: Entity): boolean {
  const at = entity.position.floored();
  const here = bot.blockAt(at);
  const below = bot.blockAt(at.offset(0, -1, 0));
  return here?.name === 'water' && below?.name === 'water';
}

export function createCombatActions(ctx: ActionContext) {
  const { bot, runner } = ctx;

  /** "zombie 12m, chicken 38m" -- what could be hunted or fought right now. */
  function creaturesInSight(): string {
    const seen = new Map<string, number>();
    for (const entity of Object.values(bot.entities)) {
      if (entity === bot.entity || entity.name === undefined || WATER_CREATURES.has(entity.name)) continue;
      // String, not the typed union: prismarine-entity's typings omit
      // "animal", which is what the server actually reports for livestock.
      if (!HUNTABLE_KINDS.has(String(entity.type))) continue;
      const d = entity.position.distanceTo(bot.entity.position);
      if (d > IN_SIGHT_RADIUS) continue;
      if (!seen.has(entity.name) || d < (seen.get(entity.name) ?? Infinity)) seen.set(entity.name, d);
    }
    return [...seen.entries()]
      .sort((a, b) => a[1] - b[1])
      .slice(0, 6)
      .map(([n, d]) => `${n} ${Math.round(d)}m`)
      .join(', ');
  }

  function nearest(name: string): Entity | null {
    let best: Entity | null = null;
    let bestDistance = SEARCH_RADIUS;
    for (const entity of Object.values(bot.entities)) {
      if (entity === bot.entity || entity.type === 'player' || entity.name !== name) continue;
      const distance = entity.position.distanceTo(bot.entity.position);
      if (distance <= bestDistance) {
        best = entity;
        bestDistance = distance;
      }
    }
    return best;
  }

  async function equipBestWeapon(): Promise<string | null> {
    for (const name of WEAPONS) {
      const item = bot.inventory.items().find((i) => i.name === name);
      if (item !== undefined) {
        if (bot.heldItem?.name !== name) await bot.equip(item, 'hand');
        return name;
      }
    }
    return null;
  }

  return {
    /** Chase and attack the nearest creature of a type until it dies or gets away. */
    async attackEntity(target: string, timeoutMs = DEFAULT_ATTACK_TIMEOUT_MS): Promise<ActionResult> {
      return runner.run(
        { action: 'attack_entity', eventType: 'damage_taken', timeoutMs },
        async (signal) => {
          const name = target.trim().toLowerCase().replace(/^minecraft:/, '');
          if (bot.players[target] !== undefined || Object.values(bot.players).some((p) => p.username.toLowerCase() === name)) {
            throw new ActionFailure('invalid_argument', 'players and agents cannot be attacked -- only animals and monsters');
          }
          if (WATER_CREATURES.has(name)) {
            throw new ActionFailure(
              'invalid_argument',
              `${name} live in water: they cannot be caught from land, and chasing them leads into deep water, ` +
                'which is how agents drown. Hunt land animals instead.',
            );
          }
          const entity = nearest(name);
          if (entity === null) {
            // Say what IS here, so the next turn is not a guess at another
            // animal that is not there either.
            const around = creaturesInSight();
            throw new ActionFailure(
              'not_found',
              `no ${name} within ${SEARCH_RADIUS} blocks -- ` +
                (around === '' ? 'no creatures in sight at all; go somewhere else to hunt' : `in sight: ${around}`),
            );
          }
          if (inDeepWater(bot, entity)) {
            throw new ActionFailure(
              'blocked',
              `the ${name} is in deep water; fighting it there is how agents drown -- wait for it on land, or leave it`,
            );
          }

          const weapon = await equipBestWeapon();
          const startDistance = round2(entity.position.distanceTo(bot.entity.position));
          // How a kill is noticed. Traced in the arena on 1.21.8: the cow took
          // its last hit, dropped its beef -- and stayed in bot.entities,
          // frozen at 1 health, with no entityDead ever fired. So besides the
          // proper events, anything dropping out of the spot it stands on
          // after we have hit it counts. A mob killed by a player always drops
          // an experience orb, so this does not depend on the loot table.
          let died = false;
          let swings = 0;
          const onDead = (dead: Entity): void => {
            if (dead.id === entity.id) died = true;
          };
          const onSpawn = (spawned: Entity): void => {
            if (swings === 0 || (spawned.name !== 'item' && spawned.name !== 'experience_orb')) return;
            if (spawned.position.distanceTo(entity.position) <= DROP_NEAR) died = true;
          };
          bot.on('entityDead', onDead);
          bot.on('entitySpawn', onSpawn);

          // Inside the runner's timeout, so a chase that cannot be won ends
          // as "still alive after N hits" -- which says what happened -- and
          // not as a bare "exceeded 30000ms" that throws the detail away.
          const fightUntil = Date.now() + timeoutMs - PICKUP_MS - 2_000;
          let lastSwing = 0;
          let chasing = false;
          bot.pathfinder.setMovements(movementsFor(bot));

          try {
            for (;;) {
              if (signal.aborted || Date.now() > fightUntil) break;
              const gone = bot.entities[entity.id] === undefined;
              if (died || gone) break;

              const distance = entity.position.distanceTo(bot.entity.position);
              // It swam off: following it now means swimming after it.
              if (distance > REACH && inDeepWater(bot, entity)) {
                throw new ActionFailure(
                  'blocked',
                  `the ${name} went into deep water after ${swings} hit(s); not following it in`,
                  { target: name, hits: swings },
                );
              }
              if (distance > LOST_DISTANCE) {
                throw new ActionFailure('unreachable', `${name} got away (${round2(distance)}m) after ${swings} hit(s)`);
              }

              if (distance > REACH) {
                if (!chasing) {
                  // Right up against it: stopping at arm's length from a
                  // fleeing animal means the next step it takes is out of reach.
                  bot.pathfinder.setGoal(new goals.GoalFollow(entity, 1), true);
                  chasing = true;
                }
              } else {
                if (chasing) {
                  bot.pathfinder.setGoal(null);
                  chasing = false;
                }
                if (Date.now() - lastSwing >= SWING_MS) {
                  await bot.lookAt(entity.position.offset(0, entity.height * 0.6, 0), true);
                  bot.attack(entity);
                  swings++;
                  lastSwing = Date.now();
                }
              }
              await sleep(TICK_MS);
            }
          } finally {
            bot.removeListener('entityDead', onDead);
            bot.removeListener('entitySpawn', onSpawn);
            bot.pathfinder.setGoal(null);
          }

          if (!died && swings > 0 && bot.entities[entity.id] === undefined) {
            // Gone from view after being hit. If its drops or experience are
            // lying where it stood, it died and was removed before the drop
            // listener saw anything -- counted as "lost sight" twice before.
            await sleep(600);
            died = Object.values(bot.entities).some(
              (e) => (e.name === 'item' || e.name === 'experience_orb') && e.position.distanceTo(entity.position) <= DROP_NEAR + 1,
            );
          }

          if (!died) {
            if (bot.entities[entity.id] === undefined) {
              throw new ActionFailure('not_found', `lost sight of the ${name} after ${swings} hit(s)`);
            }
            const distance = bot.entities[entity.id] === undefined
              ? null
              : entity.position.distanceTo(bot.entity.position);
            throw new ActionFailure(
              'failed',
              `${name} is still alive after ${swings} hit(s)` +
                (distance === null ? '' : `, ${round2(distance)}m away`),
              { target: name, hits: swings, weapon: weapon ?? 'fist' },
            );
          }

          // Walk over what it dropped, so a hunt is one turn and not two. Drops
          // are picked up automatically by standing on them.
          const where = entity.position.clone();
          const before = bot.inventory.items().reduce((n, i) => n + i.count, 0);
          await sleep(500);
          const pickupDeadline = Date.now() + PICKUP_MS;
          for (const drop of Object.values(bot.entities)) {
            if (signal.aborted || Date.now() > pickupDeadline) break;
            if (drop.name !== 'item' || drop.position.distanceTo(where) > 4) continue;
            try {
              await Promise.race([
                bot.pathfinder.goto(new goals.GoalNear(drop.position.x, drop.position.y, drop.position.z, 0.5)),
                sleep(Math.max(0, pickupDeadline - Date.now())),
              ]);
            } catch {
              // Unreachable or already picked up; the rest may not be.
            }
          }
          bot.pathfinder.setGoal(null);
          await sleep(300);
          const pickedUp = bot.inventory.items().reduce((n, i) => n + i.count, 0) - before;

          return {
            target: name,
            killed: true,
            hits: swings,
            weapon: weapon ?? 'fist',
            startDistance,
            at: toPosition(where),
            itemsPickedUp: pickedUp,
            note:
              pickedUp > 0
                ? 'picked up what it dropped. Raw meat is edible; cooked is far better.'
                : 'nothing picked up yet -- if it dropped anything, collect_items gets it.',
          };
        },
      );
    },
  };
}

export type CombatActions = ReturnType<typeof createCombatActions>;
