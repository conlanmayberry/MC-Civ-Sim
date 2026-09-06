/**
 * Movement actions, built on mineflayer-pathfinder.
 *
 * The wedge detector below is the reason Stage 3 could proceed at all. See
 * ADR-006: on Minecraft 26.1.2 in normal terrain, pathfinder computes a route
 * correctly, executes part of it, then stops moving while `isMoving()` still
 * reports true -- so `goto` never settles and the caller hangs forever. The
 * benchmark measured 3/3 wedges on 26.1.2 normal terrain against 0/3 on 1.21.8,
 * which is mineflayer-pathfinder#366.
 *
 * We do not fix the upstream bug. We convert an unrecoverable hang into a
 * typed, returned `unreachable` failure, which is exactly what ADR-007's
 * contract exists to carry: Stage 5's model can read that and try something
 * else, where a hang would have stalled the agent permanently.
 */

import type { Bot } from 'mineflayer';
import pathfinderPkg from 'mineflayer-pathfinder';
import { Vec3 } from 'vec3';

import type { ActionContext } from './run.ts';
import { ActionFailure } from './run.ts';
import type { ActionResult } from './types.ts';
import { round2, toPosition } from './types.ts';

const { Movements, goals } = pathfinderPkg;

/** How often to sample position while a goal is active. */
const WATCH_INTERVAL_MS = 400;
/** Below this movement between samples, the bot counts as not making progress. */
const PROGRESS_EPSILON = 0.1;
/** Consecutive stalled samples before we call it a wedge (~2.4s). */
const WEDGE_SAMPLES = 6;
/**
 * How many times to recompute and retry after a wedge.
 *
 * A wedge is a stuck execution of ONE path, not proof the destination is
 * unreachable -- pathfinder often succeeds on a freshly computed route from the
 * slightly different position it wedged at. Retrying is what a person would do,
 * and in dense forest it is the difference between a bot that gets everywhere
 * slowly and one that gets nowhere.
 */
const WEDGE_RETRIES = 3;
/** A hop and a turn, to break whatever geometry the wedge got caught on. */
const UNSTICK_MS = 600;

export const DEFAULT_MOVE_TIMEOUT_MS = 45_000;

/**
 * Drive pathfinder to a goal, aborting on a detected wedge.
 *
 * Returns the reason it ended rather than throwing, so callers can decide how
 * to report it.
 */
async function pathfindTo(
  bot: Bot,
  goal: InstanceType<typeof goals.GoalNear> | InstanceType<typeof goals.GoalFollow>,
  signal: AbortSignal,
  timeoutMs: number,
): Promise<{ outcome: 'reached' | 'wedged' | 'no_path' | 'aborted' | 'timeout'; detail: string }> {
  bot.pathfinder.setMovements(new Movements(bot));

  let settled: 'reached' | 'no_path' | null = null;
  let pathError = '';

  void bot.pathfinder
    .goto(goal)
    .then(() => {
      settled = 'reached';
    })
    .catch((err: unknown) => {
      // Aborting the goal ourselves rejects the pending goto; that is our own
      // doing and must not be reported as a pathfinding failure.
      const message = err instanceof Error ? err.message : String(err);
      if (!message.includes('goal was changed')) {
        settled = 'no_path';
        pathError = message;
      }
    });

  let last = bot.entity.position.clone();
  let stalled = 0;
  const deadline = Date.now() + timeoutMs;

  while (settled === null) {
    if (signal.aborted) {
      bot.pathfinder.setGoal(null);
      return { outcome: 'aborted', detail: 'aborted' };
    }
    if (Date.now() > deadline) {
      bot.pathfinder.setGoal(null);
      return { outcome: 'timeout', detail: `no arrival within ${timeoutMs}ms` };
    }

    await new Promise((r) => setTimeout(r, WATCH_INTERVAL_MS));

    const now = bot.entity.position;
    // "Claims to be moving but is not" is the wedge signature. Either half
    // alone is normal -- a bot can pause while pathfinder recomputes, and it
    // can be still with no goal at all.
    if (now.distanceTo(last) < PROGRESS_EPSILON && bot.pathfinder.isMoving()) {
      stalled++;
    } else {
      stalled = 0;
    }
    last = now.clone();

    if (stalled >= WEDGE_SAMPLES) {
      bot.pathfinder.setGoal(null);
      // Let the rejection land before the caller moves on.
      await new Promise((r) => setTimeout(r, 200));
      return {
        outcome: 'wedged',
        detail: `pathfinder wedged after ~${round2((WEDGE_SAMPLES * WATCH_INTERVAL_MS) / 1000)}s without progress`,
      };
    }
  }

  if (settled === 'reached') return { outcome: 'reached', detail: '' };
  return { outcome: 'no_path', detail: pathError };
}

/**
 * Navigate without taking the action mutex.
 *
 * Composite actions (mine_block walks to the block, collect_items walks to each
 * drop) already hold the mutex, so they must NOT call the `moveTo` action --
 * that would deadlock against itself and return `interrupted`. They call this
 * instead and map the outcome onto their own error code.
 */
export async function navigateTo(
  bot: Bot,
  x: number,
  y: number,
  z: number,
  range: number,
  timeoutMs: number,
  signal: AbortSignal,
): Promise<{ ok: boolean; outcome: string; detail: string; remaining: number; attempts: number }> {
  const target = new Vec3(x, y, z);
  const deadline = Date.now() + timeoutMs;

  let outcome = 'no_path';
  let detail = '';
  let attempts = 0;

  for (let attempt = 0; attempt <= WEDGE_RETRIES; attempt++) {
    attempts++;
    const remainingBudget = deadline - Date.now();
    if (remainingBudget <= 1_000) {
      outcome = 'timeout';
      detail = 'ran out of time between retries';
      break;
    }

    const result = await pathfindTo(
      bot,
      new goals.GoalNear(x, y, z, range),
      signal,
      remainingBudget,
    );
    outcome = result.outcome;
    detail = result.detail;

    if (outcome !== 'wedged') break;
    if (bot.entity.position.distanceTo(target) <= range + 1) {
      outcome = 'reached';
      break;
    }
    if (signal.aborted) break;

    await unstick(bot);
  }

  const remaining = bot.entity.position.distanceTo(target);
  return { ok: outcome === 'reached', outcome, detail, remaining: round2(remaining), attempts };
}

/** Hop and turn, to shake loose whatever geometry the wedge caught on. */
async function unstick(bot: Bot): Promise<void> {
  try {
    await bot.look(Math.random() * Math.PI * 2, 0, true);
    bot.setControlState('jump', true);
    bot.setControlState('forward', true);
    await new Promise((r) => setTimeout(r, UNSTICK_MS));
  } finally {
    bot.clearControlStates();
  }
}

export function createMovementActions(ctx: ActionContext) {
  const { bot, log, runner } = ctx;

  return {
    /** Walk to within `range` blocks of a coordinate. */
    async moveTo(
      x: number,
      y: number,
      z: number,
      range = 1,
      timeoutMs = DEFAULT_MOVE_TIMEOUT_MS,
    ): Promise<ActionResult> {
      return runner.run({ action: 'move_to', eventType: 'movement', timeoutMs }, async (signal) => {
        if (![x, y, z].every(Number.isFinite)) {
          throw new ActionFailure('invalid_argument', 'coordinates must be finite numbers');
        }

        const target = new Vec3(x, y, z);
        const from = bot.entity.position.clone();
        const startDistance = from.distanceTo(target);

        const { outcome, detail, remaining, attempts } = await navigateTo(
          bot,
          x,
          y,
          z,
          range,
          timeoutMs - 1_000,
          signal,
        );

        if (outcome !== 'reached') {
          // Wedge, no-path and timeout all mean the same thing to a caller:
          // this destination could not be reached right now. The distinction
          // is preserved in the message for humans and for ADR-006 follow-up.
          throw new ActionFailure(
            outcome === 'timeout' ? 'timeout' : 'unreachable',
            `${outcome} after ${attempts} attempt(s)${detail === '' ? '' : `: ${detail}`} (${round2(remaining)}m short)`,
          );
        }

        return {
          from: toPosition(from),
          to: toPosition(bot.entity.position),
          requested: toPosition(target),
          travelled: round2(startDistance - remaining),
          remaining: round2(remaining),
          attempts,
        };
      });
    },

    /** Follow a player until within `range`, or until the timeout. */
    async followPlayer(
      username: string,
      range = 3,
      timeoutMs = DEFAULT_MOVE_TIMEOUT_MS,
    ): Promise<ActionResult> {
      return runner.run(
        { action: 'follow_player', eventType: 'movement', timeoutMs },
        async (signal) => {
          const target = bot.players[username]?.entity;
          if (target === undefined || target === null) {
            throw new ActionFailure('not_found', `cannot see ${username}`);
          }

          const startDistance = bot.entity.position.distanceTo(target.position);
          const { outcome, detail } = await pathfindTo(
            bot,
            new goals.GoalFollow(target, range),
            signal,
            timeoutMs - 1_000,
          );

          const current = bot.players[username]?.entity;
          const endDistance =
            current === undefined || current === null
              ? Number.NaN
              : bot.entity.position.distanceTo(current.position);

          // GoalFollow is dynamic and never "completes" while the target moves,
          // so arriving within range counts as success even if goto did not
          // resolve on its own.
          if (Number.isFinite(endDistance) && endDistance <= range + 1) {
            return {
              username,
              startDistance: round2(startDistance),
              endDistance: round2(endDistance),
            };
          }

          throw new ActionFailure(
            outcome === 'timeout' ? 'timeout' : 'unreachable',
            `${outcome}${detail === '' ? '' : `: ${detail}`} (${
              Number.isFinite(endDistance) ? `${round2(endDistance)}m away` : 'lost sight of them'
            })`,
          );
        },
      );
    },

    /** Cancel any active goal and release the controls. Always succeeds. */
    stop(): ActionResult {
      bot.pathfinder.setGoal(null);
      bot.clearControlStates();
      log.event('movement', { action: 'stop_movement', ok: true });
      return {
        ok: true,
        action: 'stop_movement',
        durationMs: 0,
        detail: { position: toPosition(bot.entity.position) },
      };
    },
  };
}

export type MovementActions = ReturnType<typeof createMovementActions>;
