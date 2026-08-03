import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import http, { type IncomingMessage, type ServerResponse } from 'node:http';
import path from 'node:path';
import { gzipSync } from 'node:zlib';

import type { AppConfig } from '../config.js';
import type { Logger } from '../logger.js';
import { MonitorDatabase } from '../storage/database.js';
import type {
  AssetDefinition,
  MarketSnapshot,
  Opportunity,
  ServiceHealth,
  TransferStatus,
  V3PoolDescriptor,
} from '../types.js';
import { errorMessage } from '../utils.js';
import { DashboardLogTail, type DashboardLogCursor } from './log-tail.js';

export interface HttpStateProvider {
  health(): ServiceHealth;
  assets(): AssetDefinition[];
  pools(): V3PoolDescriptor[];
  markets(): MarketSnapshot[];
  latestOpportunities(): Opportunity[];
  transferStatuses(): TransferStatus[];
}

interface StaticAsset {
  body: Buffer;
  contentType: string;
  etag: string;
}

const STATIC_FILES: Record<string, { filename: string; contentType: string }> = {
  '/': { filename: 'index.html', contentType: 'text/html; charset=utf-8' },
  '/dashboard.css': { filename: 'dashboard.css', contentType: 'text/css; charset=utf-8' },
  '/dashboard.js': { filename: 'dashboard.js', contentType: 'text/javascript; charset=utf-8' },
  '/favicon.svg': { filename: 'favicon.svg', contentType: 'image/svg+xml' },
};

const SECURITY_HEADERS = {
  'x-content-type-options': 'nosniff',
  'x-frame-options': 'DENY',
  'referrer-policy': 'no-referrer',
  'permissions-policy': 'camera=(), microphone=(), geolocation=()',
};

export class MonitorHttpServer {
  private server: http.Server | null = null;
  private readonly dashboardDirectory = path.resolve('public/dashboard');
  private readonly staticAssets = new Map<string, StaticAsset>();
  private readonly logTail: DashboardLogTail;

  constructor(
    private readonly config: AppConfig,
    private readonly logger: Logger,
    private readonly state: HttpStateProvider,
    private readonly database: MonitorDatabase,
  ) {
    this.logTail = new DashboardLogTail(config.dashboardLogDir);
  }

  async start(): Promise<void> {
    if (this.server) return;
    this.server = http.createServer((request, response) => {
      void this.route(request, response).catch((error) => {
        this.logger.warn({ error: errorMessage(error), path: request.url }, 'Dashboard request failed');
        if (!response.headersSent) json(request, response, 500, { error: 'internal_error' });
        else response.end();
      });
    });
    await new Promise<void>((resolve, reject) => {
      this.server!.once('error', reject);
      this.server!.listen(this.config.httpPort, this.config.httpHost, () => {
        this.server!.off('error', reject);
        resolve();
      });
    });
    this.logger.info(
      { url: `http://${this.config.httpHost}:${this.config.httpPort}` },
      'Monitor dashboard and HTTP status server started',
    );
  }

  async stop(): Promise<void> {
    const server = this.server;
    this.server = null;
    if (!server) return;
    await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
  }

  private async route(request: IncomingMessage, response: ServerResponse): Promise<void> {
    if (request.method !== 'GET' && request.method !== 'HEAD') {
      json(request, response, 405, { error: 'method_not_allowed' });
      return;
    }
    const url = new URL(request.url ?? '/', 'http://localhost');

    if (url.pathname in STATIC_FILES) {
      await this.staticAsset(request, response, url.pathname);
      return;
    }

    if (url.pathname === '/api') {
      json(request, response, 200, {
        service: 'bstock-monitor',
        dashboard: '/',
        endpoints: [
          '/health',
          '/v1/dashboard',
          '/v1/assets',
          '/v1/markets',
          '/v1/opportunities',
          '/v1/logs',
          '/metrics',
        ],
      });
      return;
    }

    if (url.pathname === '/health') {
      const payload = this.healthPayload();
      json(request, response, payload.status === 'ok' ? 200 : 503, payload);
      return;
    }

    if (url.pathname === '/v1/dashboard') {
      const health = this.healthPayload();
      json(request, response, 200, {
        serverTime: Date.now(),
        ...health,
        monitor: {
          notionalUsd: this.config.notionalUsd,
          alertThresholdBps: this.config.alertThresholdBps,
          prequoteThresholdBps: this.config.prequoteThresholdBps,
          maxPriceAgeMs: this.config.maxPriceAgeMs,
          settlementMode: this.config.settlementMode,
          logsEnabled: this.config.dashboardLogsEnabled,
        },
        markets: this.state.markets(),
        latestOpportunities: this.state.latestOpportunities(),
      });
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
        request,
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
      json(request, response, 200, this.state.markets());
      return;
    }

    if (url.pathname === '/v1/opportunities') {
      const limit = Number(url.searchParams.get('limit') ?? '100');
      const source = url.searchParams.get('source') ?? 'latest';
      json(
        request,
        response,
        200,
        source === 'history'
          ? this.database.listRecentOpportunities(Number.isFinite(limit) ? limit : 100)
          : this.state.latestOpportunities(),
      );
      return;
    }

    if (url.pathname === '/v1/logs') {
      if (!this.config.dashboardLogsEnabled) {
        json(request, response, 404, { error: 'logs_disabled' });
        return;
      }
      const cursor: Partial<DashboardLogCursor> = {};
      const stdout = parseNonNegativeInteger(url.searchParams.get('stdout'));
      const stderr = parseNonNegativeInteger(url.searchParams.get('stderr'));
      if (stdout !== null) cursor.stdout = stdout;
      if (stderr !== null) cursor.stderr = stderr;
      const limit = Number(url.searchParams.get('limit') ?? '120');
      json(request, response, 200, await this.logTail.read(cursor, limit));
      return;
    }

    if (url.pathname === '/metrics') {
      this.metrics(request, response);
      return;
    }

    json(request, response, 404, { error: 'not_found' });
  }

  private healthPayload() {
    const health = this.state.health();
    const dexFresh =
      health.dexLastPollAt !== null && Date.now() - health.dexLastPollAt <= this.config.maxPriceAgeMs * 2;
    const healthy =
      health.cexConnected && dexFresh && health.assets > 0 && health.pools > 0 && health.activeMarkets > 0;
    return {
      status: healthy ? ('ok' as const) : ('degraded' as const),
      ...health,
      database: this.database.stats(),
    };
  }

  private async staticAsset(
    request: IncomingMessage,
    response: ServerResponse,
    pathname: string,
  ): Promise<void> {
    const descriptor = STATIC_FILES[pathname];
    if (!descriptor) {
      json(request, response, 404, { error: 'not_found' });
      return;
    }
    let asset = this.staticAssets.get(pathname);
    if (!asset) {
      const body = await readFile(path.join(this.dashboardDirectory, descriptor.filename));
      asset = {
        body,
        contentType: descriptor.contentType,
        etag: `W/"${createHash('sha256').update(body).digest('base64url').slice(0, 16)}"`,
      };
      this.staticAssets.set(pathname, asset);
    }
    if (request.headers['if-none-match'] === asset.etag) {
      response.writeHead(304, {
        ...SECURITY_HEADERS,
        etag: asset.etag,
        'cache-control': staticCacheControl(pathname),
      });
      response.end();
      return;
    }
    sendBody(request, response, 200, asset.body, asset.contentType, {
      etag: asset.etag,
      'cache-control': staticCacheControl(pathname),
      'content-security-policy':
        "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'",
    });
  }

  private metrics(request: IncomingMessage, response: ServerResponse): void {
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
    sendBody(
      request,
      response,
      200,
      Buffer.from(lines.join('\n')),
      'text/plain; version=0.0.4; charset=utf-8',
      { 'cache-control': 'no-store' },
    );
  }
}

function json(request: IncomingMessage, response: ServerResponse, status: number, payload: unknown): void {
  sendBody(request, response, status, Buffer.from(JSON.stringify(payload)), 'application/json; charset=utf-8', {
    'cache-control': 'no-store',
  });
}

function sendBody(
  request: IncomingMessage,
  response: ServerResponse,
  status: number,
  body: Buffer,
  contentType: string,
  headers: Record<string, string>,
): void {
  const shouldCompress = body.byteLength >= 1024 && request.headers['accept-encoding']?.includes('gzip');
  const encoded = shouldCompress ? gzipSync(body, { level: 4 }) : body;
  response.writeHead(status, {
    ...SECURITY_HEADERS,
    ...headers,
    'content-type': contentType,
    'content-length': encoded.byteLength,
    ...(shouldCompress ? { 'content-encoding': 'gzip', vary: 'accept-encoding' } : {}),
  });
  if (request.method === 'HEAD') response.end();
  else response.end(encoded);
}

function parseNonNegativeInteger(value: string | null): number | null {
  if (value === null || !/^\d+$/.test(value)) return null;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) ? parsed : null;
}

function staticCacheControl(pathname: string): string {
  return pathname === '/'
    ? 'public, max-age=0, must-revalidate'
    : 'public, max-age=86400, immutable';
}
