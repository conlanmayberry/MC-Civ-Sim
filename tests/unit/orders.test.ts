import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { createOrders, describeOrder } from '../../src/agent/orders.ts';

/**
 * The strongest intervention in the system: it overrides the agent's own
 * judgement and persists until lifted. Both halves of that need pinning --
 * that it lasts, and that it can be ended.
 */

describe('standing orders', () => {
  test('there is no order until one is given', () => {
    assert.equal(createOrders().current(), null);
  });

  test('an order persists -- that is the whole difference from a nudge', () => {
    const orders = createOrders();
    orders.give('come to me and stay put', 'Cheeksmack56');

    // Nothing about time passing or turns elapsing clears it.
    assert.equal(orders.current()?.text, 'come to me and stay put');
    assert.equal(orders.current()?.from, 'Cheeksmack56');
    assert.equal(orders.current()?.text, 'come to me and stay put');
  });

  test('releasing returns what was lifted, and leaves nothing behind', () => {
    const orders = createOrders();
    orders.give('stay put', 'Cheeksmack56');

    assert.equal(orders.release()?.text, 'stay put');
    assert.equal(orders.current(), null);
  });

  test('releasing when free is harmless', () => {
    assert.equal(createOrders().release(), null);
  });

  test('a new order replaces the old one rather than stacking', () => {
    const orders = createOrders();
    orders.give('stay put', 'Cheeksmack56');
    orders.give('follow me instead', 'Cheeksmack56');

    assert.equal(orders.current()?.text, 'follow me instead');
  });

  test('an empty order is not an order', () => {
    const orders = createOrders();
    assert.equal(orders.give('   ', 'Cheeksmack56'), null);
    assert.equal(orders.current(), null);
  });
});

describe('how an order reads to the agent', () => {
  test('no order says nothing at all', () => {
    assert.deepEqual(describeOrder(null), []);
  });

  test('it is unambiguous about outranking the agent’s own plans', () => {
    // Hedging here would defeat the point: an operator who says "stay put"
    // and gets a considered opinion about why moving is better has not been
    // listened to.
    const orders = createOrders();
    const rendered = describeOrder(orders.give('come to me and stay put', 'Cheeksmack56')).join(
      '\n',
    );

    assert.match(rendered, /STANDING ORDER/);
    assert.match(rendered, /come to me and stay put/);
    assert.match(rendered, /Cheeksmack56/);
    assert.match(rendered, /overrides your own goal/);
    assert.match(rendered, /until they tell you otherwise/);
  });

  test('staying alive is exempt, or "stay put" becomes a death sentence', () => {
    const orders = createOrders();
    const rendered = describeOrder(orders.give('stay put', 'Cheeksmack56')).join('\n');

    assert.match(rendered, /eat if you are starving/);
  });
});
