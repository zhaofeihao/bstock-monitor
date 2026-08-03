import { Decimal } from 'decimal.js';
import {
  Contract,
  FetchRequest,
  Interface,
  JsonRpcProvider,
  WebSocketProvider,
  ZeroAddress,
  formatUnits,
  getAddress,
  parseUnits,
} from 'ethers';

import type { AppConfig } from '../config.js';
import type { Logger } from '../logger.js';
import type { AssetDefinition, DexExactQuote, V3PoolDescriptor, V3PoolState } from '../types.js';
import { errorMessage } from '../utils.js';
import { MulticallReader } from './multicall-reader.js';
import { feeFraction, sqrtPriceX96ToQuotePerBase } from './v3-math.js';

const FACTORY_ABI = [
  'function getPool(address tokenA, address tokenB, uint24 fee) external view returns (address pool)',
];
const POOL_ABI = [
  'function token0() external view returns (address)',
  'function token1() external view returns (address)',
  'function fee() external view returns (uint24)',
  'function liquidity() external view returns (uint128)',
  'function slot0() external view returns (uint160 sqrtPriceX96, int24 tick, uint16 observationIndex, uint16 observationCardinality, uint16 observationCardinalityNext, uint32 feeProtocol, bool unlocked)',
  'event Swap(address indexed sender,address indexed recipient,int256 amount0,int256 amount1,uint160 sqrtPriceX96,uint128 liquidity,int24 tick,uint128 protocolFeesToken0,uint128 protocolFeesToken1)',
];
const TOKEN_ABI = [
  'function decimals() external view returns (uint8)',
  'function uiMultiplier() external view returns (uint256)',
];
const QUOTER_ABI = [
  'function quoteExactInputSingle((address tokenIn,address tokenOut,uint256 amountIn,uint24 fee,uint160 sqrtPriceLimitX96) params) external returns (uint256 amountOut,uint160 sqrtPriceX96After,uint32 initializedTicksCrossed,uint256 gasEstimate)',
];

interface MarginalDexMarket {
  bestBuy: V3PoolState;
  bestSell: V3PoolState;
}

interface RawQuoteResult {
  pool: V3PoolDescriptor;
  amountOut: bigint;
  gasEstimate: bigint;
}

type PoolStateSource = 'poll' | 'event';

interface PoolStateOrder {
  blockNumber: number;
  source: PoolStateSource;
  logIndex: number;
}

function toRawAmount(value: number, decimals: number): bigint {
  const fixed = new Decimal(value).toDecimalPlaces(decimals, Decimal.ROUND_DOWN).toFixed(decimals);
  return parseUnits(fixed, decimals);
}

function withTimeout<T>(promise: Promise<T>, timeoutMs: number, label: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${label} timed out after ${timeoutMs}ms`)), timeoutMs);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error: unknown) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

export class PancakeV3Monitor {
  private readonly provider: JsonRpcProvider;
  private readonly eventProvider: WebSocketProvider | undefined;
  private readonly factory: Contract;
  private readonly quoter: Contract;
  private readonly multicall: MulticallReader;
  private readonly factoryInterface = new Interface(FACTORY_ABI);
  private readonly poolInterface = new Interface(POOL_ABI);
  private readonly tokenInterface = new Interface(TOKEN_ABI);
  private assets = new Map<string, AssetDefinition>();
  private poolsByAsset = new Map<string, V3PoolDescriptor[]>();
  private statesByPool = new Map<string, V3PoolState>();
  private stateOrderByPool = new Map<string, PoolStateOrder>();
  private multipliers = new Map<string, number>();
  private eventContracts: Contract[] = [];
  private configurePromise: Promise<void> | null = null;
  private pollPromise: Promise<void> | null = null;
  private multiplierRefreshPromise: Promise<void> | null = null;
  private stopPromise: Promise<void> | null = null;
  private pollTimer: NodeJS.Timeout | null = null;
  private multiplierTimer: NodeJS.Timeout | null = null;
  private polling = false;
  private stopping = false;
  private registryGeneration = 0;
  private lastPollAt: number | null = null;
  private lastBlock: number | null = null;
  private lastPollErrorLogAt = 0;
  private readonly quoteTimeoutMs: number;

  constructor(
    private readonly config: AppConfig,
    private readonly logger: Logger,
  ) {
    this.quoteTimeoutMs = Math.max(250, config.exactQuoteTimeoutMs);
    const rpcRequest = new FetchRequest(config.bscRpcUrl);
    rpcRequest.timeout = this.quoteTimeoutMs;
    this.provider = new JsonRpcProvider(rpcRequest, 56, {
      staticNetwork: true,
      batchMaxCount: 10,
      batchStallTime: 10,
      batchMaxSize: 1_000_000,
    });
    this.provider.pollingInterval = config.dexPollIntervalMs;
    this.eventProvider = config.bscWssUrl ? new WebSocketProvider(config.bscWssUrl, 56) : undefined;
    this.factory = new Contract(config.pancakeV3Factory, FACTORY_ABI, this.provider);
    this.quoter = new Contract(config.pancakeV3Quoter, QUOTER_ABI, this.provider);
    this.multicall = new MulticallReader(config.multicall3Address, this.provider, logger);
  }

  getLastPollAt(): number | null {
    return this.lastPollAt;
  }

  getLastBlock(): number | null {
    return this.lastBlock;
  }

  getPoolCount(): number {
    return [...this.poolsByAsset.values()].reduce((sum, pools) => sum + pools.length, 0);
  }

  listPools(): V3PoolDescriptor[] {
    return [...this.poolsByAsset.values()].flat();
  }

  listStates(): V3PoolState[] {
    return [...this.statesByPool.values()];
  }

  getStates(assetCode: string): V3PoolState[] {
    return (this.poolsByAsset.get(assetCode) ?? [])
      .map((pool) => this.statesByPool.get(pool.address.toLowerCase()))
      .filter((state): state is V3PoolState => Boolean(state));
  }

  getMultiplier(assetCode: string): number | undefined {
    return this.multipliers.get(assetCode);
  }

  getBestMarginal(assetCode: string): MarginalDexMarket | undefined {
    const states = this.getStates(assetCode).filter((state) => state.liquidity > 0n);
    if (states.length === 0) return undefined;
    const maxLiquidity = states.reduce(
      (maximum, state) => (state.liquidity > maximum ? state.liquidity : maximum),
      0n,
    );
    const eligible = states.filter(
      (state) =>
        state.liquidity * 10_000n >= maxLiquidity * BigInt(this.config.minRelativePoolLiquidityBps),
    );
    const bestBuy = eligible.reduce((best, state) =>
      state.quotePerTokenBuyMarginal < best.quotePerTokenBuyMarginal ? state : best,
    );
    const bestSell = eligible.reduce((best, state) =>
      state.quotePerTokenSellMarginal > best.quotePerTokenSellMarginal ? state : best,
    );
    return { bestBuy, bestSell };
  }

  async configure(assets: AssetDefinition[]): Promise<void> {
    while (this.configurePromise) await this.configurePromise;
    if (this.stopping) return;
    const promise = this.discoverPools(assets);
    this.configurePromise = promise;
    try {
      await promise;
    } finally {
      if (this.configurePromise === promise) this.configurePromise = null;
    }
  }

  start(): void {
    if (this.pollTimer || this.stopping) return;
    void this.pollOnce();
    this.pollTimer = setInterval(() => void this.pollOnce(), this.config.dexPollIntervalMs);
    this.multiplierTimer = setInterval(() => this.triggerMultiplierRefresh(), this.config.multiplierRefreshMs);
  }

  async stop(): Promise<void> {
    if (this.stopPromise) return this.stopPromise;
    this.stopping = true;
    if (this.pollTimer) clearInterval(this.pollTimer);
    if (this.multiplierTimer) clearInterval(this.multiplierTimer);
    this.pollTimer = null;
    this.multiplierTimer = null;
    this.stopPromise = this.finishStop();
    return this.stopPromise;
  }

  async pollOnce(): Promise<void> {
    if (this.polling || this.configurePromise || this.stopping) return;
    const pools = this.listPools();
    if (pools.length === 0) return;
    this.polling = true;
    const generation = this.registryGeneration;

    const promise = (async () => {
      try {
        const blockNumber = await this.provider.getBlockNumber();
        const calls = pools.flatMap((pool) => [
          { target: pool.address, callData: this.poolInterface.encodeFunctionData('slot0') },
          { target: pool.address, callData: this.poolInterface.encodeFunctionData('liquidity') },
        ]);
        const responses = await this.multicall.read(calls, blockNumber);
        if (generation !== this.registryGeneration || this.stopping) return;
        let failures = 0;
        for (let index = 0; index < pools.length; index += 1) {
          const pool = pools[index]!;
          const slot0Data = responses[index * 2];
          const liquidityData = responses[index * 2 + 1];
          if (!slot0Data || !liquidityData) {
            failures += 1;
            continue;
          }
          try {
            const slot0 = this.poolInterface.decodeFunctionResult('slot0', slot0Data);
            const decodedLiquidity = this.poolInterface.decodeFunctionResult('liquidity', liquidityData);
            const sqrtPriceX96 = BigInt(slot0.sqrtPriceX96 ?? slot0[0]);
            const tick = Number(slot0.tick ?? slot0[1]);
            const currentLiquidity = BigInt(decodedLiquidity[0]);
            const state = this.buildState(
              pool,
              sqrtPriceX96,
              tick,
              currentLiquidity,
              blockNumber,
              Date.now(),
            );
            this.storeState(state, 'poll');
          } catch {
            failures += 1;
          }
        }
        this.lastPollAt = Date.now();
        this.lastBlock = Math.max(this.lastBlock ?? 0, blockNumber);
        if (failures > 0 && Date.now() - this.lastPollErrorLogAt > 30_000) {
          this.lastPollErrorLogAt = Date.now();
          this.logger.warn({ failures, pools: pools.length }, 'Some PancakeSwap pool state calls failed');
        }
      } catch (error) {
        if (Date.now() - this.lastPollErrorLogAt > 30_000) {
          this.lastPollErrorLogAt = Date.now();
          this.logger.warn({ error: errorMessage(error) }, 'PancakeSwap state poll failed');
        }
      }
    })();
    this.pollPromise = promise;
    try {
      await promise;
    } finally {
      if (this.pollPromise === promise) this.pollPromise = null;
      this.polling = false;
    }
  }

  async quoteBuy(assetCode: string, quoteAmount: number): Promise<DexExactQuote | undefined> {
    const asset = this.assets.get(assetCode);
    const pools = this.poolsByAsset.get(assetCode) ?? [];
    if (!asset || pools.length === 0 || !(quoteAmount > 0)) return undefined;

    const amountIn = toRawAmount(quoteAmount, pools[0]!.quoteDecimals);
    const quotes = await this.quoteAcrossPools(pools, this.config.quoteTokenAddress, asset.address, amountIn);
    const best = quotes.reduce<RawQuoteResult | undefined>(
      (current, quote) => (!current || quote.amountOut > current.amountOut ? quote : current),
      undefined,
    );
    if (!best) return undefined;

    const baseOut = Number(formatUnits(best.amountOut, best.pool.baseDecimals));
    return {
      assetCode,
      side: 'BUY_BSTOCK',
      poolAddress: best.pool.address,
      poolFee: best.pool.fee,
      amountIn: quoteAmount,
      amountOut: baseOut,
      effectivePrice: baseOut > 0 ? quoteAmount / baseOut : Number.POSITIVE_INFINITY,
      gasEstimate: best.gasEstimate,
      multiplier: this.multipliers.get(assetCode) ?? asset.apiMultiplier,
      quotedAt: Date.now(),
    };
  }

  async quoteSell(assetCode: string, baseAmount: number): Promise<DexExactQuote | undefined> {
    const asset = this.assets.get(assetCode);
    const pools = this.poolsByAsset.get(assetCode) ?? [];
    if (!asset || pools.length === 0 || !(baseAmount > 0)) return undefined;

    const amountIn = toRawAmount(baseAmount, pools[0]!.baseDecimals);
    const quotes = await this.quoteAcrossPools(pools, asset.address, this.config.quoteTokenAddress, amountIn);
    const best = quotes.reduce<RawQuoteResult | undefined>(
      (current, quote) => (!current || quote.amountOut > current.amountOut ? quote : current),
      undefined,
    );
    if (!best) return undefined;

    const quoteOut = Number(formatUnits(best.amountOut, best.pool.quoteDecimals));
    return {
      assetCode,
      side: 'SELL_BSTOCK',
      poolAddress: best.pool.address,
      poolFee: best.pool.fee,
      amountIn: baseAmount,
      amountOut: quoteOut,
      effectivePrice: baseAmount > 0 ? quoteOut / baseAmount : 0,
      gasEstimate: best.gasEstimate,
      multiplier: this.multipliers.get(assetCode) ?? asset.apiMultiplier,
      quotedAt: Date.now(),
    };
  }

  private async discoverPools(assets: AssetDefinition[]): Promise<void> {
    const stagedAssets = new Map<string, AssetDefinition>();
    const stagedMultipliers = new Map<string, number>();
    for (const asset of assets) {
      stagedAssets.set(asset.assetCode, asset);
      stagedMultipliers.set(asset.assetCode, asset.apiMultiplier);
    }

    const decimalTargets = [
      { assetCode: '__QUOTE__', address: this.config.quoteTokenAddress },
      ...assets.map((asset) => ({ assetCode: asset.assetCode, address: asset.address })),
    ];
    const decimalResponses = await this.multicall.read(
      decimalTargets.map((target) => ({
        target: target.address,
        callData: this.tokenInterface.encodeFunctionData('decimals'),
      })),
    );
    const quoteDecimalData = decimalResponses[0];
    if (!quoteDecimalData) throw new Error('Unable to read quote-token decimals');
    const quoteDecimals = Number(this.tokenInterface.decodeFunctionResult('decimals', quoteDecimalData)[0]);
    const baseDecimalsByAsset = new Map<string, number>();
    for (let index = 1; index < decimalTargets.length; index += 1) {
      const data = decimalResponses[index];
      const target = decimalTargets[index]!;
      if (!data) continue;
      baseDecimalsByAsset.set(
        target.assetCode,
        Number(this.tokenInterface.decodeFunctionResult('decimals', data)[0]),
      );
    }

    const poolQueries = assets.flatMap((asset) =>
      this.config.pancakeV3Fees.map((fee) => ({ asset, fee })),
    );
    const poolLookupResponses = await this.multicall.read(
      poolQueries.map(({ asset, fee }) => ({
        target: this.config.pancakeV3Factory,
        callData: this.factoryInterface.encodeFunctionData('getPool', [
          asset.address,
          this.config.quoteTokenAddress,
          fee,
        ]),
      })),
    );
    const stagedPoolsByAsset = new Map<string, V3PoolDescriptor[]>();
    const validCandidates = poolQueries.flatMap((query, index) => {
      const data = poolLookupResponses[index];
      if (!data) return [];
      const address = String(this.factoryInterface.decodeFunctionResult('getPool', data)[0]);
      return address === ZeroAddress ? [] : [{ ...query, address }];
    });

    const verificationCalls = validCandidates.flatMap(({ address }) =>
      ['token0', 'token1', 'fee', 'liquidity'].map((functionName) => ({
        target: address,
        callData: this.poolInterface.encodeFunctionData(functionName),
      })),
    );
    const verificationResponses = await this.multicall.read(verificationCalls);
    for (let index = 0; index < validCandidates.length; index += 1) {
      const { asset, fee, address } = validCandidates[index]!;
      const [token0Data, token1Data, feeData, liquidityData] = verificationResponses.slice(
        index * 4,
        index * 4 + 4,
      );
      if (!token0Data || !token1Data || !feeData || !liquidityData) continue;
      try {
        const normalizedToken0 = getAddress(
          String(this.poolInterface.decodeFunctionResult('token0', token0Data)[0]),
        );
        const normalizedToken1 = getAddress(
          String(this.poolInterface.decodeFunctionResult('token1', token1Data)[0]),
        );
        const onchainFee = Number(this.poolInterface.decodeFunctionResult('fee', feeData)[0]);
        const liquidity = BigInt(this.poolInterface.decodeFunctionResult('liquidity', liquidityData)[0]);
        const expected = new Set([asset.address.toLowerCase(), this.config.quoteTokenAddress.toLowerCase()]);
        if (!expected.has(normalizedToken0.toLowerCase()) || !expected.has(normalizedToken1.toLowerCase())) {
          throw new Error(`Factory returned an unexpected token pair for ${asset.assetCode}`);
        }
        if (onchainFee !== fee) throw new Error(`Pool fee mismatch for ${address}`);
        const baseDecimals = baseDecimalsByAsset.get(asset.assetCode);
        if (baseDecimals === undefined) {
          throw new Error(`Unable to verify token decimals for ${asset.assetCode}`);
        }

        const descriptor: V3PoolDescriptor = {
          assetCode: asset.assetCode,
          address: getAddress(address),
          token0: normalizedToken0,
          token1: normalizedToken1,
          fee,
          baseIsToken0: normalizedToken0.toLowerCase() === asset.address.toLowerCase(),
          baseDecimals,
          quoteDecimals,
          liquidity,
        };
        const list = stagedPoolsByAsset.get(descriptor.assetCode) ?? [];
        list.push(descriptor);
        stagedPoolsByAsset.set(descriptor.assetCode, list);
      } catch (error) {
        this.logger.warn({ address, error: errorMessage(error) }, 'Rejected an invalid PancakeSwap pool');
      }
    }

    for (const asset of assets) {
      const pools = (stagedPoolsByAsset.get(asset.assetCode) ?? []).sort((left, right) =>
        left.liquidity === right.liquidity ? left.fee - right.fee : left.liquidity > right.liquidity ? -1 : 1,
      );
      stagedPoolsByAsset.set(asset.assetCode, pools);
      if (pools.length === 0) {
        this.logger.debug({ assetCode: asset.assetCode }, 'No direct PancakeSwap V3 bStock/USDT pool found');
      }
    }

    const refreshedMultipliers = await this.readMultipliers(assets, stagedMultipliers);
    const nextGeneration = this.registryGeneration + 1;
    const stagedPools = [...stagedPoolsByAsset.values()].flat();
    const stagedEventContracts = await this.prepareSwapListeners(stagedPools, nextGeneration);
    if (this.stopping) {
      await Promise.allSettled(stagedEventContracts.map((contract) => contract.removeAllListeners()));
      return;
    }

    const descriptorsByAddress = new Map(
      stagedPools.map((pool) => [pool.address.toLowerCase(), pool] as const),
    );
    const stagedStatesByPool = new Map<string, V3PoolState>();
    const stagedStateOrderByPool = new Map<string, PoolStateOrder>();
    for (const [address, state] of this.statesByPool) {
      const descriptor = descriptorsByAddress.get(address);
      if (!descriptor) continue;
      stagedStatesByPool.set(address, {
        ...state,
        pool: { ...descriptor, liquidity: state.liquidity },
        multiplier: refreshedMultipliers.get(descriptor.assetCode) ?? state.multiplier,
      });
      stagedStateOrderByPool.set(
        address,
        this.stateOrderByPool.get(address) ?? {
          blockNumber: state.blockNumber,
          source: 'poll',
          logIndex: Number.MAX_SAFE_INTEGER,
        },
      );
    }

    const previousEventContracts = this.eventContracts;
    this.assets = stagedAssets;
    this.poolsByAsset = stagedPoolsByAsset;
    this.multipliers = refreshedMultipliers;
    this.statesByPool = stagedStatesByPool;
    this.stateOrderByPool = stagedStateOrderByPool;
    this.registryGeneration = nextGeneration;
    this.eventContracts = stagedEventContracts;

    await Promise.allSettled(previousEventContracts.map((contract) => contract.removeAllListeners()));
    if (this.eventProvider) {
      this.logger.info(
        { pools: stagedEventContracts.length },
        'PancakeSwap V3 Swap-event fast path enabled',
      );
    }
    const assetsWithPools = [...stagedPoolsByAsset.values()].filter((pools) => pools.length > 0).length;
    this.logger.info(
      {
        assets: assets.length,
        assetsWithPools,
        assetsWithoutPools: assets.length - assetsWithPools,
        pools: stagedPools.length,
      },
      'Discovered canonical PancakeSwap V3 pools',
    );
  }

  private async refreshMultipliers(): Promise<void> {
    const generation = this.registryGeneration;
    const assetsRegistry = this.assets;
    const previousMultipliers = this.multipliers;
    const multipliers = await this.readMultipliers([...assetsRegistry.values()], previousMultipliers);
    if (!this.stopping && generation === this.registryGeneration && assetsRegistry === this.assets) {
      for (const [assetCode, multiplier] of multipliers) {
        const previous = previousMultipliers.get(assetCode);
        if (
          previous !== undefined &&
          Math.abs(multiplier - previous) > Math.max(1e-12, Math.abs(previous) * 1e-12)
        ) {
          this.logger.warn(
            { assetCode, previousMultiplier: previous, nextMultiplier: multiplier },
            'On-chain bStock UI multiplier changed',
          );
        }
      }
      this.multipliers = multipliers;
    }
  }

  private async readMultipliers(
    assets: AssetDefinition[],
    initial: ReadonlyMap<string, number>,
  ): Promise<Map<string, number>> {
    const multipliers = new Map(initial);
    if (assets.length === 0) return multipliers;
    const responses = await this.multicall.read(
      assets.map((asset) => ({
        target: asset.address,
        callData: this.tokenInterface.encodeFunctionData('uiMultiplier'),
      })),
    );
    for (let index = 0; index < assets.length; index += 1) {
      const data = responses[index];
      if (!data) continue;
      const multiplier = BigInt(this.tokenInterface.decodeFunctionResult('uiMultiplier', data)[0]);
      const value = Number(formatUnits(multiplier, 18));
      if (Number.isFinite(value) && value > 0) multipliers.set(assets[index]!.assetCode, value);
    }
    return multipliers;
  }

  private async quoteAcrossPools(
    pools: V3PoolDescriptor[],
    tokenIn: string,
    tokenOut: string,
    amountIn: bigint,
  ): Promise<RawQuoteResult[]> {
    const settled = await Promise.allSettled(
      pools
        .filter((pool) => pool.liquidity > 0n || (this.statesByPool.get(pool.address.toLowerCase())?.liquidity ?? 0n) > 0n)
        .map(async (pool) => {
          const result = await withTimeout(
            this.quoter.getFunction('quoteExactInputSingle').staticCall({
              tokenIn,
              tokenOut,
              amountIn,
              fee: pool.fee,
              sqrtPriceLimitX96: 0,
            }),
            this.quoteTimeoutMs,
            `PancakeSwap quote for ${pool.assetCode}/${pool.fee}`,
          );
          return {
            pool,
            amountOut: BigInt(result.amountOut ?? result[0]),
            gasEstimate: BigInt(result.gasEstimate ?? result[3]),
          } satisfies RawQuoteResult;
        }),
    );
    return settled
      .filter((result): result is PromiseFulfilledResult<RawQuoteResult> => result.status === 'fulfilled')
      .map((result) => result.value)
      .filter((quote) => quote.amountOut > 0n);
  }

  private buildState(
    pool: V3PoolDescriptor,
    sqrtPriceX96: bigint,
    tick: number,
    liquidity: bigint,
    blockNumber: number,
    updatedAt: number,
  ): V3PoolState {
    const quotePerToken = sqrtPriceX96ToQuotePerBase(
      sqrtPriceX96,
      pool.baseIsToken0,
      pool.baseDecimals,
      pool.quoteDecimals,
    );
    const fee = feeFraction(pool.fee);
    return {
      pool: { ...pool, liquidity },
      sqrtPriceX96,
      tick,
      liquidity,
      multiplier: this.multipliers.get(pool.assetCode) ?? 1,
      // Binance Spot and ERC-20/Pancake operations both use raw token amounts.
      // Multiplier is monitored for corporate actions, not applied to cross-venue quantities.
      quotePerTokenMid: quotePerToken,
      quotePerTokenBuyMarginal: quotePerToken / (1 - fee),
      quotePerTokenSellMarginal: quotePerToken * (1 - fee),
      blockNumber,
      updatedAt,
    };
  }

  private storeState(state: V3PoolState, source: PoolStateSource, logIndex = -1): boolean {
    const address = state.pool.address.toLowerCase();
    const previousState = this.statesByPool.get(address);
    const previousOrder =
      this.stateOrderByPool.get(address) ??
      (previousState
        ? {
            blockNumber: previousState.blockNumber,
            source: 'poll' as const,
            logIndex: Number.MAX_SAFE_INTEGER,
          }
        : undefined);

    if (previousOrder) {
      if (state.blockNumber < previousOrder.blockNumber) return false;
      if (state.blockNumber === previousOrder.blockNumber && source === 'event') {
        if (previousOrder.source === 'poll') return false;
        if (logIndex <= previousOrder.logIndex) return false;
      }
    }

    this.statesByPool.set(address, state);
    this.stateOrderByPool.set(address, {
      blockNumber: state.blockNumber,
      source,
      logIndex: source === 'poll' ? Number.MAX_SAFE_INTEGER : logIndex,
    });
    return true;
  }

  private async prepareSwapListeners(
    pools: V3PoolDescriptor[],
    generation: number,
  ): Promise<Contract[]> {
    if (!this.eventProvider) return [];
    const contracts: Contract[] = [];

    for (const pool of pools) {
      let contract: Contract | undefined;
      try {
        contract = new Contract(pool.address, POOL_ABI, this.eventProvider);
        await contract.on('Swap', (...args: unknown[]) => {
          try {
            if (this.stopping || generation !== this.registryGeneration) return;
            const sqrtPriceX96 = BigInt(args[4] as bigint);
            const liquidity = BigInt(args[5] as bigint);
            const tick = Number(args[6]);
            const payload = args.at(-1) as
              | { log?: { blockNumber?: number; index?: number; logIndex?: number } }
              | undefined;
            const blockNumber = Number(payload?.log?.blockNumber);
            const logIndex = Number(payload?.log?.index ?? payload?.log?.logIndex);
            if (!Number.isSafeInteger(blockNumber) || !Number.isSafeInteger(logIndex)) {
              throw new Error('Swap event omitted block ordering metadata');
            }
            const state = this.buildState(pool, sqrtPriceX96, tick, liquidity, blockNumber, Date.now());
            if (this.storeState(state, 'event', logIndex)) {
              this.lastBlock = Math.max(this.lastBlock ?? 0, blockNumber);
            }
          } catch (error) {
            this.logger.debug({ pool: pool.address, error: errorMessage(error) }, 'Ignored malformed V3 Swap event');
          }
        });
        contracts.push(contract);
      } catch (error) {
        if (contract) await Promise.allSettled([contract.removeAllListeners()]);
        this.logger.warn({ pool: pool.address, error: errorMessage(error) }, 'Unable to subscribe to V3 Swap events');
      }
    }
    return contracts;
  }

  private triggerMultiplierRefresh(): void {
    if (this.stopping || this.multiplierRefreshPromise) return;
    const promise = this.refreshMultipliers();
    this.multiplierRefreshPromise = promise;
    void promise
      .catch((error: unknown) => {
        if (!this.stopping) {
          this.logger.warn({ error: errorMessage(error) }, 'Unable to refresh bStock UI multipliers');
        }
      })
      .finally(() => {
        if (this.multiplierRefreshPromise === promise) this.multiplierRefreshPromise = null;
      });
  }

  private async finishStop(): Promise<void> {
    // A refresh may be inside RPC or listener setup. Providers are kept alive until every
    // operation that owns them has settled, so shutdown cannot strand rejected promises.
    const shutdownDeadline = Date.now() + this.quoteTimeoutMs + 1_000;
    for (;;) {
      const pending = [this.configurePromise, this.pollPromise, this.multiplierRefreshPromise].filter(
        (promise): promise is Promise<void> => Boolean(promise),
      );
      if (pending.length === 0) break;
      const remaining = shutdownDeadline - Date.now();
      if (remaining <= 0) {
        this.logger.warn('Timed out waiting for PancakeSwap background RPC calls during shutdown');
        break;
      }
      await Promise.race([Promise.allSettled(pending), delay(remaining)]);
      await delay(0);
    }

    const contracts = this.eventContracts;
    this.eventContracts = [];
    this.registryGeneration += 1;
    await Promise.allSettled(contracts.map((contract) => contract.removeAllListeners()));
    await Promise.allSettled([
      this.provider.destroy(),
      ...(this.eventProvider ? [this.eventProvider.destroy()] : []),
    ]);
  }
}
