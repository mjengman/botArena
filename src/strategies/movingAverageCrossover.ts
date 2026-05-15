import type { StrategyDefinition } from "../engine/types.ts";

// Golden/death cross: buy when short MA crosses above long MA, sell on cross below.
// Default params: shortPeriod=10, longPeriod=30.
export const movingAverageCrossover: StrategyDefinition = {
  name: "MA Crossover",
  defaultParams: { shortPeriod: 10, longPeriod: 30 },
  fn(ctx) {
    const { shortPeriod = 10, longPeriod = 30 } = ctx.botState as {
      shortPeriod?: number;
      longPeriod?: number;
    };

    if (ctx.candleIndex < (longPeriod as number)) return null;

    const closes = ctx.allCandles.map((c) => c.close);
    const shortMa = mean(closes.slice(-shortPeriod));
    const shortMaPrev = mean(closes.slice(-(shortPeriod + 1), -1));
    const longMa = mean(closes.slice(-longPeriod));
    const longMaPrev = mean(closes.slice(-(longPeriod + 1), -1));

    const crossedAbove = shortMaPrev <= longMaPrev && shortMa > longMa;
    const crossedBelow = shortMaPrev >= longMaPrev && shortMa < longMa;

    const hasPosition = ctx.portfolio.positions.some((p) => p.symbol === ctx.symbol && p.quantity > 0);

    if (crossedAbove && !hasPosition) {
      return { side: "buy", symbol: ctx.symbol, size: { type: "targetAllocation", fraction: 0.95 } };
    }
    if (crossedBelow && hasPosition) {
      return { side: "sell", symbol: ctx.symbol, size: { type: "closePosition" } };
    }
    return null;
  },
};

function mean(arr: number[]): number {
  if (arr.length === 0) return 0;
  return arr.reduce((s, v) => s + v, 0) / arr.length;
}
