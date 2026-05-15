import type { StrategyDefinition } from "../engine/types.ts";
import { makePrng } from "../engine/prng.ts";

// Seeded random baseline: randomly buys or sells each candle with low probability.
// Deterministic given a seed — same run always produces same decisions.
export const randomBaseline: StrategyDefinition = {
  name: "Random Baseline",
  defaultParams: { buyProb: 0.05, sellProb: 0.1 },
  fn(ctx) {
    const { buyProb = 0.05, sellProb = 0.1 } = ctx.botState as {
      buyProb?: number;
      sellProb?: number;
    };

    // Derive a per-candle seed from base seed + candle index so each candle
    // gets a unique but reproducible random value.
    const prng = makePrng(ctx.seed ^ (ctx.candleIndex * 2654435761));
    const roll = prng();

    const hasPosition = ctx.portfolio.positions.some((p) => p.symbol === ctx.symbol && p.quantity > 0);

    if (!hasPosition && roll < buyProb) {
      return {
        side: "buy",
        symbol: ctx.symbol,
        size: { type: "targetAllocation", fraction: 0.5 },
      };
    }
    if (hasPosition && roll < sellProb) {
      return { side: "sell", symbol: ctx.symbol, size: { type: "closePosition" } };
    }
    return null;
  },
};
