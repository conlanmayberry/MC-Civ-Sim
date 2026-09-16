import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';

import type { AiProvider, DecisionRequest } from '../../src/ai/provider.ts';
import { compareCalls, formatCalls, toolShift } from '../../src/replay/compare.ts';
import type { RecordedDecision } from '../../src/replay/replay.ts';
import { estimateCost, loadRecorded, runReplay, sampleEvenly } from '../../src/replay/replay.ts';
import { SCHEMA } from '../../src/telemetry/schema.ts';

/**
 * Replay is how a prompt or model change gets tested against real situations
 * without a live hour. What counts as "the same decision" is the judgement
 * everything else rests on, so it is pinned here.
 */

describe('comparing decisions', () => {
  const mine = { name: 'mine_block', args: { block: 'stone', count: 3 } };
  const chat = { name: 'send_chat', args: { message: 'hello' } };

  test('the same calls in a different order are identical', () => {
    // The loop reorders calls itself (speech first), so listing order is not
    // part of what was decided.
    assert.equal(compareCalls([mine, chat], [chat, mine]).agreement, 'identical');
  });

  test('same tools with different arguments is its own grade', () => {
    const elsewhere = { name: 'mine_block', args: { block: 'stone', count: 5 } };
    const result = compareCalls([mine], [elsewhere]);
    assert.equal(result.agreement, 'same_tools');
    assert.deepEqual(result.added, []);
  });

  test('a different tool is a different choice, and says which', () => {
    const result = compareCalls([mine], [mine, chat]);
    assert.equal(result.agreement, 'different');
    assert.deepEqual(result.added, ['send_chat']);
    assert.deepEqual(result.dropped, []);
  });

  test('doing nothing where the original acted is a different choice', () => {
    assert.equal(compareCalls([mine], []).agreement, 'different');
    assert.equal(compareCalls([], []).agreement, 'identical');
  });

  test('repeats count: twice is not the same as once', () => {
    assert.equal(compareCalls([mine, mine], [mine]).agreement, 'different');
  });

  test('tool shift summarises behaviour change, biggest change first', () => {
    const shift = toolShift([
      { original: [chat, chat], replayed: [mine] },
      { original: [chat], replayed: [mine] },
    ]);
    assert.equal(shift[0]?.tool, 'send_chat');
    assert.equal(shift[0]?.original, 3);
    assert.equal(shift[0]?.replayed, 0);
  });

  test('calls format the same way setbacks do', () => {
    assert.equal(formatCalls([mine]), 'mine_block(block=stone,count=3)');
    assert.equal(formatCalls([]), '(nothing)');
  });
});

describe('sampling', () => {
  test('evenly across the session, not just the start', () => {
    // The first forty turns are all "gather wood"; a useful sample is not.
    const sample = sampleEvenly(Array.from({ length: 100 }, (_, i) => i), 4);
    assert.deepEqual(sample, [0, 25, 50, 75]);
  });

  test('fewer items than the limit returns them all', () => {
    assert.deepEqual(sampleEvenly([1, 2], 10), [1, 2]);
  });
});

function recorded(cycle: number, calls: Array<{ name: string; args: Record<string, unknown> }> = []): RecordedDecision {
  return {
    runId: 'r1',
    agentId: 'bob',
    cycle,
    timestamp: '2026-09-09T15:00:00Z',
    trigger: 'interval',
    observation: `--- turn ${cycle} ---`,
    history: [],
    injections: [],
    original: { calls, summary: '', model: 'gpt-5.6-luna', costUsd: 0.001, inputTokens: 3000, outputTokens: 200 },
  };
}

/** A provider that echoes a fixed decision and charges a fixed cost. */
function fakeProvider(costUsd: number, seen: DecisionRequest[] = []): AiProvider {
  return {
    id: 'fake',
    model: 'gpt-5.6-luna',
    async decide(request) {
      seen.push(request);
      return {
        toolCalls: [{ callId: 'c', name: 'mine_block', args: { block: 'stone' } }],
        summary: 'fake',
        model: 'gpt-5.6-luna',
        usage: { inputTokens: 0, cachedTokens: 0, outputTokens: 0 },
        costUsd,
      };
    },
  };
}

describe('running a replay', () => {
  test('each decision is made from its recorded inputs and compared', async () => {
    const seen: DecisionRequest[] = [];
    const { results } = await runReplay(
      [recorded(1, [{ name: 'mine_block', args: { block: 'stone' } }]), recorded(2)],
      {
        provider: fakeProvider(0, seen),
        systemFor: () => 'SYSTEM',
        tools: [],
        maxUsd: 1,
        concurrency: 2,
      },
    );

    assert.equal(results.length, 2);
    assert.equal(results[0]?.comparison?.agreement, 'identical');
    assert.equal(results[1]?.comparison?.agreement, 'different');
    assert.ok(seen.every((r) => r.system === 'SYSTEM'));
    assert.deepEqual(seen.map((r) => r.observation).sort(), ['--- turn 1 ---', '--- turn 2 ---']);
  });

  test('the spend cap stops new decisions being sent', async () => {
    const decisions = Array.from({ length: 20 }, (_, i) => recorded(i));
    const { results, spentUsd, stoppedForBudget } = await runReplay(decisions, {
      provider: fakeProvider(0.1),
      systemFor: () => '',
      tools: [],
      maxUsd: 0.25,
      concurrency: 1,
    });

    assert.ok(results.length < 20, 'it must not replay everything past the cap');
    assert.ok(spentUsd < 0.25 + 0.1 + 1e-9, 'at most one decision past the cap');
    assert.equal(stoppedForBudget, true);
  });

  test('a provider error is recorded against that decision, not thrown', async () => {
    const broken: AiProvider = {
      id: 'broken',
      model: 'x',
      async decide() {
        throw new Error('rate limited');
      },
    };
    const { results } = await runReplay([recorded(1)], {
      provider: broken,
      systemFor: () => '',
      tools: [],
      maxUsd: 1,
      concurrency: 1,
    });
    assert.equal(results[0]?.error, 'rate limited');
    assert.equal(results[0]?.comparison, null);
  });

  test('the estimate prices every decision, never at the cached discount', () => {
    const cost = estimateCost([recorded(1), recorded(2)], 'gpt-5.6-luna');
    // 3000 in at $0.20/M + 200 out at $1.20/M, twice.
    assert.ok(Math.abs(cost - 2 * (0.0006 + 0.00024)) < 1e-9);
  });
});

describe('loading recorded decisions', () => {
  function db(): DatabaseSync {
    const d = new DatabaseSync(':memory:');
    for (const statement of SCHEMA) d.exec(statement);
    return d;
  }

  const insertInput = (d: DatabaseSync, cycle: number, observation: string, trigger = 'interval'): void => {
    d.prepare(
      `INSERT INTO decision_inputs (run_id, agent_id, cycle, timestamp, trigger, observation, history, injections)
       VALUES ('r1', 'bob', ?, '2026-09-09T15:00:00Z', ?, ?, '["earlier"]', '[]')`,
    ).run(cycle, trigger, observation);
  };
  const insertDecision = (d: DatabaseSync, cycle: number, tools: string[]): void => {
    d.prepare(
      `INSERT INTO events (run_id, agent_id, timestamp, event_type, data)
       VALUES ('r1', 'bob', '2026-09-09T15:00:01Z', 'decision', ?)`,
    ).run(JSON.stringify({ cycle, tools, args: tools.map(() => ({})), model: 'gpt-5.6-luna', summary: 's' }));
  };
  const run = { runId: 'r1', agentId: 'bob', startedAt: '', endedAt: null, decisions: 2, model: 'gpt-5.6-luna' };

  test('inputs are joined to what was originally decided in them', () => {
    const d = db();
    insertInput(d, 1, 'obs one');
    insertDecision(d, 1, ['move_to', 'send_chat']);

    const [decision] = loadRecorded(d, [run]);
    assert.equal(decision?.observation, 'obs one');
    assert.deepEqual(decision?.history, ['earlier']);
    assert.deepEqual(decision?.original.calls.map((c) => c.name), ['move_to', 'send_chat']);
  });

  test('a situation whose decision never landed is skipped -- nothing to compare against', () => {
    const d = db();
    insertInput(d, 1, 'the process died inside the API call');
    assert.deepEqual(loadRecorded(d, [run]), []);
  });

  test('filters narrow to the situations a change is about', () => {
    const d = db();
    insertInput(d, 1, 'plain turn');
    insertDecision(d, 1, []);
    insertInput(d, 2, '*** STANDING ORDER ***', 'Operator addressed you');
    insertDecision(d, 2, []);

    assert.deepEqual(loadRecorded(d, [run], { filter: /STANDING ORDER/ }).map((r) => r.cycle), [2]);
    assert.deepEqual(loadRecorded(d, [run], { trigger: /addressed you/ }).map((r) => r.cycle), [2]);
    assert.deepEqual(loadRecorded(d, [run], { agent: 'alice' }), []);
  });
});
