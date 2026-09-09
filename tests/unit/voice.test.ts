import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { CHAT_ALLOWANCE, CHAT_WINDOW_MS, createVoice } from '../../src/agent/voice.ts';

/**
 * Four agents produced 550 messages in an hour and spent most of the run's
 * thinking answering each other. This is the price that was missing: chat was
 * free and instant while every physical act cost seconds.
 */

describe('chat allowance', () => {
  const t0 = 1_000_000;

  test('the allowance is spendable, then spent', () => {
    const voice = createVoice();
    for (let i = 0; i < CHAT_ALLOWANCE; i++) {
      assert.equal(voice.trySpeak(t0), true, `message ${i + 1} should be allowed`);
    }
    assert.equal(voice.trySpeak(t0), false, 'one past the allowance is refused');
    assert.equal(voice.remaining(t0), 0);
  });

  test('it refills as the window rolls, rather than all at once', () => {
    const voice = createVoice(3, CHAT_WINDOW_MS);
    voice.trySpeak(t0);
    voice.trySpeak(t0 + 10_000);
    voice.trySpeak(t0 + 20_000);
    assert.equal(voice.trySpeak(t0 + 30_000), false);

    // The first message ages out of the window, and only that one comes back.
    assert.equal(voice.remaining(t0 + CHAT_WINDOW_MS + 1), 1);
    assert.equal(voice.trySpeak(t0 + CHAT_WINDOW_MS + 1), true);
    assert.equal(voice.trySpeak(t0 + CHAT_WINDOW_MS + 2), false);
  });

  test('it says how long the silence lasts', () => {
    const voice = createVoice(1, CHAT_WINDOW_MS);
    voice.trySpeak(t0);
    assert.equal(voice.waitMs(t0), CHAT_WINDOW_MS);
    assert.equal(voice.waitMs(t0 + CHAT_WINDOW_MS), 0);
  });
});

describe('telling the agent what it has left', () => {
  const t0 = 2_000_000;

  test('a full allowance is not mentioned at all', () => {
    // A budget named every turn becomes something to spend rather than
    // something to notice.
    assert.deepEqual(createVoice().describe(t0), []);
  });

  test('a partly spent allowance is stated plainly', () => {
    const voice = createVoice();
    voice.trySpeak(t0);
    assert.match(voice.describe(t0)[0] ?? '', new RegExp(`${CHAT_ALLOWANCE - 1} messages? left`));
  });

  test('being out of messages says so, and says to act instead', () => {
    const voice = createVoice();
    for (let i = 0; i < CHAT_ALLOWANCE; i++) voice.trySpeak(t0);

    const line = voice.describe(t0)[0] ?? '';
    assert.match(line, /cannot speak/);
    assert.match(line, /Do something instead/);
  });
});
