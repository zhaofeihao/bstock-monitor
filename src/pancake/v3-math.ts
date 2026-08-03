import { Decimal } from 'decimal.js';

const Q96 = new Decimal(2).pow(96);

export function sqrtPriceX96ToQuotePerBase(
  sqrtPriceX96: bigint,
  baseIsToken0: boolean,
  baseDecimals: number,
  quoteDecimals: number,
): number {
  if (sqrtPriceX96 <= 0n) throw new Error('sqrtPriceX96 must be positive');
  const token1PerToken0Raw = new Decimal(sqrtPriceX96.toString()).div(Q96).pow(2);
  const decimalScale = new Decimal(10).pow(baseDecimals - quoteDecimals);
  const quotePerBase = baseIsToken0
    ? token1PerToken0Raw.mul(decimalScale)
    : new Decimal(1).div(token1PerToken0Raw).mul(decimalScale);
  return quotePerBase.toNumber();
}

export function feeFraction(fee: number): number {
  return fee / 1_000_000;
}
