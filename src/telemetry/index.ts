/**
 * Telemetry wiring: one call that gives the bot a recording logger.
 *
 * Also owns periodic snapshots. Events say what changed; snapshots say what was
 * true. Without them, answering "what was the inventory when it died?" means
 * replaying every item event from the beginning and hoping none were missed --
 * fragile, and wrong the first time a batch is dropped.
 */

import path from 'node:path';

import type { Bot } from 'mineflayer';

import { ROOT } from '../config.ts';
import { observeEntities, observeInventory, observeSelf } from '../bot/observations.ts';
import type { Logger, Sink } from '../util/log.ts';
import { consoleSink, createLogger } from '../util/log.ts';
import { createSqliteSink, fanOut, NO_CONTEXT } from './sink.ts';
import type { ContextProvider } from './sink.ts';
import { openStore } from './store.ts';
import type { Store } from './store.ts';

export type { Store } from './store.ts';
export { openStore } from './store.ts';

export const DEFAULT_DB_PATH = path.join(ROOT, 'data', 'database', 'telemetry.sqlite');

/** How often to record a full state snapshot during normal operation. */
const DEFAULT_SNAPSHOT_INTERVAL_MS = 60_000;
/** Long enough for health, food and inventory to be populated after spawn. */
const SPAWN_SNAPSHOT_DELAY_MS = 1_000;

export interface TelemetryOptions {
  dbPath?: string;
  runId?: string;
  minecraftVersion?: string;
  worldName?: string;
  note?: string;
  snapshotIntervalMs?: number;
  /** Keep printing events to the console as well. Default true. */
  console?: boolean;
}

export interface Telemetry {
  logger: Logger;
  store: Store;
  runId: string;
  /**
   * Attach to a bot: supplies event context, records a spawn snapshot, and
   * starts the periodic snapshot timer. Call on every spawn, since reconnecting
   * produces a new Bot.
   */
  attach: (bot: Bot) => void;
  /** Record a snapshot right now, tagged with why. */
  snapshot: (reason: string) => void;
  close: () => void;
}

/**
 * A run id that sorts chronologically and is readable in a filename.
 * `2026-09-06T23-14-07`
 */
function defaultRunId(): string {
  return new Date().toISOString().replace(/\..+$/, '').replace(/:/g, '-');
}

export function createTelemetry(agentId: string, options: TelemetryOptions = {}): Telemetry {
  const dbPath = options.dbPath ?? DEFAULT_DB_PATH;
  const runId = options.runId ?? defaultRunId();

  const store = openStore(dbPath);
  store.startRun(
    runId,
    options.minecraftVersion ?? 'unknown',
    options.worldName ?? 'civ-sim-world',
    options.note ?? '',
  );

  // Rebound by attach(); until then events record without a position rather
  // than not recording at all.
  let getContext: ContextProvider = () => NO_CONTEXT;
  let current: Bot | null = null;
  let snapshotTimer: NodeJS.Timeout | null = null;

  const sqliteSink = createSqliteSink(store, runId, () => getContext());
  const sink: Sink = options.console === false ? sqliteSink : fanOut(consoleSink, sqliteSink);
  const logger = createLogger(agentId, sink);

  function snapshot(reason: string): void {
    const bot = current;
    if (bot === null || bot.entity === undefined) return;

    try {
      const self = observeSelf(bot);
      const inventory = observeInventory(bot);
      const entities = observeEntities(bot, 16, 10);

      store.writeSnapshot({
        runId,
        agentId,
        timestamp: new Date().toISOString(),
        minecraftTick: bot.time?.age ?? null,
        x: self.position.x,
        y: self.position.y,
        z: self.position.z,
        dimension: self.dimension,
        health: self.health,
        food: self.food,
        experience: self.experienceLevel,
        inventory: inventory.items,
        nearbyEntities: entities.entities,
        reason,
      });
    } catch (err) {
      process.stderr.write(
        `[telemetry] snapshot skipped: ${err instanceof Error ? err.message : String(err)}\n`,
      );
    }
  }

  return {
    logger,
    store,
    runId,

    attach(bot) {
      current = bot;

      getContext = () => {
        // Guarded: events fire during connect and disconnect when the entity
        // does not exist, and telemetry must never throw into a bot handler.
        try {
          const position = bot.entity?.position;
          return {
            minecraftTick: bot.time?.age ?? null,
            x: position === undefined ? null : Math.round(position.x * 100) / 100,
            y: position === undefined ? null : Math.round(position.y * 100) / 100,
            z: position === undefined ? null : Math.round(position.z * 100) / 100,
            dimension: bot.game?.dimension ?? null,
          };
        } catch {
          return NO_CONTEXT;
        }
      };

      // bot.player.uuid, not bot.entity.uuid -- the latter is not populated for
      // the bot's own entity. This is the name-derived offline-mode UUID that
      // Stage 1 established as the durable agent identity.
      store.upsertAgent(
        agentId,
        bot.username,
        bot.player?.uuid ?? bot.players[bot.username]?.uuid ?? null,
        new Date().toISOString(),
      );
      // Deliberately delayed. mineflayer fires `spawn` from a `once`
      // handler on the first update_health packet that is registered BEFORE
      // the handler which assigns `bot.health` -- so at the instant of spawn,
      // health and food are still undefined and the snapshot records nulls.
      // A second later the bot is fully populated.
      setTimeout(() => snapshot('spawn'), SPAWN_SNAPSHOT_DELAY_MS).unref();

      // Death is the single most valuable moment to have a full record of, and
      // it is exactly when the inventory is about to be destroyed.
      bot.on('death', () => snapshot('death'));

      if (snapshotTimer !== null) clearInterval(snapshotTimer);
      snapshotTimer = setInterval(
        () => snapshot('periodic'),
        options.snapshotIntervalMs ?? DEFAULT_SNAPSHOT_INTERVAL_MS,
      );
      snapshotTimer.unref();
    },

    snapshot,

    close() {
      if (snapshotTimer !== null) {
        clearInterval(snapshotTimer);
        snapshotTimer = null;
      }
      // No snapshot here: by the time close() runs the bot has disconnected and
      // its entity is gone. The shutdown snapshot is taken from the
      // connection's onStopping hook, while the bot is still live.
      store.endRun(runId, new Date().toISOString());
      store.close();
    },
  };
}
