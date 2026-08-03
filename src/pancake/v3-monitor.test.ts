import assert from 'node:assert/strict';
import test from 'node:test';

import type { AppConfig } from '../config.js';
import type { Logger } from '../logger.js';
import type { V3PoolDescriptor, V3PoolState } from '../types.js';
import { PancakeV3Monitor } from './v3-monitor.js';

interface TestableMonitor {
  statesByPool: Map<string, V3PoolState>;
  storeState(state: V3PoolState, source: 'poll' | 'event', logIndex?: number): boolean;
}

const pool: V3PoolDescriptor = {
  assetCode: 'TSLAB',
  address: '0x0000000000000000000000000000000000000001',
  token0: '0x0000000000000000000000000000000000000002',
  token1: '0x0000000000000000000000000000000000000003',
  fee: 2500,
  baseIsToken0: true,
  baseDecimals: 18,
  quoteDecimals: 18,
  liquidity: 1n,
};

function state(blockNumber: number, tick: number): V3PoolState {
  return {
    pool,
    sqrtPriceX96: 1n,
    tick,
    liquidity: 1n,
    multiplier: 1,
    quotePerTokenMid: 1,
    quotePerTokenBuyMarginal: 1,
    quotePerTokenSellMarginal: 1,
    blockNumber,
    updatedAt: Date.now(),
  };
}

test('orders V3 poll and Swap-event states by block and log position', async () => {
  const monitor = new PancakeV3Monitor(
    {
      bscRpcUrl: 'http://127.0.0.1:1',
      exactQuoteTimeoutMs: 250,
      dexPollIntervalMs: 1_000,
      pancakeV3Factory: '0x0000000000000000000000000000000000000004',
      pancakeV3Quoter: '0x0000000000000000000000000000000000000005',
      multicall3Address: '0x0000000000000000000000000000000000000006',
    } as AppConfig,
    { warn: () => undefined } as unknown as Logger,
  );
  const testable = monitor as unknown as TestableMonitor;

  try {
    assert.equal(testable.storeState(state(101, 1), 'event', 2), true);
    assert.equal(testable.storeState(state(100, 2), 'poll'), false);
    assert.equal(testable.storeState(state(101, 3), 'event', 1), false);
    assert.equal(testable.storeState(state(101, 4), 'poll'), true);
    assert.equal(testable.storeState(state(101, 5), 'event', 3), false);
    assert.equal(testable.statesByPool.get(pool.address)?.tick, 4);
    assert.equal(testable.storeState(state(102, 6), 'event', 0), true);
    assert.equal(testable.statesByPool.get(pool.address)?.tick, 6);
  } finally {
    await monitor.stop();
  }
});
