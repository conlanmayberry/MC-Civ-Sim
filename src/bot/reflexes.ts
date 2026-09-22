/**
 * Things the body does without asking the model.
 *
 * Found by the one-hour four-agent session of 2026-09-16: 28 of 33 deaths were
 * drowning. The model could see `oxygen` in every observation, but it thinks
 * every few seconds at best and a single move_to can run for 45 -- so an agent
 * pathing along a lake bed ran out of air mid-action, died, respawned nearby,
 * went back for its dropped things and drowned again. Bob did that nine times.
 *
 * No decision loop can be fast enough for that, and no decision is actually
 * needed: nobody wants to drown. So it is a reflex, like pulling a hand off a
 * stove. It takes the body away from whatever action holds it, swims up, and
 * gives it back once the agent can breathe, and the agent is told it happened.
 *
 * Deliberately the only reflex. Every other choice -- flee or fight, eat now or
 * later -- is the model's, because those are the behaviours being studied.
 */

import type { Bot } from 'mineflayer';

import type { Logger } from '../util/log.ts';
import type { ActionRunner } from './actions/run.ts';

/** Out of 20. Twenty is ~15s of air, so this leaves ~10s to reach the surface. */
const SURFACE_BELOW_OXYGEN = 14;
const CHECK_MS = 250;
/** Swimming straight up has not freed the head after this long: something is overhead. */
const BLOCKED_OVERHEAD_MS = 3_000;
const TURN_EVERY_MS = 1_500;
/** Give the body back regardless, rather than holding it forever in some odd case. */
const MAX_HOLD_MS = 25_000;

/**
 * One notice per this long. A bot that surfaces and then sinks again would
 * otherwise wake its model every few seconds for the same news.
 */
const NOTIFY_EVERY_MS = 60_000;

const WATERY = new Set(['water', 'bubble_column', 'kelp', 'kelp_plant', 'seagrass', 'tall_seagrass']);

export function headUnderwater(bot: Bot): boolean {
  const block = bot.blockAt(bot.entity.position.offset(0, bot.entity.height * 0.9, 0));
  if (block === null) return false;
  if (WATERY.has(block.name)) return true;
  const properties = block.getProperties() as Record<string, unknown>;
  return properties['waterlogged'] === true || properties['waterlogged'] === 'true';
}

/**
 * Air, out of 20.
 *
 * mineflayer leaves oxygenLevel undefined until the server first reports a
 * change, which happens only once the head goes under. Undefined therefore
 * means full -- and read raw, `undefined > 14` is false, so every bot standing
 * in water one block deep counted as out of air. That fired the reflex in the
 * middle of a wheat harvest beside a water channel in the arena.
 */
export function air(bot: Bot): number {
  const level = bot.oxygenLevel as number | undefined;
  return typeof level === 'number' && Number.isFinite(level) ? level : 20;
}

export interface Reflexes {
  /** Called when a reflex has finished, with what happened, so the agent can be told. */
  onReflex: (listener: (what: string) => void) => void;
  stop: () => void;
}

export function startReflexes(bot: Bot, runner: ActionRunner, log: Logger): Reflexes {
  const listeners: Array<(what: string) => void> = [];
  let engagedAt: number | null = null;
  let lastTurn = 0;
  let lowestOxygen = 20;
  let lastNotified = 0;
  let treading = false;

  function release(outcome: string): void {
    if (engagedAt === null) return;
    const durationMs = Date.now() - engagedAt;
    engagedAt = null;
    bot.clearControlStates();
    runner.hold(null);
    log.event('reflex', { reflex: 'surface', outcome, durationMs, lowestOxygen, oxygen: air(bot) });
    if (outcome === 'died') return;
    const what =
      outcome === 'surfaced'
        ? `you were running out of air underwater (oxygen fell to ${lowestOxygen}/20), so you stopped what you were doing and swam up. Stay out of deep water.`
        : `you were drowning and could not reach air (${outcome}). Get out of the water.`;
    if (Date.now() - lastNotified < NOTIFY_EVERY_MS) return;
    lastNotified = Date.now();
    for (const listener of listeners) listener(what);
  }

  const timer = setInterval(() => {
    if (bot.entity === undefined || bot.health <= 0) {
      if (engagedAt !== null) release('died');
      return;
    }
    const underwater = headUnderwater(bot);

    if (engagedAt === null) {
      // Idle in water, keep afloat. Traced in the arena: released at the
      // surface with nothing to do, a bot sinks straight back to the bottom
      // and needs rescuing again seven seconds later. Any action that moves
      // the bot takes the controls over, so this only applies while idle.
      const inWater = (bot.entity as { isInWater?: boolean }).isInWater === true;
      if (inWater && !runner.busy()) {
        bot.setControlState('jump', true);
        treading = true;
      } else if (treading) {
        // Out of the water, or an action has started: let go, or a craft in
        // shallow water would be done bouncing.
        bot.setControlState('jump', false);
        treading = false;
      }
      // Air falling is the server's own verdict that the head is under. The
      // block check alone missed it once in the arena: a bot swimming in the
      // low swimming pose has its eyes well below where mineflayer puts them
      // (it does not track pose), so air ran down to 8 with "head" in the air
      // block above. In water with air going, that is enough. (Not air alone:
      // mineflayer reads 0 until the server first sends it.)
      if (!(underwater || inWater) || air(bot) > SURFACE_BELOW_OXYGEN) return;
      engagedAt = Date.now();
      lastTurn = engagedAt;
      lowestOxygen = air(bot);
      // Taking the hold first aborts the running action, whose own cleanup
      // clears the pathfinder goal; clearing here too covers an idle bot.
      runner.hold('interrupted to swim up for air before drowning');
      bot.pathfinder?.setGoal(null);
      bot.clearControlStates();
      bot.setControlState('jump', true);
      return;
    }

    lowestOxygen = Math.min(lowestOxygen, air(bot));
    const elapsed = Date.now() - engagedAt;

    if (!underwater && air(bot) >= 20) {
      release('surfaced');
      return;
    }
    if (elapsed > MAX_HOLD_MS) {
      release('gave up after 25s');
      return;
    }

    bot.setControlState('jump', true);
    if (underwater && elapsed > BLOCKED_OVERHEAD_MS) {
      // Straight up is not working -- under an overhang or ice. Swim sideways,
      // turning now and then, to find open water above.
      bot.setControlState('forward', true);
      if (Date.now() - lastTurn > TURN_EVERY_MS) {
        lastTurn = Date.now();
        void bot.look(bot.entity.yaw + Math.PI / 2, 0, true);
      }
    } else if (!underwater) {
      // Head is out: tread water in place until the lungs are full.
      bot.setControlState('forward', false);
    }
  }, CHECK_MS);
  timer.unref();

  bot.once('end', () => clearInterval(timer));
  // Respawning puts the bot on dry land with full air, which would otherwise
  // read as having surfaced.
  bot.on('death', () => release('died'));

  return {
    onReflex: (listener) => listeners.push(listener),
    stop: () => clearInterval(timer),
  };
}
