import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { Vec3 } from 'vec3';
import type { Bot } from 'mineflayer';

import { isThinkingTimeout, moveBudgetMs, recentWedges, rememberWedge } from '../../src/bot/actions/movement.ts';

describe('move budgets', () => {
  test('short moves keep the flat default', () => {
    assert.equal(moveBudgetMs(10), 45_000);
  });

  test('long moves get time to walk the distance', () => {
    // 150m trips "timed out" while making steady progress under a flat 45s.
    assert.ok(moveBudgetMs(150) > 60_000);
  });

  test('are capped, so one move cannot hold the agent for minutes', () => {
    assert.equal(moveBudgetMs(5_000), 120_000);
  });
});

describe('pathfinder think timeouts', () => {
  test('are recognised despite pathfinder spelling it "to long"', () => {
    assert.equal(isThinkingTimeout('Took to long to decide path to goal!'), true);
    assert.equal(isThinkingTimeout('Took too long to decide path to goal!'), true);
    assert.equal(isThinkingTimeout('No path to the goal!'), false);
  });
});

describe('wedge memory', () => {
  test('remembers where this bot got stuck, per bot', () => {
    const a = { entity: { position: new Vec3(10.4, 64, -3.2) } } as unknown as Bot;
    const b = { entity: { position: new Vec3(0, 64, 0) } } as unknown as Bot;
    rememberWedge(a);
    assert.deepEqual(recentWedges(a).map(({ x, y, z }) => [x, y, z]), [[10, 64, -4]]);
    assert.equal(recentWedges(b).length, 0);
  });
});

describe('describing time for the model', async () => {
  const { minutesToNightfall, describeAge } = await import('../../src/ai/prompt.ts');

  test('nightfall is announced only in the last few minutes of the day', () => {
    assert.equal(minutesToNightfall(6_000), null, 'midday');
    assert.equal(minutesToNightfall(11_800), 1);
    assert.equal(minutesToNightfall(10_000), 3);
    assert.equal(minutesToNightfall(14_000), null, 'already night');
  });

  test('ages read naturally', () => {
    assert.equal(describeAge(12_000), '12s ago');
    assert.equal(describeAge(185_000), '3 min ago');
  });
});
