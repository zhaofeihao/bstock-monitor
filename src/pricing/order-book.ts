import { Decimal } from 'decimal.js';

import type { PriceLevel } from '../types.js';

export interface QuoteBudgetFill {
  filled: boolean;
  quoteSpent: number;
  baseReceived: number;
  effectivePrice: number;
}

export interface BaseAmountFill {
  filled: boolean;
  baseSold: number;
  quoteReceived: number;
  effectivePrice: number;
}

const EPSILON = 1e-10;

export function roundDownToStep(value: number, stepSize?: number): number {
  if (!(value > 0) || !(stepSize && stepSize > 0)) return value;
  return new Decimal(value).div(stepSize).floor().mul(stepSize).toNumber();
}

export function buyBaseWithQuote(asks: PriceLevel[], quoteBudget: number): QuoteBudgetFill {
  if (!(quoteBudget > 0)) return { filled: false, quoteSpent: 0, baseReceived: 0, effectivePrice: 0 };

  let remainingQuote = quoteBudget;
  let baseReceived = 0;
  for (const level of asks) {
    if (!(level.price > 0 && level.quantity > 0)) continue;
    const levelCost = level.price * level.quantity;
    const quoteAtLevel = Math.min(remainingQuote, levelCost);
    baseReceived += quoteAtLevel / level.price;
    remainingQuote -= quoteAtLevel;
    if (remainingQuote <= EPSILON) break;
  }

  const quoteSpent = quoteBudget - Math.max(0, remainingQuote);
  return {
    filled: remainingQuote <= EPSILON,
    quoteSpent,
    baseReceived,
    effectivePrice: baseReceived > 0 ? quoteSpent / baseReceived : 0,
  };
}

export function sellBaseForQuote(bids: PriceLevel[], baseAmount: number): BaseAmountFill {
  if (!(baseAmount > 0)) return { filled: false, baseSold: 0, quoteReceived: 0, effectivePrice: 0 };

  let remainingBase = baseAmount;
  let quoteReceived = 0;
  for (const level of bids) {
    if (!(level.price > 0 && level.quantity > 0)) continue;
    const baseAtLevel = Math.min(remainingBase, level.quantity);
    quoteReceived += baseAtLevel * level.price;
    remainingBase -= baseAtLevel;
    if (remainingBase <= EPSILON) break;
  }

  const baseSold = baseAmount - Math.max(0, remainingBase);
  return {
    filled: remainingBase <= EPSILON,
    baseSold,
    quoteReceived,
    effectivePrice: baseSold > 0 ? quoteReceived / baseSold : 0,
  };
}
