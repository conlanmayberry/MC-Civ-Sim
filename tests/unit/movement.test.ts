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

describe('getting unstuck without falling', async () => {
  const { safeHopYaw } = await import('../../src/bot/actions/movement.ts');

  /** Ground at y=63 only where `solid(x, z)` says so; air everywhere else, down to bedrock-free void. */
  function world(solid: (x: number, z: number) => boolean, liquid: (x: number, z: number) => string | null = () => null) {
    return {
      entity: { position: new Vec3(0.5, 64, 0.5) },
      blockAt: (p: Vec3) => {
        const fluid = liquid(p.x, p.z);
        if (p.y === 64 && fluid !== null) return { name: fluid, boundingBox: 'empty' };
        if (p.y === 63 && solid(p.x, p.z)) return { name: 'stone', boundingBox: 'block' };
        return { name: 'air', boundingBox: 'empty' };
      },
    } as unknown as Parameters<typeof safeHopYaw>[0];
  }

  test('never hops toward a cliff', () => {
    // Solid only to the west (x <= 0); a sheer drop everywhere east.
    const bot = world((x) => x <= 0);
    for (let i = 0; i < 50; i++) {
      const yaw = safeHopYaw(bot);
      assert.ok(yaw !== null);
      // mineflayer yaw: facing +x is -PI/2. Anything with an eastward component is unsafe.
      assert.ok(-Math.sin(yaw) <= 0.001, `hopped east (yaw ${yaw})`);
    }
  });

  test('hops in place when every direction is a drop', () => {
    assert.equal(safeHopYaw(world(() => false)), null);
  });

  test('does not hop into water', () => {
    const bot = world(() => true, (x) => (x !== 0 ? 'water' : null));
    const yaw = safeHopYaw(bot);
    // Only straight north or south stays dry.
    assert.ok(yaw !== null && Math.abs(Math.sin(yaw)) < 0.001);
  });
});

describe('knowing you are trapped', async () => {
  const { describeTrap } = await import('../../src/ai/prompt.ts');

  test('a few wedges around one spot say so, with ways out that fit what is carried', () => {
    const bot = { entity: { position: new Vec3(1410, 52, -158) } } as unknown as Bot;
    assert.equal(describeTrap(bot, []), null, 'no wedges yet');
    for (let i = 0; i < 3; i++) rememberWedge(bot);
    const line = describeTrap(bot, ['spruce_planks', 'stick']) ?? '';
    assert.match(line, /You are stuck/);
    assert.match(line, /spruce_planks/);
    assert.match(line, /a pickaxe would let you dig/);
  });
});
