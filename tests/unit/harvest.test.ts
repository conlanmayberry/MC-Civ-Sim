import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { canHarvest } from '../../src/bot/harvest.ts';

/**
 * Harvestability decides whether mining yields anything, which is the
 * difference between an agent learning "I need a pickaxe" and an agent quietly
 * destroying stone for nothing. Pure function, so it is testable without a
 * server -- the reason it was split out of the mining action at all.
 */
describe('canHarvest', () => {
  test('blocks with no tool requirement can always be harvested', () => {
    assert.equal(canHarvest({ name: 'dirt' }, null).ok, true);
    assert.equal(canHarvest({ name: 'oak_log', harvestTools: {} }, null).ok, true);
  });

  test('a block needing a tool cannot be harvested by hand', () => {
    const result = canHarvest({ name: 'stone', harvestTools: { '795': true } }, null);
    assert.equal(result.ok, false);
    assert.match(result.reason ?? '', /needs a tool/);
  });

  test('the right tool harvests', () => {
    const result = canHarvest(
      { name: 'stone', harvestTools: { '795': true } },
      { name: 'wooden_pickaxe', type: 795 },
    );
    assert.equal(result.ok, true);
  });

  test('the wrong tool does not, and says which one was held', () => {
    const result = canHarvest(
      { name: 'stone', harvestTools: { '795': true } },
      { name: 'wooden_axe', type: 800 },
    );
    assert.equal(result.ok, false);
    assert.match(result.reason ?? '', /wooden_axe/);
  });

  test('harvestTools keys are compared as strings, not numbers', () => {
    // minecraft-data serialises these as an object, so the keys arrive as
    // strings while item.type is a number. Getting this wrong makes every
    // harvestable block report no_tool.
    const result = canHarvest(
      { name: 'iron_ore', harvestTools: { '822': true } },
      { name: 'stone_pickaxe', type: 822 },
    );
    assert.equal(result.ok, true);
  });
});
