import assert from 'node:assert/strict';
import test from 'node:test';

import { buyBaseWithQuote, roundDownToStep, sellBaseForQuote } from './order-book.js';

test('walks asks and calculates a quote-budget VWAP', () => {
  const result = buyBaseWithQuote(
    [
      { price: 100, quantity: 2 },
      { price: 110, quantity: 4 },
    ],
    420,
  );

  assert.equal(result.filled, true);
  assert.equal(result.quoteSpent, 420);
  assert.ok(Math.abs(result.baseReceived - 4) < 1e-12);
  assert.equal(result.effectivePrice, 105);
});

test('marks an ask book with insufficient depth as unfilled', () => {
  const result = buyBaseWithQuote([{ price: 100, quantity: 1 }], 200);
  assert.equal(result.filled, false);
  assert.equal(result.quoteSpent, 100);
  assert.equal(result.baseReceived, 1);
});

test('walks bids and calculates a base-amount VWAP', () => {
  const result = sellBaseForQuote(
    [
      { price: 110, quantity: 1 },
      { price: 100, quantity: 3 },
    ],
    3,
  );

  assert.equal(result.filled, true);
  assert.equal(result.baseSold, 3);
  assert.equal(result.quoteReceived, 310);
  assert.ok(Math.abs(result.effectivePrice - 310 / 3) < 1e-12);
});

test('rounds executable quantities down to the Binance lot-size step', () => {
  assert.ok(Math.abs(roundDownToStep(3.17866, 0.001) - 3.178) < 1e-12);
  assert.equal(roundDownToStep(3.17866), 3.17866);
});
