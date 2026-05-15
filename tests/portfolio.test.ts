import { describe, it, expect, beforeEach } from "vitest";
import { applyFill, makePortfolioSnapshot } from "../src/engine/portfolio.ts";
import type { BotInstance, BotSpec, StrategyDefinition } from "../src/engine/types.ts";

const noop: StrategyDefinition = { name: "noop", fn: () => null };
const spec: BotSpec = { id: "test", name: "Test Bot", strategy: noop };

function makeBot(cash = 10_000): BotInstance {
  return {
    spec,
    cash,
    positions: new Map(),
    realizedPnl: 0,
    state: {},
    trades: [],
    fillHistory: [],
    portfolio: {
      cash,
      positions: [],
      equity: cash,
      realizedPnl: 0,
      unrealizedPnl: 0,
      exposure: 0,
    },
  };
}

describe("Portfolio: buy fill", () => {
  let bot: BotInstance;
  beforeEach(() => { bot = makeBot(10_000); });

  it("reduces cash by cost + fee", () => {
    applyFill(bot, { side: "buy", symbol: "X", quantity: 10, price: 100, fee: 5, timestamp: 1 });
    expect(bot.cash).toBeCloseTo(10_000 - 10 * 100 - 5);
  });

  it("creates a position", () => {
    applyFill(bot, { side: "buy", symbol: "X", quantity: 10, price: 100, fee: 5, timestamp: 1 });
    expect(bot.positions.get("X")?.quantity).toBe(10);
    expect(bot.positions.get("X")?.avgCost).toBe(100);
  });

  it("averages cost on additional buy", () => {
    applyFill(bot, { side: "buy", symbol: "X", quantity: 10, price: 100, fee: 0, timestamp: 1 });
    applyFill(bot, { side: "buy", symbol: "X", quantity: 10, price: 120, fee: 0, timestamp: 2 });
    expect(bot.positions.get("X")?.avgCost).toBe(110);
    expect(bot.positions.get("X")?.quantity).toBe(20);
  });

  it("creates a trade record", () => {
    applyFill(bot, { side: "buy", symbol: "X", quantity: 10, price: 100, fee: 0, timestamp: 1 });
    expect(bot.trades.length).toBe(1);
    expect(bot.trades[0]?.status).toBe("open");
  });
});

describe("Portfolio: sell fill", () => {
  it("increases cash by proceeds - fee", () => {
    const bot = makeBot(10_000);
    applyFill(bot, { side: "buy", symbol: "X", quantity: 10, price: 100, fee: 0, timestamp: 1 });
    const cashAfterBuy = bot.cash;
    applyFill(bot, { side: "sell", symbol: "X", quantity: 5, price: 110, fee: 2, timestamp: 2 });
    expect(bot.cash).toBeCloseTo(cashAfterBuy + 5 * 110 - 2);
  });

  it("calculates realized PnL correctly", () => {
    const bot = makeBot(10_000);
    applyFill(bot, { side: "buy", symbol: "X", quantity: 10, price: 100, fee: 0, timestamp: 1 });
    applyFill(bot, { side: "sell", symbol: "X", quantity: 10, price: 120, fee: 0, timestamp: 2 });
    // PnL = (120 - 100) * 10 = 200
    expect(bot.realizedPnl).toBeCloseTo(200);
  });

  it("removes position when fully closed", () => {
    const bot = makeBot(10_000);
    applyFill(bot, { side: "buy", symbol: "X", quantity: 10, price: 100, fee: 0, timestamp: 1 });
    applyFill(bot, { side: "sell", symbol: "X", quantity: 10, price: 100, fee: 0, timestamp: 2 });
    expect(bot.positions.has("X")).toBe(false);
  });

  it("closes trade record on sell", () => {
    const bot = makeBot(10_000);
    applyFill(bot, { side: "buy", symbol: "X", quantity: 10, price: 100, fee: 0, timestamp: 1 });
    applyFill(bot, { side: "sell", symbol: "X", quantity: 10, price: 120, fee: 0, timestamp: 2 });
    expect(bot.trades[0]?.status).toBe("closed");
    expect(bot.trades[0]?.realizedPnl).toBeCloseTo(200);
  });
});

describe("PortfolioSnapshot", () => {
  it("equity = cash + position value", () => {
    const bot = makeBot(5_000);
    applyFill(bot, { side: "buy", symbol: "X", quantity: 10, price: 100, fee: 0, timestamp: 1 });
    const snap = makePortfolioSnapshot(bot, { X: 150 });
    // cash = 5000 - 1000 = 4000, posValue = 10*150 = 1500, equity = 5500
    expect(snap.equity).toBeCloseTo(5_500);
  });

  it("unrealized PnL reflects market price vs avg cost", () => {
    const bot = makeBot(10_000);
    applyFill(bot, { side: "buy", symbol: "X", quantity: 10, price: 100, fee: 0, timestamp: 1 });
    const snap = makePortfolioSnapshot(bot, { X: 130 });
    expect(snap.unrealizedPnl).toBeCloseTo(300); // (130-100)*10
  });
});
