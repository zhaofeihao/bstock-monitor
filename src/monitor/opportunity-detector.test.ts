import assert from 'node:assert/strict';
import test from 'node:test';

import type { AppConfig } from '../config.js';
import type { Logger } from '../logger.js';
import type { AssetDefinition, TransferStatus } from '../types.js';
import type { BinanceDepthStream } from '../binance/depth-stream.js';
import type { BinancePrivateClient } from '../binance/private-client.js';
import type { PancakeV3Monitor } from '../pancake/v3-monitor.js';
import type { MonitorDatabase } from '../storage/database.js';
import { OpportunityDetector } from './opportunity-detector.js';

interface TestableDetector {
  sellableBaseAfterCexBuy(
    grossBase: number,
    asset: AssetDefinition,
    transfer?: TransferStatus,
  ): number;
}

const asset = {
  assetCode: 'TSLAB',
  stepSize: 0.01,
} as AssetDefinition;

function detector(feeAsset: 'base' | 'quote', settlementMode: 'prepositioned' | 'transfer' = 'prepositioned') {
  return new OpportunityDetector(
    {
      cexTakerFeeBps: 10,
      cexBuyFeeAsset: feeAsset,
      settlementMode,
    } as AppConfig,
    {} as Logger,
    {} as BinanceDepthStream,
    {} as PancakeV3Monitor,
    {} as BinancePrivateClient,
    {} as MonitorDatabase,
  ) as unknown as TestableDetector;
}

test('deducts a base-paid CEX buy commission before lot-size rounding', () => {
  assert.equal(detector('base').sellableBaseAfterCexBuy(10, asset), 9.99);
});

test('does not reduce base quantity when the CEX buy commission is quote-paid', () => {
  assert.equal(detector('quote').sellableBaseAfterCexBuy(10, asset), 10);
});

test('deducts transfer withdrawal fee before final lot-size rounding', () => {
  const transfer = { withdrawFeeUi: 0.005 } as TransferStatus;
  assert.equal(detector('base', 'transfer').sellableBaseAfterCexBuy(10, asset, transfer), 9.98);
});
