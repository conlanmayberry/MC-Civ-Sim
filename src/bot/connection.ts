/**
 * Mineflayer lifecycle: connect, observe the connection, reconnect, stop.
 *
 * The stopping half matters as much as the connecting half. An autonomous agent
 * that cannot be halted, or that hammers a downed server forever, is precisely
 * the failure mode the project brief's safety section is written against -- so
 * an intentional quit is a hard latch that the reconnect path checks, and the
 * backoff has both a ceiling and an attempt limit.
 */

import mineflayer from 'mineflayer';
import type { Bot } from 'mineflayer';

import type { BotConfig } from '../config.ts';
import type { Logger } from '../util/log.ts';

/**
 * How long a connection must hold before its backoff history is forgiven.
 * Anything shorter is a flapping connection, not a recovered one.
 */
const STABLE_CONNECTION_MS = 30_000;

export interface ConnectionHandlers {
  /**
   * Called after every successful spawn -- including reconnects. Reconnecting
   * builds a brand-new Bot object, so anything listener-shaped must be attached
   * here rather than once at startup.
   */
  onSpawn?: (bot: Bot) => void;
  onChat?: (bot: Bot, username: string, message: string) => void;
  /**
   * Called at the start of an intentional stop, while the bot is still
   * connected. The last chance to read live state -- by `onStopped` the socket
   * is closed and the entity is gone.
   */
  onStopping?: (bot: Bot) => void;
  /** Called once, when the session is finished and will not reconnect. */
  onStopped?: (reason: string) => void;
}

export interface BotSession {
  /** Stop for good. Suppresses reconnect; safe to call more than once. */
  stop: (reason?: string) => void;
  isStopping: () => boolean;
}

export function connect(
  config: BotConfig,
  log: Logger,
  handlers: ConnectionHandlers = {},
): BotSession {
  let stopping = false;
  let attempt = 0;
  let current: Bot | null = null;
  let retryTimer: NodeJS.Timeout | null = null;
  let stabilityTimer: NodeJS.Timeout | null = null;

  function clearStabilityTimer(): void {
    if (stabilityTimer !== null) {
      clearTimeout(stabilityTimer);
      stabilityTimer = null;
    }
  }

  const stop = (reason = 'stopped by operator'): void => {
    if (stopping) return;
    stopping = true;

    if (retryTimer !== null) {
      clearTimeout(retryTimer);
      retryTimer = null;
    }
    clearStabilityTimer();

    if (current !== null) {
      try {
        handlers.onStopping?.(current);
      } catch {
        // A telemetry failure must not prevent the bot from stopping.
      }
      try {
        current.quit(reason);
      } catch {
        // Already disconnected; nothing to do.
      }
    }

    log.event('bot_disconnected', { reason, intentional: true });
    handlers.onStopped?.(reason);
  };

  /** Full jitter on top of capped exponential backoff. */
  function nextDelayMs(): number {
    const capped = Math.min(
      config.reconnect.initialDelayMs * 2 ** attempt,
      config.reconnect.maxDelayMs,
    );
    return Math.round(capped / 2 + Math.random() * (capped / 2));
  }

  function scheduleReconnect(reason: string): void {
    if (stopping) return;

    if (!config.reconnect.enabled) {
      log.event('bot_disconnected', { reason, intentional: false, willRetry: false });
      handlers.onStopped?.(reason);
      return;
    }

    if (attempt >= config.reconnect.maxAttempts) {
      log.event('bot_disconnected', {
        reason,
        intentional: false,
        willRetry: false,
        note: `giving up after ${attempt} attempts`,
      });
      handlers.onStopped?.(`gave up reconnecting: ${reason}`);
      return;
    }

    const delayMs = nextDelayMs();
    attempt++;

    log.event('bot_reconnecting', {
      reason,
      attempt,
      maxAttempts: config.reconnect.maxAttempts,
      delayMs,
    });

    // NOT unref'd, deliberately. While waiting to reconnect there is no open
    // socket, so this timer is the only thing holding the event loop open --
    // unref'ing it makes the process exit instead of retrying, which defeats
    // the entire feature. (The stability timer above IS unref'd: it must never
    // keep a finished process alive.)
    retryTimer = setTimeout(() => {
      retryTimer = null;
      spawnBot();
    }, delayMs);
  }

  function spawnBot(): void {
    if (stopping) return;

    let bot: Bot;
    try {
      bot = mineflayer.createBot({
        host: config.host,
        port: config.port,
        username: config.username,
        version: config.version,
        // Matches the server's online-mode=false (ADR-002). No Microsoft
        // account, and none of the auth code paths npm audit flags.
        auth: 'offline',
        // We surface errors through the logger; mineflayer's own console
        // printing would duplicate them in a different shape.
        logErrors: false,
      });
    } catch (err) {
      log.error('createBot', err);
      scheduleReconnect(err instanceof Error ? err.message : String(err));
      return;
    }

    current = bot;

    // Guards against `error` and `end` both firing for one disconnect and
    // queueing two reconnects.
    let settled = false;
    const settle = (reason: string): void => {
      if (settled) return;
      settled = true;
      // Dropped before proving stable: the attempt counter must keep climbing.
      clearStabilityTimer();
      bot.removeAllListeners();
      if (current === bot) current = null;
      if (!stopping) scheduleReconnect(reason);
    };

    let lastHealth: number | null = null;

    bot.once('spawn', () => {
      // Reset the backoff only once the connection has PROVEN stable. Resetting
      // on spawn looks equivalent but is not: a connection that succeeds and
      // immediately dies (two bots sharing a username trade
      // `duplicate_login` kicks) would reset the counter every cycle and
      // reconnect forever at ~1/s, never exhausting maxAttempts. That is the
      // runaway loop the project brief's safety section exists to prevent.
      stabilityTimer = setTimeout(() => {
        attempt = 0;
      }, STABLE_CONNECTION_MS);
      stabilityTimer.unref();

      lastHealth = bot.health;

      log.event('bot_connected', {
        username: bot.username,
        version: bot.version,
        serverBrand: bot.game.serverBrand,
        dimension: bot.game.dimension,
        position: {
          x: Math.round(bot.entity.position.x),
          y: Math.round(bot.entity.position.y),
          z: Math.round(bot.entity.position.z),
        },
      });

      handlers.onSpawn?.(bot);
    });

    bot.on('chat', (username, message) => {
      if (username === bot.username) return; // Never react to our own messages.
      log.event('chat_received', { from: username, message });
      handlers.onChat?.(bot, username, message);
    });

    bot.on('health', () => {
      if (lastHealth !== null && bot.health < lastHealth) {
        log.event('damage_taken', {
          health: bot.health,
          lost: Math.round((lastHealth - bot.health) * 10) / 10,
          food: bot.food,
        });
      }
      lastHealth = bot.health;
    });

    bot.on('death', () => {
      log.event('death', {
        position: {
          x: Math.round(bot.entity.position.x),
          y: Math.round(bot.entity.position.y),
          z: Math.round(bot.entity.position.z),
        },
      });
    });

    bot.on('kicked', (reason) => {
      settle(`kicked: ${typeof reason === 'string' ? reason : JSON.stringify(reason)}`);
    });

    bot.on('error', (err) => {
      log.error('bot', err);
      settle(err instanceof Error ? err.message : String(err));
    });

    bot.on('end', (reason) => {
      if (stopping) return; // Expected: our own quit() produced this.
      log.event('bot_disconnected', { reason, intentional: false });
      settle(reason);
    });
  }

  spawnBot();

  return { stop, isStopping: () => stopping };
}
