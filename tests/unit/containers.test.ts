import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { describeContents, fuelUnitsFor } from '../../src/bot/actions/containers.ts';

describe('chest contents', () => {
  test('are summed by name, most first', () => {
    assert.equal(
      describeContents([
        { name: 'bread', count: 3 },
        { name: 'cobblestone', count: 64 },
        { name: 'bread', count: 2 },
      ]),
      '64x cobblestone, 5x bread',
    );
  });

  test('say so when empty', () => {
    assert.equal(describeContents([]), 'empty');
  });

  test('are cut off after a dozen kinds, saying how many more', () => {
    const many = Array.from({ length: 15 }, (_, i) => ({ name: `item${i}`, count: 1 }));
    assert.match(describeContents(many), /and 3 more kinds$/);
  });
});

describe('furnace fuel', () => {
  test('one coal smelts eight', () => {
    assert.equal(fuelUnitsFor(8, 8), 1);
    assert.equal(fuelUnitsFor(9, 8), 2);
  });

  test('planks smelt one and a half each', () => {
    assert.equal(fuelUnitsFor(3, 1.5), 2);
  });

  test('never zero', () => {
    assert.equal(fuelUnitsFor(0, 8), 1);
  });
});
