import { BinanceAssetCatalog } from '../binance/asset-catalog.js';
import { config } from '../config.js';
import { createLogger } from '../logger.js';
import { PancakeV3Monitor } from '../pancake/v3-monitor.js';

const logger = createLogger({ ...config, logLevel: 'warn' });
const catalog = new BinanceAssetCatalog(config, logger);
const dex = new PancakeV3Monitor(config, logger);

try {
  const assets = await catalog.load();
  const requestedCode = (process.env.CHECK_ASSET ?? 'TSLAB').toUpperCase();
  const asset = assets.find((entry) => entry.assetCode === requestedCode);
  if (!asset) throw new Error(`Unknown active bStock: ${requestedCode}`);

  await dex.configure([asset]);
  await dex.pollOnce();
  const market = dex.getBestMarginal(asset.assetCode);
  const [buy, sell] = await Promise.all([
    dex.quoteBuy(asset.assetCode, config.notionalUsd),
    dex.quoteSell(asset.assetCode, config.notionalUsd / (market?.bestSell.quotePerTokenMid ?? 1)),
  ]);

  process.stdout.write(
    `${JSON.stringify(
      {
        asset,
        pools: dex.listPools().map((pool) => ({ ...pool, liquidity: pool.liquidity.toString() })),
        marginal: market
          ? {
              buy: market.bestBuy.quotePerTokenBuyMarginal,
              sell: market.bestSell.quotePerTokenSellMarginal,
              blockNumber: market.bestBuy.blockNumber,
            }
          : null,
        exactQuote: { buy, sell: sell ? { ...sell, gasEstimate: sell.gasEstimate.toString() } : null },
      },
      (_key, value) => (typeof value === 'bigint' ? value.toString() : value),
      2,
    )}\n`,
  );
} finally {
  await dex.stop();
}
