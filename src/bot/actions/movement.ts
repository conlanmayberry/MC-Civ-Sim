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
/**
 * The most any single pathfinding attempt gets, even when the overall budget
 * is bigger.
 *
 * Measured live: "timeout after 1 attempt(s)" was the single most common
 * movement failure, at distances as short as 6-16m -- and it was ALWAYS one
 * attempt, never more, because the full timeout budget was handed to the
 * first try. A path that has not arrived in 20s is not obviously a path that
 * would arrive in 45s either, but a FRESH path computed from wherever the bot
 * now stands often is: the first route can run through a bad chokepoint that
 * a recompute from a slightly different position avoids entirely. Capping
 * each attempt turns one long shot into two or three fresh ones within the
 * same wall-clock budget.
 */
const MAX_ATTEMPT_MS = 20_000;

export const DEFAULT_MOVE_TIMEOUT_MS = 45_000;

/**
 * Pathfinder costs a water block the same as a dry one by default, so it
 * happily routes along a lake bed as the shortest way round -- and 28 of 33
 * deaths in the 2026-09-16 session were drownings, mostly mid-move. Water is
 * still allowed when there is no other way, just strongly disfavoured.
 */
const WATER_COST = 12;

/**
 * Where this bot has recently wedged, so later paths route around the spot.
 *
 * In the 2026-09-16 session Dmitri wedged at the same village corner
 * (1395,65,-140) sixteen times over half an hour, at one heart and no food,
 * because every retry recomputed the same route through the same spot. A
 * person who got stuck somewhere tries a different way next time.
 */
const WEDGE_MEMORY_MS = 10 * 60_000;
const WEDGE_AVOID_COST = 40;
const wedgeSpots = new WeakMap<Bot, Array<{ x: number; y: number; z: number; at: number }>>();

export function rememberWedge(bot: Bot): void {
  const p = bot.entity.position;
  const now = Date.now();
  const spots = (wedgeSpots.get(bot) ?? []).filter((s) => now - s.at < WEDGE_MEMORY_MS);
  spots.push({ x: Math.floor(p.x), y: Math.floor(p.y), z: Math.floor(p.z), at: now });
  wedgeSpots.set(bot, spots.slice(-20));
}

export function recentWedges(bot: Bot): Array<{ x: number; y: number; z: number }> {
  const now = Date.now();
  return (wedgeSpots.get(bot) ?? []).filter((s) => now - s.at < WEDGE_MEMORY_MS);
}

interface ExtraMovements {
  liquidCost: number;
  allowParkour: boolean;
  allowSprinting: boolean;
  maxDropDown: number;
  scafoldingBlocks: number[];
  exclusionAreasStep: Array<(block: { position?: Vec3; name?: string }) => number>;
  exclusionAreasBreak: Array<(block: { position?: Vec3; name?: string }) => number>;
}

/**
 * Fields are walked around, and never dug through.
 *
 * Caught by the harvest scenario: working a field, the bot broke farmland to
 * path across it (picking up the dirt) and trampled crops it was not
 * harvesting, which then could not be replanted. Crops have no collision, so
 * pathfinder saw a field as open ground. Walking through stays possible when
 * there is no other way; digging it effectively is not.
 */
const FIELD_BLOCKS = new Set(['farmland', 'wheat', 'carrots', 'potatoes', 'beetroots', 'melon_stem', 'pumpkin_stem']);
const FIELD_STEP_COST = 15;
const FIELD_BREAK_COST = 90;

/**
 * The furthest a bot can fall without being hurt: fall damage is the distance
 * fallen less three.
 *
 * Note pathfinder's maxDropDown measures differently -- from the feet to the
 * block landed ON, one more than the fall -- so its default of 4 already
 * means a harmless three-block fall. Setting it to 3 on the reading that 4
 * "costs a heart" left a bot unable to step down off a three-high wall: an
 * arena bot built itself out of a pit and then could not get down the other
 * side. Falls were the leading cause of death on 2026-09-22, but not from
 * pathfinder's own drops; see unstick and mine_block's floor check.
 */
export const SAFE_FALL = 3;

/**
 * Blocks pathfinder may stack under the bot or bridge with. Its default is
 * dirt and cobblestone only, so an agent in a pit with a stack of planks had
 * no way up: Alice spent 81 minutes on 2026-09-22 at the bottom of a ravine
 * holding six spruce planks, trying to build a staircase by hand.
 *
 * Common rubble is always allowed. Planks and stone only on a retry, because
 * they are what agents build with -- a routine walk should not quietly spend
 * a builder's wall.
 */
const RUBBLE = ['dirt', 'cobblestone', 'cobbled_deepslate', 'andesite', 'diorite', 'granite', 'netherrack', 'tuff'];
const BUILDING = ['stone', 'deepslate', 'sandstone', 'coarse_dirt', 'mud', 'blackstone'];

function scaffoldIds(bot: Bot, careful: boolean): number[] {
  const names = [...RUBBLE];
  if (careful) {
    names.push(...BUILDING);
    for (const name of Object.keys(bot.registry.itemsByName)) {
      if (name.endsWith('_planks')) names.push(name);
    }
  }
  return names
    .map((name) => bot.registry.itemsByName[name]?.id)
    .filter((id): id is number => id !== undefined);
}

/**
 * Pathfinder settings for this bot.
 *
 * `careful` is for retries after a failed attempt: no parkour jumps and no
 * sprinting. Both make paths shorter and both are how a bot overshoots a
 * ledge, catches on a corner, or lands in water -- a fair trade on a first
 * attempt, a bad one on a second.
 */
export function movementsFor(bot: Bot, careful = false): InstanceType<typeof Movements> {
  const movements = new Movements(bot);
  // Present at runtime (movements.js) but missing from the bundled typings.
  const extra = movements as unknown as ExtraMovements;
  extra.liquidCost = WATER_COST;
  extra.maxDropDown = SAFE_FALL + 1;
  extra.scafoldingBlocks = scaffoldIds(bot, careful);
  if (careful) {
    extra.allowParkour = false;
    extra.allowSprinting = false;
  }
  extra.exclusionAreasStep.push((block) => (block.name !== undefined && FIELD_BLOCKS.has(block.name) ? FIELD_STEP_COST : 0));
  extra.exclusionAreasBreak.push((block) => (block.name !== undefined && FIELD_BLOCKS.has(block.name) ? FIELD_BREAK_COST : 0));
  const spots = recentWedges(bot);
  if (spots.length > 0) {
    // pathfinder also passes placeholder blocks for unloaded space, which
    // have no position; throwing here would crash the physics tick.
    extra.exclusionAreasStep.push((block) => {
      const p = block.position;
      if (p === undefined) return 0;
      return spots.some(
        (s) => Math.abs(p.x - s.x) <= 1 && Math.abs(p.z - s.z) <= 1 && Math.abs(p.y - s.y) <= 2,
      )
        ? WEDGE_AVOID_COST
        : 0;
    });
  }
  return movements;
}

/**
 * The budget move_to gets when the caller does not set one.
 *
 * A flat 45s could not cover the moves agents actually ask for: 100-155m
 * trips "timed out" while making steady progress, because walking that far
 * takes longer than that. Roughly 3 m/s of useful progress once detours are
 * counted, plus slack, capped so one move cannot hold the agent for minutes.
 */
export function moveBudgetMs(distance: number): number {
  return Math.round(Math.min(120_000, Math.max(DEFAULT_MOVE_TIMEOUT_MS, 15_000 + (distance / 3) * 1_000)));
}

/**
 * Drive pathfinder to a goal, aborting on a detected wedge.
 *
 * Returns the reason it ended rather than throwing, so callers can decide how
 * to report it.
 */
async function pathfindTo(
  bot: Bot,
  goal:
    | InstanceType<typeof goals.GoalNear>
    | InstanceType<typeof goals.GoalFollow>
    | InstanceType<typeof goals.GoalNearXZ>,
  signal: AbortSignal,
  timeoutMs: number,
  careful = false,
  leash: { target: Vec3; maxDistance: number } | null = null,
): Promise<{ outcome: 'reached' | 'wedged' | 'no_path' | 'aborted' | 'timeout' | 'wandered'; detail: string }> {
  bot.pathfinder.setMovements(movementsFor(bot, careful));

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
    // Traced from a bot stuck inside a hillside: every attempt led it further
    // off, 85-100m in the wrong direction before the budget ran out. A detour
    // that long is not a route to the target any more.
    if (leash !== null && now.distanceTo(leash.target) > leash.maxDistance) {
      bot.pathfinder.setGoal(null);
      return {
        outcome: 'wandered',
        detail: `the path led ${round2(now.distanceTo(leash.target))}m away from the target, so it was abandoned`,
      };
    }
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
      rememberWedge(bot);
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
  // Only attempts that got nowhere count against the retry limit. A long trip
  // that hits the per-attempt cap while still closing in is going fine, and
  // used to burn a retry each time until it "failed" mid-journey.
  let failures = 0;
  let lastWedge: Vec3 | null = null;

  while (failures <= WEDGE_RETRIES) {
    attempts++;
    const remainingBudget = deadline - Date.now();
    if (remainingBudget <= 1_000) {
      outcome = 'timeout';
      detail = 'ran out of time between retries';
      break;
    }

    const before = bot.entity.position.distanceTo(target);
    const result = await pathfindTo(
      bot,
      new goals.GoalNear(x, y, z, range),
      signal,
      Math.min(remainingBudget, MAX_ATTEMPT_MS),
      failures > 0,
      { target, maxDistance: before + Math.max(WANDER_SLACK, before) },
    );
    outcome = result.outcome;
    detail = result.detail;

    // A plain timeout is retried the same as a wedge: both are "this attempt
    // did not arrive", and a fresh path from a new position resolves each of
    // them for the same reason. So is pathfinder giving up on THINKING --
    // "took too long to decide" is about the search budget, not the world,
    // and a search from a few blocks further on is a different search.
    // Any other no_path is final: nothing connects the two points.
    // A path that wandered off is final too: the next one would be computed
    // from further away, through the same obstacle.
    if (outcome === 'wandered') break;
    const thinkingTimedOut = outcome === 'no_path' && isThinkingTimeout(detail);
    // One more try when the first found no path at all: the retry may build
    // with planks and stone (see scaffoldIds), which is sometimes the only
    // way out of a hole.
    const worthCarefulRetry = outcome === 'no_path' && failures === 0;
    if (outcome !== 'wedged' && outcome !== 'timeout' && !thinkingTimedOut && !worthCarefulRetry) break;
    if (bot.entity.position.distanceTo(target) <= range + 1) {
      outcome = 'reached';
      break;
    }
    if (signal.aborted) break;

    const progressed = before - bot.entity.position.distanceTo(target) >= PROGRESS_WORTH_KEEPING;
    if (!progressed) failures++;

    if (outcome === 'wedged') {
      const here = bot.entity.position.clone();
      // Wedged twice in the same place: a fresh path from here keeps finding
      // the same bad spot, so step well away from it first.
      if (lastWedge !== null && lastWedge.distanceTo(here) < 3) {
        await detour(bot, target, signal, Math.min(DETOUR_MS, deadline - Date.now()));
      } else {
        await unstick(bot);
      }
      lastWedge = here;
    }
  }

  const remaining = bot.entity.position.distanceTo(target);
  return { ok: outcome === 'reached', outcome, detail, remaining: round2(remaining), attempts };
}

/** pathfinder's "Took to long to decide path to goal!" -- its own typo, matched loosely. */
export function isThinkingTimeout(detail: string): boolean {
  return /too? long to decide/i.test(detail);
}

/** How much further from the target than it started a path may lead, at least. */
const WANDER_SLACK = 24;
/** An attempt that closed this much distance was working, however it ended. */
const PROGRESS_WORTH_KEEPING = 8;
const DETOUR_MS = 8_000;

/**
 * Walk a few blocks off to one side of the line to the target.
 *
 * Which side is random: the point is only to approach the wedge spot from a
 * different angle next time, with the spot itself now costed as a place to
 * avoid (see rememberWedge).
 */
async function detour(bot: Bot, target: Vec3, signal: AbortSignal, budgetMs: number): Promise<void> {
  if (budgetMs < 2_000) return;
  const here = bot.entity.position;
  const toward = target.minus(here);
  const length = Math.hypot(toward.x, toward.z) || 1;
  const side = Math.random() < 0.5 ? 1 : -1;
  // Perpendicular in the horizontal plane, and a little back the way we came.
  const px = (-toward.z / length) * side;
  const pz = (toward.x / length) * side;
  const dx = px * 6 - (toward.x / length) * 2;
  const dz = pz * 6 - (toward.z / length) * 2;
  await pathfindTo(bot, new goals.GoalNearXZ(here.x + dx, here.z + dz, 2), signal, budgetMs, true);
}

/** Hop and turn, to shake loose whatever geometry the wedge caught on. */
async function unstick(bot: Bot): Promise<void> {
  // Two of the six fatal falls on 2026-09-22 came straight after a stuck move:
  // this used to hop forward in any direction at all, ledges included.
  const yaw = safeHopYaw(bot);
  try {
    if (yaw !== null) await bot.look(yaw, 0, true);
    bot.setControlState('jump', true);
    bot.setControlState('forward', yaw !== null);
    await new Promise((r) => setTimeout(r, UNSTICK_MS));
  } finally {
    bot.clearControlStates();
  }
}

const HOP_DIRECTIONS: ReadonlyArray<[number, number]> = [
  [1, 0], [-1, 0], [0, 1], [0, -1], [1, 1], [1, -1], [-1, 1], [-1, -1],
];

/**
 * A direction to hop that does not go over a drop or into water or lava, or
 * null to hop in place. Checks two blocks ahead, since a hop carries that far.
 */
export function safeHopYaw(bot: Pick<Bot, 'entity' | 'blockAt'>): number | null {
  const feet = bot.entity.position.floored();
  const landsSafely = (dx: number, dz: number): boolean => {
    const column = feet.offset(dx, 0, dz);
    const here = bot.blockAt(column);
    if (here === null || here.name === 'water' || here.name === 'lava') return false;
    for (let down = 1; down <= SAFE_FALL; down++) {
      const below = bot.blockAt(column.offset(0, -down, 0));
      if (below === null) return false;
      if (below.name === 'water' || below.name === 'lava') return false;
      if (below.boundingBox === 'block') return true;
    }
    return false;
  };
  const start = Math.floor(Math.random() * HOP_DIRECTIONS.length);
  for (let i = 0; i < HOP_DIRECTIONS.length; i++) {
    const [dx, dz] = HOP_DIRECTIONS[(start + i) % HOP_DIRECTIONS.length] ?? [0, 0];
    if (landsSafely(dx, dz) && landsSafely(dx * 2, dz * 2)) return Math.atan2(-dx, -dz);
  }
  return null;
}

/**
 * Where each player was last seen, per bot.
 *
 * follow_player and give_item used to fail outright the moment someone was
 * out of entity range -- "cannot see Dmitri" 13 times in one session, with
 * the agent standing where it had watched Dmitri walk off. A person would go
 * to where they last saw them and look again. Only what this bot itself saw:
 * nothing here knows where anyone is without having seen them.
 */
const LAST_SEEN_MAX_AGE_MS = 10 * 60_000;
const lastSeenByBot = new WeakMap<Bot, Map<string, { position: Vec3; at: number }>>();

export function trackPlayers(bot: Bot): () => void {
  const seen = new Map<string, { position: Vec3; at: number }>();
  lastSeenByBot.set(bot, seen);
  const timer = setInterval(() => {
    for (const [name, player] of Object.entries(bot.players)) {
      if (name === bot.username || player.entity === undefined || player.entity === null) continue;
      seen.set(name, { position: player.entity.position.clone(), at: Date.now() });
    }
  }, 1_000);
  timer.unref();
  bot.once('end', () => clearInterval(timer));
  return () => clearInterval(timer);
}

export function lastSeen(bot: Bot, username: string): { position: Vec3; ageMs: number } | null {
  const entry = lastSeenByBot.get(bot)?.get(username);
  if (entry === undefined) return null;
  const ageMs = Date.now() - entry.at;
  return ageMs <= LAST_SEEN_MAX_AGE_MS ? { position: entry.position, ageMs } : null;
}

/** Budget for reaching a player: how far they are, or were last seen. */
export function approachBudgetMs(bot: Bot, username: string): number {
  const visible = bot.players[username]?.entity;
  const where = visible?.position ?? lastSeen(bot, username)?.position ?? null;
  return where === null ? DEFAULT_MOVE_TIMEOUT_MS : moveBudgetMs(bot.entity.position.distanceTo(where));
}

export type ApproachResult =
  | { ok: true; startDistance: number; endDistance: number; searchedLastSeen: boolean }
  | { ok: false; code: 'not_found' | 'unreachable' | 'timeout'; message: string };

/**
 * Get within `range` of a player, following them if they move.
 *
 * Shared by follow_player and give_item, which both need exactly this, and
 * without the action mutex so give_item can use it while holding its own.
 * Out of sight, it goes to where they were last seen and looks again.
 */
export async function approachPlayer(
  bot: Bot,
  username: string,
  range: number,
  timeoutMs: number,
  signal: AbortSignal,
): Promise<ApproachResult> {
  const deadline = Date.now() + timeoutMs;
  let searchedLastSeen = false;

  if (bot.players[username]?.entity == null) {
    const memory = lastSeen(bot, username);
    if (memory === null) {
      return {
        ok: false,
        code: 'not_found',
        message:
          `cannot see ${username}, and have not seen them in the last ${LAST_SEEN_MAX_AGE_MS / 60_000} minutes` +
          ' -- they may be far away, in another dimension, or offline',
      };
    }
    searchedLastSeen = true;
    const p = memory.position;
    await navigateTo(bot, p.x, p.y, p.z, 3, Math.max(5_000, deadline - Date.now() - 3_000), signal);
    if (bot.players[username]?.entity == null) {
      return {
        ok: false,
        code: 'not_found',
        message:
          `cannot see ${username}; went to where you last saw them ` +
          `(${Math.round(p.x)}, ${Math.round(p.y)}, ${Math.round(p.z)}, ${Math.round(memory.ageMs / 1000)}s earlier) ` +
          'and they are not there any more',
      };
    }
  }

  const first = bot.players[username]?.entity;
  if (first == null) return { ok: false, code: 'not_found', message: `cannot see ${username}` };
  const startDistance = bot.entity.position.distanceTo(first.position);

  // Retried the same way moveTo is, and for the same reason: this used to be
  // a single un-retried pathfindTo call, which made follow_player the
  // worst-performing action in the tool surface (37.5% success, measured
  // live) -- a target that is WALKING makes a wedge more likely, not less.
  let outcome = 'no_path';
  let detail = '';
  let endDistance = startDistance;

  for (let attempt = 0; attempt <= WEDGE_RETRIES; attempt++) {
    const live = bot.players[username]?.entity;
    if (live == null) {
      outcome = 'no_path';
      detail = 'they are no longer visible';
      endDistance = Number.NaN;
      break;
    }
    endDistance = bot.entity.position.distanceTo(live.position);
    if (endDistance <= range + 1) {
      outcome = 'reached';
      break;
    }

    const remainingBudget = deadline - Date.now();
    if (remainingBudget <= 1_000) {
      outcome = 'timeout';
      detail = 'ran out of time between retries';
      break;
    }

    const result = await pathfindTo(
      bot,
      new goals.GoalFollow(live, range),
      signal,
      Math.min(remainingBudget, MAX_ATTEMPT_MS),
      attempt > 0,
    );
    outcome = result.outcome;
    detail = result.detail;

    endDistance = bot.entity.position.distanceTo(live.position);
    // GoalFollow never "completes" while the target keeps moving, so being
    // within range counts as success even when goto did not resolve.
    if (endDistance <= range + 1) {
      outcome = 'reached';
      break;
    }

    if (outcome !== 'wedged' && outcome !== 'timeout') break;
    if (signal.aborted) break;
    await unstick(bot);
  }

  if (outcome === 'reached') {
    return { ok: true, startDistance: round2(startDistance), endDistance: round2(endDistance), searchedLastSeen };
  }
  return {
    ok: false,
    code: outcome === 'timeout' ? 'timeout' : 'unreachable',
    message: `${outcome}${detail === '' ? '' : `: ${detail}`} (${
      Number.isFinite(endDistance) ? `${round2(endDistance)}m away` : 'lost sight of them'
    })`,
  };
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
      timeoutMs?: number,
    ): Promise<ActionResult> {
      const budget = timeoutMs ?? moveBudgetMs(bot.entity.position.distanceTo(new Vec3(x, y, z)));
      return runner.run({ action: 'move_to', eventType: 'movement', timeoutMs: budget }, async (signal) => {
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
          budget - 1_000,
          signal,
        );

        if (outcome !== 'reached') {
          // Wedge, no-path and timeout all mean the same thing to a caller:
          // this destination could not be reached right now. The distinction
          // is preserved in the message for humans and for ADR-006 follow-up.
          throw new ActionFailure(
            outcome === 'timeout' ? 'timeout' : 'unreachable',
            `${outcome} after ${attempts} attempt(s)${detail === '' ? '' : `: ${detail}`} (${round2(remaining)}m short)`,
            {
              from: toPosition(from),
              to: toPosition(bot.entity.position),
              requested: toPosition(target),
              travelled: round2(startDistance - remaining),
              remaining: round2(remaining),
              attempts,
            },
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
      timeoutMs?: number,
    ): Promise<ActionResult> {
      const budget = timeoutMs ?? approachBudgetMs(bot, username);
      return runner.run(
        { action: 'follow_player', eventType: 'movement', timeoutMs: budget },
        async (signal) => {
          const result = await approachPlayer(bot, username, range, budget - 1_000, signal);
          if (result.ok) {
            return {
              username,
              startDistance: result.startDistance,
              endDistance: result.endDistance,
              ...(result.searchedLastSeen ? { foundVia: 'where you last saw them' } : {}),
            };
          }
          throw new ActionFailure(result.code, result.message, {
            username,
            position: toPosition(bot.entity.position),
          });
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
