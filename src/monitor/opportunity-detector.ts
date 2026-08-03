import type { AppConfig } from '../config.js';
import type { Logger } from '../logger.js';
import type {
  AssetDefinition,
  MarketSnapshot,
  Opportunity,
  OpportunityDirection,
  TransferStatus,
} from '../types.js';
import { errorMessage, round, sleep, withTimeout } from '../utils.js';
import { BinanceDepthStream } from '../binance/depth-stream.js';
import { BinancePrivateClient } from '../binance/private-client.js';
import { PancakeV3Monitor } from '../pancake/v3-monitor.js';
import { buyBaseWithQuote, roundDownToStep, sellBaseForQuote } from '../pricing/order-book.js';
import { MonitorDatabase } from '../storage/database.js';
import { sendFeishuOpportunity } from '../notifications/feishu.js';

interface Candidate {
  asset: AssetDefinition;
  direction: OpportunityDirection;
  roughBps: number;
}

export class OpportunityDetector {
  private readonly assets = new Map<string, AssetDefinition>();
  private readonly inFlight = new Set<string>();
  private readonly lastQuotedAt = new Map<string, number>();
  private readonly lastAlertAt = new Map<string, number>();
  private readonly latestOpportunities = new Map<string, Opportunity>();
  private timer: NodeJS.Timeout | null = null;
  private stopping = false;
  private paused = false;

  constructor(
    private readonly config: AppConfig,
    private readonly logger: Logger,
    private readonly cex: BinanceDepthStream,
    private readonly dex: PancakeV3Monitor,
    private readonly transfers: BinancePrivateClient,
    private readonly database: MonitorDatabase,
  ) {}

  configure(assets: AssetDefinition[]): void {
    this.assets.clear();
    for (const asset of assets) this.assets.set(asset.assetCode, asset);
    for (const key of [...this.latestOpportunities.keys()]) {
      if (!this.assets.has(key.split(':', 1)[0]!)) this.latestOpportunities.delete(key);
    }
  }

  start(): void {
    if (this.timer) return;
    this.stopping = false;
    this.paused = false;
    this.timer = setInterval(() => this.scan(), this.config.detectionIntervalMs);
  }

  stop(): void {
    this.stopping = true;
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  pause(): void {
    this.paused = true;
  }

  resume(): void {
    if (!this.stopping) this.paused = false;
  }

  async drain(timeoutMs: number): Promise<boolean> {
    const deadline = Date.now() + timeoutMs;
    while (this.inFlight.size > 0 && Date.now() < deadline) await sleep(25);
    return this.inFlight.size === 0;
  }

  getInFlightCount(): number {
    return this.inFlight.size;
  }

  listLatestOpportunities(): Opportunity[] {
    return [...this.latestOpportunities.values()].sort((left, right) => right.detectedAt - left.detectedAt);
  }

  buildMarketSnapshots(): MarketSnapshot[] {
    const now = Date.now();
    const snapshots: MarketSnapshot[] = [];
    for (const asset of this.assets.values()) {
      const book = this.cex.getTop(asset.cexSymbol);
      const market = this.dex.getBestMarginal(asset.assetCode);
      const bid = book?.bidPrice;
      const ask = book?.askPrice;
      if (!book || !market || !bid || !ask) continue;

      snapshots.push({
        timestamp: now,
        assetCode: asset.assetCode,
        cexSymbol: asset.cexSymbol,
        cexBid: bid,
        cexAsk: ask,
        dexMid: (market.bestBuy.quotePerTokenMid + market.bestSell.quotePerTokenMid) / 2,
        dexBuyMarginal: market.bestBuy.quotePerTokenBuyMarginal,
        dexSellMarginal: market.bestSell.quotePerTokenSellMarginal,
        multiplier: this.dex.getMultiplier(asset.assetCode) ?? asset.apiMultiplier,
        poolAddress: market.bestSell.pool.address,
        cexAgeMs: now - book.updatedAt,
        dexAgeMs: now - Math.min(market.bestBuy.updatedAt, market.bestSell.updatedAt),
      });
    }
    return snapshots;
  }

  private scan(): void {
    if (this.stopping || this.paused || !this.cex.isConnected()) return;
    const globalCexAge = Date.now() - (this.cex.getLastMessageAt() ?? 0);
    if (globalCexAge > this.config.maxPriceAgeMs) return;

    const now = Date.now();
    const candidates: Candidate[] = [];
    for (const asset of this.assets.values()) {
      const book = this.cex.getTop(asset.cexSymbol);
      const market = this.dex.getBestMarginal(asset.assetCode);
      const bestBid = book?.bidPrice;
      const bestAsk = book?.askPrice;
      if (!book || !market || !bestBid || !bestAsk) continue;
      if (
        now - book.updatedAt > this.config.maxPriceAgeMs ||
        now - market.bestBuy.updatedAt > this.config.maxPriceAgeMs ||
        now - market.bestSell.updatedAt > this.config.maxPriceAgeMs
      ) {
        continue;
      }

      const cexBuyDexSell = (market.bestSell.quotePerTokenSellMarginal / bestAsk - 1) * 10_000;
      const dexBuyCexSell = (bestBid / market.bestBuy.quotePerTokenBuyMarginal - 1) * 10_000;
      if (cexBuyDexSell >= this.config.prequoteThresholdBps) {
        candidates.push({ asset, direction: 'CEX_BUY_DEX_SELL', roughBps: cexBuyDexSell });
      }
      if (dexBuyCexSell >= this.config.prequoteThresholdBps) {
        candidates.push({ asset, direction: 'DEX_BUY_CEX_SELL', roughBps: dexBuyCexSell });
      }
    }

    candidates.sort((left, right) => right.roughBps - left.roughBps);
    let capacity = Math.max(0, 8 - this.inFlight.size);
    for (const candidate of candidates) {
      if (capacity === 0) break;
      if (this.schedule(candidate)) capacity -= 1;
    }
  }

  private schedule(candidate: Candidate): boolean {
    if (this.stopping) return false;
    const key = `${candidate.asset.assetCode}:${candidate.direction}`;
    const now = Date.now();
    if (this.inFlight.has(key)) return false;
    if (now - (this.lastQuotedAt.get(key) ?? 0) < this.config.exactQuoteMinIntervalMs) return false;
    this.inFlight.add(key);
    this.lastQuotedAt.set(key, now);

    const work =
      candidate.direction === 'CEX_BUY_DEX_SELL'
        ? this.evaluateCexBuyDexSell(candidate.asset)
        : this.evaluateDexBuyCexSell(candidate.asset);
    void work
      .then((opportunity) => {
        if (opportunity && !this.stopping) this.handleOpportunity(opportunity);
      })
      .catch((error) => {
        this.logger.debug(
          { assetCode: candidate.asset.assetCode, direction: candidate.direction, error: errorMessage(error) },
          'Exact opportunity evaluation failed',
        );
      })
      .finally(() => this.inFlight.delete(key));
    return true;
  }

  private async evaluateCexBuyDexSell(asset: AssetDefinition): Promise<Opportunity | undefined> {
    const startedAt = Date.now();
    const deadline = startedAt + this.config.exactQuoteTimeoutMs;
    let book = await this.getFreshBook(asset.cexSymbol, deadline);
    if (!book) return undefined;
    let cexBuy = buyBaseWithQuote(book.asks, this.config.notionalUsd);
    if (!cexBuy.filled) {
      book = await this.getFreshBook(asset.cexSymbol, deadline, Date.now());
      if (!book) return undefined;
      cexBuy = buyBaseWithQuote(book.asks, this.config.notionalUsd);
    }
    if (!cexBuy.filled || cexBuy.baseReceived <= 0) return undefined;
    const initialBookUpdatedAt = book.updatedAt;

    const transfer = this.transfers.getStatus(asset.assetCode);
    const initialBaseToSell = this.sellableBaseAfterCexBuy(cexBuy.baseReceived, asset, transfer);
    if (initialBaseToSell <= 0) return undefined;

    const dexSell = await this.beforeDeadline(
      this.dex.quoteSell(asset.assetCode, initialBaseToSell),
      deadline,
      `Pancake quoteSell ${asset.assetCode}`,
    );
    if (!dexSell || Date.now() > deadline) return undefined;

    // Re-read the CEX execution book after the RPC quote. This prevents combining a
    // current on-chain leg with a CEX leg that existed only before a slow eth_call.
    const validatedBook = await this.getFreshBook(asset.cexSymbol, deadline, initialBookUpdatedAt + 1);
    if (!validatedBook) return undefined;
    const validatedCexBuy = buyBaseWithQuote(validatedBook.asks, this.config.notionalUsd);
    if (!validatedCexBuy.filled || validatedCexBuy.baseReceived <= 0) return undefined;
    const validatedBaseToSell = this.sellableBaseAfterCexBuy(
      validatedCexBuy.baseReceived,
      asset,
      transfer,
    );
    if (validatedBaseToSell <= 0) return undefined;

    const priceDriftBps = this.relativeDriftBps(cexBuy.effectivePrice, validatedCexBuy.effectivePrice);
    const quantityDriftBps = this.relativeDriftBps(initialBaseToSell, validatedBaseToSell);
    if (Math.max(priceDriftBps, quantityDriftBps) > this.config.maxLegDriftBps) return undefined;

    // Quoter was called for the initial quantity. Scaling down is conservative for
    // a single V3 exact-input swap because the smaller trade has no worse slippage.
    const baseToSell = Math.min(initialBaseToSell, validatedBaseToSell);
    if (baseToSell <= 0) return undefined;
    const conservativeDexOut =
      dexSell.amountOut *
      (baseToSell / initialBaseToSell) *
      (1 - this.config.executionBufferBps / 10_000);
    const quoteFee =
      this.config.cexBuyFeeAsset === 'quote'
        ? cexBuy.quoteSpent * (this.config.cexTakerFeeBps / 10_000)
        : 0;
    const grossProfit = conservativeDexOut - cexBuy.quoteSpent;
    const estimatedCosts = quoteFee + this.config.estimatedGasCostUsd + this.config.rebalanceCostUsd;
    const netProfit = grossProfit - estimatedCosts;
    const acquisitionCost = cexBuy.quoteSpent + quoteFee;
    const transferReady = this.transferReady('CEX_BUY_DEX_SELL', transfer);
    const actionable =
      this.config.settlementMode === 'prepositioned' &&
      netProfit >= this.config.minProfitUsd &&
      (netProfit / acquisitionCost) * 10_000 >= this.config.alertThresholdBps;

    return this.makeOpportunity({
      asset,
      direction: 'CEX_BUY_DEX_SELL',
      poolAddress: dexSell.poolAddress,
      poolFee: dexSell.poolFee,
      baseAmount: baseToSell,
      cexEffectivePrice: Math.max(cexBuy.effectivePrice, validatedCexBuy.effectivePrice),
      dexEffectivePrice: conservativeDexOut / baseToSell,
      grossProfit,
      estimatedCosts,
      netProfit,
      acquisitionCost,
      quoteLatencyMs: Date.now() - startedAt,
      actionable,
      transferReady,
    });
  }

  private async evaluateDexBuyCexSell(asset: AssetDefinition): Promise<Opportunity | undefined> {
    const startedAt = Date.now();
    const deadline = startedAt + this.config.exactQuoteTimeoutMs;
    const dexBuy = await this.beforeDeadline(
      this.dex.quoteBuy(asset.assetCode, this.config.notionalUsd),
      deadline,
      `Pancake quoteBuy ${asset.assetCode}`,
    );
    if (!dexBuy || dexBuy.amountOut <= 0) return undefined;
    let book = await this.getFreshBook(asset.cexSymbol, deadline, startedAt);
    if (!book) return undefined;
    const conservativeBaseOut = roundDownToStep(
      dexBuy.amountOut * (1 - this.config.executionBufferBps / 10_000),
      asset.stepSize,
    );
    let cexSell = sellBaseForQuote(book.bids, conservativeBaseOut);
    if (!cexSell.filled) {
      book = await this.getFreshBook(asset.cexSymbol, deadline, Date.now());
      if (!book) return undefined;
      cexSell = sellBaseForQuote(book.bids, conservativeBaseOut);
    }
    if (!cexSell.filled || Date.now() > deadline) return undefined;
    const cexFee = cexSell.quoteReceived * (this.config.cexTakerFeeBps / 10_000);
    const grossProfit = cexSell.quoteReceived - dexBuy.amountIn;
    const estimatedCosts = cexFee + this.config.estimatedGasCostUsd + this.config.rebalanceCostUsd;
    const netProfit = grossProfit - estimatedCosts;
    const acquisitionCost = dexBuy.amountIn + this.config.estimatedGasCostUsd;
    const transfer = this.transfers.getStatus(asset.assetCode);
    const transferReady = this.transferReady('DEX_BUY_CEX_SELL', transfer);
    const actionable =
      this.config.settlementMode === 'prepositioned' &&
      netProfit >= this.config.minProfitUsd &&
      (netProfit / acquisitionCost) * 10_000 >= this.config.alertThresholdBps;

    return this.makeOpportunity({
      asset,
      direction: 'DEX_BUY_CEX_SELL',
      poolAddress: dexBuy.poolAddress,
      poolFee: dexBuy.poolFee,
      baseAmount: conservativeBaseOut,
      cexEffectivePrice: cexSell.effectivePrice,
      dexEffectivePrice: dexBuy.amountIn / conservativeBaseOut,
      grossProfit,
      estimatedCosts,
      netProfit,
      acquisitionCost,
      quoteLatencyMs: Date.now() - startedAt,
      actionable,
      transferReady,
    });
  }

  private makeOpportunity(input: {
    asset: AssetDefinition;
    direction: OpportunityDirection;
    poolAddress: string;
    poolFee: number;
    baseAmount: number;
    cexEffectivePrice: number;
    dexEffectivePrice: number;
    grossProfit: number;
    estimatedCosts: number;
    netProfit: number;
    acquisitionCost: number;
    quoteLatencyMs: number;
    actionable: boolean;
    transferReady: boolean | null;
  }): Opportunity {
    const netBps = (input.netProfit / input.acquisitionCost) * 10_000;
    const transferReason =
      this.config.settlementMode === 'transfer'
        ? input.transferReady === false
          ? 'Required Binance deposit/withdraw route is disabled'
          : input.transferReady === null
            ? 'Transfer status is unverified; configure Binance API credentials'
            : 'Cross-platform transfer is non-atomic; opportunity is indicative only'
        : undefined;

    return {
      detectedAt: Date.now(),
      assetCode: input.asset.assetCode,
      underlyingTicker: input.asset.underlyingTicker,
      tokenAddress: input.asset.address,
      direction: input.direction,
      cexSymbol: input.asset.cexSymbol,
      poolAddress: input.poolAddress,
      poolFee: input.poolFee,
      notionalUsd: round(this.config.notionalUsd, 8),
      baseAmount: round(input.baseAmount, 12),
      cexEffectivePrice: round(input.cexEffectivePrice, 10),
      dexEffectivePrice: round(input.dexEffectivePrice, 10),
      grossProfitUsd: round(input.grossProfit, 8),
      estimatedCostsUsd: round(input.estimatedCosts, 8),
      netProfitUsd: round(input.netProfit, 8),
      netBps: round(netBps, 4),
      quoteLatencyMs: input.quoteLatencyMs,
      actionable: input.actionable,
      transferReady: input.transferReady,
      settlementMode: this.config.settlementMode,
      ...(transferReason ? { reason: transferReason } : {}),
    };
  }

  private transferReady(direction: OpportunityDirection, status?: TransferStatus): boolean | null {
    if (!status) return null;
    return direction === 'CEX_BUY_DEX_SELL' ? status.withdrawEnabled : status.depositEnabled;
  }

  private sellableBaseAfterCexBuy(
    grossBase: number,
    asset: AssetDefinition,
    transfer?: TransferStatus,
  ): number {
    let base = grossBase;
    if (this.config.cexBuyFeeAsset === 'base') {
      base *= 1 - this.config.cexTakerFeeBps / 10_000;
    }
    if (this.config.settlementMode === 'transfer' && transfer) base -= transfer.withdrawFeeUi;
    return roundDownToStep(base, asset.stepSize);
  }

  private relativeDriftBps(before: number, after: number): number {
    if (!(before > 0) || !(after > 0)) return Number.POSITIVE_INFINITY;
    return Math.abs(after / before - 1) * 10_000;
  }

  private async beforeDeadline<T>(promise: Promise<T>, deadline: number, label: string): Promise<T> {
    const remaining = deadline - Date.now();
    if (remaining <= 0) throw new Error(`${label} missed its evaluation deadline`);
    return withTimeout(promise, remaining, label);
  }

  private async getFreshBook(
    symbol: string,
    deadline: number,
    notBefore = 0,
  ): Promise<ReturnType<BinanceDepthStream['getBook']>> {
    let book = this.cex.getBook(symbol);
    if (!book || Date.now() - book.updatedAt > this.config.maxPriceAgeMs || book.updatedAt < notBefore) {
      book = await this.beforeDeadline(
        this.cex.fetchDepthSnapshot(symbol),
        deadline,
        `Binance depth snapshot ${symbol}`,
      );
    }
    if (book.updatedAt < notBefore || Date.now() - book.updatedAt > this.config.maxPriceAgeMs) return undefined;
    return book;
  }

  private handleOpportunity(opportunity: Opportunity): void {
    if (this.stopping) return;
    const key = `${opportunity.assetCode}:${opportunity.direction}`;
    this.latestOpportunities.set(key, opportunity);
    if (opportunity.netProfitUsd >= this.config.minProfitUsd) this.database.insertOpportunity(opportunity);

    if (!(opportunity.netProfitUsd >= this.config.minProfitUsd && opportunity.netBps >= this.config.alertThresholdBps)) return;
    const now = Date.now();
    if (now - (this.lastAlertAt.get(key) ?? 0) < this.config.alertCooldownMs) return;
    this.lastAlertAt.set(key, now);

    this.logger.warn({ opportunity }, opportunity.actionable ? 'Actionable bStock arbitrage signal' : 'Indicative bStock arbitrage signal');
    if (this.config.webhookUrl) void this.sendWebhook(opportunity);
    if (this.config.feishuWebhookUrl) {
      void sendFeishuOpportunity(this.config, this.logger, opportunity).catch((error) => {
        this.logger.warn(
          { assetCode: opportunity.assetCode, error: errorMessage(error) },
          'Failed to deliver arbitrage alert to Feishu',
        );
      });
    }
  }

  private async sendWebhook(opportunity: Opportunity): Promise<void> {
    try {
      const response = await fetch(this.config.webhookUrl!, {
        method: 'POST',
        signal: AbortSignal.timeout(5000),
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ event: 'bstock_arbitrage', opportunity }),
      });
      if (!response.ok) throw new Error(`Webhook returned HTTP ${response.status}`);
    } catch (error) {
      this.logger.warn({ error: errorMessage(error) }, 'Failed to deliver arbitrage webhook');
    }
  }
}
