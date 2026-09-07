import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import type { Place, PlaceStore } from '../../src/agent/places.ts';
import {
  MAX_PLACES,
  createPlaces,
  describePlaces,
  direction,
  normaliseName,
} from '../../src/agent/places.ts';

const somewhere = (name: string, x: number, z: number, y = 71): Omit<Place, 'updatedAt'> => ({
  name,
  x,
  y,
  z,
  dimension: 'overworld',
  note: '',
});

describe('remembering places', () => {
  test('a place is recorded and can be recalled by name', () => {
    const places = createPlaces('alice');
    places.remember(somewhere('shelter', 1419, -170));

    const found = places.get('shelter');
    assert.equal(found?.x, 1419);
    assert.equal(found?.z, -170);
  });

  test('names are matched the way an agent would type them', () => {
    const places = createPlaces('alice');
    places.remember(somewhere('The  Shelter', 1419, -170));

    assert.equal(places.get('the shelter')?.x, 1419);
    assert.equal(normaliseName('  IRON   Cave '), 'iron cave');
  });

  test('re-recording a name moves it rather than duplicating it', () => {
    const places = createPlaces('alice');
    places.remember(somewhere('shelter', 1419, -170));
    places.remember(somewhere('shelter', 1620, -40));

    assert.equal(places.all().length, 1);
    assert.equal(places.get('shelter')?.x, 1620);
  });

  test('the list is bounded, dropping the least recently recorded', () => {
    // Every place is in every prompt from then on, so an agent that names
    // forty holes in the ground would spend its context on them.
    const places = createPlaces('alice');
    places.remember(somewhere('first', 0, 0));
    for (let i = 0; i < MAX_PLACES; i++) places.remember(somewhere(`spot ${i}`, i, i));

    assert.equal(places.all().length, MAX_PLACES);
    assert.equal(places.get('first'), null);
  });

  test('re-recording an old place keeps it from being dropped', () => {
    const places = createPlaces('alice');
    places.remember(somewhere('shelter', 1419, -170));
    for (let i = 0; i < MAX_PLACES - 1; i++) places.remember(somewhere(`spot ${i}`, i, i));

    // Visiting it again is exactly the evidence that it still matters.
    places.remember(somewhere('shelter', 1419, -170));
    places.remember(somewhere('one more', 5, 5));

    assert.ok(places.get('shelter') !== null, 'a place just revisited must not be evicted');
  });

  test('a genuinely new place reports as changed', () => {
    const places = createPlaces('alice');
    const { changed } = places.remember(somewhere('shelter', 1419, -170));
    assert.equal(changed, true);
  });

  test('a moved place reports as changed', () => {
    const places = createPlaces('alice');
    places.remember(somewhere('shelter', 1419, -170));
    const { changed } = places.remember(somewhere('shelter', 1620, -40));
    assert.equal(changed, true);
  });

  test('recording the identical place again reports as unchanged', () => {
    // The turn spent doing this accomplished nothing new -- a caller deciding
    // whether a cycle was worth its interval needs to be able to tell.
    const places = createPlaces('alice');
    places.remember({ ...somewhere('shelter', 1419, -170), note: 'blue bed' });
    const { changed, place } = places.remember({
      ...somewhere('shelter', 1419, -170),
      note: 'blue bed',
    });

    assert.equal(changed, false);
    assert.equal(place.x, 1419);
  });

  test('a different note on the same spot still counts as changed', () => {
    const places = createPlaces('alice');
    places.remember({ ...somewhere('shelter', 1419, -170), note: 'blue bed' });
    const { changed } = places.remember({
      ...somewhere('shelter', 1419, -170),
      note: 'doorway now on the east side',
    });
    assert.equal(changed, true);
  });
});

describe('persistence', () => {
  test('places survive a restart', () => {
    const saved: Place[] = [];
    const store: PlaceStore = {
      load: () => [...saved],
      upsert: (_agentId, place) => {
        saved.push(place);
      },
    };

    createPlaces('alice', store).remember(somewhere('shelter', 1419, -170));

    // A new process, the same agent.
    assert.equal(createPlaces('alice', store).get('shelter')?.x, 1419);
  });

  test('one agent does not read another agent’s places', () => {
    // Sharing this table would mean an agent knowing where a shelter is
    // without anyone having told it, which is exactly what Stage 9 studies.
    const rows: Record<string, Place[]> = {};
    const store: PlaceStore = {
      load: (agentId) => rows[agentId] ?? [],
      upsert: (agentId, place) => {
        (rows[agentId] ??= []).push(place);
      },
    };

    createPlaces('alice', store).remember(somewhere('shelter', 1419, -170));
    assert.equal(createPlaces('bob', store).all().length, 0);
  });
});

describe('describing places to the agent', () => {
  const here = { x: 1419, y: 71, z: -170 };

  test('nothing recorded says nothing at all', () => {
    assert.deepEqual(describePlaces([], here, 'overworld'), []);
  });

  test('distance and direction are what make it actionable', () => {
    const places = createPlaces('alice');
    places.remember({ ...somewhere('shelter', 1419, -170), note: 'blue bed' });

    // Standing 200 blocks north of it: +z is south in Minecraft, so a place
    // at a greater z than yours is south of you.
    const lines = describePlaces(places.all(), { x: 1419, y: 71, z: -370 }, 'overworld');
    assert.match(lines[1] ?? '', /shelter -- 1419,71,-170/);
    assert.match(lines[1] ?? '', /200m south/);
    assert.match(lines[1] ?? '', /\(blue bed\)/);
  });

  test('standing on it reads as being there, not as 1m away', () => {
    const places = createPlaces('alice');
    places.remember(somewhere('shelter', 1419, -170));

    assert.match(describePlaces(places.all(), here, 'overworld')[1] ?? '', /you are here/);
  });

  test('nearest first, because that is the one that is relevant', () => {
    const places = createPlaces('alice');
    places.remember(somewhere('far', 1419, -600));
    places.remember(somewhere('near', 1419, -180));

    const lines = describePlaces(places.all(), here, 'overworld');
    assert.match(lines[1] ?? '', /near/);
    assert.match(lines[2] ?? '', /far/);
  });

  test('a place in another dimension is given no distance', () => {
    // The number would be meaningless, and an agent walking it in a straight
    // line would be walking to nowhere.
    const places = createPlaces('alice');
    places.remember({ ...somewhere('fortress', 200, 40), dimension: 'the_nether' });

    const line = describePlaces(places.all(), here, 'overworld')[1] ?? '';
    assert.match(line, /in the the_nether/);
    assert.doesNotMatch(line, /\dm /);
  });
});

describe('compass', () => {
  test('bearings follow Minecraft axes, where +z is south', () => {
    // Getting this backwards would send an agent the wrong way with total
    // confidence, which is worse than saying nothing.
    assert.equal(direction(0, -10), 'north');
    assert.equal(direction(0, 10), 'south');
    assert.equal(direction(10, 0), 'east');
    assert.equal(direction(-10, 0), 'west');
    assert.equal(direction(10, 10), 'southeast');
    assert.equal(direction(-10, -10), 'northwest');
    assert.equal(direction(0, 0), 'here');
  });
});
