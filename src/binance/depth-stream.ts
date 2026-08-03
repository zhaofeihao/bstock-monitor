import WebSocket from 'ws';

import type { AppConfig } from '../config.js';
import type { Logger } from '../logger.js';
import type { CexOrderBook, CexTopOfBook, PriceLevel } from '../types.js';
import { errorMessage, fetchJson, sameStringSet } from '../utils.js';

interface CombinedMessage {
  stream?: string;
  data?: unknown;
  result?: null;
  id?: number;
}

interface PartialDepthPayload {
  lastUpdateId: number;
  bids: [string, string][];
  asks: [string, string][];
}

interface BookTickerPayload {
  u: number;
  s: string;
  b: string;
  B: string;
  a: string;
  A: string;
}

interface SocketTimers {
  forcedReconnect: NodeJS.Timeout | null;
  watchdog: NodeJS.Timeout | null;
  closeFallback: NodeJS.Timeout | null;
}

function parseLevels(levels: [string, string][]): PriceLevel[] {
  return levels
    .map(([price, quantity]) => ({ price: Number(price), quantity: Number(quantity) }))
    .filter((level) => level.price > 0 && level.quantity > 0);
}

export class BinanceDepthStream {
  private socket: WebSocket | null = null;
  private symbols: string[] = [];
  private readonly books = new Map<string, CexOrderBook>();
  private readonly tops = new Map<string, CexTopOfBook>();
  private readonly restDepthInFlight = new Map<string, Promise<CexOrderBook>>();
  private readonly socketTimers = new WeakMap<WebSocket, SocketTimers>();
  private reconnectTimer: NodeJS.Timeout | null = null;
  private restartAfterClose = false;
  private reconnectAttempts = 0;
  private stopping = false;
  private connected = false;
  private lastMessageAt: number | null = null;

  constructor(
    private readonly config: AppConfig,
    private readonly logger: Logger,
  ) {}

  isConnected(): boolean {
    return this.connected;
  }

  getLastMessageAt(): number | null {
    return this.lastMessageAt;
  }

  getBook(symbol: string): CexOrderBook | undefined {
    return this.books.get(symbol.toUpperCase());
  }

  getTop(symbol: string): CexTopOfBook | undefined {
    return this.tops.get(symbol.toUpperCase());
  }

  listBooks(): CexOrderBook[] {
    return [...this.books.values()];
  }

  async fetchDepthSnapshot(symbol: string): Promise<CexOrderBook> {
    const normalized = symbol.toUpperCase();
    const existingRequest = this.restDepthInFlight.get(normalized);
    if (existingRequest) return existingRequest;

    const request = fetchJson<PartialDepthPayload>(
      `${this.config.binanceRestUrl}/api/v3/depth?symbol=${encodeURIComponent(normalized)}&limit=100`,
    ).then((depth) => {
      const snapshot: CexOrderBook = {
        symbol: normalized,
        bids: parseLevels(depth.bids),
        asks: parseLevels(depth.asks),
        lastUpdateId: depth.lastUpdateId,
        updatedAt: Date.now(),
      };
      const current = this.books.get(normalized);
      if (current && snapshot.lastUpdateId < current.lastUpdateId) return current;
      if (current && snapshot.lastUpdateId === current.lastUpdateId) {
        const confirmed = { ...current, updatedAt: snapshot.updatedAt };
        this.books.set(normalized, confirmed);
        return confirmed;
      }
      this.books.set(normalized, snapshot);
      return snapshot;
    });
    this.restDepthInFlight.set(normalized, request);
    try {
      return await request;
    } finally {
      this.restDepthInFlight.delete(normalized);
    }
  }

  async configure(symbols: string[]): Promise<void> {
    const normalized = [...new Set(symbols.map((symbol) => symbol.toUpperCase()))].sort();
    if (sameStringSet(normalized, this.symbols) && this.socket) return;

    this.symbols = normalized;
    for (const symbol of [...this.books.keys()]) {
      if (!this.symbols.includes(symbol)) this.books.delete(symbol);
    }
    for (const symbol of [...this.tops.keys()]) {
      if (!this.symbols.includes(symbol)) this.tops.delete(symbol);
    }
    this.reconnectAttempts = 0;
    this.clearReconnectTimer();

    if (this.socket) {
      this.restartAfterClose = !this.stopping && this.symbols.length > 0;
      this.closeSocket(1000, 'subscription refresh');
      return;
    }

    this.restartAfterClose = false;
    if (!this.stopping && this.symbols.length > 0) this.connect();
  }

  stop(): void {
    this.stopping = true;
    this.connected = false;
    this.restartAfterClose = false;
    this.clearReconnectTimer();
    this.closeSocket(1000, 'service stopping');
  }

  private connect(): void {
    if (this.stopping || this.socket || this.symbols.length === 0) return;

    const socket = new WebSocket(`${this.config.binanceWsUrl}/stream`, {
      handshakeTimeout: 10_000,
      perMessageDeflate: false,
    });
    this.socket = socket;
    this.socketTimers.set(socket, {
      forcedReconnect: null,
      watchdog: null,
      closeFallback: null,
    });

    socket.on('open', () => {
      if (this.socket !== socket || this.stopping) {
        this.closeSpecificSocket(socket, 1000, 'stale connection');
        return;
      }
      this.connected = true;
      this.reconnectAttempts = 0;
      this.lastMessageAt = Date.now();
      const streams = this.symbols.flatMap((symbol) => {
        const lower = symbol.toLowerCase();
        return [`${lower}@bookTicker`, `${lower}@depth20@100ms`];
      });
      socket.send(JSON.stringify({ method: 'SUBSCRIBE', params: streams, id: Date.now() }));
      this.logger.info({ symbols: this.symbols.length, streams: streams.length }, 'Connected to Binance Spot streams');

      // Binance closes market-data connections after 24 hours. Reconnect on our own schedule.
      const timers = this.socketTimers.get(socket);
      if (!timers) return;
      timers.forcedReconnect = setTimeout(() => {
        if (this.socket !== socket) return;
        this.logger.info('Rotating Binance WebSocket connection before the 24-hour limit');
        this.closeSocket(1000, 'scheduled rotation');
      }, 23 * 60 * 60 * 1000);

      timers.watchdog = setInterval(() => {
        if (this.socket !== socket) return;
        const age = Date.now() - (this.lastMessageAt ?? 0);
        if (age > Math.max(30_000, this.config.maxPriceAgeMs * 4)) {
          this.logger.warn({ ageMs: age }, 'Binance stream is silent; reconnecting');
          this.closeSocket(4000, 'stream watchdog');
        }
      }, 10_000);
    });

    socket.on('message', (raw) => {
      if (this.socket !== socket || this.stopping) return;
      this.lastMessageAt = Date.now();
      try {
        const message = JSON.parse(raw.toString()) as CombinedMessage;
        if (message.result === null || !message.stream || !message.data) return;
        this.handleMarketMessage(message.stream, message.data);
      } catch (error) {
        this.logger.debug({ error: errorMessage(error) }, 'Ignored malformed Binance stream message');
      }
    });

    socket.on('error', (error) => {
      if (this.socket !== socket) return;
      this.logger.warn({ error: errorMessage(error) }, 'Binance WebSocket error');
    });

    socket.on('close', (code, reason) => {
      this.clearSocketTimers(socket);
      if (this.socket !== socket) return;

      this.socket = null;
      this.connected = false;
      this.logger.warn({ code, reason: reason.toString() }, 'Binance WebSocket closed');

      if (this.restartAfterClose) {
        this.restartAfterClose = false;
        if (!this.stopping && this.symbols.length > 0) this.connect();
        return;
      }
      this.scheduleReconnect();
    });
  }

  private handleMarketMessage(stream: string, payload: unknown): void {
    const [streamSymbol, channel] = stream.split('@');
    if (!streamSymbol || !channel) return;
    const symbol = streamSymbol.toUpperCase();
    if (!this.symbols.includes(symbol)) return;
    const now = Date.now();

    if (channel.startsWith('depth')) {
      const depth = payload as PartialDepthPayload;
      if (
        !Number.isSafeInteger(depth.lastUpdateId) ||
        !Array.isArray(depth.bids) ||
        !Array.isArray(depth.asks)
      ) {
        return;
      }
      const existing = this.books.get(symbol);
      if (existing && depth.lastUpdateId <= existing.lastUpdateId) return;
      this.books.set(symbol, {
        symbol,
        bids: parseLevels(depth.bids),
        asks: parseLevels(depth.asks),
        lastUpdateId: depth.lastUpdateId,
        updatedAt: now,
      });
      return;
    }

    if (channel === 'bookTicker') {
      const ticker = payload as BookTickerPayload;
      if (!Number.isSafeInteger(ticker.u)) return;
      const existing = this.tops.get(symbol);
      if (existing && ticker.u <= existing.lastUpdateId) return;

      const bidPrice = Number(ticker.b);
      const bidQuantity = Number(ticker.B);
      const askPrice = Number(ticker.a);
      const askQuantity = Number(ticker.A);
      if (![bidPrice, bidQuantity, askPrice, askQuantity].every((value) => Number.isFinite(value) && value > 0)) {
        return;
      }
      this.tops.set(symbol, {
        symbol,
        bidPrice,
        bidQuantity,
        askPrice,
        askQuantity,
        lastUpdateId: ticker.u,
        updatedAt: now,
      });
    }
  }

  private closeSocket(code: number, reason: string): void {
    const socket = this.socket;
    if (!socket) return;
    this.connected = false;
    this.closeSpecificSocket(socket, code, reason);
  }

  private closeSpecificSocket(socket: WebSocket, code: number, reason: string): void {
    this.clearSocketTimers(socket);
    try {
      socket.close(code, reason);
    } catch {
      socket.terminate();
    }

    const timers = this.socketTimers.get(socket);
    if (timers && socket.readyState !== WebSocket.CLOSED) {
      timers.closeFallback = setTimeout(() => {
        if (socket.readyState === WebSocket.CLOSED) return;
        try {
          socket.terminate();
        } catch {
          // The close event owns reconnection; there is nothing else to do here.
        }
      }, 2_000);
    }
  }

  private clearSocketTimers(socket: WebSocket): void {
    const timers = this.socketTimers.get(socket);
    if (!timers) return;
    if (timers.forcedReconnect) clearTimeout(timers.forcedReconnect);
    if (timers.watchdog) clearInterval(timers.watchdog);
    if (timers.closeFallback) clearTimeout(timers.closeFallback);
    timers.forcedReconnect = null;
    timers.watchdog = null;
    timers.closeFallback = null;
  }

  private clearReconnectTimer(): void {
    if (!this.reconnectTimer) return;
    clearTimeout(this.reconnectTimer);
    this.reconnectTimer = null;
  }

  private scheduleReconnect(): void {
    if (this.stopping || this.reconnectTimer || this.socket) return;
    const delay = Math.min(30_000, 500 * 2 ** this.reconnectAttempts) + Math.floor(Math.random() * 250);
    this.reconnectAttempts += 1;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.connect();
    }, delay);
  }
}
