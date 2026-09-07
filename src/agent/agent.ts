/**
 * The agent loop: OBSERVE -> DECIDE -> ACT -> RECORD.
 *
 * Deliberately slow. Minecraft runs at 20 ticks a second; this thinks once
 * every 30 seconds by default, plus when something happens that is worth
 * reacting to. The brief is explicit about this separation, and it is also what
 * makes the economics work -- a decision per tick would be both unaffordable
 * and worse, since most ticks contain no new information.
 *
 * The loop never runs two decisions at once and never thinks while acting. The
 * action layer's mutex (ADR-007) would refuse the overlap anyway, but waiting
 * is the correct behaviour rather than the enforced one: a model deciding from
 * a world state that is mid-change is deciding from fiction.
 */

import type { Bot } from 'mineflayer';

import type { Actions } from '../bot/actions/index.ts';
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

export interface AgentOptions {
  identity: AgentIdentity;
  provider: AiProvider;
  budget: Budget;
  inbox: Inbox;
  hearing: Hearing;
  log: Logger;
  /** Normal thinking interval. */
  intervalMs: number;
  /** Called when the agent stops for good. */
  onStopped?: (reason: string) => void;
}

export interface Agent {
  /** Begin thinking. Resolves when the agent stops. */
  run: (bot: Bot, actions: Actions) => Promise<void>;
  /** Ask for an early decision, e.g. after taking damage. */
  nudge: (reason: string) => void;
  /**
   * Deliver something said nearby. Records it and, if it names this agent,
   * wakes it to reply now rather than at the next interval.
   */
  hear: (from: string, text: string, distance: number | null) => void;
  stop: (reason: string) => void;
  cycles: () => number;
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

export function createAgent(options: AgentOptions): Agent {
  const { identity, provider, budget, inbox, hearing, log } = options;

  const system = buildSystemPrompt(identity);
  let history: string[] = [];
  let cycle = 0;
  let stopping: string | null = null;
  let wakeEarly: (() => void) | null = null;
  let nudgeReason: string | null = null;

  function nudge(reason: string): void {
    nudgeReason = reason;
    wakeEarly?.();
  }

  /** Sleep, but wake immediately if something interesting happens. */
  async function waitForNextCycle(ms: number): Promise<void> {
    await new Promise<void>((resolve) => {
      const timer = setTimeout(() => {
        wakeEarly = null;
        resolve();
      }, ms);
      timer.unref();
      wakeEarly = () => {
        clearTimeout(timer);
        wakeEarly = null;
        resolve();
      };
    });
  }

  async function runOneCycle(bot: Bot, actions: Actions): Promise<void> {
    cycle++;
    const trigger = nudgeReason ?? 'interval';
    nudgeReason = null;

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
    const observation = buildObservation(bot, cycle, heard);

    const outcome = await provider.decide({
      system,
      observation,
      history: trimHistory(history),
      injections: injections.map((i) => i.text),
      tools: [...TOOL_SCHEMAS],
    });

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
      summary: outcome.summary,
      tools: outcome.toolCalls.map((c) => c.name),
      args: outcome.toolCalls.map((c) => c.args),
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
      return;
    }

    const results: string[] = [];
    for (const call of outcome.toolCalls) {
      if (stopping !== null) break;

      const result = await invokeTool(
        actions,
        (message) => {
          bot.chat(message);
          // Record it: the agent does not hear itself, so without this its own
          // replies exist nowhere and every conversation reads one-sided.
          log.event('chat_sent', { message, cycle });
        },
        call.name,
        call.args,
      );
      results.push(describeForModel(call.name, result));

      // A failure is information, not an error: the model sees it next turn and
      // can choose differently. That is the whole point of ADR-007's contract.
      if (!result.ok && result.error?.code === 'interrupted') break;
    }

    history.push(`Turn ${cycle}: ${outcome.summary}\n${results.join('\n')}`);
    history = trimHistory(history);
  }

  return {
    cycles: () => cycle,

    stop(reason) {
      stopping ??= reason;
      budget.stop('operator');
      wakeEarly?.();
    },

    nudge,

    hear(from, text, distance) {
      const message = hearing.hear(from, text, distance);
      if (message === null) return;

      // Being addressed by name deserves an answer now, not in half a minute.
      nudge(message.directed ? `${from} addressed you` : `chat from ${from}`);
    },

    async run(bot, actions) {
      // React to things worth reacting to, rather than only to the clock.
      bot.on('health', () => {
        if (bot.food <= LOW_FOOD) nudge('hungry');
        else if (bot.health <= LOW_HEALTH) nudge('hurt');
      });
      bot.on('death', () => nudge('died'));
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
      });

      let stopReason = 'unknown';
      let consecutiveFailures = 0;

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

        try {
          await runOneCycle(bot, actions);
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
        await waitForNextCycle(options.intervalMs);
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
