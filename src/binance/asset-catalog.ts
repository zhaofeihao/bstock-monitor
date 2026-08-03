import type { AppConfig } from '../config.js';
import type { Logger } from '../logger.js';
import type { AssetDefinition } from '../types.js';
import { asFiniteNumber, fetchJson } from '../utils.js';
import { z } from 'zod';

const tokenisedAssetSchema = z.object({
  code: z.string(),
  message: z.string().nullable().optional(),
  data: z.array(
    z.object({
      assetCode: z.string().min(1),
      assetName: z.string().min(1),
      ml: z.string().min(1),
      uq: z.string().min(1),
      mv: z.boolean(),
      caList: z.array(
        z.object({
          network: z.string().min(1),
          ca: z.string().regex(/^0x[a-fA-F0-9]{40}$/),
        }),
      ),
    }),
  ),
});

const exchangeInfoSchema = z.object({
  symbols: z.array(
    z.object({
      symbol: z.string(),
      status: z.string(),
      baseAsset: z.string(),
      quoteAsset: z.string(),
      baseAssetPrecision: z.number().int(),
      quoteAssetPrecision: z.number().int(),
      isSpotTradingAllowed: z.boolean().optional(),
      filters: z.array(
        z
          .object({
            filterType: z.string(),
            stepSize: z.string().optional(),
            minNotional: z.string().optional(),
          })
          .loose(),
      ),
    }),
  ),
});

export class BinanceAssetCatalog {
  constructor(
    private readonly config: AppConfig,
    private readonly logger: Logger,
  ) {}

  async load(): Promise<AssetDefinition[]> {
    const [tokenisedRaw, exchangeInfoRaw] = await Promise.all([
      fetchJson<unknown>(this.config.bstockAssetUrl),
      fetchJson<unknown>(`${this.config.binanceRestUrl}/api/v3/exchangeInfo`, undefined, 20_000),
    ]);
    const tokenised = tokenisedAssetSchema.parse(tokenisedRaw);
    const exchangeInfo = exchangeInfoSchema.parse(exchangeInfoRaw);

    if (tokenised.code !== '000000' || !Array.isArray(tokenised.data)) {
      throw new Error(`Unexpected bStocks asset response: code=${tokenised.code}`);
    }

    const activeSymbols = new Map(
      exchangeInfo.symbols
        .filter(
          (symbol) =>
            symbol.status === 'TRADING' &&
            symbol.isSpotTradingAllowed !== false &&
            symbol.quoteAsset.toUpperCase() === this.config.binanceQuoteAsset,
        )
        .map((symbol) => [symbol.baseAsset.toUpperCase(), symbol]),
    );

    const assets: AssetDefinition[] = [];
    for (const item of tokenised.data) {
      const chain = item.caList.find((entry) => entry.network.toUpperCase() === 'BSC');
      const market = activeSymbols.get(item.assetCode.toUpperCase());

      if (!chain) {
        this.logger.warn({ assetCode: item.assetCode }, 'Skipping bStock without a BSC contract address');
        continue;
      }
      if (!market) {
        this.logger.info(
          { assetCode: item.assetCode, quoteAsset: this.config.binanceQuoteAsset },
          'Skipping bStock without an active matching Binance Spot pair',
        );
        continue;
      }

      const lotSize = market.filters.find((filter) => filter.filterType === 'LOT_SIZE');
      const notional = market.filters.find(
        (filter) => filter.filterType === 'NOTIONAL' || filter.filterType === 'MIN_NOTIONAL',
      );

      const stepSize = lotSize?.stepSize ? Number(lotSize.stepSize) : undefined;
      const minNotional = notional?.minNotional ? Number(notional.minNotional) : undefined;

      assets.push({
        underlyingTicker: item.uq,
        assetCode: item.assetCode,
        assetName: item.assetName,
        address: chain.ca,
        network: chain.network,
        apiMultiplier: asFiniteNumber(item.ml, `${item.assetCode}.ml`),
        cexSymbol: market.symbol,
        quoteAsset: market.quoteAsset,
        baseAssetPrecision: market.baseAssetPrecision,
        quoteAssetPrecision: market.quoteAssetPrecision,
        ...(typeof stepSize === 'number' && Number.isFinite(stepSize) ? { stepSize } : {}),
        ...(typeof minNotional === 'number' && Number.isFinite(minNotional) ? { minNotional } : {}),
      });
    }

    assets.sort((left, right) => left.assetCode.localeCompare(right.assetCode));
    this.logger.info(
      { listedByBstocks: tokenised.data.length, activeWithSpotPair: assets.length },
      'Loaded Binance bStock asset catalog',
    );
    return assets;
  }
}
