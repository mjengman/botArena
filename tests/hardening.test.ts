import { describe, it, expect } from "vitest";
import { executeOrder } from "../src/engine/execution.ts";
import { applyFill, makePortfolioSnapshot } from "../src/engine/portfolio.ts";
import { createSimulation } from "../src/engine/simulation.ts";
import { sampleDataset } from "../src/data/sampleDataset.ts";
import type {
  BotInstance,
  BotSpec,
  Candle,
  SimulationConfig,
  StrategyDefinition,
} from "../src/engine/types.ts";

const config: SimulationConfig = { startingCash: 10_000, feeBps: 5, slippageBps: 3, seed: 1 };
const candle: Candle = { timestamp: 1, open: 99, high: 105, low: 98, close: 100, volume: 1_000_000 };
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

// ─── Oversell guards ─────────────────────────────────────────────────────────

describe("Oversell prevention", () => {
  it("sellPercent > 1.0 is clamped to full position", () => {
    const bot = makeBot();
    bot.positions.set("X", { symbol: "X", quantity: 10, avgCost: 100 });
    const portfolio = makePortfolioSnapshot(bot, { X: 100 });
    const result = executeOrder(
      { side: "sell", symbol: "X", size: { type: "sellPercent", fraction: 1.5 } },
      bot, portfolio, candle, config,
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    // fraction clamped to 1.0 → sells exactly 10 shares
    expect(result.fill.quantity).toBe(10);
  });

  it("sellPercent < 0 results in zero quantity (rejected)", () => {
    const bot = makeBot();
    bot.positions.set("X", { symbol: "X", quantity: 10, avgCost: 100 });
    const portfolio = makePortfolioSnapshot(bot, { X: 100 });
    const result = executeOrder(
      { side: "sell", symbol: "X", size: { type: "sellPercent", fraction: -0.5 } },
      bot, portfolio, candle, config,
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe("ZERO_QUANTITY");
  });
});

// ─── Invalid allocation guards ────────────────────────────────────────────────

describe("Invalid allocation guards", () => {
  it("targetAllocation > 1.0 is clamped to 1.0 (uses full equity)", () => {
    const bot = makeBot(10_000);
    const portfolio = makePortfolioSnapshot(bot, { X: 100 });
    // 2.0 allocation clamped to 1.0 → would try to buy ~99 shares (fee-limited)
    const result = executeOrder(
      { side: "buy", symbol: "X", size: { type: "targetAllocation", fraction: 2.0 } },
      bot, portfolio, candle, config,
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    // Should buy no more shares than cash can cover
    const totalCost = result.fill.quantity * result.fill.price + result.fill.fee;
    expect(totalCost).toBeLessThanOrEqual(10_000 + 0.01); // within rounding
  });

  it("targetAllocation < 0 is clamped to 0 (no shares purchased)", () => {
    const bot = makeBot(10_000);
    const portfolio = makePortfolioSnapshot(bot, { X: 100 });
    const result = executeOrder(
      { side: "buy", symbol: "X", size: { type: "targetAllocation", fraction: -1.0 } },
      bot, portfolio, candle, config,
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe("ZERO_QUANTITY");
  });
});

// ─── Partial sell trade lifecycle ─────────────────────────────────────────────

describe("Partial sell trade lifecycle", () => {
  it("partial sell keeps trade open with reduced entry quantity", () => {
    const bot = makeBot(10_000);
    applyFill(bot, { side: "buy", symbol: "X", quantity: 10, price: 100, fee: 0, timestamp: 1 });
    expect(bot.trades[0]?.status).toBe("open");
    expect(bot.trades[0]?.entryQuantity).toBe(10);

    applyFill(bot, { side: "sell", symbol: "X", quantity: 4, price: 110, fee: 0, timestamp: 2 });

    expect(bot.trades[0]?.status).toBe("open");
    expect(bot.trades[0]?.entryQuantity).toBe(6);
  });

  it("partial sell accumulates realized PnL on the open trade", () => {
    const bot = makeBot(10_000);
    applyFill(bot, { side: "buy", symbol: "X", quantity: 10, price: 100, fee: 0, timestamp: 1 });
    applyFill(bot, { side: "sell", symbol: "X", quantity: 5, price: 120, fee: 0, timestamp: 2 });
    // PnL so far = (120-100)*5 = 100
    expect(bot.trades[0]?.realizedPnl).toBeCloseTo(100);
    expect(bot.trades[0]?.status).toBe("open");
  });

  it("full sell after partial sell closes the trade", () => {
    const bot = makeBot(10_000);
    applyFill(bot, { side: "buy", symbol: "X", quantity: 10, price: 100, fee: 0, timestamp: 1 });
    applyFill(bot, { side: "sell", symbol: "X", quantity: 4, price: 110, fee: 0, timestamp: 2 });
    applyFill(bot, { side: "sell", symbol: "X", quantity: 6, price: 120, fee: 0, timestamp: 3 });

    expect(bot.trades[0]?.status).toBe("closed");
    // Total PnL = (110-100)*4 + (120-100)*6 = 40+120 = 160
    expect(bot.trades[0]?.realizedPnl).toBeCloseTo(160);
    expect(bot.positions.has("X")).toBe(false);
  });

  it("cash is consistent after partial sell", () => {
    const bot = makeBot(10_000);
    applyFill(bot, { side: "buy", symbol: "X", quantity: 10, price: 100, fee: 0, timestamp: 1 });
    const cashAfterBuy = bot.cash; // 9000
    applyFill(bot, { side: "sell", symbol: "X", quantity: 5, price: 110, fee: 0, timestamp: 2 });
    expect(bot.cash).toBeCloseTo(cashAfterBuy + 5 * 110);
  });
});

// ─── Per-candle equity history ────────────────────────────────────────────────

describe("Per-candle equity history", () => {
  it("equityHistory length equals candle count after runToEnd", () => {
    const sim = createSimulation(config, sampleDataset, [
      { id: "bah", name: "B", strategy: { name: "bah", fn: (ctx) => ctx.candleIndex === 0
        ? { side: "buy", symbol: ctx.symbol, size: { type: "targetAllocation", fraction: 0.99 } }
        : null } },
    ]);
    sim.runToEnd();
    const snap = sim.getSnapshot();
    const bot = snap.bots[0]!;
    expect(bot.equityHistory.length).toBe(sampleDataset.candles.length);
  });

  it("buy-and-hold drawdown > 0 when equity falls from peak", () => {
    const sim = createSimulation(config, sampleDataset, [
      { id: "bah", name: "B&H", strategy: { name: "bah", fn: (ctx) => ctx.candleIndex === 0
        ? { side: "buy", symbol: ctx.symbol, size: { type: "targetAllocation", fraction: 0.99 } }
        : null } },
    ]);
    sim.runToEnd();
    const standings = sim.getStandings();
    // With 504 candles and volatility, a fully-invested bot must have experienced some drawdown
    expect(standings[0]!.maxDrawdown).toBeGreaterThan(0.01);
  });
});
