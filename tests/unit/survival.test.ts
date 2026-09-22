import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { armorPoints, armorSlotFor, describeArmor } from '../../src/bot/actions/armor.ts';
import { cropAge, isRipe } from '../../src/bot/actions/farming.ts';
import { canSleepNow, explainSleepRefusal } from '../../src/bot/actions/rest.ts';

describe('armour', () => {
  test('each piece belongs in one slot', () => {
    assert.equal(armorSlotFor('iron_chestplate'), 'torso');
    assert.equal(armorSlotFor('leather_boots'), 'feet');
    assert.equal(armorSlotFor('turtle_helmet'), 'head');
    assert.equal(armorSlotFor('iron_sword'), null);
  });

  test('points follow vanilla', () => {
    assert.equal(armorPoints('iron_chestplate'), 6);
    assert.equal(armorPoints('leather_helmet'), 1);
    assert.equal(armorPoints('diamond_leggings'), 6);
    assert.equal(armorPoints('bread'), 0);
  });

  test('what is worn is described, including nothing', () => {
    assert.equal(describeArmor({ head: null, torso: null, legs: null, feet: null, points: 0 }), 'no armour');
    assert.equal(
      describeArmor({ head: null, torso: 'iron_chestplate', legs: null, feet: 'leather_boots', points: 7 }),
      'iron_chestplate, leather_boots (armour 7/20)',
    );
  });
});

describe('crops', () => {
  const block = (age: unknown) => ({ getProperties: () => ({ age }) });

  test('growth stage is read whether the property is a number or a string', () => {
    assert.equal(cropAge(block(5)), 5);
    assert.equal(cropAge(block('7')), 7);
    assert.equal(cropAge({ getProperties: () => ({}) }), null);
  });

  test('only a full-grown crop is ripe -- digging a green one destroys it for a seed', () => {
    assert.equal(isRipe('wheat', 7), true);
    assert.equal(isRipe('wheat', 6), false);
    assert.equal(isRipe('beetroots', 3), true);
    assert.equal(isRipe('wheat', null), false);
  });

  test('berries can be picked from stage 2', () => {
    assert.equal(isRipe('sweet_berry_bush', 1), false);
    assert.equal(isRipe('sweet_berry_bush', 2), true);
  });

  test('anything that does not grow is always "ripe"', () => {
    assert.equal(isRipe('oak_log', null), true);
  });
});

describe('beds', () => {
  test('sleep is possible at night or in a thunderstorm', () => {
    assert.equal(canSleepNow(6_000, false), false, 'midday');
    assert.equal(canSleepNow(18_000, false), true, 'midnight');
    assert.equal(canSleepNow(6_000, true), true, 'thunderstorm');
    assert.equal(canSleepNow(23_500, false), false, 'dawn');
  });

  test('refusals say what to do about them', () => {
    assert.match(explainSleepRefusal('You may not rest now; there are monsters nearby'), /monsters are too close/);
    assert.match(explainSleepRefusal('This bed is occupied'), /already in that bed/);
  });
});

describe('hunting', async () => {
  const { WATER_CREATURES, inDeepWater } = await import('../../src/bot/actions/combat.ts');

  test('fish are not hunting targets', () => {
    assert.ok(WATER_CREATURES.has('cod'));
    assert.ok(WATER_CREATURES.has('salmon'));
    assert.ok(!WATER_CREATURES.has('cow'));
  });

  test('deep water is two blocks of it; a puddle is not', () => {
    const botWith = (depth: number) => ({
      blockAt: (p: { y: number }) => ({ name: p.y > 63 - depth ? 'water' : 'stone' }),
    }) as never;
    const entity = { position: { floored: () => ({ y: 63, offset: (_x: number, dy: number) => ({ y: 63 + dy }) }) } } as never;
    assert.equal(inDeepWater(botWith(1), entity), false);
    assert.equal(inDeepWater(botWith(3), entity), true);
  });
});
