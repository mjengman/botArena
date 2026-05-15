import type { StrategyDefinition } from "../engine/types.ts";

// Rate-of-change momentum: buy when N-period return > threshold, sell when negative.
// Default params: period=20, threshold=0.02 (2%)
export const momentum: StrategyDefinition = {
  name: "Momentum",
  defaultParams: { period: 20, threshold: 0.02 },
  fn(ctx) {
    const { period = 20, threshold = 0.02 } = ctx.botState as {
      period?: number;
      threshold?: number;
    };

    if (ctx.candleIndex < period) return null;

    const closes = ctx.allCandles.map((c) => c.close);
    const current = closes[closes.length - 1]!;
    const past = closes[closes.length - 1 - period]!;
    const roc = (current - past) / past;

    const hasPosition = ctx.portfolio.positions.some((p) => p.symbol === ctx.symbol && p.quantity > 0);

    if (roc > threshold && !hasPosition) {
      return { side: "buy", symbol: ctx.symbol, size: { type: "targetAllocation", fraction: 0.95 } };
    }
    if (roc < 0 && hasPosition) {
      return { side: "sell", symbol: ctx.symbol, size: { type: "closePosition" } };
    }
    return null;
  },
};
