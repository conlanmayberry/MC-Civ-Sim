import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import type { Bot } from 'mineflayer';

import { observeEntities } from '../../src/bot/observations.ts';

/**
 * Handing something over is a two-sided act, and the receiving side was blind.
 *
 * Measured over one four-agent session: 12 of 37 successful gives were never
 * picked up, and the pattern in the failures was a giver dropping one item at
 * a time, over and over, onto a pile the recipient never touched. The
 * recipient was not ignoring it -- a dropped stack reached them as the bare
 * word "Item", with no way to tell the bread they were starving for from a
 * stray sapling.
 */

interface FakeEntity {
  id: number;
  name: string;
  type: string;
  username?: string;
  displayName?: string;
  position: { x: number; y: number; z: number; distanceTo: (o: never) => number };
  isValid: boolean;
  getDroppedItem?: () => { name: string; count: number } | null;
}

function at(x: number, z: number): FakeEntity['position'] {
  const self = { x, y: 64, z };
  return {
    ...self,
    distanceTo: (o: never) => {
      const other = o as unknown as { x: number; z: number };
      return Math.hypot(self.x - other.x, self.z - other.z);
    },
  };
}

function botWith(entities: FakeEntity[]): Bot {
  return {
    entity: { id: 1, position: at(0, 0) },
    entities: Object.fromEntries(entities.map((e) => [e.id, e])),
  } as unknown as Bot;
}

const drop = (id: number, name: string, count: number, x: number): FakeEntity => ({
  id,
  name: 'item',
  type: 'object',
  position: at(x, 0),
  isValid: true,
  getDroppedItem: () => ({ name, count }),
});

describe('dropped items in an observation', () => {
  test('a dropped stack is named and counted, not called "Item"', () => {
    const view = observeEntities(botWith([drop(2, 'cooked_beef', 3, 2)]), 24, 8);
    const item = view.entities[0];

    assert.deepEqual(item?.drop, { name: 'cooked_beef', count: 3 });
    assert.match(item?.name ?? '', /3x cooked_beef/);
    assert.match(item?.name ?? '', /on the ground/);
  });

  test('anything that is not a drop has no drop details', () => {
    const player: FakeEntity = {
      id: 3,
      name: 'player',
      type: 'player',
      username: 'Bob',
      position: at(3, 0),
      isValid: true,
    };

    const view = observeEntities(botWith([player]), 24, 8);
    assert.equal(view.entities[0]?.drop, null);
    assert.equal(view.entities[0]?.name, 'Bob');
  });

  test('a drop still spawning is reported, just without a name', () => {
    // Metadata can be absent for a moment. An unnamed drop is worth less than
    // a named one and still worth more than pretending it is not there.
    const half: FakeEntity = {
      id: 4,
      name: 'item',
      type: 'object',
      displayName: 'Item',
      position: at(1, 0),
      isValid: true,
      getDroppedItem: () => null,
    };

    const view = observeEntities(botWith([half]), 24, 8);
    assert.equal(view.entities.length, 1);
    assert.equal(view.entities[0]?.drop, null);
  });

  test('a drop whose metadata throws does not take the observation down', () => {
    const broken: FakeEntity = {
      id: 5,
      name: 'item',
      type: 'object',
      position: at(1, 0),
      isValid: true,
      getDroppedItem: () => {
        throw new Error('metadata not ready');
      },
    };

    assert.doesNotThrow(() => observeEntities(botWith([broken]), 24, 8));
  });
});

describe('what survives the entity limit', () => {
  test('sheep cannot crowd out the food somebody just dropped for you', () => {
    // The failure this prevents: the drop is the single most actionable thing
    // in the list, and it is also the furthest thing from urgent-looking.
    const sheep: FakeEntity[] = Array.from({ length: 8 }, (_, i) => ({
      id: 100 + i,
      name: 'sheep',
      type: 'mob',
      position: at(i + 1, 0),
      isValid: true,
    }));
    const bread = drop(200, 'bread', 2, 12);

    const view = observeEntities(botWith([...sheep, bread]), 24, 8);

    assert.ok(
      view.entities.some((e) => e.drop?.name === 'bread'),
      'the bread must survive the cut even though eight sheep are closer',
    );
  });

  test('another player survives the cut too', () => {
    const sheep: FakeEntity[] = Array.from({ length: 8 }, (_, i) => ({
      id: 300 + i,
      name: 'sheep',
      type: 'mob',
      position: at(i + 1, 0),
      isValid: true,
    }));
    const bob: FakeEntity = {
      id: 400,
      name: 'player',
      type: 'player',
      username: 'Bob',
      position: at(15, 0),
      isValid: true,
    };

    const view = observeEntities(botWith([...sheep, bob]), 24, 8);
    assert.ok(view.entities.some((e) => e.username === 'Bob'));
  });

  test('the list is still nearest-first once it has been chosen', () => {
    const view = observeEntities(
      botWith([drop(1, 'bread', 1, 10), drop(2, 'coal', 1, 2)]),
      24,
      8,
    );
    assert.equal(view.entities[0]?.drop?.name, 'coal');
  });
});
