import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { parseDeathMessage } from '../../src/bot/death.ts';
import { summariseCauses } from '../../src/telemetry/doctor.ts';

describe('death causes', () => {
  test('are read from the server message about this bot', () => {
    assert.equal(parseDeathMessage('Bob', 'Bob drowned'), 'drowned');
    assert.equal(parseDeathMessage('Bob', 'Bob was shot by Skeleton'), 'was shot by Skeleton');
  });

  test('ignore other players and non-death announcements', () => {
    assert.equal(parseDeathMessage('Bob', 'Bobby drowned'), null);
    assert.equal(parseDeathMessage('Bob', 'Alice drowned'), null);
    assert.equal(parseDeathMessage('Bob', 'Bob joined the game'), null);
    assert.equal(parseDeathMessage('Bob', 'Bob has made the advancement [Stone Age]'), null);
  });

  test('summarise most common first', () => {
    assert.equal(
      summariseCauses('drowned|was shot by Skeleton|drowned'),
      'drowned x2, was shot by Skeleton',
    );
  });
});
