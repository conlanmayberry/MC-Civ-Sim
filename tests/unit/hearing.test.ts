import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { Vec3 } from 'vec3';

import { createHearing, describeHearing, isDirectedAt } from '../../src/agent/hearing.ts';
import { buildObservation } from '../../src/ai/prompt.ts';

/**
 * These exist because agents were deaf: chat woke them for a decision but the
 * message content never reached the observation, so an agent could be spoken to
 * and have no idea what was said. The tests pin the behaviour that fixes it.
 */

describe('isDirectedAt', () => {
  test('matches the name on a word boundary', () => {
    assert.equal(isDirectedAt('Alice', 'Alice, come here'), true);
    assert.equal(isDirectedAt('Alice', 'hey alice can you help'), true, 'must be case-insensitive');
  });

  test('does not match a name inside another word', () => {
    // "malice" contains "alice" -- a substring check would misfire here, and
    // an agent that thinks every message is for it will reply to everything.
    assert.equal(isDirectedAt('Alice', 'there was no malice in it'), false);
  });

  test('undirected chat is not treated as addressed', () => {
    assert.equal(isDirectedAt('Alice', 'nice weather today'), false);
  });
});

describe('hearing', () => {
  test('records what was said, with who said it', () => {
    const hearing = createHearing('Alice');
    const message = hearing.hear('Bob', 'hello there', 5);

    assert.ok(message !== null);
    assert.equal(message.from, 'Bob');
    assert.equal(message.text, 'hello there');
    assert.equal(message.distance, 5);
    assert.equal(message.directed, false);
  });

  test('an agent does not hear itself', () => {
    // Otherwise it would react to its own send_chat and talk to itself forever.
    const hearing = createHearing('Alice');
    assert.equal(hearing.hear('Alice', 'thinking out loud', 0), null);
  });

  test('empty messages are ignored', () => {
    const hearing = createHearing('Alice');
    assert.equal(hearing.hear('Bob', '   ', 1), null);
  });

  test('takeNew returns each message once', () => {
    const hearing = createHearing('Alice');
    hearing.hear('Bob', 'first', 1);
    hearing.hear('Bob', 'second', 1);

    assert.equal(hearing.takeNew().length, 2);
    // A message repeated every turn would waste tokens and read as the speaker
    // saying it again.
    assert.equal(hearing.takeNew().length, 0);

    hearing.hear('Bob', 'third', 1);
    assert.deepEqual(hearing.takeNew().map((m) => m.text), ['third']);
  });

  test('the buffer is bounded, keeping the most recent', () => {
    const hearing = createHearing('Alice', { keep: 3 });
    for (let i = 0; i < 10; i++) hearing.hear('Bob', `message ${i}`, 1);

    const recent = hearing.recent();
    assert.equal(recent.length, 3);
    assert.equal(recent.at(-1)?.text, 'message 9');
  });

  test('a proximity radius filters out distant speakers', () => {
    // The hook Stage 9 needs: agents must not hear conversations they were not
    // part of, or rumour and misinformation cannot be studied.
    const hearing = createHearing('Alice', { radius: 10 });
    assert.ok(hearing.hear('Bob', 'nearby', 5) !== null);
    assert.equal(hearing.hear('Carol', 'far away', 50), null);
  });

  test('speakers who cannot be located are still heard', () => {
    // Console and terminal messages have no position; dropping them would
    // silently discard operator speech.
    const hearing = createHearing('Alice', { radius: 10 });
    assert.ok(hearing.hear('operator', 'from the terminal', null) !== null);
  });
});

describe('rendering for the prompt', () => {
  test('nothing heard renders nothing', () => {
    assert.deepEqual(describeHearing([]), []);
  });

  test('directed messages are flagged so the agent notices', () => {
    const hearing = createHearing('Alice');
    hearing.hear('Bob', 'Alice can you help', 3);
    const rendered = describeHearing(hearing.recent()).join('\n');

    assert.match(rendered, /<Bob>/);
    assert.match(rendered, /3m away/);
    assert.match(rendered, /names you/);
  });
});

describe('observation integration', () => {
  test('what was heard reaches the prompt', () => {
    // The actual bug: chat woke the agent, but buildObservation never mentioned
    // it, so the model saw a nudge and no message.
    const bot = {
      // Real Vec3s: the observation functions call .offset() and .distanceTo()
      // on these, so plain objects are not a sufficient stand-in.
      entity: {
        position: new Vec3(1, 64, 2),
        velocity: new Vec3(0, 0, 0),
        yaw: 0,
        pitch: 0,
        onGround: true,
        id: 1,
      },
      health: 20,
      food: 20,
      foodSaturation: 5,
      oxygenLevel: 20,
      game: { dimension: 'overworld', gameMode: 'survival' },
      time: { timeOfDay: 1000, isDay: true },
      experience: { level: 0 },
      inventory: { items: () => [] },
      heldItem: null,
      entities: {},
      blockAt: () => null,
    } as unknown as Parameters<typeof buildObservation>[0];

    const heard = createHearing('Alice');
    heard.hear('Cheeksmack56', 'Alice, follow me', 4);

    const observation = buildObservation(bot, 1, { heard: heard.takeNew() });
    assert.match(observation, /Cheeksmack56/);
    assert.match(observation, /follow me/);
  });
});

describe('placeable spots', () => {
  test('never offers the space the bot occupies', async () => {
    const { observePlaceableSpots } = await import('../../src/bot/observations.ts');

    // A player is ~1.8 blocks tall, so it fills (0,0,0) AND (0,1,0). Only the
    // first was excluded, so the head block was offered -- and being at
    // horizontal distance zero it sorted FIRST, meaning the agent was told
    // every single turn that it could build inside its own head. It tried,
    // the server silently refused, and place_block ran at 15%.
    const origin = new Vec3(10, 64, 20);

    const bot = {
      entity: { position: origin },
      // Ground below y=64, air above.
      blockAt: (v: Vec3) =>
        v.y < 64
          ? { name: 'grass_block', boundingBox: 'block', position: v }
          : { name: 'air', boundingBox: 'empty', position: v },
    } as unknown as Parameters<typeof observePlaceableSpots>[0];

    const spots = observePlaceableSpots(bot, 12);

    const feet = `${origin.x},${origin.y},${origin.z}`;
    const head = `${origin.x},${origin.y + 1},${origin.z}`;
    const offered = spots.map((s) => `${s.position.x},${s.position.y},${s.position.z}`);

    assert.ok(!offered.includes(feet), 'must not offer the block the bot stands in');
    assert.ok(!offered.includes(head), 'must not offer the block the bot’s head is in');
    assert.ok(spots.length > 0, 'should still find somewhere valid to build');
  });
});
