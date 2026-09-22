/**
 * The action surface: everything the bot can do to the world.
 *
 * Stage 5 turns this object into Claude's tool list, which is why it is a flat,
 * named set rather than a class hierarchy -- each entry maps to one tool with
 * one structured result. Anything not exposed here, Claude cannot do; that
 * boundary is the whole safety story for principle 16 of the project brief
 * (no arbitrary code execution, only explicitly defined Minecraft tools).
 */

import type { Bot } from 'mineflayer';
import pathfinderPkg from 'mineflayer-pathfinder';

import type { Logger } from '../../util/log.ts';
import { startReflexes } from '../reflexes.ts';
import { createArmorActions } from './armor.ts';
import { createCombatActions } from './combat.ts';
import { createContainerActions } from './containers.ts';
import { createCraftActions } from './craft.ts';
import { createFarmingActions } from './farming.ts';
import { createGatherActions } from './gather.ts';
import { createMovementActions, trackPlayers } from './movement.ts';
import { createRestActions, leaveBed } from './rest.ts';
import { createActionRunner } from './run.ts';
import { createSurviveActions } from './survive.ts';

const { pathfinder } = pathfinderPkg;

export type { ActionResult, ActionError, ActionErrorCode } from './types.ts';
export { describeResult } from './run.ts';

export interface Actions {
  moveTo: ReturnType<typeof createMovementActions>['moveTo'];
  followPlayer: ReturnType<typeof createMovementActions>['followPlayer'];
  stop: ReturnType<typeof createMovementActions>['stop'];
  mineBlock: ReturnType<typeof createGatherActions>['mineBlock'];
  collectNearbyItems: ReturnType<typeof createGatherActions>['collectNearbyItems'];
  craftItem: ReturnType<typeof createCraftActions>['craftItem'];
  placeBlock: ReturnType<typeof createSurviveActions>['placeBlock'];
  eatFood: ReturnType<typeof createSurviveActions>['eatFood'];
  equipItem: ReturnType<typeof createSurviveActions>['equipItem'];
  giveItem: ReturnType<typeof createSurviveActions>['giveItem'];
  attackEntity: ReturnType<typeof createCombatActions>['attackEntity'];
  smeltItem: ReturnType<typeof createContainerActions>['smeltItem'];
  storeItems: ReturnType<typeof createContainerActions>['storeItems'];
  takeItems: ReturnType<typeof createContainerActions>['takeItems'];
  plantCrop: ReturnType<typeof createFarmingActions>['plantCrop'];
  sleepInBed: ReturnType<typeof createRestActions>['sleepInBed'];
  wearArmor: ReturnType<typeof createArmorActions>['wearArmor'];
  /** True while an action holds the bot. */
  busy: () => boolean;
  /** Name of the running action, if any. */
  current: () => string | null;
  /** Cut the running action short; the next one runs normally. */
  interrupt: (reason: string) => void;
  /** Hear about reflexes (surfacing for air) that took the body over. */
  onReflex: (listener: (what: string) => void) => void;
}

/**
 * Build the action surface for a bot.
 *
 * Loads the pathfinder plugin, so call this once per connection -- reconnecting
 * produces a new Bot object and needs a fresh set.
 */
export function createActions(bot: Bot, log: Logger): Actions {
  bot.loadPlugin(pathfinder);
  // Twice pathfinder's default. "Took to long to decide path to goal" ended
  // moves outright on long trips across rough ground; a longer think is far
  // cheaper than a failed turn.
  bot.pathfinder.thinkTimeout = 10_000;

  const runner = createActionRunner(log, {
    // Out of bed before doing anything else. A sleeping player cannot move,
    // dig or place; the action would fail for a reason the agent cannot see.
    async before(spec) {
      if (spec.action !== 'sleep_in_bed' && bot.isSleeping) await leaveBed(bot);
    },
  });
  const ctx = { bot, log, runner };

  const movement = createMovementActions(ctx);
  const gather = createGatherActions(ctx);
  const craft = createCraftActions(ctx);
  const survive = createSurviveActions(ctx);
  const combat = createCombatActions(ctx);
  const containers = createContainerActions(ctx);
  const farming = createFarmingActions(ctx);
  const rest = createRestActions(ctx);
  const armor = createArmorActions(ctx);
  const reflexes = startReflexes(bot, runner, log);
  trackPlayers(bot);

  return {
    moveTo: movement.moveTo,
    followPlayer: movement.followPlayer,
    stop: movement.stop,
    mineBlock: gather.mineBlock,
    collectNearbyItems: gather.collectNearbyItems,
    craftItem: craft.craftItem,
    placeBlock: survive.placeBlock,
    eatFood: survive.eatFood,
    equipItem: survive.equipItem,
    giveItem: survive.giveItem,
    attackEntity: combat.attackEntity,
    smeltItem: containers.smeltItem,
    storeItems: containers.storeItems,
    takeItems: containers.takeItems,
    plantCrop: farming.plantCrop,
    sleepInBed: rest.sleepInBed,
    wearArmor: armor.wearArmor,
    busy: runner.busy,
    current: runner.current,
    interrupt: runner.interrupt,
    onReflex: reflexes.onReflex,
  };
}
