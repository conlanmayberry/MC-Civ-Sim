import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { createWaker } from '../../src/agent/waker.ts';
import { orderCalls } from '../../src/agent/agent.ts';

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
