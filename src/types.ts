export interface AssetDefinition {
  underlyingTicker: string;
  assetCode: string;
  assetName: string;
  address: string;
  network: string;
  apiMultiplier: number;
  cexSymbol: string;
  quoteAsset: string;
  baseAssetPrecision: number;
  quoteAssetPrecision: number;
  stepSize?: number;
  minNotional?: number;
}

export interface PriceLevel {
  price: number;
  quantity: number;
}

export interface CexOrderBook {
  symbol: string;
  bids: PriceLevel[];
  asks: PriceLevel[];
  lastUpdateId: number;
  updatedAt: number;
}

export interface CexTopOfBook {
  symbol: string;
  bidPrice: number;
  bidQuantity: number;
  askPrice: number;
  askQuantity: number;
  lastUpdateId: number;
  updatedAt: number;
}

export interface TransferStatus {
  assetCode: string;
  network: string;
  depositEnabled: boolean;
  withdrawEnabled: boolean;
  withdrawFeeUi: number;
  minConfirmations?: number;
  updatedAt: number;
}

export interface V3PoolDescriptor {
  assetCode: string;
  address: string;
  token0: string;
  token1: string;
  fee: number;
  baseIsToken0: boolean;
  baseDecimals: number;
  quoteDecimals: number;
  liquidity: bigint;
}

export interface V3PoolState {
  pool: V3PoolDescriptor;
  sqrtPriceX96: bigint;
  tick: number;
  liquidity: bigint;
  multiplier: number;
  quotePerTokenMid: number;
  quotePerTokenBuyMarginal: number;
  quotePerTokenSellMarginal: number;
  blockNumber: number;
  updatedAt: number;
}

export interface DexExactQuote {
  assetCode: string;
  side: 'BUY_BSTOCK' | 'SELL_BSTOCK';
  poolAddress: string;
  poolFee: number;
  amountIn: number;
  amountOut: number;
  effectivePrice: number;
  gasEstimate: bigint;
  multiplier: number;
  quotedAt: number;
}

export type OpportunityDirection = 'CEX_BUY_DEX_SELL' | 'DEX_BUY_CEX_SELL';

export interface Opportunity {
  detectedAt: number;
  assetCode: string;
  underlyingTicker: string;
  direction: OpportunityDirection;
  cexSymbol: string;
  poolAddress: string;
  poolFee: number;
  notionalUsd: number;
  baseAmount: number;
  cexEffectivePrice: number;
  dexEffectivePrice: number;
  grossProfitUsd: number;
  estimatedCostsUsd: number;
  netProfitUsd: number;
  netBps: number;
  quoteLatencyMs: number;
  actionable: boolean;
  transferReady: boolean | null;
  settlementMode: 'prepositioned' | 'transfer';
  reason?: string;
}

export interface MarketSnapshot {
  timestamp: number;
  assetCode: string;
  cexSymbol: string;
  cexBid: number;
  cexAsk: number;
  dexMid: number;
  dexBuyMarginal: number;
  dexSellMarginal: number;
  multiplier: number;
  poolAddress: string;
  cexAgeMs: number;
  dexAgeMs: number;
}

export interface ServiceHealth {
  startedAt: number;
  assets: number;
  pools: number;
  activeMarkets: number;
  cexConnected: boolean;
  cexLastMessageAt: number | null;
  dexLastPollAt: number | null;
  dexLastBlock: number | null;
  exactQuotesInFlight: number;
  lastAssetRefreshAt: number | null;
}
