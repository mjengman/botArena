import type { StrategyDefinition } from "../engine/types.ts";

// Z-score mean reversion: buy when price is >zBuy std devs below mean, sell at mean.
// Default params: period=20, zBuy=1.5, zSell=0.0
export const meanReversion: StrategyDefinition = {
  name: "Mean Reversion",
  defaultParams: { period: 20, zBuy: 1.5, zSell: 0.0 },
  fn(ctx) {
    const { period = 20, zBuy = 1.5, zSell = 0.0 } = ctx.botState as {
      period?: number;
      zBuy?: number;
      zSell?: number;
    };

    if (ctx.candleIndex < period) return null;

    const closes = ctx.allCandles.slice(-period).map((c) => c.close);
    const avg = closes.reduce((s, v) => s + v, 0) / closes.length;
    const variance = closes.reduce((s, v) => s + (v - avg) ** 2, 0) / closes.length;
    const std = Math.sqrt(variance);
    if (std === 0) return null;

    const z = (ctx.candle.close - avg) / std;
    const hasPosition = ctx.portfolio.positions.some((p) => p.symbol === ctx.symbol && p.quantity > 0);

    if (z < -zBuy && !hasPosition) {
      return { side: "buy", symbol: ctx.symbol, size: { type: "targetAllocation", fraction: 0.95 } };
    }
    if (z > -zSell && hasPosition) {
      return { side: "sell", symbol: ctx.symbol, size: { type: "closePosition" } };
    }
    return null;
  },
};
