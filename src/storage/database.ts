import fs from 'node:fs';
import path from 'node:path';

import Database from 'better-sqlite3';

import type { Logger } from '../logger.js';
import type { AssetDefinition, MarketSnapshot, Opportunity, V3PoolDescriptor } from '../types.js';

export class MonitorDatabase {
  private static readonly PRUNE_BATCH_SIZE = 5_000;

  private readonly db: Database.Database;
  private readonly insertSnapshotStatement: Database.Statement;
  private readonly insertOpportunityStatement: Database.Statement;
  private maintenanceGeneration = 0;
  private closed = false;

  constructor(databasePath: string, private readonly logger: Logger) {
    fs.mkdirSync(path.dirname(databasePath), { recursive: true });
    this.db = new Database(databasePath);
    this.db.pragma('journal_mode = WAL');
    this.db.pragma('synchronous = NORMAL');
    this.db.pragma('foreign_keys = ON');
    this.db.pragma('busy_timeout = 5000');
    this.migrate();

    this.insertSnapshotStatement = this.db.prepare(`
      INSERT INTO price_snapshots (
        timestamp, asset_code, cex_symbol, cex_bid, cex_ask, dex_mid,
        dex_buy_marginal, dex_sell_marginal, multiplier, pool_address,
        cex_age_ms, dex_age_ms
      ) VALUES (
        @timestamp, @assetCode, @cexSymbol, @cexBid, @cexAsk, @dexMid,
        @dexBuyMarginal, @dexSellMarginal, @multiplier, @poolAddress,
        @cexAgeMs, @dexAgeMs
      )
    `);
    this.insertOpportunityStatement = this.db.prepare(`
      INSERT INTO opportunities (
        detected_at, asset_code, underlying_ticker, direction, cex_symbol,
        pool_address, pool_fee, notional_usd, base_amount, cex_effective_price,
        dex_effective_price, gross_profit_usd, estimated_costs_usd,
        net_profit_usd, net_bps, quote_latency_ms, actionable, transfer_ready,
        settlement_mode, reason, payload_json
      ) VALUES (
        @detectedAt, @assetCode, @underlyingTicker, @direction, @cexSymbol,
        @poolAddress, @poolFee, @notionalUsd, @baseAmount, @cexEffectivePrice,
        @dexEffectivePrice, @grossProfitUsd, @estimatedCostsUsd,
        @netProfitUsd, @netBps, @quoteLatencyMs, @actionable, @transferReady,
        @settlementMode, @reason, @payloadJson
      )
    `);
  }

  upsertAssets(assets: AssetDefinition[]): void {
    if (this.closed) return;

    const statement = this.db.prepare(`
      INSERT INTO assets (
        asset_code, underlying_ticker, asset_name, contract_address, network,
        api_multiplier, cex_symbol, quote_asset, updated_at
      ) VALUES (
        @assetCode, @underlyingTicker, @assetName, @address, @network,
        @apiMultiplier, @cexSymbol, @quoteAsset, @updatedAt
      )
      ON CONFLICT(asset_code) DO UPDATE SET
        underlying_ticker = excluded.underlying_ticker,
        asset_name = excluded.asset_name,
        contract_address = excluded.contract_address,
        network = excluded.network,
        api_multiplier = excluded.api_multiplier,
        cex_symbol = excluded.cex_symbol,
        quote_asset = excluded.quote_asset,
        updated_at = excluded.updated_at
    `);
    const now = Date.now();
    const transaction = this.db.transaction((rows: AssetDefinition[]) => {
      for (const asset of rows) statement.run({ ...asset, updatedAt: now });
    });
    transaction(assets);
  }

  replacePools(pools: V3PoolDescriptor[]): void {
    if (this.closed) return;

    const statement = this.db.prepare(`
      INSERT INTO pools (
        address, asset_code, token0, token1, fee, base_is_token0,
        base_decimals, quote_decimals, liquidity, updated_at
      ) VALUES (
        @address, @assetCode, @token0, @token1, @fee, @baseIsToken0,
        @baseDecimals, @quoteDecimals, @liquidity, @updatedAt
      )
      ON CONFLICT(address) DO UPDATE SET
        asset_code = excluded.asset_code,
        token0 = excluded.token0,
        token1 = excluded.token1,
        fee = excluded.fee,
        base_is_token0 = excluded.base_is_token0,
        base_decimals = excluded.base_decimals,
        quote_decimals = excluded.quote_decimals,
        liquidity = excluded.liquidity,
        updated_at = excluded.updated_at
    `);
    const now = Date.now();
    const active = new Set(pools.map((pool) => pool.address.toLowerCase()));
    const transaction = this.db.transaction((rows: V3PoolDescriptor[]) => {
      for (const pool of rows) {
        statement.run({
          ...pool,
          address: pool.address.toLowerCase(),
          baseIsToken0: pool.baseIsToken0 ? 1 : 0,
          liquidity: pool.liquidity.toString(),
          updatedAt: now,
        });
      }
      const existing = this.db.prepare('SELECT address FROM pools').all() as Array<{ address: string }>;
      const remove = this.db.prepare('DELETE FROM pools WHERE address = ?');
      for (const row of existing) {
        if (!active.has(row.address.toLowerCase())) remove.run(row.address);
      }
    });
    transaction(pools);
  }

  insertSnapshots(snapshots: MarketSnapshot[]): void {
    if (this.closed || snapshots.length === 0) return;
    const transaction = this.db.transaction((rows: MarketSnapshot[]) => {
      for (const snapshot of rows) this.insertSnapshotStatement.run(snapshot);
    });
    transaction(snapshots);
  }

  insertOpportunity(opportunity: Opportunity): void {
    if (this.closed) return;

    this.insertOpportunityStatement.run({
      ...opportunity,
      actionable: opportunity.actionable ? 1 : 0,
      transferReady: opportunity.transferReady === null ? null : opportunity.transferReady ? 1 : 0,
      reason: opportunity.reason ?? null,
      payloadJson: JSON.stringify(opportunity),
    });
  }

  listRecentOpportunities(limit = 100): Opportunity[] {
    if (this.closed) return [];

    const safeLimit = Math.max(1, Math.min(1000, Math.floor(limit)));
    const rows = this.db
      .prepare('SELECT payload_json FROM opportunities ORDER BY detected_at DESC, id DESC LIMIT ?')
      .all(safeLimit) as Array<{ payload_json: string }>;
    return rows.map((row) => JSON.parse(row.payload_json) as Opportunity);
  }

  async prune(retentionDays: number): Promise<void> {
    if (this.closed) return;

    const maintenanceGeneration = ++this.maintenanceGeneration;
    const cutoff = Date.now() - retentionDays * 24 * 60 * 60 * 1000;
    const deleteSnapshots = this.db.prepare(`
      DELETE FROM price_snapshots
      WHERE id IN (
        SELECT id FROM price_snapshots
        WHERE timestamp < ?
        ORDER BY timestamp
        LIMIT ?
      )
    `);
    const deleteOpportunities = this.db.prepare(`
      DELETE FROM opportunities
      WHERE id IN (
        SELECT id FROM opportunities
        WHERE detected_at < ?
        ORDER BY detected_at
        LIMIT ?
      )
    `);

    const snapshotsDeleted = await this.deleteExpiredInBatches(
      deleteSnapshots,
      cutoff,
      maintenanceGeneration,
    );
    const opportunitiesDeleted = await this.deleteExpiredInBatches(
      deleteOpportunities,
      cutoff,
      maintenanceGeneration,
    );
    const cancelled = !this.canContinueMaintenance(maintenanceGeneration);

    this.logger.info(
      { snapshotsDeleted, opportunitiesDeleted, cancelled },
      cancelled ? 'Monitor history pruning cancelled' : 'Pruned expired monitor history',
    );
  }

  cancelMaintenance(): void {
    this.maintenanceGeneration += 1;
  }

  stats(): { snapshots: number; opportunities: number; databaseBytes: number } {
    if (this.closed) return { snapshots: 0, opportunities: 0, databaseBytes: 0 };

    const snapshots = this.db.prepare('SELECT COUNT(*) AS count FROM price_snapshots').get() as { count: number };
    const opportunities = this.db.prepare('SELECT COUNT(*) AS count FROM opportunities').get() as { count: number };
    const pageCount = this.db.pragma('page_count', { simple: true }) as number;
    const pageSize = this.db.pragma('page_size', { simple: true }) as number;
    return {
      snapshots: snapshots.count,
      opportunities: opportunities.count,
      databaseBytes: pageCount * pageSize,
    };
  }

  close(): void {
    if (this.closed) return;

    this.cancelMaintenance();
    this.closed = true;
    this.db.close();
  }

  private async deleteExpiredInBatches(
    statement: Database.Statement,
    cutoff: number,
    maintenanceGeneration: number,
  ): Promise<number> {
    let deleted = 0;

    while (this.canContinueMaintenance(maintenanceGeneration)) {
      const result = statement.run(cutoff, MonitorDatabase.PRUNE_BATCH_SIZE);
      deleted += result.changes;
      if (result.changes < MonitorDatabase.PRUNE_BATCH_SIZE) break;
      await new Promise<void>((resolve) => setImmediate(resolve));
    }

    return deleted;
  }

  private canContinueMaintenance(maintenanceGeneration: number): boolean {
    return !this.closed && maintenanceGeneration === this.maintenanceGeneration;
  }

  private migrate(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS assets (
        asset_code TEXT PRIMARY KEY,
        underlying_ticker TEXT NOT NULL,
        asset_name TEXT NOT NULL,
        contract_address TEXT NOT NULL,
        network TEXT NOT NULL,
        api_multiplier REAL NOT NULL,
        cex_symbol TEXT NOT NULL,
        quote_asset TEXT NOT NULL,
        updated_at INTEGER NOT NULL
      );

      CREATE TABLE IF NOT EXISTS pools (
        address TEXT PRIMARY KEY,
        asset_code TEXT NOT NULL,
        token0 TEXT NOT NULL,
        token1 TEXT NOT NULL,
        fee INTEGER NOT NULL,
        base_is_token0 INTEGER NOT NULL,
        base_decimals INTEGER NOT NULL,
        quote_decimals INTEGER NOT NULL,
        liquidity TEXT NOT NULL,
        updated_at INTEGER NOT NULL,
        FOREIGN KEY(asset_code) REFERENCES assets(asset_code)
      );
      CREATE INDEX IF NOT EXISTS idx_pools_asset_code ON pools(asset_code);

      CREATE TABLE IF NOT EXISTS price_snapshots (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        timestamp INTEGER NOT NULL,
        asset_code TEXT NOT NULL,
        cex_symbol TEXT NOT NULL,
        cex_bid REAL NOT NULL,
        cex_ask REAL NOT NULL,
        dex_mid REAL NOT NULL,
        dex_buy_marginal REAL NOT NULL,
        dex_sell_marginal REAL NOT NULL,
        multiplier REAL NOT NULL,
        pool_address TEXT NOT NULL,
        cex_age_ms INTEGER NOT NULL,
        dex_age_ms INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_snapshots_asset_timestamp
        ON price_snapshots(asset_code, timestamp DESC);
      CREATE INDEX IF NOT EXISTS idx_snapshots_timestamp ON price_snapshots(timestamp);

      CREATE TABLE IF NOT EXISTS opportunities (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        detected_at INTEGER NOT NULL,
        asset_code TEXT NOT NULL,
        underlying_ticker TEXT NOT NULL,
        direction TEXT NOT NULL,
        cex_symbol TEXT NOT NULL,
        pool_address TEXT NOT NULL,
        pool_fee INTEGER NOT NULL,
        notional_usd REAL NOT NULL,
        base_amount REAL NOT NULL,
        cex_effective_price REAL NOT NULL,
        dex_effective_price REAL NOT NULL,
        gross_profit_usd REAL NOT NULL,
        estimated_costs_usd REAL NOT NULL,
        net_profit_usd REAL NOT NULL,
        net_bps REAL NOT NULL,
        quote_latency_ms INTEGER NOT NULL,
        actionable INTEGER NOT NULL,
        transfer_ready INTEGER,
        settlement_mode TEXT NOT NULL,
        reason TEXT,
        payload_json TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_opportunities_detected_at ON opportunities(detected_at DESC);
      CREATE INDEX IF NOT EXISTS idx_opportunities_asset_direction
        ON opportunities(asset_code, direction, detected_at DESC);
    `);
  }
}
