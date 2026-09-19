/**
 * The single wrapper every action goes through.
 *
 * Centralising this is what makes the five rules in ADR-007 true by
 * construction rather than by everyone remembering them: an action body just
 * returns its detail object or throws, and gets timeout handling, the
 * one-at-a-time guarantee, telemetry and error mapping for free.
 */

import type { Bot } from 'mineflayer';

import type { EventType, Logger } from '../../util/log.ts';
import type { ActionError, ActionErrorCode, ActionResult } from './types.ts';

/** Thrown by action bodies to select a specific error code. */
export class ActionFailure extends Error {
  readonly code: ActionErrorCode;
  /**
   * What is known despite the failure -- where a move ended, what was gathered
   * before it went wrong. Failed moves used to record only a message, so the
   * analysis of a session could not say where agents were trying to go.
   */
  readonly detail: Record<string, unknown>;

  constructor(code: ActionErrorCode, message: string, detail: Record<string, unknown> = {}) {
    super(message);
    this.name = 'ActionFailure';
    this.code = code;
    this.detail = detail;
  }
}

export interface ActionSpec {
  /** Stable snake_case name, e.g. 'mine_block'. */
  action: string;
  /** Telemetry event type from the Stage 4 vocabulary. */
  eventType: EventType;
  timeoutMs: number;
}

export interface ActionBody {
  (signal: AbortSignal): Promise<Record<string, unknown>>;
}

export interface ActionRunner {
  run: (spec: ActionSpec, body: ActionBody) => Promise<ActionResult>;
  /** True while an action holds the bot. */
  busy: () => boolean;
  /** Name of the running action, for error messages. */
  current: () => string | null;
  /**
   * Take the body away from whatever holds it, for a reflex that cannot wait
   * for the model -- surfacing before drowning. While held, the running action
   * fails as `interrupted` with the reason, and new actions are refused the
   * same way. Pass null to release.
   */
  hold: (reason: string | null) => void;
  /** Cut the running action short as `interrupted`, without refusing the next one. */
  interrupt: (reason: string) => void;
}

export interface ActionContext {
  bot: Bot;
  log: Logger;
  runner: ActionRunner;
}

export function createActionRunner(log: Logger): ActionRunner {
  // A bot has one body. Two actions driving it at once produce nonsense --
  // `moveTo` fighting `mineBlock` for control states, two `craft` calls racing
  // on the same inventory. Rather than interleave, the second caller is told it
  // was refused, which is information Stage 5 can act on.
  let running: string | null = null;
  let held: string | null = null;
  let abortRunning: ((reason: string) => void) | null = null;

  return {
    busy: () => running !== null,
    current: () => running,

    hold(reason) {
      held = reason;
      if (reason !== null) abortRunning?.(reason);
    },

    interrupt(reason) {
      abortRunning?.(reason);
    },

    async run(spec, body) {
      const started = Date.now();

      if (running !== null || held !== null) {
        const error: ActionError = {
          code: 'interrupted',
          message: held !== null ? held : `busy running ${running}`,
        };
        log.event(spec.eventType, {
          action: spec.action,
          ok: false,
          error: error.code,
          message: error.message,
        });
        return { ok: false, action: spec.action, durationMs: 0, detail: {}, error };
      }

      running = spec.action;
      const controller = new AbortController();

      // Unref'd on purpose: a pending timeout must never hold the process open
      // once everything else is finished. (The reconnect timer in
      // connection.ts is the opposite case and is deliberately NOT unref'd.)
      const timer = setTimeout(() => controller.abort(), spec.timeoutMs);
      timer.unref();
      let interruptedBy: string | null = null;
      abortRunning = (reason) => {
        interruptedBy = reason;
        controller.abort();
      };

      let result: ActionResult;
      try {
        const detail = await Promise.race([
          body(controller.signal),
          new Promise<never>((_resolve, reject) => {
            controller.signal.addEventListener('abort', () => {
              reject(
                interruptedBy !== null
                  ? new ActionFailure('interrupted', interruptedBy)
                  : new ActionFailure('timeout', `exceeded ${spec.timeoutMs}ms`),
              );
            });
          }),
        ]);
        // A body that notices the abort and returns normally was still cut
        // short; it must not read as having finished what it was asked.
        if (interruptedBy !== null) throw new ActionFailure('interrupted', interruptedBy);

        result = {
          ok: true,
          action: spec.action,
          durationMs: Date.now() - started,
          detail,
        };
      } catch (err) {
        const failureDetail = err instanceof ActionFailure ? err.detail : {};
        const failure =
          err instanceof ActionFailure
            ? { code: err.code, message: err.message }
            : {
                code: 'failed' as ActionErrorCode,
                message: err instanceof Error ? err.message : String(err),
              };

        result = {
          ok: false,
          action: spec.action,
          durationMs: Date.now() - started,
          detail: failureDetail,
          error: failure,
        };
      } finally {
        clearTimeout(timer);
        running = null;
        abortRunning = null;
      }

      // One event per action, success or failure. Stage 4 swaps the sink for
      // SQLite and gets an action log for free.
      log.event(spec.eventType, {
        action: result.action,
        ok: result.ok,
        durationMs: result.durationMs,
        ...(result.error === undefined ? {} : { error: result.error.code, message: result.error.message }),
        ...result.detail,
      });

      return result;
    },
  };
}

/** Formats a result for chat: short enough for Minecraft, honest about failure. */
export function describeResult(result: ActionResult): string {
  if (!result.ok) {
    return `${result.action} failed [${result.error?.code ?? 'failed'}]: ${result.error?.message ?? 'unknown'}`;
  }
  const parts = Object.entries(result.detail)
    .filter(([, v]) => v !== undefined && v !== null)
    .map(([k, v]) => `${k}=${typeof v === 'object' ? JSON.stringify(v) : String(v)}`);
  return `${result.action} ok (${(result.durationMs / 1000).toFixed(1)}s)${parts.length > 0 ? ` ${parts.join(' ')}` : ''}`;
}
