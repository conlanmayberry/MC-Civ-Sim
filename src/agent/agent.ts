/**
 * The agent loop: OBSERVE -> DECIDE -> ACT -> RECORD.
 *
 * Deliberately slow. Minecraft runs at 20 ticks a second; this thinks once
 * every 15 seconds by default, plus when something happens that is worth
 * reacting to. The brief is explicit about this separation, and it is also what
 * makes the economics work -- a decision per tick would be both unaffordable
 * and worse, since most ticks contain no new information. Measured live at
 * this cadence with prompt caching in effect, Luna costs about $0.06/agent-hour
 * -- well under the $5 cap for an afternoon (see ADR-010's pricing table for
 * the pre-caching estimate that was budgeted against).
 *
 * The loop never runs two decisions at once and never thinks while acting. The
 * action layer's mutex (ADR-007) would refuse the overlap anyway, but waiting
 * is the correct behaviour rather than the enforced one: a model deciding from
 * a world state that is mid-change is deciding from fiction.
 */

import type { Bot } from 'mineflayer';

import type { ActionResult, Actions } from '../bot/actions/index.ts';
import type { Logger } from '../util/log.ts';
import type { Budget } from '../ai/budget.ts';
import { backoffMs, classifyProviderError } from '../ai/errors.ts';
import { formatUsd } from '../ai/pricing.ts';
import type { AiProvider } from '../ai/provider.ts';
import { describeForModel } from '../ai/provider.ts';
import { buildObservation, buildSystemPrompt, trimHistory } from '../ai/prompt.ts';
import { TOOL_SCHEMAS, invokeTool } from '../ai/tools.ts';
import type { AgentIdentity } from './identity.ts';
import type { Inbox } from './inbox.ts';
import type { Hearing } from './hearing.ts';
import type { Orders } from './orders.ts';
import type { Places } from './places.ts';
import { createSetbacks } from './setbacks.ts';
import { createVoice } from './voice.ts';
import { createWaker } from './waker.ts';

export interface AgentOptions {
  identity: AgentIdentity;
  provider: AiProvider;
  budget: Budget;
  inbox: Inbox;
  hearing: Hearing;
  places: Places;
  /** Standing orders from the operator, which override the agent's own plans. */
  orders: Orders;
  log: Logger;
  /** Normal thinking interval. */
  intervalMs: number;
  /** Called when the agent stops for good. */
  onStopped?: (reason: string) => void;
  /**
   * Called with exactly what each decision is made from, just before it is
   * made. This is what replay re-runs later -- see src/replay.
   */
  recordInput?: (input: DecisionInput) => void;
}

/** Everything a decision is a function of, besides the system prompt and tools. */
export interface DecisionInput {
  cycle: number;
  trigger: string;
  observation: string;
  history: string[];
  injections: string[];
}

export interface Agent {
  /** Begin thinking. Resolves when the agent stops. */
  run: (bot: Bot, actions: Actions) => Promise<void>;
  /**
   * Ask for an early decision, e.g. after taking damage.
   *
   * `urgent` also abandons the rest of the batch in progress. An operator
   * order that waited for a ten-step plan to finish would not be an override.
   */
  nudge: (reason: string, urgent?: boolean) => void;
  /**
   * Deliver something said nearby. Records it and, if it names this agent,
   * wakes it to reply now rather than at the next interval.
   */
  hear: (from: string, text: string, distance: number | null) => void;
  stop: (reason: string) => void;
  cycles: () => number;
  /** What the agent says it is working on, for the dashboard. */
  goal: () => string | null;
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/** Hunger and health thresholds that justify thinking early. */
const LOW_FOOD = 6;
const LOW_HEALTH = 10;
/**
 * Give up after this many failures in a row.
 *
 * A backstop for errors the classifier does not recognise: unknown failures are
 * treated as transient so a one-off does not end a run, and this is what stops
 * "transient" becoming "forever".
 */
const MAX_CONSECUTIVE_FAILURES = 5;
/**
 * Ceiling on tool calls in one decision.
 *
 * The model is encouraged to batch -- placing eight blocks should be one turn,
 * not eight -- but an unbounded list could run for many minutes with no chance
 * to reconsider, which is exactly the wedge the interval exists to avoid.
 */
const MAX_TOOL_CALLS = 10;
/** And a wall-clock ceiling, since a batch of moves can be slow rather than many. */
const MAX_ACTING_MS = 120_000;
/**
 * How long to wait before trying again after a turn that changed nothing at
 * all -- restated a goal it already had, logged a place it already knew, or
 * called no tool.
 *
 * Short, so a stray no-op does not cost a full interval standing still. Not
 * zero, so it does not hammer the API back-to-back. Used at most once in a
 * row (see the run loop): if the very next turn is ALSO a no-op, something
 * more than a stray restatement is going on, and falling back to the normal
 * interval is safer than a fast loop with no backstop.
 */
const NOOP_RETRY_MS = 4_000;

/**
 * Speech first, whatever order the model listed things in.
 *
 * What an agent says is composed before any of the batch runs, so it can never
 * depend on how an action turned out -- but leaving `send_chat` behind a
 * forty-second mining trip makes the reply land forty seconds late, which to
 * whoever asked is indistinguishable from being ignored. Nothing is lost by
 * saying it first, and the wait is what people actually notice.
 *
 * sort() is stable, so everything else keeps the order it was decided in.
 */
export function orderCalls<T extends { name: string }>(calls: readonly T[]): T[] {
  return [...calls].sort(
    (a, b) => Number(b.name === 'send_chat') - Number(a.name === 'send_chat'),
  );
}

/**
 * Did an action result count as this turn accomplishing something?
 *
 * Only a result explicitly marked `unchanged` fails this -- a restated goal
 * (set_goal), a place already known at the same spot (remember_place). A
 * FAILED action still counts as effective: `unreachable`, `no_tool`,
 * `insufficient_items` are real information the model did not have before,
 * which is a different situation from a turn that produced nothing at all.
 * Used to decide whether a turn earned its full interval -- see NOOP_RETRY_MS.
 */
export function isEffective(result: ActionResult): boolean {
  return result.detail?.['unchanged'] !== true;
}

/**
 * Record a place and report it the way every other tool reports itself.
 *
 * Coordinates are optional because the common case is "here", and asking a
 * model to restate coordinates it was just shown is an invitation to transcribe
 * them wrongly.
 */
function rememberPlaceWith(
  places: Places,
  log: Logger,
  bot: Bot,
  name: string,
  note: string,
  at: { x: number; y: number; z: number } | null,
  cycle: number,
): ActionResult {
  const position = at ?? bot.entity?.position ?? null;
  if (position === null) {
    return {
      ok: false,
      action: 'remember_place',
      durationMs: 0,
      detail: { name },
      error: { code: 'failed', message: 'cannot tell where you are right now' },
    };
  }

  const { place, changed } = places.remember({
    name,
    note,
    x: position.x,
    y: position.y,
    z: position.z,
    dimension: bot.game?.dimension ?? 'overworld',
  });

  log.event('place_remembered', {
    name: place.name,
    note: place.note,
    x: place.x,
    y: place.y,
    z: place.z,
    dimension: place.dimension,
    changed,
    cycle,
  });

  return {
    ok: true,
    action: 'remember_place',
    durationMs: 0,
    detail: changed
      ? { ...place }
      : {
          ...place,
          // Mirrors set_goal's `unchanged`: this place already pointed here,
          // so nothing about the world model actually changed this turn.
          unchanged: true,
          hint: 'this was already recorded at the same spot, so nothing changed',
        },
  };
}

export function createAgent(options: AgentOptions): Agent {
  const { identity, provider, budget, inbox, hearing, places, orders, log } = options;

  const system = buildSystemPrompt(identity);
  let history: string[] = [];
  // Survives interruptions on purpose: an agent that gets spoken to mid-task
  // and never returns to it was the whole problem this solves.
  let goal: string | null = null;
  let cycle = 0;
  let stopping: string | null = null;
  const waker = createWaker();
  // What has already been tried and refused, so a failure survives longer than
  // the six-turn history window that let one placement be retried 110 times.
  const setbacks = createSetbacks();
  // Chat was free while every physical act cost seconds, so the cheapest way
  // to look busy was always to say something. This gives talking a price.
  const voice = createVoice();

  function nudge(reason: string, urgent = false): void {
    waker.nudge(reason, urgent);
  }

  const rememberPlace = (
    bot: Bot,
    name: string,
    note: string,
    at: { x: number; y: number; z: number } | null,
    cycle: number,
  ): ActionResult => rememberPlaceWith(places, log, bot, name, note, at, cycle);

  /**
   * Runs one cycle; returns whether it actually changed anything.
   *
   * False covers a decision with no tool calls and a decision whose every call
   * came back marked `unchanged` (a restated goal, a place already known). The
   * run loop uses this to decide whether the turn earned its full interval or
   * should be retried sooner -- see NOOP_RETRY_MS.
   */
  async function runOneCycle(bot: Bot, actions: Actions): Promise<boolean> {
    cycle++;
    // Consuming the trigger also clears any interruption: from here on, only
    // news arriving *after* this point -- including during the API call, which
    // this decision cannot have accounted for -- may cut the batch short.
    const trigger = waker.takeTrigger();

    const injections = inbox.drain();
    for (const injection of injections) {
      // Recorded as an intervention: analysis must be able to see exactly where
      // a human steered the run.
      log.event('thought_injected', {
        from: injection.from,
        text: injection.text,
        queuedAt: injection.at,
        cycle,
      });
    }

    // takeNew, not recent: each message is presented once as fresh. The
    // window in `recent` still gives continuity through history.
    const heard = hearing.takeNew();
    const observation = buildObservation(bot, cycle, {
      heard,
      goal,
      places: places.all(),
      setbacks: setbacks.all(cycle),
      voice: voice.describe(),
      order: orders.current(),
    });

    const decisionHistory = trimHistory(history);
    const decisionInjections = injections.map((i) => i.text);

    // Recorded before the call, so a decision that errors or crashes still
    // leaves the situation that produced it -- those are exactly the ones
    // worth replaying.
    try {
      options.recordInput?.({
        cycle,
        trigger,
        observation,
        history: decisionHistory,
        injections: decisionInjections,
      });
    } catch {
      /* analysis must never cost the agent a turn */
    }

    // Timed because thinking is dead air: the agent stands still for it, and
    // without a number there is no way to tell a slow model from a slow loop.
    const decideStarted = Date.now();
    const outcome = await provider.decide({
      system,
      observation,
      history: decisionHistory,
      injections: decisionInjections,
      tools: [...TOOL_SCHEMAS],
    });
    const decisionMs = Date.now() - decideStarted;

    const spent = budget.record(outcome.model, outcome.usage);
    const warning = budget.takeWarning();
    if (warning !== null) {
      log.event('budget_warning', { message: warning, spentUsd: spent });
    }

    // The decision itself, before acting -- so a crash mid-action still leaves
    // a record of what was intended. Summary only; no chain-of-thought.
    log.event('decision', {
      cycle,
      trigger,
      // So analysis can separate turns the agent decided for itself from turns
      // it was under instruction. Without this the two are indistinguishable
      // afterwards, and the run stops being evidence of anything.
      underOrder: orders.current() === null ? null : orders.current()?.text,
      durationMs: decisionMs,
      summary: outcome.summary,
      tools: outcome.toolCalls.map((c) => c.name),
      args: outcome.toolCalls.map((c) => c.args),
      goal,
      model: outcome.model,
      inputTokens: outcome.usage.inputTokens,
      cachedTokens: outcome.usage.cachedTokens,
      outputTokens: outcome.usage.outputTokens,
      costUsd: outcome.costUsd,
      spentUsd: spent,
      injections: injections.length,
    });

    if (outcome.toolCalls.length === 0) {
      history.push(`Turn ${cycle}: ${outcome.summary || 'did nothing'} -> no action taken`);
      history = trimHistory(history);
      log.event('observation', { note: 'no-op turn', cycle, reason: 'no tool calls' });
      return false;
    }

    const results: string[] = [];
    const actingDeadline = Date.now() + MAX_ACTING_MS;
    let effective = false;

    const calls = orderCalls(outcome.toolCalls);

    for (const call of calls.slice(0, MAX_TOOL_CALLS)) {
      if (stopping !== null) break;

      // Somebody said the agent's name while it was working. Finishing an
      // eight-step plan first is the behaviour of a machine; stopping and
      // reconsidering with the new information is the point of the loop. The
      // goal persists, so it can pick the work back up next turn.
      const interruption = waker.interruption();
      if (interruption !== null) {
        results.push(`(stopped early -- ${interruption}; remaining steps skipped)`);
        break;
      }

      if (Date.now() > actingDeadline) {
        // Stopping here rather than pressing on: the world has moved since the
        // decision was made, and continuing to execute a stale plan is worse
        // than reconsidering with fresh eyes.
        results.push('(ran out of time; remaining steps skipped)');
        break;
      }

      // Skip a call that already failed THIS batch, rather than running it
      // against the world a second or third time.
      //
      // Found live: one decision placed cobblestone at the same already-solid
      // coordinate three times in a row -- not three separate turns re-trying
      // it, but one batch of tool calls containing the identical failing call
      // three times, because the model decided all three before seeing any of
      // the results. Cross-turn setbacks (below) could not have caught this:
      // they only reach the prompt on the NEXT decision, and by then the
      // damage -- three wasted actions, three identical telemetry rows -- was
      // already done. This is the same memory, checked one batch earlier.
      const repeat = setbacks.active(call.name, call.args, cycle);
      const result =
        repeat !== null
          ? {
              ok: false as const,
              action: call.name,
              durationMs: 0,
              detail: {},
              error: {
                code: 'blocked' as const,
                message: `skipped -- this exact call already failed earlier in this same batch (${repeat.why}); it will not work unchanged`,
              },
            }
          : await invokeTool(
              actions,
              (message) => {
                if (!voice.trySpeak()) {
                  log.event('observation', {
                    note: 'chat withheld -- allowance spent',
                    message,
                    cycle,
                  });
                  return false;
                }
                bot.chat(message);
                // Record it: the agent does not hear itself, so without this its
                // own replies exist nowhere and every conversation reads one-sided.
                log.event('chat_sent', { message, cycle });
                return true;
              },
              call.name,
              call.args,
              (next) => {
                // Restating the same goal is not a change, and recording it as
                // one makes the telemetry read as though the agent kept
                // changing its mind when it was in fact stuck.
                if (next === goal) return false;
                goal = next;
                log.event('goal_set', { goal: next, cycle });
                return true;
              },
              (name, note, at) => rememberPlace(bot, name, note, at, cycle),
            );
      results.push(describeForModel(call.name, result));

      // Remembered past the history window, and cleared the moment the same
      // attempt works -- a setback is a fact about a moment, not a law.
      if (result.ok) {
        setbacks.succeeded(call.name, call.args);
      } else {
        setbacks.record(
          call.name,
          call.args,
          result.error?.message ?? result.error?.code ?? 'failed',
          cycle,
        );
      }

      if (isEffective(result)) effective = true;

      // A failure is information, not an error: the model sees it next turn and
      // can choose differently. That is the whole point of ADR-007's contract.
      if (!result.ok && result.error?.code === 'interrupted') break;
    }

    if (calls.length > MAX_TOOL_CALLS) {
      results.push(`(only the first ${MAX_TOOL_CALLS} of ${calls.length} were run)`);
    }

    history.push(`Turn ${cycle}: ${outcome.summary}\n${results.join('\n')}`);
    history = trimHistory(history);

    if (!effective) {
      log.event('observation', {
        note: 'no-op turn',
        cycle,
        reason: 'every call changed nothing',
      });
    }

    return effective;
  }

  return {
    cycles: () => cycle,
    goal: () => goal,

    stop(reason) {
      stopping ??= reason;
      budget.stop('operator');
      waker.nudge(reason, true);
    },

    nudge,

    hear(from, text, distance) {
      const message = hearing.hear(from, text, distance);
      if (message === null) return;

      // ONLY being addressed by name wakes the agent.
      //
      // Overhearing used to trigger a decision too, which was right with one
      // agent and a player and became a feedback storm with four: every
      // message woke the other three, each of whom replied, waking the
      // others. Measured across a one-hour four-agent session, 82% of all
      // 1,487 decisions were chat-triggered and 40% were merely overheard --
      // most of the run's thinking, and most of its cost, was agents
      // answering each other rather than doing anything.
      //
      // Nothing is lost by not waking: the message is already recorded above
      // and appears in the next observation either way. This changes when it
      // is read, not whether.
      if (!message.directed) return;

      nudge(`${from} addressed you`, true);
    },

    async run(bot, actions) {
      // React to things worth reacting to, rather than only to the clock.
      bot.on('health', () => {
        if (bot.food <= LOW_FOOD) nudge('hungry');
        else if (bot.health <= LOW_HEALTH) nudge('hurt');
      });
      bot.on('death', () => {
        // Recorded before the nudge, while the position is still the one it
        // died at. Where you died is the single most useful thing to know
        // afterwards -- your things are there, and so is whatever killed you.
        rememberPlace(bot, 'where i died', 'my things dropped here', null, cycle);
        nudge('died');
      });
      // Chat arrives via hear(), called from the single onChat handler in
      // main.ts. Registering another bot.on('chat') here would double-log every
      // message, since connection.ts already records chat_received.

      log.event('agent_started', {
        agent: identity.id,
        username: identity.username,
        model: provider.model,
        provider: provider.id,
        intervalMs: options.intervalMs,
        traits: identity.traits,
        // Recorded because it changes what the run is evidence FOR: with a
        // role assigned, division of labour was given rather than observed.
        role: identity.role,
      });

      let stopReason = 'unknown';
      let consecutiveFailures = 0;
      // Tracks one no-op turn at a time -- see NOOP_RETRY_MS for why this is
      // bounded to a single fast retry rather than however many it takes.
      let noOpStreak = 0;

      for (;;) {
        if (stopping !== null) {
          stopReason = stopping;
          break;
        }

        const verdict = budget.check();
        if (!verdict.allowed) {
          if (verdict.stop !== undefined) {
            stopReason = `${verdict.stop}: ${verdict.reason}`;
            break;
          }
          // Rate-limited rather than stopped: wait it out.
          log.event('observation', { note: 'rate limited', reason: verdict.reason });
          await sleep(verdict.waitMs ?? 1_000);
          continue;
        }

        // Defaults to effective so an error below falls straight through to
        // the normal interval -- the backoff sleep already governs retries on
        // a failed cycle, and the no-op path is only for a cycle that ran
        // cleanly and simply did nothing.
        let effective = true;

        try {
          effective = await runOneCycle(bot, actions);
          consecutiveFailures = 0;
        } catch (err) {
          consecutiveFailures++;
          const { kind, reason } = classifyProviderError(err);

          log.error('agent-cycle', err);
          log.event('observation', {
            note: 'cycle failed',
            kind,
            reason,
            consecutiveFailures,
          });

          // A permanent condition -- no credits, a rejected key, a model that
          // does not exist -- will not fix itself. Retrying it every few
          // seconds forever is a runaway loop, so stop and say why.
          if (kind === 'permanent') {
            stopReason = `provider error (${reason})`;
            console.error(`
  ${reason} -- stopping. This will not resolve by retrying.`);
            break;
          }

          if (consecutiveFailures >= MAX_CONSECUTIVE_FAILURES) {
            stopReason = `${consecutiveFailures} consecutive failures (${reason})`;
            console.error(`
  ${consecutiveFailures} cycles failed in a row -- stopping.`);
            break;
          }

          await sleep(backoffMs(consecutiveFailures));
        }

        if (stopping !== null) {
          stopReason = stopping;
          break;
        }

        if (!effective && noOpStreak === 0) {
          // First empty turn in a row: try again shortly rather than standing
          // still for a full interval on it.
          noOpStreak = 1;
          await waker.wait(NOOP_RETRY_MS);
          continue;
        }
        noOpStreak = 0;
        await waker.wait(options.intervalMs);
      }

      log.event('agent_stopped', {
        agent: identity.id,
        reason: stopReason,
        cycles: cycle,
        spentUsd: budget.spentUsd(),
        requests: budget.requestCount(),
        summary: budget.summary(),
      });

      console.log(`\n  Agent stopped: ${stopReason}`);
      console.log(`  ${budget.summary()}  |  ${cycle} cycles, ${formatUsd(budget.spentUsd())}\n`);

      options.onStopped?.(stopReason);
    },
  };
}
