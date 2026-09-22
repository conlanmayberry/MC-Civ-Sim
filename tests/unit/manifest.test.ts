import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';

import {
  buildManifest,
  describeGitState,
  parsePorcelain,
  shortHash,
} from '../../src/telemetry/manifest.ts';
import { SCHEMA } from '../../src/telemetry/schema.ts';
import { groupSessions } from '../../src/telemetry/sessions.ts';
import type { RunInfo } from '../../src/telemetry/sessions.ts';

/**
 * A run manifest exists because a model comparison could not be trusted: the
 * two sessions ran different code, and nothing recorded could say so.
 */

describe('reading git status', () => {
  test('the first file keeps its first character', () => {
    // The real bug: trimming the whole output ate the significant leading
    // space of " M file" on the first line, so the first file lost a letter.
    const files = parsePorcelain(' M src/agent/agent.ts\n M src/agent/main.ts\n');
    assert.deepEqual(files, ['src/agent/agent.ts', 'src/agent/main.ts']);
  });

  test('untracked, staged and renamed files are all reported by their current path', () => {
    const files = parsePorcelain('?? src/new.ts\nA  src/added.ts\nR  old.ts -> src/renamed.ts');
    assert.deepEqual(files, ['src/new.ts', 'src/added.ts', 'src/renamed.ts']);
  });

  test('quoted paths lose their quotes', () => {
    assert.deepEqual(parsePorcelain(' M "path with spaces.ts"'), ['path with spaces.ts']);
  });

  test('empty status means a clean tree', () => {
    assert.deepEqual(parsePorcelain(''), []);
  });
});

describe('describing the code a run used', () => {
  test('a clean commit is just the commit', () => {
    assert.equal(
      describeGitState({ commit: 'abcdef1234567', dirty: false, dirtyFiles: [] }),
      'code: abcdef1',
    );
  });

  test('uncommitted changes are called out as not reproducible', () => {
    const line = describeGitState({ commit: 'abcdef1234567', dirty: true, dirtyFiles: ['a.ts', 'b.ts'] });
    assert.match(line, /2 uncommitted/);
    assert.match(line, /not reproducible/);
  });

  test('no git at all is stated, not guessed', () => {
    assert.match(describeGitState({ commit: null, dirty: null, dirtyFiles: [] }), /unknown/);
  });
});

describe('the manifest row', () => {
  const base = {
    runId: 'r1',
    agentId: 'bob',
    git: { commit: 'abc', dirty: false, dirtyFiles: [] },
    minecraftVersion: '1.21.8',
    provider: 'openai',
    model: 'gpt-5.6-luna',
    intervalMs: 15_000,
    budgetUsd: 5,
    identity: { id: 'bob' },
    settings: { historyWindow: 14 },
    systemPrompt: 'You are Bob.',
    tools: [{ name: 'move_to' }],
  };

  test('the prompt is stored whole, because replay needs the exact text', () => {
    assert.equal(buildManifest(base).systemPrompt, 'You are Bob.');
  });

  test('a changed prompt gets a different hash; an unchanged one the same', () => {
    assert.equal(buildManifest(base).systemPromptHash, buildManifest(base).systemPromptHash);
    assert.notEqual(
      buildManifest(base).systemPromptHash,
      buildManifest({ ...base, systemPrompt: 'You are Bob. Build things.' }).systemPromptHash,
    );
    assert.equal(shortHash('x').length, 12);
  });

  test('it round-trips through the real schema', () => {
    const db = new DatabaseSync(':memory:');
    for (const statement of SCHEMA) db.exec(statement);
    const row = buildManifest(base);
    db.prepare(
      `INSERT INTO run_manifests (run_id, agent_id, created_at, git_commit, git_dirty, dirty_files,
         node_version, minecraft_version, provider, model, interval_ms, budget_usd, identity,
         settings, system_prompt, system_prompt_hash, tools_hash)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      row.runId, row.agentId, row.createdAt, row.gitCommit, 0, '[]', row.nodeVersion,
      row.minecraftVersion, row.provider, row.model, row.intervalMs, row.budgetUsd,
      JSON.stringify(row.identity), JSON.stringify(row.settings), row.systemPrompt,
      row.systemPromptHash, row.toolsHash,
    );
    const back = db.prepare('SELECT model, system_prompt FROM run_manifests').get() as Record<string, unknown>;
    assert.equal(back['model'], 'gpt-5.6-luna');
    assert.equal(back['system_prompt'], 'You are Bob.');
  });
});

describe('grouping runs into sessions', () => {
  const run = (agentId: string, startedAt: string, lastAt: string | null = null): RunInfo => ({
    runId: `${agentId}-${startedAt}`,
    agentId,
    startedAt,
    endedAt: null,
    lastAt,
    decisions: 100,
    model: 'gpt-5.6-luna',
  });

  test('agents launched together are one session', () => {
    // start-all-agents.bat staggers launches by three seconds.
    const sessions = groupSessions([
      run('alice', '2026-09-09T15:21:45Z'),
      run('bob', '2026-09-09T15:21:48Z'),
      run('carla', '2026-09-09T15:21:51Z'),
      run('dmitri', '2026-09-09T15:21:54Z'),
    ]);
    assert.equal(sessions.length, 1);
    assert.equal(sessions[0]?.length, 4);
  });

  test('a restart eight minutes earlier is a different session', () => {
    // The first window was ten minutes, which merged exactly this case.
    const sessions = groupSessions([
      run('alice', '2026-09-09T15:13:39Z'),
      run('alice', '2026-09-09T15:21:45Z'),
      run('bob', '2026-09-09T15:21:48Z'),
    ]);
    assert.equal(sessions.length, 2);
    assert.deepEqual(sessions[0]?.map((r) => r.agentId), ['bob', 'alice']);
  });

  test('agents launched in two batches that then ran side by side are one session', () => {
    // 2026-09-22: two pairs 3.5 minutes apart, four hours together. The
    // start-time window alone reported on half of them.
    const sessions = groupSessions([
      run('alice', '2026-09-22T05:03:00Z', '2026-09-22T09:07:00Z'),
      run('dmitri', '2026-09-22T05:03:01Z', '2026-09-22T09:07:00Z'),
      run('carla', '2026-09-22T05:06:36Z', '2026-09-22T09:07:00Z'),
      run('bob', '2026-09-22T05:06:39Z', '2026-09-22T09:07:00Z'),
    ]);
    assert.equal(sessions.length, 1);
    assert.equal(sessions[0]?.length, 4);
  });

  test('a run that had stopped before the next began is its own session', () => {
    const sessions = groupSessions([
      run('alice', '2026-09-09T15:13:39Z', '2026-09-09T15:15:00Z'),
      run('alice', '2026-09-09T15:21:45Z', '2026-09-09T16:00:00Z'),
    ]);
    assert.equal(sessions.length, 2);
  });

  test('newest session first', () => {
    const sessions = groupSessions([run('alice', '2026-09-01T10:00:00Z'), run('alice', '2026-09-09T10:00:00Z')]);
    assert.equal(sessions[0]?.[0]?.startedAt, '2026-09-09T10:00:00Z');
  });
});
