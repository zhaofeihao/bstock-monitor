import type { AppConfig } from './config.js';
import type { Logger } from './logger.js';
import type { AssetDefinition, ServiceHealth } from './types.js';
import { errorMessage, sleep } from './utils.js';
import { BinanceAssetCatalog } from './binance/asset-catalog.js';
import { BinanceDepthStream } from './binance/depth-stream.js';
import { BinancePrivateClient } from './binance/private-client.js';
import { MonitorHttpServer, type HttpStateProvider } from './http/server.js';
import { OpportunityDetector } from './monitor/opportunity-detector.js';
import { PancakeV3Monitor } from './pancake/v3-monitor.js';
import { MonitorDatabase } from './storage/database.js';

export class MonitorApp implements HttpStateProvider {
  private readonly startedAt = Date.now();
  private readonly database: MonitorDatabase;
  private readonly catalog: BinanceAssetCatalog;
  private readonly cex: BinanceDepthStream;
  private readonly transfers: BinancePrivateClient;
  private readonly dex: PancakeV3Monitor;
  private readonly detector: OpportunityDetector;
  private readonly http: MonitorHttpServer;
  private currentAssets: AssetDefinition[] = [];
  private lastAssetRefreshAt: number | null = null;
  private assetRefreshTimer: NodeJS.Timeout | null = null;
  private poolRefreshTimer: NodeJS.Timeout | null = null;
  private transferRefreshTimer: NodeJS.Timeout | null = null;
  private snapshotTimer: NodeJS.Timeout | null = null;
  private pruneTimer: NodeJS.Timeout | null = null;
  private pruneTask: Promise<void> | null = null;
  private refreshingAssets = false;
  private refreshingPools = false;
  private stopping = false;

  constructor(
    private readonly config: AppConfig,
    private readonly logger: Logger,
  ) {
    this.database = new MonitorDatabase(config.sqlitePath, logger);
    this.catalog = new BinanceAssetCatalog(config, logger);
    this.cex = new BinanceDepthStream(config, logger);
    this.transfers = new BinancePrivateClient(config, logger);
    this.dex = new PancakeV3Monitor(config, logger);
    this.detector = new OpportunityDetector(config, logger, this.cex, this.dex, this.transfers, this.database);
    this.http = new MonitorHttpServer(config, logger, this, this.database);
  }

  async start(): Promise<void> {
    await this.refreshAssets(true);
    this.dex.start();
    this.detector.start();
    await this.http.start();

    this.assetRefreshTimer = setInterval(() => void this.refreshAssets(false), this.config.assetRefreshMs);
    this.poolRefreshTimer = setInterval(() => void this.refreshPools(), this.config.poolRefreshMs);
    this.transferRefreshTimer = setInterval(
      () => void this.transfers.refresh(this.currentAssets),
      this.config.transferStatusRefreshMs,
    );
    this.snapshotTimer = setInterval(() => {
      try {
        this.database.insertSnapshots(this.detector.buildMarketSnapshots());
      } catch (error) {
        this.logger.warn({ error: errorMessage(error) }, 'Unable to persist market snapshots');
      }
    }, this.config.snapshotIntervalMs);
    this.pruneTimer = setInterval(() => this.startPrune(), 24 * 60 * 60 * 1000);
    this.startPrune();

    this.logger.info(
      {
        assets: this.currentAssets.length,
        pools: this.dex.getPoolCount(),
        notionalUsd: this.config.notionalUsd,
        settlementMode: this.config.settlementMode,
        sqlitePath: this.config.sqlitePath,
      },
      'bStock arbitrage monitor is running',
    );
  }

  async stop(): Promise<void> {
    if (this.stopping) return;
    this.stopping = true;
    for (const timer of [
      this.assetRefreshTimer,
      this.poolRefreshTimer,
      this.transferRefreshTimer,
      this.snapshotTimer,
      this.pruneTimer,
    ]) {
      if (timer) clearInterval(timer);
    }
    this.detector.stop();
    this.cex.stop();
    this.database.cancelMaintenance();
    const detectorDrained = await this.detector.drain(this.config.exactQuoteTimeoutMs + 500);
    if (!detectorDrained) {
      this.logger.warn({ inFlight: this.detector.getInFlightCount() }, 'Timed out draining exact quotes');
    }
    await this.waitForRefreshes(5_000);
    await Promise.allSettled([this.http.stop(), this.dex.stop(), ...(this.pruneTask ? [this.pruneTask] : [])]);
    this.database.close();
    this.logger.info('bStock arbitrage monitor stopped');
  }

  health(): ServiceHealth {
    const activeMarkets = this.detector
      .buildMarketSnapshots()
      .filter(
        (market) =>
          market.cexAgeMs <= this.config.maxPriceAgeMs && market.dexAgeMs <= this.config.maxPriceAgeMs,
      ).length;
    return {
      startedAt: this.startedAt,
      assets: this.currentAssets.length,
      pools: this.dex.getPoolCount(),
      activeMarkets,
      cexConnected: this.cex.isConnected(),
      cexLastMessageAt: this.cex.getLastMessageAt(),
      dexLastPollAt: this.dex.getLastPollAt(),
      dexLastBlock: this.dex.getLastBlock(),
      exactQuotesInFlight: this.detector.getInFlightCount(),
      lastAssetRefreshAt: this.lastAssetRefreshAt,
    };
  }

  assets(): AssetDefinition[] {
    return this.currentAssets;
  }

  pools() {
    return this.dex.listPools();
  }

  markets() {
    return this.detector.buildMarketSnapshots();
  }

  latestOpportunities() {
    return this.detector.listLatestOpportunities();
  }

  transferStatuses() {
    return this.transfers.listStatuses();
  }

  private async refreshAssets(initial: boolean): Promise<void> {
    if (this.refreshingAssets || this.stopping) return;
    this.refreshingAssets = true;
    if (!initial) this.detector.pause();
    const previousAssets = this.currentAssets;
    let registryChanged = false;
    try {
      const assets = await this.catalog.load();
      if (assets.length === 0) throw new Error('No active bStocks returned by Binance');
      if (this.stopping) return;
      if (!initial && !(await this.detector.drain(this.config.exactQuoteTimeoutMs + 500))) {
        throw new Error('Timed out draining exact quotes before catalog refresh');
      }

      await this.dex.configure(assets);
      registryChanged = true;
      if (this.stopping) return;
      await this.cex.configure(assets.map((asset) => asset.cexSymbol));
      if (this.stopping) return;

      // Persist and publish only after both venue registries are ready. The detector
      // remains paused so a contract-address change cannot mix old pools and new assets.
      this.database.upsertAssets(assets);
      this.database.replacePools(this.dex.listPools());
      await this.transfers.refresh(assets);
      if (this.stopping) return;
      await this.dex.pollOnce();
      if (this.stopping) return;

      this.logCatalogChanges(previousAssets, assets);
      this.currentAssets = assets;
      this.detector.configure(assets);
      this.lastAssetRefreshAt = Date.now();
    } catch (error) {
      this.logger.error({ error: errorMessage(error), initial }, 'Failed to refresh bStock catalog');
      if (registryChanged && previousAssets.length > 0 && !this.stopping) {
        try {
          await this.dex.configure(previousAssets);
          await this.cex.configure(previousAssets.map((asset) => asset.cexSymbol));
        } catch (rollbackError) {
          this.logger.error(
            { error: errorMessage(rollbackError) },
            'Failed to roll back venue registries after catalog refresh failure',
          );
        }
      }
      if (initial) throw error;
    } finally {
      this.refreshingAssets = false;
      if (!initial) this.detector.resume();
    }
  }

  private async refreshPools(): Promise<void> {
    if (this.refreshingPools || this.refreshingAssets || this.stopping || this.currentAssets.length === 0) return;
    this.refreshingPools = true;
    this.detector.pause();
    try {
      if (!(await this.detector.drain(this.config.exactQuoteTimeoutMs + 500))) {
        throw new Error('Timed out draining exact quotes before pool refresh');
      }
      await this.dex.configure(this.currentAssets);
      if (this.stopping) return;
      this.database.replacePools(this.dex.listPools());
      await this.dex.pollOnce();
    } catch (error) {
      this.logger.warn({ error: errorMessage(error) }, 'Failed to refresh PancakeSwap pool registry');
    } finally {
      this.refreshingPools = false;
      this.detector.resume();
    }
  }

  private startPrune(): void {
    if (this.stopping || this.pruneTask) return;
    this.pruneTask = this.database
      .prune(this.config.retentionDays)
      .catch((error) => this.logger.warn({ error: errorMessage(error) }, 'Unable to prune monitor history'))
      .finally(() => {
        this.pruneTask = null;
      });
  }

  private async waitForRefreshes(timeoutMs: number): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while ((this.refreshingAssets || this.refreshingPools) && Date.now() < deadline) await sleep(25);
    if (this.refreshingAssets || this.refreshingPools) {
      this.logger.warn('Timed out waiting for a registry refresh to stop');
    }
  }

  private logCatalogChanges(previous: AssetDefinition[], next: AssetDefinition[]): void {
    if (previous.length === 0) return;
    const oldByCode = new Map(previous.map((asset) => [asset.assetCode, asset]));
    const nextCodes = new Set(next.map((asset) => asset.assetCode));
    for (const asset of next) {
      const old = oldByCode.get(asset.assetCode);
      if (!old) {
        this.logger.warn({ assetCode: asset.assetCode, address: asset.address }, 'New Binance bStock detected');
      } else if (old.address.toLowerCase() !== asset.address.toLowerCase()) {
        this.logger.error(
          { assetCode: asset.assetCode, previousAddress: old.address, nextAddress: asset.address },
          'Binance bStock contract address changed',
        );
      } else if (old.apiMultiplier !== asset.apiMultiplier) {
        this.logger.warn(
          { assetCode: asset.assetCode, previousMultiplier: old.apiMultiplier, nextMultiplier: asset.apiMultiplier },
          'Binance bStock multiplier changed',
        );
      }
    }
    for (const asset of previous) {
      if (!nextCodes.has(asset.assetCode)) {
        this.logger.error({ assetCode: asset.assetCode }, 'Previously monitored bStock disappeared from active catalog');
      }
    }
  }
}
