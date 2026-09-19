import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';

import { normaliseMessage, renderFindings, runDoctor } from '../../src/telemetry/doctor.ts';
import type { Finding } from '../../src/telemetry/doctor.ts';
import { SCHEMA } from '../../src/telemetry/schema.ts';

/**
 * Every check here is a failure that actually happened in this project. The
 * tests rebuild each one in miniature, and -- as importantly -- the nearby
 * situation that must NOT trip it, since a check that cries wolf gets ignored.
 */

const RUN = 'run-1';
const T0 = Date.parse('2026-09-09T15:00:00Z');

function freshDb(): DatabaseSync {
  const db = new DatabaseSync(':memory:');
  for (const statement of SCHEMA) db.exec(statement);
  return db;
}

function event(
  db: DatabaseSync,
  agent: string,
  atMs: number,
  type: string,
  fields: {
    action?: string;
    ok?: 0 | 1;
    error?: string;
    data?: Record<string, unknown>;
    at?: { x: number; z: number };
  } = {},
): void {
  db.prepare(
    `INSERT INTO events (run_id, agent_id, timestamp, event_type, action, ok, error_code, x, y, z, data)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    RUN,
    agent,
    new Date(atMs).toISOString(),
    type,
    fields.action ?? null,
    fields.ok ?? null,
    fields.error ?? null,
    fields.at?.x ?? null,
    fields.at === undefined ? null : 64,
    fields.at?.z ?? null,
    JSON.stringify(fields.data ?? {}),
  );
}

function snapshot(db: DatabaseSync, agent: string, atMs: number, x: number, z: number, food = 20): void {
  db.prepare(
    `INSERT INTO snapshots (run_id, agent_id, timestamp, x, y, z, food, inventory)
     VALUES (?, ?, ?, ?, 64, ?, ?, '[]')`,
  ).run(RUN, agent, new Date(atMs).toISOString(), x, z, food);
}

const doctor = (db: DatabaseSync): Finding[] => runDoctor(db, { runIds: [RUN] });
const only = (findings: Finding[], check: string): Finding[] => findings.filter((f) => f.check === check);

describe('message normalisation', () => {
  test('numbers are ignored, so one recurring failure is counted as one', () => {
    assert.equal(
      normaliseMessage('timeout after 1 attempt(s): no arrival within 44000ms (16.12m short)'),
      normaliseMessage('timeout after 1 attempt(s): no arrival within 44000ms (9.93m short)'),
    );
  });
});

describe('repeated failures', () => {
  test('the same failure over and over is flagged, and escalates', () => {
    const db = freshDb();
    for (let i = 0; i < 35; i++) {
      event(db, 'carla', T0 + i * 1000, 'block_placed', {
        action: 'place_block',
        ok: 0,
        error: 'blocked',
        data: { message: 'stone already occupies that position' },
      });
    }
    const [finding] = only(doctor(db), 'repeated_failure');
    assert.equal(finding?.agent, 'carla');
    assert.equal(finding?.severity, 'error');
    assert.match(finding?.message ?? '', /35 times/);
  });

  test('a few scattered failures are not a pattern', () => {
    const db = freshDb();
    for (let i = 0; i < 5; i++) {
      event(db, 'carla', T0 + i, 'block_placed', { action: 'place_block', ok: 0, data: { message: 'blocked' } });
    }
    assert.deepEqual(only(doctor(db), 'repeated_failure'), []);
  });
});

describe('low success', () => {
  test('an action that mostly fails is flagged once it has enough attempts', () => {
    const db = freshDb();
    for (let i = 0; i < 30; i++) {
      event(db, 'dmitri', T0 + i, 'movement', { action: 'follow_player', ok: i < 10 ? 1 : 0 });
    }
    const [finding] = only(doctor(db), 'low_success');
    assert.match(finding?.message ?? '', /10\/30/);
  });

  test('three failures out of three attempts is not enough to judge', () => {
    const db = freshDb();
    for (let i = 0; i < 3; i++) event(db, 'dmitri', T0 + i, 'movement', { action: 'follow_player', ok: 0 });
    assert.deepEqual(only(doctor(db), 'low_success'), []);
  });
});

describe('regression against the previous session', () => {
  test('an action that got much worse since last time is flagged', () => {
    const db = freshDb();
    for (let i = 0; i < 30; i++) {
      db.prepare(
        `INSERT INTO events (run_id, agent_id, timestamp, event_type, action, ok, data)
         VALUES ('before', 'bob', ?, 'movement', 'move_to', ?, '{}')`,
      ).run(new Date(T0 - 1e6 + i).toISOString(), i < 27 ? 1 : 0);
      event(db, 'bob', T0 + i, 'movement', { action: 'move_to', ok: i < 15 ? 1 : 0 });
    }
    const findings = runDoctor(db, { runIds: [RUN], previousRunIds: ['before'] });
    assert.match(only(findings, 'success_regression')[0]?.message ?? '', /90% to 50%/);
  });
});

describe('handovers', () => {
  function withAgents(db: DatabaseSync): void {
    for (const [id, name] of [['alice', 'Alice'], ['bob', 'Bob']] as const) {
      db.prepare(`INSERT INTO agents (agent_id, username, first_seen, last_seen) VALUES (?, ?, '', '')`).run(id, name);
    }
  }

  test('items dropped for an agent and never collected are flagged', () => {
    const db = freshDb();
    withAgents(db);
    for (let i = 0; i < 4; i++) {
      event(db, 'alice', T0 + i * 60_000, 'item_given', { action: 'give_item', ok: 1, data: { to: 'Bob', item: 'bread' } });
    }
    assert.match(only(doctor(db), 'uncollected_gives')[0]?.message ?? '', /4 of 4/);
  });

  test('items that were picked up promptly are fine', () => {
    const db = freshDb();
    withAgents(db);
    for (let i = 0; i < 4; i++) {
      event(db, 'alice', T0 + i * 60_000, 'item_given', { action: 'give_item', ok: 1, data: { to: 'Bob' } });
      event(db, 'bob', T0 + i * 60_000 + 10_000, 'item_collected', {
        action: 'collect_items',
        ok: 1,
        data: { itemsGained: 3 },
      });
    }
    assert.deepEqual(only(doctor(db), 'uncollected_gives'), []);
  });

  test('gives to a person are not held against the agents', () => {
    const db = freshDb();
    withAgents(db);
    for (let i = 0; i < 5; i++) {
      event(db, 'alice', T0 + i, 'item_given', { action: 'give_item', ok: 1, data: { to: 'Cheeksmack56' } });
    }
    assert.deepEqual(only(doctor(db), 'uncollected_gives'), []);
  });
});

describe('hunger', () => {
  test('dying with an empty food bar is starvation', () => {
    const db = freshDb();
    snapshot(db, 'dmitri', T0, 0, 0, 0);
    event(db, 'dmitri', T0 + 2_000, 'death');
    const [finding] = only(doctor(db), 'starvation');
    assert.equal(finding?.severity, 'error');
  });

  test('dying with a full food bar is not', () => {
    const db = freshDb();
    snapshot(db, 'dmitri', T0, 0, 0, 20);
    event(db, 'dmitri', T0 + 2_000, 'death');
    assert.deepEqual(only(doctor(db), 'starvation'), []);
  });
});

describe('standing still', () => {
  test('minutes in one spot are flagged', () => {
    const db = freshDb();
    for (let i = 0; i < 8; i++) snapshot(db, 'carla', T0 + i * 60_000, 100 + (i % 2), 200);
    assert.equal(only(doctor(db), 'stuck').length, 1);
  });

  test('standing still under a "stay put" order is obedience, not a fault', () => {
    const db = freshDb();
    event(db, 'carla', T0 - 1_000, 'thought_injected', { data: { kind: 'standing_order_given', text: 'stay put' } });
    for (let i = 0; i < 8; i++) snapshot(db, 'carla', T0 + i * 60_000, 100, 200);
    assert.deepEqual(only(doctor(db), 'stuck'), []);
  });

  test('walking around is fine', () => {
    const db = freshDb();
    for (let i = 0; i < 8; i++) snapshot(db, 'carla', T0 + i * 60_000, 100 + i * 20, 200);
    assert.deepEqual(only(doctor(db), 'stuck'), []);
  });
});

describe('code consistency', () => {
  function manifest(db: DatabaseSync, agent: string, commit: string, dirty: 0 | 1): void {
    db.prepare(
      `INSERT INTO run_manifests (run_id, agent_id, created_at, git_commit, git_dirty, identity, settings,
         system_prompt, system_prompt_hash, tools_hash)
       VALUES (?, ?, '', ?, ?, '{}', '{}', '', '', '')`,
    ).run(RUN, agent, commit, dirty);
  }

  test('agents on different commits confound any comparison between them', () => {
    const db = freshDb();
    manifest(db, 'alice', 'aaaaaaa111', 0);
    manifest(db, 'bob', 'bbbbbbb222', 0);
    assert.match(only(doctor(db), 'mixed_code')[0]?.message ?? '', /2 different commits/);
  });

  test('uncommitted changes are noted', () => {
    const db = freshDb();
    manifest(db, 'alice', 'aaaaaaa111', 1);
    assert.equal(only(doctor(db), 'uncommitted_code').length, 1);
  });

  test('a database from before manifests says so rather than failing the check', () => {
    const db = new DatabaseSync(':memory:');
    // Only the tables that existed before manifests were added.
    for (const statement of SCHEMA.filter((s) => !/run_manifests|decision_inputs|scenario_results/.test(s))) {
      db.exec(statement);
    }
    const findings = doctor(db);
    assert.equal(only(findings, 'no_manifest').length, 1);
    assert.ok(!findings.some((f) => /could not run/.test(f.message)));
  });
});

describe('wedge hotspots', () => {
  test('movement failing again and again in one spot is flagged, with where', () => {
    const db = freshDb();
    for (let i = 0; i < 8; i++) {
      event(db, 'dmitri', T0 + i * 60_000, 'movement', {
        action: 'move_to', ok: 0, error: 'unreachable', at: { x: 1395 + (i % 2), z: -140 },
      });
    }
    const found = only(doctor(db), 'wedge_hotspot');
    assert.equal(found.length, 1);
    assert.match(found[0]?.message ?? '', /8 times around \(139[56], -140\)/);
  });

  test('the same number of failures spread across the map is not a hotspot', () => {
    const db = freshDb();
    for (let i = 0; i < 8; i++) {
      event(db, 'dmitri', T0 + i * 60_000, 'movement', {
        action: 'move_to', ok: 0, error: 'unreachable', at: { x: i * 50, z: 0 },
      });
    }
    assert.equal(only(doctor(db), 'wedge_hotspot').length, 0);
  });
});

describe('deaths to mobs', () => {
  test('being killed without having tried to fight is flagged', () => {
    const db = freshDb();
    event(db, 'bob', T0, 'death', { data: { cause: 'was shot by Skeleton' } });
    assert.equal(only(doctor(db), 'unanswered_attack').length, 1);
  });

  test('fighting and losing is not', () => {
    const db = freshDb();
    event(db, 'bob', T0 - 10_000, 'damage_taken', { action: 'attack_entity', ok: 0 });
    event(db, 'bob', T0, 'death', { data: { cause: 'was slain by Zombie' } });
    assert.equal(only(doctor(db), 'unanswered_attack').length, 0);
  });

  test('drowning is not a fight that was dodged', () => {
    const db = freshDb();
    event(db, 'bob', T0, 'death', { data: { cause: 'drowned' } });
    assert.equal(only(doctor(db), 'unanswered_attack').length, 0);
  });
});

describe('the surfacing reflex', () => {
  test('failing to reach air is an error', () => {
    const db = freshDb();
    event(db, 'bob', T0, 'reflex', { data: { reflex: 'surface', outcome: 'gave up after 25s' } });
    const found = only(doctor(db), 'reflex');
    assert.equal(found[0]?.severity, 'error');
  });
});

describe('the report', () => {
  test('a clean session says it is healthy', () => {
    assert.match(renderFindings([], false)[0] ?? '', /healthy/);
  });

  test('errors come before warnings', () => {
    const db = freshDb();
    for (let i = 0; i < 12; i++) {
      event(db, 'bob', T0 + i, 'block_placed', { action: 'place_block', ok: 0, data: { message: 'x' } });
    }
    snapshot(db, 'dmitri', T0, 0, 0, 0);
    event(db, 'dmitri', T0 + 1_000, 'death');
    const findings = doctor(db).filter((f) => f.severity !== 'info');
    assert.equal(findings[0]?.severity, 'error');
  });
});
