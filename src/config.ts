import 'dotenv/config';

import path from 'node:path';
import { z } from 'zod';

const optionalString = z.preprocess(
  (value) => (typeof value === 'string' && value.trim() === '' ? undefined : value),
  z.string().optional(),
);

const positiveInt = (defaultValue: number) => z.coerce.number().int().positive().default(defaultValue);
const nonNegativeNumber = (defaultValue: number) => z.coerce.number().min(0).default(defaultValue);
const booleanString = (defaultValue: boolean) =>
  z
    .enum(['true', 'false'])
    .default(defaultValue ? 'true' : 'false')
    .transform((value) => value === 'true');

const schema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).default('info'),
  HTTP_HOST: z.string().default('127.0.0.1'),
  HTTP_PORT: positiveInt(8787),

  BSTOCK_ASSET_URL: z
    .url()
    .default('https://www.binance.com/bapi/asset/v2/public/asset/asset/get-tokenised-asset'),
  BINANCE_REST_URL: z.url().default('https://api.binance.com'),
  BINANCE_WS_URL: z.url().default('wss://stream.binance.com:9443'),
  BINANCE_QUOTE_ASSET: z.string().min(2).default('USDT'),
  BINANCE_API_KEY: optionalString,
  BINANCE_API_SECRET: optionalString,

  BSC_RPC_URL: z.url().default('https://bsc-dataseed.binance.org'),
  BSC_WSS_URL: optionalString.pipe(z.url().optional()),
  PANCAKE_V3_FACTORY: z
    .string()
    .regex(/^0x[a-fA-F0-9]{40}$/)
    .default('0x0BFbCF9fa4f9C56B0F40a671Ad40E0805A091865'),
  PANCAKE_V3_QUOTER: z
    .string()
    .regex(/^0x[a-fA-F0-9]{40}$/)
    .default('0xB048Bbc1Ee6b733FFfCFb9e9CeF7375518e25997'),
  BSC_USDT_ADDRESS: z
    .string()
    .regex(/^0x[a-fA-F0-9]{40}$/)
    .default('0x55d398326f99059fF775485246999027B3197955'),
  MULTICALL3_ADDRESS: z
    .string()
    .regex(/^0x[a-fA-F0-9]{40}$/)
    .default('0xcA11bde05977b3631167028862bE2a173976CA11'),
  PANCAKE_V3_FEES: z.string().default('100,500,2500,10000'),

  NOTIONAL_USD: z.coerce.number().positive().default(1000),
  ALERT_THRESHOLD_BPS: nonNegativeNumber(30),
  PREQUOTE_THRESHOLD_BPS: nonNegativeNumber(10),
  MIN_PROFIT_USD: nonNegativeNumber(1),
  CEX_TAKER_FEE_BPS: z.coerce.number().min(0).max(9999).default(10),
  CEX_BUY_FEE_ASSET: z.enum(['base', 'quote']).default('base'),
  EXECUTION_BUFFER_BPS: z.coerce.number().min(0).max(9999).default(5),
  ESTIMATED_GAS_COST_USD: nonNegativeNumber(0.2),
  REBALANCE_COST_USD: nonNegativeNumber(0),
  SETTLEMENT_MODE: z.enum(['prepositioned', 'transfer']).default('prepositioned'),

  DEX_POLL_INTERVAL_MS: positiveInt(1000),
  DETECTION_INTERVAL_MS: positiveInt(250),
  EXACT_QUOTE_MIN_INTERVAL_MS: positiveInt(1000),
  EXACT_QUOTE_TIMEOUT_MS: positiveInt(3000),
  MAX_LEG_DRIFT_BPS: z.coerce.number().min(0).max(10_000).default(5),
  MAX_PRICE_AGE_MS: positiveInt(5000),
  SNAPSHOT_INTERVAL_MS: positiveInt(30_000),
  ASSET_REFRESH_MS: positiveInt(3_600_000),
  POOL_REFRESH_MS: positiveInt(900_000),
  TRANSFER_STATUS_REFRESH_MS: positiveInt(60_000),
  MULTIPLIER_REFRESH_MS: positiveInt(60_000),
  ALERT_COOLDOWN_MS: positiveInt(30_000),
  MIN_RELATIVE_POOL_LIQUIDITY_BPS: z.coerce.number().int().min(0).max(10_000).default(100),

  SQLITE_PATH: z.string().default('./data/bstock-monitor.db'),
  RETENTION_DAYS: positiveInt(14),
  WEBHOOK_URL: optionalString.pipe(z.url().optional()),
  FEISHU_WEBHOOK_URL: optionalString.pipe(z.url().optional()),
  FEISHU_WEBHOOK_SECRET: optionalString,
  FEISHU_MESSAGE_TITLE: z.string().min(1).max(100).default('bStock 套利告警'),
  FEISHU_AT_ALL: booleanString(false),
});

const parsed = schema.parse(process.env);
const pancakeFees = parsed.PANCAKE_V3_FEES.split(',').map((fee) => Number.parseInt(fee.trim(), 10));

if (pancakeFees.length === 0 || pancakeFees.some((fee) => !Number.isInteger(fee) || fee <= 0)) {
  throw new Error('PANCAKE_V3_FEES must be a comma-separated list of positive integers');
}

if ((parsed.BINANCE_API_KEY && !parsed.BINANCE_API_SECRET) || (!parsed.BINANCE_API_KEY && parsed.BINANCE_API_SECRET)) {
  throw new Error('BINANCE_API_KEY and BINANCE_API_SECRET must be configured together');
}

if (parsed.PREQUOTE_THRESHOLD_BPS > parsed.ALERT_THRESHOLD_BPS) {
  throw new Error('PREQUOTE_THRESHOLD_BPS must not exceed ALERT_THRESHOLD_BPS');
}

if (parsed.FEISHU_WEBHOOK_SECRET && !parsed.FEISHU_WEBHOOK_URL) {
  throw new Error('FEISHU_WEBHOOK_URL is required when FEISHU_WEBHOOK_SECRET is configured');
}

export interface AppConfig {
  nodeEnv: 'development' | 'test' | 'production';
  logLevel: string;
  httpHost: string;
  httpPort: number;
  bstockAssetUrl: string;
  binanceRestUrl: string;
  binanceWsUrl: string;
  binanceQuoteAsset: string;
  binanceApiKey?: string;
  binanceApiSecret?: string;
  bscRpcUrl: string;
  bscWssUrl?: string;
  pancakeV3Factory: string;
  pancakeV3Quoter: string;
  quoteTokenAddress: string;
  multicall3Address: string;
  pancakeV3Fees: number[];
  notionalUsd: number;
  alertThresholdBps: number;
  prequoteThresholdBps: number;
  minProfitUsd: number;
  cexTakerFeeBps: number;
  cexBuyFeeAsset: 'base' | 'quote';
  executionBufferBps: number;
  estimatedGasCostUsd: number;
  rebalanceCostUsd: number;
  settlementMode: 'prepositioned' | 'transfer';
  dexPollIntervalMs: number;
  detectionIntervalMs: number;
  exactQuoteMinIntervalMs: number;
  exactQuoteTimeoutMs: number;
  maxLegDriftBps: number;
  maxPriceAgeMs: number;
  snapshotIntervalMs: number;
  assetRefreshMs: number;
  poolRefreshMs: number;
  transferStatusRefreshMs: number;
  multiplierRefreshMs: number;
  alertCooldownMs: number;
  minRelativePoolLiquidityBps: number;
  sqlitePath: string;
  retentionDays: number;
  webhookUrl?: string;
  feishuWebhookUrl?: string;
  feishuWebhookSecret?: string;
  feishuMessageTitle: string;
  feishuAtAll: boolean;
}

export const config: AppConfig = {
  nodeEnv: parsed.NODE_ENV,
  logLevel: parsed.LOG_LEVEL,
  httpHost: parsed.HTTP_HOST,
  httpPort: parsed.HTTP_PORT,
  bstockAssetUrl: parsed.BSTOCK_ASSET_URL,
  binanceRestUrl: parsed.BINANCE_REST_URL.replace(/\/$/, ''),
  binanceWsUrl: parsed.BINANCE_WS_URL.replace(/\/$/, ''),
  binanceQuoteAsset: parsed.BINANCE_QUOTE_ASSET.toUpperCase(),
  ...(parsed.BINANCE_API_KEY ? { binanceApiKey: parsed.BINANCE_API_KEY } : {}),
  ...(parsed.BINANCE_API_SECRET ? { binanceApiSecret: parsed.BINANCE_API_SECRET } : {}),
  bscRpcUrl: parsed.BSC_RPC_URL,
  ...(parsed.BSC_WSS_URL ? { bscWssUrl: parsed.BSC_WSS_URL } : {}),
  pancakeV3Factory: parsed.PANCAKE_V3_FACTORY,
  pancakeV3Quoter: parsed.PANCAKE_V3_QUOTER,
  quoteTokenAddress: parsed.BSC_USDT_ADDRESS,
  multicall3Address: parsed.MULTICALL3_ADDRESS,
  pancakeV3Fees: pancakeFees,
  notionalUsd: parsed.NOTIONAL_USD,
  alertThresholdBps: parsed.ALERT_THRESHOLD_BPS,
  prequoteThresholdBps: parsed.PREQUOTE_THRESHOLD_BPS,
  minProfitUsd: parsed.MIN_PROFIT_USD,
  cexTakerFeeBps: parsed.CEX_TAKER_FEE_BPS,
  cexBuyFeeAsset: parsed.CEX_BUY_FEE_ASSET,
  executionBufferBps: parsed.EXECUTION_BUFFER_BPS,
  estimatedGasCostUsd: parsed.ESTIMATED_GAS_COST_USD,
  rebalanceCostUsd: parsed.REBALANCE_COST_USD,
  settlementMode: parsed.SETTLEMENT_MODE,
  dexPollIntervalMs: parsed.DEX_POLL_INTERVAL_MS,
  detectionIntervalMs: parsed.DETECTION_INTERVAL_MS,
  exactQuoteMinIntervalMs: parsed.EXACT_QUOTE_MIN_INTERVAL_MS,
  exactQuoteTimeoutMs: parsed.EXACT_QUOTE_TIMEOUT_MS,
  maxLegDriftBps: parsed.MAX_LEG_DRIFT_BPS,
  maxPriceAgeMs: parsed.MAX_PRICE_AGE_MS,
  snapshotIntervalMs: parsed.SNAPSHOT_INTERVAL_MS,
  assetRefreshMs: parsed.ASSET_REFRESH_MS,
  poolRefreshMs: parsed.POOL_REFRESH_MS,
  transferStatusRefreshMs: parsed.TRANSFER_STATUS_REFRESH_MS,
  multiplierRefreshMs: parsed.MULTIPLIER_REFRESH_MS,
  alertCooldownMs: parsed.ALERT_COOLDOWN_MS,
  minRelativePoolLiquidityBps: parsed.MIN_RELATIVE_POOL_LIQUIDITY_BPS,
  sqlitePath: path.resolve(parsed.SQLITE_PATH),
  retentionDays: parsed.RETENTION_DAYS,
  ...(parsed.WEBHOOK_URL ? { webhookUrl: parsed.WEBHOOK_URL } : {}),
  ...(parsed.FEISHU_WEBHOOK_URL ? { feishuWebhookUrl: parsed.FEISHU_WEBHOOK_URL } : {}),
  ...(parsed.FEISHU_WEBHOOK_SECRET ? { feishuWebhookSecret: parsed.FEISHU_WEBHOOK_SECRET } : {}),
  feishuMessageTitle: parsed.FEISHU_MESSAGE_TITLE,
  feishuAtAll: parsed.FEISHU_AT_ALL,
};
