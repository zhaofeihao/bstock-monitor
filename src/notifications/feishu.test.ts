import assert from 'node:assert/strict';
import test from 'node:test';

import type { AppConfig } from '../config.js';
import type { Opportunity } from '../types.js';
import {
  buildFeishuOpportunityPayload,
  createFeishuSignature,
  sendFeishuTest,
} from './feishu.js';

const opportunity: Opportunity = {
  detectedAt: Date.parse('2026-08-03T14:00:00.000Z'),
  assetCode: 'TSLAB',
  underlyingTicker: 'TSLA',
  direction: 'CEX_BUY_DEX_SELL',
  cexSymbol: 'TSLABUSDT',
  poolAddress: '0x0000000000000000000000000000000000000001',
  poolFee: 2500,
  notionalUsd: 1000,
  baseAmount: 3.14,
  cexEffectivePrice: 318,
  dexEffectivePrice: 320,
  grossProfitUsd: 6.28,
  estimatedCostsUsd: 1.2,
  netProfitUsd: 5.08,
  netBps: 50.8,
  quoteLatencyMs: 220,
  actionable: true,
  transferReady: null,
  settlementMode: 'prepositioned',
};

test('creates the Feishu custom-bot HMAC signature', () => {
  assert.equal(
    createFeishuSignature('1599360473', 'test-secret'),
    'wSds2BzzFIIGf/WrhUO+NI1q/9j+FRJd3JNHKAq0NZY=',
  );
});

test('builds a signed interactive arbitrage card', () => {
  const payload = buildFeishuOpportunityPayload(opportunity, {
    title: 'bStock 套利告警',
    secret: 'test-secret',
    atAll: true,
    timestamp: 1599360473,
  }) as {
    timestamp: string;
    sign: string;
    msg_type: string;
    card: { header: { template: string; title: { content: string } }; elements: unknown[] };
  };

  assert.equal(payload.timestamp, '1599360473');
  assert.equal(payload.sign, 'wSds2BzzFIIGf/WrhUO+NI1q/9j+FRJd3JNHKAq0NZY=');
  assert.equal(payload.msg_type, 'interactive');
  assert.equal(payload.card.header.template, 'red');
  assert.match(payload.card.header.title.content, /TSLAB/);
  assert.match(JSON.stringify(payload.card.elements), /<at id=all><\/at>/);
  assert.match(JSON.stringify(payload.card.elements), /5\.08/);
});

test('validates the application-level Feishu webhook response code', async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async () =>
    new Response(JSON.stringify({ code: 19021, msg: 'sign match fail' }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    })) as typeof fetch;

  try {
    await assert.rejects(
      sendFeishuTest({
        feishuWebhookUrl: 'https://open.feishu.cn/open-apis/bot/v2/hook/test',
        feishuMessageTitle: 'bStock 套利告警',
      } as AppConfig),
      /code=19021/,
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});
