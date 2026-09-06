import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { openStore } from '../../src/telemetry/store.ts';
import type { Store } from '../../src/telemetry/store.ts';
import { createSqliteSink, fanOut } from '../../src/telemetry/sink.ts';
import { createLogger } from '../../src/util/log.ts';

/**
 * The store is testable without Minecraft, which is the point of keeping
 * telemetry independent of the bot. These cover the properties the analysis in
 * later stages will silently depend on.
 */

let dir: string;
let store: Store;
let dbPath: string;

before(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'civsim-telemetry-'));
  dbPath = path.join(dir, 'test.sqlite');
  store = openStore(dbPath, { batchSize: 1_000, flushIntervalMs: 60_000 });
  store.startRun('run-1', '1.21.8', 'test-world', 'unit test');
});

after(() => {
  store.close();
  // Windows keeps a lock briefly after close; the temp dir is disposable, so a
  // cleanup failure must not fail an otherwise passing suite.
  try {
    fs.rmSync(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
  } catch {
    /* temp dir; the OS will reap it */
  }
});

function row(overrides: Record<string, unknown> = {}) {
  return {
    runId: 'run-1',
    agentId: 'TestBot',
    timestamp: new Date().toISOString(),
    minecraftTick: 1234,
    eventType: 'block_mined',
    action: 'mine_block',
    ok: true,
    errorCode: null,
    durationMs: 900,
    x: 10,
    y: 64,
    z: -20,
    dimension: 'overworld',
    data: { block: 'oak_log' },
    ...overrides,
  } as Parameters<Store['writeEvent']>[0];
}

describe('telemetry store', () => {
  test('buffers writes and only persists on flush', () => {
    store.writeEvent(row());
    store.writeEvent(row());
    assert.equal(store.pendingCount(), 2);

    const before = store.raw().prepare('SELECT COUNT(*) AS n FROM events').get() as { n: number };
    assert.equal(before.n, 0, 'nothing should be written before flush');

    store.flush();
    const after = store.raw().prepare('SELECT COUNT(*) AS n FROM events').get() as { n: number };
    assert.equal(after.n, 2);
    assert.equal(store.pendingCount(), 0);
  });

  test('records the fields the brief asks questions about', () => {
    store.flush();
    const r = store
      .raw()
      .prepare('SELECT * FROM events ORDER BY id LIMIT 1')
      .get() as Record<string, unknown>;

    // what / when / where / did it work / how long
    assert.equal(r['action'], 'mine_block');
    assert.ok(typeof r['timestamp'] === 'string');
    assert.equal(r['minecraft_tick'], 1234);
    assert.equal(r['x'], 10);
    assert.equal(r['ok'], 1);
    assert.equal(r['duration_ms'], 900);
    assert.equal(JSON.parse(String(r['data'])).block, 'oak_log');
  });

  test('failures keep their error code in a queryable column', () => {
    store.writeEvent(row({ ok: false, errorCode: 'no_tool', action: 'mine_block' }));
    store.flush();

    const failures = store
      .raw()
      .prepare(`SELECT error_code FROM events WHERE ok = 0`)
      .all() as Array<{ error_code: string }>;

    // Stage 4 must be able to count failures BY KIND, which is why the code is
    // a column rather than prose inside data.
    assert.ok(failures.some((f) => f.error_code === 'no_tool'));
  });

  test('snapshots capture inventory as structured JSON', () => {
    store.writeSnapshot({
      runId: 'run-1',
      agentId: 'TestBot',
      timestamp: new Date().toISOString(),
      minecraftTick: 99,
      x: 1,
      y: 2,
      z: 3,
      dimension: 'overworld',
      health: 20,
      food: 18,
      experience: 0,
      inventory: [{ name: 'oak_log', count: 4, slot: 0, displayName: 'Oak Log' }],
      nearbyEntities: [],
      reason: 'death',
    });

    const snap = store
      .raw()
      .prepare(`SELECT inventory, reason FROM snapshots ORDER BY id DESC LIMIT 1`)
      .get() as { inventory: string; reason: string };

    assert.equal(snap.reason, 'death');
    assert.equal(JSON.parse(snap.inventory)[0].name, 'oak_log');
  });

  test('agents upsert rather than duplicate', () => {
    store.upsertAgent('TestBot', 'TestBot', 'uuid-1', '2026-01-01T00:00:00Z');
    store.upsertAgent('TestBot', 'TestBot', null, '2026-01-02T00:00:00Z');

    const rows = store.raw().prepare(`SELECT * FROM agents`).all() as Array<Record<string, unknown>>;
    assert.equal(rows.length, 1);
    assert.equal(rows[0]?.['last_seen'], '2026-01-02T00:00:00Z');
    // A later sighting without a uuid must not erase the one we had.
    assert.equal(rows[0]?.['uuid'], 'uuid-1');
  });

  test('reopening a database with a different schema version is refused', () => {
    const other = path.join(dir, 'versioned.sqlite');
    const s = openStore(other);
    s.raw().prepare(`UPDATE meta SET value = '999' WHERE key = 'schema_version'`).run();
    s.close();

    // Silently mixing schema shapes would produce quietly wrong analysis.
    assert.throws(() => openStore(other), /schema version 999/);
  });
});

describe('sink bridging', () => {
  test('a logger event lands in the database with hoisted columns', () => {
    const s = openStore(path.join(dir, 'sink.sqlite'), { batchSize: 1, flushIntervalMs: 60_000 });
    s.startRun('run-2', '1.21.8', 'w', '');

    const logger = createLogger(
      'SinkBot',
      createSqliteSink(s, 'run-2', () => ({
        minecraftTick: 7,
        x: 1,
        y: 2,
        z: 3,
        dimension: 'overworld',
      })),
    );

    logger.event('block_placed', {
      action: 'place_block',
      ok: false,
      error: 'blocked',
      durationMs: 42,
      item: 'crafting_table',
    });
    s.flush();

    const r = s.raw().prepare('SELECT * FROM events ORDER BY id DESC LIMIT 1').get() as Record<
      string,
      unknown
    >;

    assert.equal(r['event_type'], 'block_placed');
    assert.equal(r['action'], 'place_block');
    assert.equal(r['ok'], 0);
    assert.equal(r['error_code'], 'blocked');
    assert.equal(r['duration_ms'], 42);
    assert.equal(r['minecraft_tick'], 7);
    // Hoisted fields must not be duplicated back into the JSON blob.
    const data = JSON.parse(String(r['data']));
    assert.equal(data.item, 'crafting_table');
    assert.equal(data.action, undefined);
    s.close();
  });

  test('one failing sink does not stop the others', () => {
    const seen: string[] = [];
    const sink = fanOut(
      () => {
        throw new Error('this sink is broken');
      },
      (e) => seen.push(e.eventType),
    );

    // Telemetry must never take the simulation down with it.
    assert.doesNotThrow(() =>
      sink({ timestamp: 'now', agentId: 'a', eventType: 'observation', data: {} }),
    );
    assert.deepEqual(seen, ['observation']);
  });
});
