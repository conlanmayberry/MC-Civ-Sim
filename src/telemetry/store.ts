/**
 * The SQLite event store.
 *
 * Uses `node:sqlite`, which Node 26 ships built in and unflagged -- so
 * telemetry adds no dependency at all, and in particular no native module to
 * compile. That matters more than it sounds for a project meant to be
 * reproducible on a fresh machine years from now (ADR-009).
 *
 * Writes are batched. Every action already emits an event, and fsyncing each
 * one would make the bot's own actions slower than the Minecraft server. Events
 * accumulate in memory and flush on a timer, on a size threshold, and always on
 * close.
 */

import { DatabaseSync } from 'node:sqlite';
import type { StatementSync } from 'node:sqlite';
import fs from 'node:fs';
import path from 'node:path';

import { SCHEMA, SCHEMA_VERSION } from './schema.ts';

export interface EventRow {
  runId: string;
  agentId: string;
  timestamp: string;
  minecraftTick: number | null;
  eventType: string;
  action: string | null;
  ok: boolean | null;
  errorCode: string | null;
  durationMs: number | null;
  x: number | null;
  y: number | null;
  z: number | null;
  dimension: string | null;
  data: Record<string, unknown>;
}

export interface SnapshotRow {
  runId: string;
  agentId: string;
  timestamp: string;
  minecraftTick: number | null;
  x: number | null;
  y: number | null;
  z: number | null;
  dimension: string | null;
  health: number | null;
  food: number | null;
  experience: number | null;
  inventory: unknown;
  nearbyEntities: unknown;
  reason: string;
}

export interface StoreOptions {
  /** Flush when this many events are buffered. */
  batchSize?: number;
  /** Flush at least this often, even when quiet. */
  flushIntervalMs?: number;
}

const DEFAULT_BATCH_SIZE = 50;
const DEFAULT_FLUSH_INTERVAL_MS = 2_000;

/**
 * Coerce anything non-numeric to NULL before binding.
 *
 * node:sqlite refuses to bind `undefined` ("cannot be bound to SQLite
 * parameter N"), and the bot legitimately has undefined fields at the edges of
 * its lifecycle -- `bot.health` is not set at the instant of spawn, before the
 * first health packet arrives. Every numeric column here is nullable, so
 * recording a partial row is strictly better than losing the whole snapshot.
 */
function num(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

/** Same, for text columns. */
function text(value: unknown): string | null {
  return typeof value === 'string' ? value : null;
}

export interface Store {
  writeEvent: (row: EventRow) => void;
  writeSnapshot: (row: SnapshotRow) => void;
  upsertAgent: (agentId: string, username: string, uuid: string | null, at: string) => void;
  startRun: (runId: string, minecraftVersion: string, worldName: string, note: string) => void;
  endRun: (runId: string, at: string) => void;
  flush: () => void;
  close: () => void;
  /** Escape hatch for the query CLI; do not use for writes. */
  raw: () => DatabaseSync;
  pendingCount: () => number;
}

export function openStore(dbPath: string, options: StoreOptions = {}): Store {
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });

  const db = new DatabaseSync(dbPath);

  // WAL lets the query CLI read while the bot is writing -- without it,
  // inspecting telemetry during a run blocks the run.
  db.exec('PRAGMA journal_mode = WAL');
  // NORMAL trades a fsync per commit for one per checkpoint. A crash can lose
  // the last few events; it cannot corrupt the database. For research
  // telemetry that is the right side of the trade.
  db.exec('PRAGMA synchronous = NORMAL');
  db.exec('PRAGMA foreign_keys = ON');

  db.exec('BEGIN');
  try {
    for (const statement of SCHEMA) db.exec(statement);
    db.exec('COMMIT');
  } catch (err) {
    db.exec('ROLLBACK');
    db.close();
    throw err;
  }

  const storedVersion = db
    .prepare(`SELECT value FROM meta WHERE key = 'schema_version'`)
    .get() as { value?: string } | undefined;

  if (storedVersion?.value === undefined) {
    db.prepare(`INSERT INTO meta (key, value) VALUES ('schema_version', ?)`).run(
      String(SCHEMA_VERSION),
    );
  } else if (Number(storedVersion.value) !== SCHEMA_VERSION) {
    // Close before throwing, or the handle leaks for the life of the process --
    // which on Windows also leaves the file locked. Loud rather than silently
    // mixing schema shapes: that produces quietly wrong analysis.
    db.close();
    throw new Error(
      `telemetry database at ${dbPath} has schema version ${storedVersion.value}, ` +
        `but this build expects ${SCHEMA_VERSION}. Move it aside or migrate it.`,
    );
  }

  const insertEvent: StatementSync = db.prepare(
    `INSERT INTO events (
       run_id, agent_id, timestamp, minecraft_tick, event_type,
       action, ok, error_code, duration_ms, x, y, z, dimension, data
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );

  const insertSnapshot: StatementSync = db.prepare(
    `INSERT INTO snapshots (
       run_id, agent_id, timestamp, minecraft_tick, x, y, z, dimension,
       health, food, experience, inventory, nearby_entities, reason
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );

  const pending: EventRow[] = [];
  let closed = false;

  function flush(): void {
    if (pending.length === 0) return;

    const batch = pending.splice(0, pending.length);
    db.exec('BEGIN');
    try {
      for (const row of batch) {
        insertEvent.run(
          row.runId,
          row.agentId,
          row.timestamp,
          num(row.minecraftTick),
          row.eventType,
          text(row.action),
          row.ok === null || row.ok === undefined ? null : row.ok ? 1 : 0,
          text(row.errorCode),
          num(row.durationMs),
          num(row.x),
          num(row.y),
          num(row.z),
          text(row.dimension),
          JSON.stringify(row.data ?? {}),
        );
      }
      db.exec('COMMIT');
    } catch (err) {
      db.exec('ROLLBACK');
      // Telemetry must never take the simulation down with it. Report and drop
      // the batch rather than throwing into the bot's event handlers.
      process.stderr.write(
        `[telemetry] dropped ${batch.length} events: ${err instanceof Error ? err.message : String(err)}\n`,
      );
    }
  }

  const timer = setInterval(flush, options.flushIntervalMs ?? DEFAULT_FLUSH_INTERVAL_MS);
  timer.unref();

  const batchSize = options.batchSize ?? DEFAULT_BATCH_SIZE;

  return {
    writeEvent(row) {
      if (closed) return;
      pending.push(row);
      if (pending.length >= batchSize) flush();
    },

    writeSnapshot(row) {
      if (closed) return;
      // Snapshots are rare and individually valuable; write them straight
      // through rather than risking them in a dropped batch.
      try {
        insertSnapshot.run(
          row.runId,
          row.agentId,
          row.timestamp,
          num(row.minecraftTick),
          num(row.x),
          num(row.y),
          num(row.z),
          text(row.dimension),
          num(row.health),
          num(row.food),
          num(row.experience),
          JSON.stringify(row.inventory ?? []),
          JSON.stringify(row.nearbyEntities ?? null),
          row.reason,
        );
      } catch (err) {
        process.stderr.write(
          `[telemetry] snapshot failed: ${err instanceof Error ? err.message : String(err)}\n`,
        );
      }
    },

    upsertAgent(agentId, username, uuid, at) {
      db.prepare(
        `INSERT INTO agents (agent_id, username, uuid, first_seen, last_seen)
         VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(agent_id) DO UPDATE SET
           last_seen = excluded.last_seen,
           uuid = COALESCE(excluded.uuid, agents.uuid)`,
      ).run(agentId, username, uuid, at, at);
    },

    startRun(runId, minecraftVersion, worldName, note) {
      db.prepare(
        `INSERT OR IGNORE INTO runs (run_id, started_at, minecraft_version, world_name, note)
         VALUES (?, ?, ?, ?, ?)`,
      ).run(runId, new Date().toISOString(), minecraftVersion, worldName, note);
    },

    endRun(runId, at) {
      db.prepare(`UPDATE runs SET ended_at = ? WHERE run_id = ?`).run(at, runId);
    },

    flush,

    close() {
      if (closed) return;
      closed = true;
      clearInterval(timer);
      flush();
      db.close();
    },

    raw: () => db,
    pendingCount: () => pending.length,
  };
}
