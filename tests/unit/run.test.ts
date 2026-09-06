import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { createActionRunner, ActionFailure, describeResult } from '../../src/bot/actions/run.ts';
import type { EventType, Logger, TelemetryEvent } from '../../src/util/log.ts';

/**
 * The runner is where ADR-007's five rules are enforced, so it is the piece
 * most worth testing without a Minecraft server. Everything below is about the
 * contract, not about Minecraft.
 */

function recordingLogger(): { logger: Logger; events: TelemetryEvent[] } {
  const events: TelemetryEvent[] = [];
  const logger: Logger = {
    event(type: EventType, data = {}) {
      events.push({ timestamp: new Date().toISOString(), agentId: 'test', eventType: type, data });
    },
    error(where, err) {
      events.push({
        timestamp: new Date().toISOString(),
        agentId: 'test',
        eventType: 'error',
        data: { where, message: err instanceof Error ? err.message : String(err) },
      });
    },
  };
  return { logger, events };
}

const spec = { action: 'test_action', eventType: 'observation' as EventType, timeoutMs: 1_000 };

describe('runAction contract', () => {
  test('a successful body yields ok with its detail', async () => {
    const { logger } = recordingLogger();
    const runner = createActionRunner(logger);

    const result = await runner.run(spec, async () => ({ mined: 3 }));

    assert.equal(result.ok, true);
    assert.equal(result.action, 'test_action');
    assert.deepEqual(result.detail, { mined: 3 });
    assert.equal(result.error, undefined);
  });

  test('a thrown ActionFailure becomes a typed error, not an exception', async () => {
    const { logger } = recordingLogger();
    const runner = createActionRunner(logger);

    // The central rule: Stage 5's model must be able to READ a failure.
    const result = await runner.run(spec, async () => {
      throw new ActionFailure('no_tool', 'needs a pickaxe');
    });

    assert.equal(result.ok, false);
    assert.equal(result.error?.code, 'no_tool');
    assert.equal(result.error?.message, 'needs a pickaxe');
  });

  test('an unexpected throw is mapped to failed rather than escaping', async () => {
    const { logger } = recordingLogger();
    const runner = createActionRunner(logger);

    const result = await runner.run(spec, async () => {
      throw new TypeError('something unforeseen');
    });

    assert.equal(result.ok, false);
    assert.equal(result.error?.code, 'failed');
    assert.match(result.error?.message ?? '', /unforeseen/);
  });

  test('a body that outlives its budget returns timeout', async () => {
    const { logger } = recordingLogger();
    const runner = createActionRunner(logger);

    const result = await runner.run(
      { ...spec, timeoutMs: 120 },
      async () => new Promise((resolve) => setTimeout(() => resolve({}), 5_000)),
    );

    assert.equal(result.ok, false);
    assert.equal(result.error?.code, 'timeout');
  });

  test('a second concurrent action is refused as interrupted', async () => {
    const { logger } = recordingLogger();
    const runner = createActionRunner(logger);

    // A bot has one body; overlapping actions corrupt each other.
    const first = runner.run({ ...spec, timeoutMs: 2_000 }, async () => {
      await new Promise((r) => setTimeout(r, 300));
      return { done: true };
    });
    const second = await runner.run(spec, async () => ({ shouldNotRun: true }));

    assert.equal(second.ok, false);
    assert.equal(second.error?.code, 'interrupted');
    assert.equal((await first).ok, true);
  });

  test('the mutex is released after a failure, not just a success', async () => {
    const { logger } = recordingLogger();
    const runner = createActionRunner(logger);

    await runner.run(spec, async () => {
      throw new ActionFailure('blocked', 'nope');
    });

    assert.equal(runner.busy(), false);
    const after = await runner.run(spec, async () => ({ recovered: true }));
    assert.equal(after.ok, true);
  });

  test('every action emits exactly one telemetry event, success or failure', async () => {
    const { logger, events } = recordingLogger();
    const runner = createActionRunner(logger);

    await runner.run(spec, async () => ({ a: 1 }));
    await runner.run(spec, async () => {
      throw new ActionFailure('not_found', 'gone');
    });

    assert.equal(events.length, 2);
    assert.equal(events[0]?.data['ok'], true);
    assert.equal(events[1]?.data['ok'], false);
    assert.equal(events[1]?.data['error'], 'not_found');
  });

  test('detail stays JSON-serialisable', async () => {
    const { logger } = recordingLogger();
    const runner = createActionRunner(logger);

    // ADR-005/007: this goes to a database column and into a prompt.
    const result = await runner.run(spec, async () => ({
      at: { x: 1, y: 2, z: 3 },
      names: ['oak_log'],
    }));

    assert.doesNotThrow(() => JSON.stringify(result));
    assert.equal(JSON.parse(JSON.stringify(result)).detail.at.y, 2);
  });
});

describe('describeResult', () => {
  test('surfaces the error code on failure', () => {
    const text = describeResult({
      ok: false,
      action: 'mine_block',
      durationMs: 120,
      detail: {},
      error: { code: 'unreachable', message: 'wedged' },
    });
    assert.match(text, /mine_block failed \[unreachable\]/);
    assert.match(text, /wedged/);
  });

  test('summarises detail on success', () => {
    const text = describeResult({
      ok: true,
      action: 'craft_item',
      durationMs: 2_400,
      detail: { item: 'stick', gained: 4 },
    });
    assert.match(text, /craft_item ok/);
    assert.match(text, /gained=4/);
  });
});
