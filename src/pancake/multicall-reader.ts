import { Contract, type Provider } from 'ethers';

import type { Logger } from '../logger.js';
import { errorMessage, sleep } from '../utils.js';

const MULTICALL3_ABI = [
  'function aggregate3((address target,bool allowFailure,bytes callData)[] calls) payable returns ((bool success,bytes returnData)[] returnData)',
];

export interface MulticallRead {
  target: string;
  callData: string;
}

export class MulticallReader {
  private readonly contract: Contract;

  constructor(address: string, provider: Provider, private readonly logger: Logger) {
    this.contract = new Contract(address, MULTICALL3_ABI, provider);
  }

  async read(calls: MulticallRead[], blockTag?: number): Promise<Array<string | null>> {
    const results: Array<string | null> = [];
    for (let offset = 0; offset < calls.length; offset += 120) {
      const chunk = calls.slice(offset, offset + 120);
      const response = await this.readChunk(chunk, blockTag);
      results.push(...response);
    }
    return results;
  }

  private async readChunk(calls: MulticallRead[], blockTag?: number): Promise<Array<string | null>> {
    let lastError: unknown;
    for (let attempt = 0; attempt < 4; attempt += 1) {
      try {
        const inputs = calls.map((call) => ({ target: call.target, allowFailure: true, callData: call.callData }));
        const result = await this.contract
          .getFunction('aggregate3')
          .staticCall(inputs, blockTag === undefined ? {} : { blockTag });
        return [...result].map((entry) => {
          const success = Boolean(entry.success ?? entry[0]);
          return success ? String(entry.returnData ?? entry[1]) : null;
        });
      } catch (error) {
        lastError = error;
        if (attempt < 3) await sleep(150 * 3 ** attempt);
      }
    }
    this.logger.warn({ error: errorMessage(lastError), calls: calls.length }, 'Multicall3 read failed after retries');
    throw lastError;
  }
}
