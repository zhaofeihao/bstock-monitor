import assert from 'node:assert/strict';
import test from 'node:test';

import { feeFraction, sqrtPriceX96ToQuotePerBase } from './v3-math.js';

const Q96 = 2n ** 96n;

test('converts a 1:1 V3 sqrt price in either token ordering', () => {
  assert.equal(sqrtPriceX96ToQuotePerBase(Q96, true, 18, 18), 1);
  assert.equal(sqrtPriceX96ToQuotePerBase(Q96, false, 18, 18), 1);
});

test('applies token decimal scaling', () => {
  assert.equal(sqrtPriceX96ToQuotePerBase(Q96, true, 18, 6), 1_000_000_000_000);
  assert.equal(sqrtPriceX96ToQuotePerBase(Q96, false, 6, 18), 0.000000000001);
});

test('converts Pancake fee units to a fraction', () => {
  assert.equal(feeFraction(2500), 0.0025);
  assert.equal(feeFraction(10_000), 0.01);
});
