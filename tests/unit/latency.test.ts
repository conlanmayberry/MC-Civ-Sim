import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import type { ChatEventRow } from '../../src/telemetry/latency.ts';
import { distribution, pairReplies, percentile, triggerKind } from '../../src/telemetry/latency.ts';

/**
 * The pairing rules decide what the headline number means, so a wrong one does
 * not look wrong -- it just quietly reports a good response time.
 */

const T0 = Date.parse('2026-09-07T16:42:00.000Z');
const at = (offsetMs: number): string => new Date(T0 + offsetMs).toISOString();

const said = (offsetMs: number, from: string, message: string): ChatEventRow => ({
  timestamp: at(offsetMs),
  event_type: 'chat_received',
  data: JSON.stringify({ from, message }),
});

const replied = (offsetMs: number, message = 'sure'): ChatEventRow => ({
  timestamp: at(offsetMs),
  event_type: 'chat_sent',
  data: JSON.stringify({ message }),
});

describe('reply pairing', () => {
  test('times a reply from when it was asked', () => {
    const { replies } = pairReplies([said(0, 'Bob', 'Alice, hello'), replied(5_000)], 'Alice');

    assert.equal(replies.length, 1);
    assert.equal(replies[0]?.waitedMs, 5_000);
    assert.equal(replies[0]?.directed, true);
  });

  test('a burst is timed from the first message, not the last', () => {
    // What the speaker experienced started when they first spoke. Timing from
    // the last message would report 1s for a wait they felt as 30.
    const { replies } = pairReplies(
      [
        said(0, 'Bob', 'Alice, where is the shelter'),
        said(20_000, 'Bob', 'where is the shelter'),
        said(29_000, 'Bob', 'Alice, I do not know where the shelter is'),
        replied(30_000),
      ],
      'Alice',
    );

    assert.equal(replies.length, 1);
    assert.equal(replies[0]?.waitedMs, 30_000);
    assert.equal(replies[0]?.burst, 3);
  });

  test('a message anywhere in the burst counts as being addressed', () => {
    const { replies } = pairReplies(
      [said(0, 'Bob', 'hello'), said(1_000, 'Bob', 'Alice?'), replied(2_000)],
      'Alice',
    );
    assert.equal(replies[0]?.directed, true);
  });

  test('speaking unprompted is not a response time', () => {
    const { replies, unanswered } = pairReplies([replied(0, 'I found iron')], 'Alice');
    assert.deepEqual(replies, []);
    assert.deepEqual(unanswered, []);
  });

  test('operator commands are not conversation', () => {
    // `agent tell ...` is handled by the command path and never replied to.
    // Left pending it would also poison the next real reply, which would be
    // measured from the command instead of from the question.
    const { replies, unanswered } = pairReplies(
      [
        said(0, 'Bob', 'agent tell go find wood'),
        said(600_000, 'Bob', 'Alice, got any wood?'),
        replied(605_000),
      ],
      'Alice',
    );

    assert.deepEqual(unanswered, []);
    assert.equal(replies.length, 1);
    assert.equal(replies[0]?.waitedMs, 5_000, 'the command must not start the clock');
  });

  test("the agent's own chat echoed back is ignored", () => {
    const { replies, unanswered } = pairReplies(
      [said(0, 'Alice', 'I am off to mine'), said(1_000, 'Bob', 'ok'), replied(3_000)],
      'Alice',
    );
    assert.equal(replies[0]?.waitedMs, 2_000);
    assert.deepEqual(unanswered, []);
  });

  test('a name inside another word is not being addressed', () => {
    const { replies } = pairReplies([said(0, 'Bob', 'what malice'), replied(1_000)], 'Alice');
    assert.equal(replies[0]?.directed, false);
  });

  test('questions that got no answer are reported, not silently dropped', () => {
    const { replies, unanswered } = pairReplies(
      [said(0, 'Bob', 'Alice, hello'), replied(1_000), said(2_000, 'Bob', 'Alice, still there?')],
      'Alice',
    );
    assert.equal(replies.length, 1);
    assert.equal(unanswered.length, 1);
    assert.equal(unanswered[0]?.directed, true);
  });

  test('malformed rows do not take the report down with them', () => {
    const broken: ChatEventRow = {
      timestamp: at(0),
      event_type: 'chat_received',
      data: 'not json',
    };
    const { replies } = pairReplies([broken, said(0, 'Bob', 'hi'), replied(1_000)], 'Alice');
    assert.equal(replies.length, 1);
  });
});

describe('statistics', () => {
  test('nearest-rank picks a real sample, never an average of two', () => {
    assert.equal(percentile([1, 2, 3, 4], 50), 2);
    assert.equal(percentile([1, 2, 3, 4], 100), 4);
    assert.equal(percentile([5], 90), 5);
  });

  test('an empty set reports nothing rather than zero', () => {
    // "p50 0.0s" would read as instant replies when there were no replies.
    const row = distribution('addressed by name', []);
    assert.equal(row['n'], 0);
    assert.equal(row['p50'], '');
  });

  test('triggers collapse per player, not per person', () => {
    assert.equal(triggerKind('Bob addressed you'), 'addressed by name');
    assert.equal(triggerKind('Ann addressed you'), 'addressed by name');
    assert.equal(triggerKind('chat from Bob'), 'nearby chat');
    assert.equal(triggerKind('interval'), 'interval');
    assert.equal(triggerKind('hungry'), 'hungry');
  });
});
