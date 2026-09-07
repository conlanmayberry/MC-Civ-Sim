import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { createBudget } from '../../src/ai/budget.ts';
import { costOf, UnknownModelError, MODEL, PRICES } from '../../src/ai/pricing.ts';

/**
 * The spend cap is a safety control on a program that spends money in a loop,
 * so it gets tested like one: not "does it compute a number" but "does it
 * actually stop, and does it fail closed when it cannot tell".
 */

describe('cost arithmetic', () => {
  test('prices the configured model', () => {
    const price = PRICES[MODEL];
    assert.ok(price !== undefined, `${MODEL} must be priced or the cap cannot be enforced`);
  });

  test('charges input and output at their own rates', () => {
    // Luna: $0.20/M in, $1.20/M out.
    const cost = costOf('gpt-5.6-luna', {
      inputTokens: 1_000_000,
      cachedTokens: 0,
      outputTokens: 1_000_000,
    });
    assert.ok(Math.abs(cost - 1.4) < 1e-9, `expected 1.40, got ${cost}`);
  });

  test('cached input is billed at the cheaper rate, not the full one', () => {
    // input_tokens INCLUDES cached ones, so charging both rates on the full
    // amount would overestimate and trip the cap early.
    const cost = costOf('gpt-5.6-luna', {
      inputTokens: 1_000_000,
      cachedTokens: 1_000_000,
      outputTokens: 0,
    });
    assert.ok(Math.abs(cost - 0.02) < 1e-9, `expected 0.02 (all cached), got ${cost}`);
  });

  test('cached tokens are clamped to the input total', () => {
    const cost = costOf('gpt-5.6-luna', {
      inputTokens: 100,
      cachedTokens: 999_999,
      outputTokens: 0,
    });
    assert.ok(cost > 0 && cost < 0.001, 'nonsense cache counts must not produce a negative charge');
  });

  test('an unpriced model throws rather than costing zero', () => {
    // Failing closed matters more here than anywhere: a silent zero would read
    // as "free" and spend without limit.
    assert.throws(
      () => costOf('some-future-model', { inputTokens: 1000, cachedTokens: 0, outputTokens: 100 }),
      UnknownModelError,
    );
  });
});

describe('budget enforcement', () => {
  const limits = {
    maxUsd: 1,
    maxRequestsPerMinute: 3,
    maxDecisionsPerMinute: 100,
    maxDurationMs: 60_000,
  };

  test('allows calls under the cap', () => {
    const budget = createBudget(limits);
    assert.equal(budget.check().allowed, true);
  });

  test('stops the run once the cap is reached', () => {
    const budget = createBudget(limits);

    // ~$0.60 of output.
    budget.record('gpt-5.6-luna', { inputTokens: 0, cachedTokens: 0, outputTokens: 500_000 });
    assert.equal(budget.check().allowed, true, 'under budget should still run');

    budget.record('gpt-5.6-luna', { inputTokens: 0, cachedTokens: 0, outputTokens: 500_000 });
    const verdict = budget.check();
    assert.equal(verdict.allowed, false);
    assert.equal(verdict.stop, 'budget_exhausted');
  });

  test('stopping is permanent, not a pause', () => {
    const budget = createBudget(limits);
    budget.record('gpt-5.6-luna', { inputTokens: 0, cachedTokens: 0, outputTokens: 1_000_000 });
    budget.check();
    assert.equal(budget.check().stop, 'budget_exhausted');
    assert.equal(budget.stopped(), 'budget_exhausted');
  });

  test('warns on the way up, once per threshold', () => {
    const budget = createBudget(limits);
    budget.record('gpt-5.6-luna', { inputTokens: 0, cachedTokens: 0, outputTokens: 500_000 });

    const first = budget.takeWarning();
    assert.ok(first !== null && first.includes('50%'), `expected a 50% warning, got ${first}`);
    // Taken once: a repeated warning every cycle would be noise.
    assert.equal(budget.takeWarning(), null);
  });

  test('rate limits make the caller wait rather than stopping the run', () => {
    let clock = 1_000_000;
    // A long duration ceiling on purpose: this test advances the clock past a
    // minute to age the rolling window out, and the shared 60s limit would end
    // the run first -- which is correct behaviour, but not what is under test.
    const budget = createBudget({ ...limits, maxDurationMs: 60 * 60 * 1000 }, () => clock);

    for (let i = 0; i < limits.maxRequestsPerMinute; i++) {
      assert.equal(budget.check().allowed, true, `call ${i} should be allowed`);
    }

    const verdict = budget.check();
    assert.equal(verdict.allowed, false);
    assert.equal(verdict.stop, undefined, 'a rate limit is not a reason to end the run');
    assert.ok((verdict.waitMs ?? 0) > 0);

    // The window is rolling: after a minute, calls resume.
    clock += 61_000;
    assert.equal(budget.check().allowed, true);
  });

  test('the duration ceiling stops the run', () => {
    let clock = 0;
    const budget = createBudget(limits, () => clock);
    assert.equal(budget.check().allowed, true);

    clock += limits.maxDurationMs + 1;
    const verdict = budget.check();
    assert.equal(verdict.allowed, false);
    assert.equal(verdict.stop, 'duration_exceeded');
  });

  test('an operator stop takes effect immediately', () => {
    const budget = createBudget(limits);
    budget.stop('operator');
    assert.equal(budget.check().allowed, false);
    assert.equal(budget.stopped(), 'operator');
  });
});

describe('zero-usage calls', () => {
  test('a call that used no tokens needs no price', () => {
    const budget = createBudget();
    // The stub provider reports model "stub", which is deliberately absent
    // from the price table. Zero tokens cost zero, so this must not throw --
    // otherwise the dry run, which exists to test the loop for free, cannot run.
    assert.doesNotThrow(() =>
      budget.record('stub', { inputTokens: 0, cachedTokens: 0, outputTokens: 0 }),
    );
    assert.equal(budget.spentUsd(), 0);
  });

  test('but an unpriced model that DID use tokens still throws', () => {
    const budget = createBudget();
    assert.throws(
      () => budget.record('stub', { inputTokens: 100, cachedTokens: 0, outputTokens: 10 }),
      /No pricing/,
    );
  });
});
