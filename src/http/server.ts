import http, { type IncomingMessage, type ServerResponse } from 'node:http';

import type { AppConfig } from '../config.js';
import type { Logger } from '../logger.js';
import type { AssetDefinition, MarketSnapshot, Opportunity, ServiceHealth, TransferStatus, V3PoolDescriptor } from '../types.js';
import { MonitorDatabase } from '../storage/database.js';

export interface HttpStateProvider {
  health(): ServiceHealth;
  assets(): AssetDefinition[];
  pools(): V3PoolDescriptor[];
  markets(): MarketSnapshot[];
  latestOpportunities(): Opportunity[];
  transferStatuses(): TransferStatus[];
}

function json(response: ServerResponse, status: number, payload: unknown): void {
  const body = JSON.stringify(payload);
  response.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(body),
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
  });
  response.end(body);
}

export class MonitorHttpServer {
  private server: http.Server | null = null;

  constructor(
    private readonly config: AppConfig,
    private readonly logger: Logger,
    private readonly state: HttpStateProvider,
    private readonly database: MonitorDatabase,
  ) {}

  async start(): Promise<void> {
    if (this.server) return;
    this.server = http.createServer((request, response) => this.route(request, response));
    await new Promise<void>((resolve, reject) => {
      this.server!.once('error', reject);
      this.server!.listen(this.config.httpPort, this.config.httpHost, () => {
        this.server!.off('error', reject);
        resolve();
      });
    });
    this.logger.info(
      { url: `http://${this.config.httpHost}:${this.config.httpPort}` },
      'Monitor HTTP status server started',
    );
  }

  async stop(): Promise<void> {
    const server = this.server;
    this.server = null;
    if (!server) return;
    await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
  }

  private route(request: IncomingMessage, response: ServerResponse): void {
    if (request.method !== 'GET') {
      json(response, 405, { error: 'method_not_allowed' });
      return;
    }
    const url = new URL(request.url ?? '/', 'http://localhost');

    if (url.pathname === '/') {
      json(response, 200, {
        service: 'bstock-monitor',
        endpoints: ['/health', '/v1/assets', '/v1/markets', '/v1/opportunities', '/metrics'],
      });
      return;
    }

    if (url.pathname === '/health') {
      const health = this.state.health();
      const dexFresh =
        health.dexLastPollAt !== null && Date.now() - health.dexLastPollAt <= this.config.maxPriceAgeMs * 2;
      const healthy =
        health.cexConnected && dexFresh && health.assets > 0 && health.pools > 0 && health.activeMarkets > 0;
      json(response, healthy ? 200 : 503, { status: healthy ? 'ok' : 'degraded', ...health, database: this.database.stats() });
      return;
    }

    if (url.pathname === '/v1/assets') {
      const poolsByAsset = new Map<string, Array<Record<string, unknown>>>();
      for (const pool of this.state.pools()) {
        const list = poolsByAsset.get(pool.assetCode) ?? [];
        list.push({ ...pool, liquidity: pool.liquidity.toString() });
        poolsByAsset.set(pool.assetCode, list);
      }
      const transfers = new Map(this.state.transferStatuses().map((status) => [status.assetCode, status]));
      json(
        response,
        200,
        this.state.assets().map((asset) => ({
          ...asset,
          pools: poolsByAsset.get(asset.assetCode) ?? [],
          transferStatus: transfers.get(asset.assetCode) ?? null,
        })),
      );
      return;
    }

    if (url.pathname === '/v1/markets') {
      json(response, 200, this.state.markets());
      return;
    }

    if (url.pathname === '/v1/opportunities') {
      const limit = Number(url.searchParams.get('limit') ?? '100');
      const source = url.searchParams.get('source') ?? 'latest';
      json(
        response,
        200,
        source === 'history'
          ? this.database.listRecentOpportunities(Number.isFinite(limit) ? limit : 100)
          : this.state.latestOpportunities(),
      );
      return;
    }

    if (url.pathname === '/metrics') {
      this.metrics(response);
      return;
    }

    json(response, 404, { error: 'not_found' });
  }

  private metrics(response: ServerResponse): void {
    const health = this.state.health();
    const database = this.database.stats();
    const lines = [
      '# HELP bstock_monitor_assets Number of active Binance bStocks in the catalog.',
      '# TYPE bstock_monitor_assets gauge',
      `bstock_monitor_assets ${health.assets}`,
      '# HELP bstock_monitor_pools Number of discovered PancakeSwap V3 pools.',
      '# TYPE bstock_monitor_pools gauge',
      `bstock_monitor_pools ${health.pools}`,
      '# HELP bstock_monitor_active_markets Number of assets with fresh CEX and active DEX prices.',
      '# TYPE bstock_monitor_active_markets gauge',
      `bstock_monitor_active_markets ${health.activeMarkets}`,
      '# HELP bstock_monitor_cex_connected Whether the Binance WebSocket is connected.',
      '# TYPE bstock_monitor_cex_connected gauge',
      `bstock_monitor_cex_connected ${health.cexConnected ? 1 : 0}`,
      '# HELP bstock_monitor_exact_quotes_in_flight Current exact DEX quote calls.',
      '# TYPE bstock_monitor_exact_quotes_in_flight gauge',
      `bstock_monitor_exact_quotes_in_flight ${health.exactQuotesInFlight}`,
      '# HELP bstock_monitor_snapshots_total Persisted market snapshots.',
      '# TYPE bstock_monitor_snapshots_total gauge',
      `bstock_monitor_snapshots_total ${database.snapshots}`,
      '# HELP bstock_monitor_opportunities_total Persisted exact opportunity evaluations.',
      '# TYPE bstock_monitor_opportunities_total gauge',
      `bstock_monitor_opportunities_total ${database.opportunities}`,
      '',
    ];
    const body = lines.join('\n');
    response.writeHead(200, {
      'content-type': 'text/plain; version=0.0.4; charset=utf-8',
      'content-length': Buffer.byteLength(body),
      'cache-control': 'no-store',
    });
    response.end(body);
  }
}
