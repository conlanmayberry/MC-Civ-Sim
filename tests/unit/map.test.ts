import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import type { Bot } from 'mineflayer';

import { observeMapTiles } from '../../src/bot/observations.ts';
import { MAP_FULL_DETAIL_RADIUS, MAX_MAP_RADIUS, mapStepFor } from '../../src/agent/control.ts';

/**
 * The map scan runs inside the agent's own process, so its cost is not merely
 * a rendering concern -- an unbounded one stalls the bot mid-action. These
 * tests are about that budget as much as about the picture.
 */

/** A flat world at y=64 with a hill, so height shading has something to shade. */
function stubBot(): { bot: Bot; reads: () => number } {
  let reads = 0;
  const bot = {
    entity: { position: { x: 100.5, y: 65, z: -200.5 } },
    blockAt(pos: { x: number; y: number; z: number }) {
      reads++;
      const hill = Math.abs(pos.x - 110) < 5 && Math.abs(pos.z + 200) < 5 ? 3 : 0;
      const surface = 64 + hill;
      if (pos.y > surface) return { name: 'air' };
      return { name: pos.y === surface ? 'grass_block' : 'stone' };
    },
  } as unknown as Bot;
  return { bot, reads: () => reads };
}

describe('map sampling', () => {
  test('step 1 samples every column', () => {
    const { bot } = stubBot();
    const view = observeMapTiles(bot, 5, 8, 1);

    assert.equal(view.step, 1);
    assert.equal(view.tiles.length, 11 * 11, 'a radius-5 map is 11x11 columns');
  });

  test('a wider view with a bigger step costs no more than a narrow detailed one', () => {
    // This is the whole point: seeing twice as far should not double the work.
    const narrow = stubBot();
    observeMapTiles(narrow.bot, 20, 24, 1);

    const wide = stubBot();
    observeMapTiles(wide.bot, 80, 24, 4);

    // Within a small tolerance rather than strictly less: both scan the same
    // NUMBER of columns, and the few percent of drift is how deep each column
    // happens to go. The regression this guards against is step being ignored,
    // which would make the wide view ~16x the work, not 1.01x.
    assert.ok(
      wide.reads() <= narrow.reads() * 1.1,
      `a 161x161 view at step 4 (${wide.reads()} reads) must cost about the same as ` +
        `a 41x41 view at step 1 (${narrow.reads()} reads)`,
    );
  });

  test('tiles carry the surface height, which is what height shading needs', () => {
    const { bot } = stubBot();
    const view = observeMapTiles(bot, 12, 12, 1);

    const flat = view.tiles.find((t) => t.dx === 0 && t.dz === 0);
    const hill = view.tiles.find((t) => t.dx === 10 && t.dz === 0);

    assert.equal(flat?.name, 'grass_block');
    assert.equal(flat?.y, 64);
    assert.equal(hill?.y, 67, 'the hill has to read as higher, or the map looks flat');
  });

  test('the step is reported, so the client knows how wide a tile is', () => {
    // Without this the client draws one-block tiles with gaps between them.
    const { bot } = stubBot();
    assert.equal(observeMapTiles(bot, 20, 8, 3).step, 3);
  });

  test('a nonsense step is treated as 1 rather than dividing by zero', () => {
    const { bot } = stubBot();
    assert.equal(observeMapTiles(bot, 3, 4, 0).step, 1);
    assert.equal(observeMapTiles(bot, 3, 4, -2).step, 1);
  });
});

describe('the radius budget', () => {
  test('full detail up to the detail radius, coarser past it', () => {
    assert.equal(mapStepFor(20), 1);
    assert.equal(mapStepFor(MAP_FULL_DETAIL_RADIUS), 1);
    assert.ok(mapStepFor(MAP_FULL_DETAIL_RADIUS * 2) >= 2);
  });

  test('column count stays bounded all the way to the maximum radius', () => {
    // The guarantee that makes a generous cap safe.
    const columnsAt = (radius: number): number => {
      const step = mapStepFor(radius);
      return (Math.floor((2 * radius) / step) + 1) ** 2;
    };

    const budget = columnsAt(MAP_FULL_DETAIL_RADIUS);
    for (let radius = 8; radius <= MAX_MAP_RADIUS; radius += 8) {
      assert.ok(
        columnsAt(radius) <= budget,
        `radius ${radius} scans ${columnsAt(radius)} columns, over the ${budget} budget`,
      );
    }
  });
});
