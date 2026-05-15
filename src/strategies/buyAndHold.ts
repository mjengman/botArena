import type { StrategyDefinition } from "../engine/types.ts";

// Buys with full allocation on the first candle, never sells.
export const buyAndHold: StrategyDefinition = {
  name: "Buy & Hold",
  fn(ctx) {
    if (ctx.candleIndex === 0) {
      return {
        side: "buy",
        symbol: ctx.symbol,
        size: { type: "targetAllocation", fraction: 0.99 },
      };
    }
    return null;
  },
};
