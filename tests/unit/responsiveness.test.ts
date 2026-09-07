import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { createWaker } from '../../src/agent/waker.ts';
import { isEffective, orderCalls } from '../../src/agent/agent.ts';
import type { ActionResult } from '../../src/bot/actions/index.ts';

/**
 * How long an agent takes to answer is a behavioural property, not a detail.
 * Both bugs covered here were invisible in play -- the agent looked like it was
 * thinking hard -- and only showed up as timestamps in telemetry.
 */

describe('waker', () => {
  test('a nudge raised mid-cycle is remembered, not dropped', async () => {
    const waker = createWaker();

    // Nobody is sleeping: this is the case that used to vanish, because there
    // was no timer to cancel.
    waker.nudge('Cheeksmack56 addressed you');

    const started = Date.now();
    await waker.wait(30_000);
    assert.ok(
      Date.now() - started < 100,
      'an outstanding wake request must not sleep the full interval',
    );
    assert.equal(waker.takeTrigger(), 'Cheeksmack56 addressed you');
  });

  test('a nudge during the sleep cancels it', async () => {
    const waker = createWaker();
    setTimeout(() => waker.nudge('hurt'), 10);

    const started = Date.now();
    await waker.wait(30_000);
    assert.ok(Date.now() - started < 1_000);
    assert.equal(waker.takeTrigger(), 'hurt');
  });

  test('with nothing pending it actually waits', async () => {
    const waker = createWaker();
    const started = Date.now();
    await waker.wait(60);
    assert.ok(Date.now() - started >= 50, 'the interval must still be honoured');
    assert.equal(waker.takeTrigger(), 'interval');
  });

  test('only urgent nudges interrupt work in progress', () => {
    const waker = createWaker();

    waker.nudge('chat from Bob');
    assert.equal(waker.interruption(), null, 'passing chat must not abandon a plan');

    waker.nudge('Bob addressed you', true);
    assert.equal(waker.interruption(), 'Bob addressed you');
  });

  test('taking the trigger clears the interruption', () => {
    // Otherwise the next cycle is cut short by news it has already seen, and
    // an agent spoken to once never completes a batch again.
    const waker = createWaker();
    waker.nudge('Bob addressed you', true);
    waker.takeTrigger();
    assert.equal(waker.interruption(), null);
  });
});

describe('turn effectiveness', () => {
  const ok = (detail: Record<string, unknown> = {}): ActionResult => ({
    ok: true,
    action: 'test',
    durationMs: 0,
    detail,
  });
  const failed = (code: string): ActionResult => ({
    ok: false,
    action: 'test',
    durationMs: 0,
    detail: {},
    error: { code: code as never, message: code },
  });

  test('an ordinary success counts as effective', () => {
    assert.equal(isEffective(ok({ gained: 3 })), true);
  });

  test('a result explicitly marked unchanged does not', () => {
    // set_goal restating a goal it already had, remember_place recording a
    // place it already knew -- the turn ran, but nothing about the world
    // model is different afterwards.
    assert.equal(isEffective(ok({ goal: 'build a shelter', unchanged: true })), false);
  });

  test('a failed action still counts as effective', () => {
    // unreachable, no_tool, insufficient_items are real information the
    // agent did not have a moment ago. That is not the same situation as a
    // turn that produced nothing at all, and must not be retried at the fast
    // no-op cadence -- repeating a doomed action every four seconds would
    // burn through the budget for no benefit.
    assert.equal(isEffective(failed('unreachable')), true);
    assert.equal(isEffective(failed('no_tool')), true);
  });
});

describe('batch ordering', () => {
  test('speech runs before the work it talks about', () => {
    const names = orderCalls([
      { name: 'mine_block' },
      { name: 'send_chat' },
      { name: 'place_block' },
    ]).map((c) => c.name);

    assert.deepEqual(names, ['send_chat', 'mine_block', 'place_block']);
  });

  test('everything else keeps the order it was decided in', () => {
    const names = orderCalls([
      { name: 'craft_item' },
      { name: 'equip_item' },
      { name: 'mine_block' },
    ]).map((c) => c.name);

    assert.deepEqual(names, ['craft_item', 'equip_item', 'mine_block']);
  });

  test('several messages keep their order relative to each other', () => {
    const calls = orderCalls([
      { name: 'move_to', id: 1 },
      { name: 'send_chat', id: 2 },
      { name: 'send_chat', id: 3 },
    ]);
    assert.deepEqual(
      calls.map((c) => c.id),
      [2, 3, 1],
    );
  });
});
