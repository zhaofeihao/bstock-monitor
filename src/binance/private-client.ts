import { createHmac } from 'node:crypto';

import type { AppConfig } from '../config.js';
import type { Logger } from '../logger.js';
import type { AssetDefinition, TransferStatus } from '../types.js';
import { errorMessage, fetchJson } from '../utils.js';

interface CapitalAsset {
  coin: string;
  networkList: CapitalNetwork[];
}

interface CapitalNetwork {
  network: string;
  name: string;
  depositEnable: boolean;
  withdrawEnable: boolean;
  withdrawFee: string;
  minConfirm?: number;
  busy?: boolean;
  contractAddress?: string;
}

export class BinancePrivateClient {
  private readonly statuses = new Map<string, TransferStatus>();
  private lastRefreshAt: number | null = null;

  constructor(
    private readonly config: AppConfig,
    private readonly logger: Logger,
  ) {}

  get enabled(): boolean {
    return Boolean(this.config.binanceApiKey && this.config.binanceApiSecret);
  }

  getLastRefreshAt(): number | null {
    return this.lastRefreshAt;
  }

  getStatus(assetCode: string): TransferStatus | undefined {
    return this.statuses.get(assetCode);
  }

  listStatuses(): TransferStatus[] {
    return [...this.statuses.values()];
  }

  async refresh(assets: AssetDefinition[]): Promise<void> {
    if (!this.enabled) return;

    const query = new URLSearchParams({ timestamp: String(Date.now()), recvWindow: '10000' });
    const signature = createHmac('sha256', this.config.binanceApiSecret!).update(query.toString()).digest('hex');
    query.set('signature', signature);

    try {
      const response = await fetchJson<CapitalAsset[]>(
        `${this.config.binanceRestUrl}/sapi/v1/capital/config/getall?${query.toString()}`,
        { headers: { 'X-MBX-APIKEY': this.config.binanceApiKey! } },
      );
      const byCoin = new Map(response.map((entry) => [entry.coin.toUpperCase(), entry]));
      const now = Date.now();

      for (const asset of assets) {
        const capital = byCoin.get(asset.assetCode.toUpperCase());
        const network = capital?.networkList.find(
          (entry) => entry.network.toUpperCase() === 'BSC' || entry.name.toUpperCase().includes('BSC'),
        );
        if (!network) continue;
        if (
          network.contractAddress &&
          network.contractAddress.toLowerCase() !== asset.address.toLowerCase()
        ) {
          this.logger.error(
            {
              assetCode: asset.assetCode,
              catalogAddress: asset.address,
              walletAddress: network.contractAddress,
            },
            'Binance wallet contract address does not match the bStock catalog',
          );
          continue;
        }

        this.statuses.set(asset.assetCode, {
          assetCode: asset.assetCode,
          network: network.network,
          depositEnabled: network.depositEnable,
          withdrawEnabled: network.withdrawEnable && network.busy !== true,
          withdrawFeeUi: Number(network.withdrawFee || '0'),
          ...(network.minConfirm !== undefined ? { minConfirmations: network.minConfirm } : {}),
          updatedAt: now,
        });
      }

      this.lastRefreshAt = now;
      this.logger.debug({ statuses: this.statuses.size }, 'Refreshed Binance deposit and withdrawal status');
    } catch (error) {
      this.logger.warn({ error: errorMessage(error) }, 'Unable to refresh Binance transfer status');
    }
  }
}
