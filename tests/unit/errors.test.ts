import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { backoffMs, classifyProviderError } from '../../src/ai/errors.ts';

/**
 * These came out of a real run that logged 42 identical "no credits" errors
 * while retrying every five seconds. The classification is the thing that stops
 * a permanent condition becoming an infinite loop, so it is worth pinning the
 * exact strings that were actually observed.
 */

describe('provider error classification', () => {
  test('no credits is permanent, despite arriving as a 429', () => {
    // The exact message from the run that motivated this.
    const result = classifyProviderError(
      new Error('429 You have no credits remaining. Add credits to continue.'),
    );
    assert.equal(result.kind, 'permanent');
    assert.match(result.reason, /credits/);
  });

  test('insufficient_quota is permanent', () => {
    assert.equal(classifyProviderError(new Error('insufficient_quota')).kind, 'permanent');
  });

  test('a rejected key is permanent', () => {
    const result = classifyProviderError(
      new Error('401 Incorrect API key provided: sk-test-****real'),
    );
    assert.equal(result.kind, 'permanent');
    assert.match(result.reason, /key/);
  });

  test('an unknown model is permanent', () => {
    assert.equal(
      classifyProviderError(new Error('404 The model `gpt-9-imaginary` does not exist')).kind,
      'permanent',
    );
  });

  test('a genuine rate limit is transient', () => {
    // Same 429 status as "no credits" -- which is exactly why status alone
    // cannot decide this, and why the permanent patterns are checked first.
    assert.equal(
      classifyProviderError(new Error('429 Rate limit reached for gpt-5.6-luna')).kind,
      'transient',
    );
  });

  test('network failures are transient', () => {
    assert.equal(classifyProviderError(new Error('read ECONNRESET')).kind, 'transient');
    assert.equal(classifyProviderError(new Error('socket hang up')).kind, 'transient');
    assert.equal(classifyProviderError(new Error('502 Bad Gateway')).kind, 'transient');
  });

  test('unrecognised errors are transient, so a one-off does not end a run', () => {
    // The consecutive-failure limit in the agent loop is what stops this
    // becoming infinite.
    assert.equal(classifyProviderError(new Error('something nobody predicted')).kind, 'transient');
  });

  test('a structured error code is used, not just the message', () => {
    const err = Object.assign(new Error('request failed'), { code: 'insufficient_quota' });
    assert.equal(classifyProviderError(err).kind, 'permanent');
  });
});

describe('backoff', () => {
  test('grows exponentially and then stops growing', () => {
    assert.equal(backoffMs(1), 2_000);
    assert.equal(backoffMs(2), 4_000);
    assert.equal(backoffMs(3), 8_000);
    assert.equal(backoffMs(99), 60_000, 'must have a ceiling, or a long outage waits for hours');
  });
});
