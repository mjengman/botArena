import { describe, it, expect } from "vitest";
import { executeOrder } from "../src/engine/execution.ts";
import { makePortfolioSnapshot } from "../src/engine/portfolio.ts";
import type { BotInstance, BotSpec, Candle, SimulationConfig, StrategyDefinition } from "../src/engine/types.ts";

const config: SimulationConfig = { startingCash: 10_000, feeBps: 10, slippageBps: 10, seed: 1 };

const candle: Candle = { timestamp: 1000, open: 99, high: 105, low: 98, close: 100, volume: 1_000_000 };

const noop: StrategyDefinition = { name: "noop", fn: () => null };
const spec: BotSpec = { id: "t", name: "T", strategy: noop };

function makeBot(cash = 10_000): BotInstance {
  return {
    spec,
    cash,
    positions: new Map(),
    realizedPnl: 0,
    state: {},
    trades: [],
    fillHistory: [],
    equityHistory: [],
    exposedCandles: 0,
    portfolio: { cash, positions: [], equity: cash, realizedPnl: 0, unrealizedPnl: 0, exposure: 0 },
  };
}

describe("Execution: buy", () => {
  it("applies buy-side slippage (fill price > close)", () => {
    const bot = makeBot();
    const portfolio = makePortfolioSnapshot(bot, { X: 100 });
    const result = executeOrder(
      { side: "buy", symbol: "X", size: { type: "quantity", quantity: 10 } },
      bot, portfolio, candle, config,
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    // slippage 10bps = 0.10% above 100 = 100.10
    expect(result.fill.price).toBeCloseTo(100.10);
  });

  it("applies fee to buy fill", () => {
    // Use $20k cash so 100 shares at $100.10 + 0.1% fee fits without fallback
    const bot = makeBot(20_000);
    const portfolio = makePortfolioSnapshot(bot, { X: 100 });
    const result = executeOrder(
      { side: "buy", symbol: "X", size: { type: "quantity", quantity: 100 } },
      bot, portfolio, candle, config,
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.fill.quantity).toBe(100);
    // fee = quantity * fillPrice * feeFraction = 100 * 100.10 * 0.001
    expect(result.fill.fee).toBeCloseTo(100 * 100.10 * 0.001);
  });

  it("rejects when insufficient cash", () => {
    const bot = makeBot(50); // only $50
    const portfolio = makePortfolioSnapshot(bot, { X: 100 });
    const result = executeOrder(
      { side: "buy", symbol: "X", size: { type: "quantity", quantity: 10_000 } },
      bot, portfolio, candle, config,
    );
    // Should either fill fewer shares or reject
    if (result.ok) {
      // Quantity must be reduced to what cash allows
      expect(result.fill.quantity).toBeLessThan(10_000);
    } else {
      expect(result.reason).toBe("INSUFFICIENT_CASH");
    }
  });

  it("targetAllocation buy allocates correct fraction of equity", () => {
    const bot = makeBot(10_000);
    const portfolio = makePortfolioSnapshot(bot, { X: 100 });
    const result = executeOrder(
      { side: "buy", symbol: "X", size: { type: "targetAllocation", fraction: 0.5 } },
      bot, portfolio, candle, config,
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    // 50% of $10k = $5k at ~$100.10 ≈ 49 shares
    expect(result.fill.quantity).toBe(49);
  });
});

describe("Execution: sell", () => {
  it("applies sell-side slippage (fill price < close)", () => {
    const bot = makeBot();
    bot.positions.set("X", { symbol: "X", quantity: 10, avgCost: 90 });
    const portfolio = makePortfolioSnapshot(bot, { X: 100 });
    const result = executeOrder(
      { side: "sell", symbol: "X", size: { type: "closePosition" } },
      bot, portfolio, candle, config,
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    // slippage 10bps below 100 = 99.90
    expect(result.fill.price).toBeCloseTo(99.90);
  });

  it("rejects sell with no position", () => {
    const bot = makeBot();
    const portfolio = makePortfolioSnapshot(bot, {});
    const result = executeOrder(
      { side: "sell", symbol: "X", size: { type: "closePosition" } },
      bot, portfolio, candle, config,
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe("ZERO_QUANTITY");
  });

  it("sellPercent fills correct quantity", () => {
    const bot = makeBot();
    bot.positions.set("X", { symbol: "X", quantity: 100, avgCost: 90 });
    const portfolio = makePortfolioSnapshot(bot, { X: 100 });
    const result = executeOrder(
      { side: "sell", symbol: "X", size: { type: "sellPercent", fraction: 0.5 } },
      bot, portfolio, candle, config,
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.fill.quantity).toBe(50);
  });
});

describe("Execution: edge cases", () => {
  it("rejects when candle close price is zero", () => {
    const bot = makeBot();
    const portfolio = makePortfolioSnapshot(bot, {});
    const zeroCandle: Candle = { ...candle, close: 0 };
    const result = executeOrder(
      { side: "buy", symbol: "X", size: { type: "quantity", quantity: 1 } },
      bot, portfolio, zeroCandle, config,
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe("PRICE_ZERO");
  });
});
