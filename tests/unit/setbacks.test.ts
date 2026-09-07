import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import {
  MAX_SETBACKS,
  SETBACK_TTL_TURNS,
  attemptKey,
  createSetbacks,
  describeSetbacks,
} from '../../src/agent/setbacks.ts';

/**
 * This is the anti-loop memory. It exists because one placement was attempted
 * and refused 110 times across seven runs, so the cases that matter are about
 * what survives, what expires, and what stops being true.
 */

describe('attempt keys', () => {
  test('the same call produces the same key regardless of argument order', () => {
    assert.equal(
      attemptKey('place_block', { item: 'dirt', x: 1, y: 2, z: 3 }),
      attemptKey('place_block', { z: 3, y: 2, x: 1, item: 'dirt' }),
    );
  });

  test('a different coordinate is a different attempt', () => {
    assert.notEqual(
      attemptKey('place_block', { item: 'dirt', x: 1, y: 2, z: 3 }),
      attemptKey('place_block', { item: 'dirt', x: 1, y: 2, z: 4 }),
    );
  });

  test('nulls are ignored, since null means "use the default"', () => {
    assert.equal(
      attemptKey('mine_block', { block: 'stone', count: null }),
      attemptKey('mine_block', { block: 'stone' }),
    );
  });
});

describe('remembering setbacks', () => {
  const place = { item: 'dirt', x: 1371, y: 65, z: -150 };

  test('a failure is remembered past the six-turn history window', () => {
    const setbacks = createSetbacks();
    setbacks.record('place_block', place, 'a spruce_sapling is in that space', 1);

    // Turn 9: long gone from history, which is exactly when the loop used to
    // restart.
    const all = setbacks.all(9);
    assert.equal(all.length, 1);
    assert.match(all[0]?.why ?? '', /spruce_sapling/);
  });

  test('repeating the same failure counts it rather than duplicating it', () => {
    const setbacks = createSetbacks();
    for (let turn = 1; turn <= 4; turn++) {
      setbacks.record('place_block', place, 'a spruce_sapling is in that space', turn);
    }

    const all = setbacks.all(4);
    assert.equal(all.length, 1, 'one attempt, not four entries');
    assert.equal(all[0]?.count, 4, 'how often it failed is the point');
  });

  test('succeeding clears it -- a setback is a moment, not a law', () => {
    // The sapling can be mined, the ground levelled, the player can come back.
    const setbacks = createSetbacks();
    setbacks.record('place_block', place, 'a spruce_sapling is in that space', 1);
    setbacks.succeeded('place_block', place);

    assert.deepEqual(setbacks.all(2), []);
  });

  test('setbacks expire, so an agent is not argued out of retrying forever', () => {
    const setbacks = createSetbacks();
    setbacks.record('place_block', place, 'blocked', 1);

    assert.equal(setbacks.all(1 + SETBACK_TTL_TURNS).length, 1, 'still fresh at the boundary');
    assert.equal(setbacks.all(2 + SETBACK_TTL_TURNS).length, 0, 'gone once stale');
  });

  test('the list is bounded, so flailing cannot fill the prompt with failures', () => {
    const setbacks = createSetbacks();
    for (let i = 0; i < MAX_SETBACKS + 5; i++) {
      setbacks.record('place_block', { item: 'dirt', x: i, y: 0, z: 0 }, 'blocked', 1);
    }
    assert.equal(setbacks.all(1).length, MAX_SETBACKS);
  });
});

describe('describing setbacks', () => {
  test('nothing failed means nothing is said', () => {
    assert.deepEqual(describeSetbacks([]), []);
  });

  test('the most-repeated failure is listed first, with its count', () => {
    const setbacks = createSetbacks();
    setbacks.record('move_to', { x: 1, y: 2, z: 3 }, 'no route', 1);
    for (let turn = 1; turn <= 5; turn++) {
      setbacks.record('place_block', { item: 'dirt', x: 9, y: 9, z: 9 }, 'sapling there', turn);
    }

    const lines = describeSetbacks(setbacks.all(5));
    assert.match(lines[1] ?? '', /place_block/);
    assert.match(lines[1] ?? '', /5 times now/);
    assert.match(lines.join('\n'), /do something else/);
  });
});
