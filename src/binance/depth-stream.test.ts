import assert from 'node:assert/strict';
import test from 'node:test';
import type { AddressInfo } from 'node:net';

import WebSocket, { WebSocketServer } from 'ws';

import type { AppConfig } from '../config.js';
import type { Logger } from '../logger.js';
import { BinanceDepthStream } from './depth-stream.js';

const config = {
  binanceRestUrl: 'https://binance.test',
  binanceWsUrl: 'wss://binance.test',
  maxPriceAgeMs: 5_000,
} as AppConfig;

const logger = {
  info: () => undefined,
  warn: () => undefined,
  debug: () => undefined,
} as unknown as Logger;

interface TestableDepthStream {
  symbols: string[];
  socket: WebSocket | null;
  handleMarketMessage(stream: string, payload: unknown): void;
}

async function waitFor(predicate: () => boolean, timeoutMs = 2_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error('Timed out waiting for condition');
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

function createStream(): { stream: BinanceDepthStream; testable: TestableDepthStream } {
  const stream = new BinanceDepthStream(config, logger);
  const testable = stream as unknown as TestableDepthStream;
  testable.symbols = ['TSLABUSDT'];
  return { stream, testable };
}

test('keeps bookTicker top-of-book separate from executable depth', () => {
  const { stream, testable } = createStream();

  testable.handleMarketMessage('tslabusdt@depth20@100ms', {
    lastUpdateId: 100,
    bids: [
      ['100', '2'],
      ['99', '3'],
    ],
    asks: [
      ['101', '4'],
      ['102', '5'],
    ],
  });
  testable.handleMarketMessage('tslabusdt@bookTicker', {
    u: 101,
    s: 'TSLABUSDT',
    b: '100.5',
    B: '1.5',
    a: '100.75',
    A: '1.25',
  });

  assert.deepEqual(stream.getBook('tslabusdt'), {
    symbol: 'TSLABUSDT',
    bids: [
      { price: 100, quantity: 2 },
      { price: 99, quantity: 3 },
    ],
    asks: [
      { price: 101, quantity: 4 },
      { price: 102, quantity: 5 },
    ],
    lastUpdateId: 100,
    updatedAt: stream.getBook('TSLABUSDT')?.updatedAt,
  });
  assert.deepEqual(stream.getTop('tslabusdt'), {
    symbol: 'TSLABUSDT',
    bidPrice: 100.5,
    bidQuantity: 1.5,
    askPrice: 100.75,
    askQuantity: 1.25,
    lastUpdateId: 101,
    updatedAt: stream.getTop('TSLABUSDT')?.updatedAt,
  });
});

test('rejects duplicate and out-of-order updates independently for depth and top-of-book', () => {
  const { stream, testable } = createStream();

  testable.handleMarketMessage('tslabusdt@depth20@100ms', {
    lastUpdateId: 200,
    bids: [['100', '2']],
    asks: [['101', '2']],
  });
  testable.handleMarketMessage('tslabusdt@depth20@100ms', {
    lastUpdateId: 199,
    bids: [['1', '1']],
    asks: [['2', '1']],
  });
  testable.handleMarketMessage('tslabusdt@bookTicker', {
    u: 300,
    s: 'TSLABUSDT',
    b: '100',
    B: '2',
    a: '101',
    A: '2',
  });
  testable.handleMarketMessage('tslabusdt@bookTicker', {
    u: 300,
    s: 'TSLABUSDT',
    b: '1',
    B: '1',
    a: '2',
    A: '1',
  });

  assert.equal(stream.getBook('TSLABUSDT')?.lastUpdateId, 200);
  assert.equal(stream.getBook('TSLABUSDT')?.bids[0]?.price, 100);
  assert.equal(stream.getTop('TSLABUSDT')?.lastUpdateId, 300);
  assert.equal(stream.getTop('TSLABUSDT')?.bidPrice, 100);
});

test('an older REST snapshot returns the newer streamed book instead of overwriting it', async () => {
  const { stream, testable } = createStream();
  testable.handleMarketMessage('tslabusdt@depth20@100ms', {
    lastUpdateId: 500,
    bids: [['100', '2']],
    asks: [['101', '2']],
  });

  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async () =>
    new Response(
      JSON.stringify({
        lastUpdateId: 499,
        bids: [['1', '1']],
        asks: [['2', '1']],
      }),
      { status: 200, headers: { 'content-type': 'application/json' } },
    )) as typeof fetch;

  try {
    const result = await stream.fetchDepthSnapshot('tslabusdt');
    assert.equal(result.lastUpdateId, 500);
    assert.equal(result.bids[0]?.price, 100);
    assert.strictEqual(result, stream.getBook('TSLABUSDT'));
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('an equal REST snapshot refreshes the confirmation timestamp without changing depth', async () => {
  const { stream, testable } = createStream();
  testable.handleMarketMessage('tslabusdt@depth20@100ms', {
    lastUpdateId: 600,
    bids: [['100', '2']],
    asks: [['101', '2']],
  });
  const before = stream.getBook('TSLABUSDT');
  assert.ok(before);
  await new Promise((resolve) => setTimeout(resolve, 2));

  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async () =>
    new Response(
      JSON.stringify({
        lastUpdateId: 600,
        bids: [['1', '1']],
        asks: [['2', '1']],
      }),
      { status: 200, headers: { 'content-type': 'application/json' } },
    )) as typeof fetch;

  try {
    const result = await stream.fetchDepthSnapshot('TSLABUSDT');
    assert.equal(result.bids[0]?.price, 100);
    assert.equal(result.asks[0]?.price, 101);
    assert.ok(result.updatedAt > before.updatedAt);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('waits for the old socket to close and ignores its callbacks after reconnecting', async () => {
  const server = new WebSocketServer({ host: '127.0.0.1', port: 0 });
  await new Promise<void>((resolve) => server.once('listening', resolve));
  const port = (server.address() as AddressInfo).port;
  const connections: WebSocket[] = [];
  server.on('connection', (socket) => connections.push(socket));

  const stream = new BinanceDepthStream(
    { ...config, binanceWsUrl: `ws://127.0.0.1:${port}` },
    logger,
  );
  const testable = stream as unknown as TestableDepthStream;

  try {
    await stream.configure(['TSLABUSDT']);
    await waitFor(() => connections.length === 1 && stream.isConnected());
    const oldClient = testable.socket;
    assert.ok(oldClient);

    await stream.configure(['NVDABUSDT']);
    await waitFor(() => connections.length === 2 && stream.isConnected());
    const newClient = testable.socket;
    assert.ok(newClient);
    assert.notStrictEqual(newClient, oldClient);

    // Simulate a duplicated/delayed callback from the retired connection.
    oldClient.emit('close', 1000, Buffer.from('late old close'));
    assert.strictEqual(testable.socket, newClient);
    assert.equal(stream.isConnected(), true);
  } finally {
    stream.stop();
    await waitFor(() => testable.socket === null).catch(() => undefined);
    for (const socket of server.clients) socket.terminate();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});
