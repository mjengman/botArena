import { describe, it, expect } from "vitest";
import { computeMetrics } from "../src/engine/metrics.ts";
import type { BotInstance, BotSpec, StrategyDefinition, Trade } from "../src/engine/types.ts";

const noop: StrategyDefinition = { name: "noop", fn: () => null };
const spec: BotSpec = { id: "t", name: "T", strategy: noop };

function makeBot(overrides: Partial<BotInstance> = {}): BotInstance {
  return {
    spec,
    cash: 10_000,
    positions: new Map(),
    realizedPnl: 0,
    state: {},
    trades: [],
    fillHistory: [],
    equityHistory: [],
    exposedCandles: 0,
    portfolio: { cash: 10_000, positions: [], equity: 10_000, realizedPnl: 0, unrealizedPnl: 0, exposure: 0 },
    ...overrides,
  };
}

let tradeId = 0;
function closedTrade(pnl: number): Trade {
  return {
    id: `t${tradeId++}`,
    symbol: "X",
    entryTimestamp: 0,
    entryPrice: 100,
    entryQuantity: 10,
    exitTimestamp: 1,
    exitPrice: 100 + pnl / 10,
    exitQuantity: 10,
    realizedPnl: pnl,
    status: "closed",
  };
}

describe("computeMetrics: profitFactor", () => {
  it("returns Infinity when all trades are winning", () => {
    const bot = makeBot({ trades: [closedTrade(100), closedTrade(50)] });
    const m = computeMetrics(bot, 10_000, {}, 100, 1);
    expect(m.profitFactor).toBe(Infinity);
  });

  it("returns 0 when no closed trades", () => {
    const bot = makeBot();
    const m = computeMetrics(bot, 10_000, {}, 100, 1);
    expect(m.profitFactor).toBe(0);
  });

  it("returns 0 when all trades are losing", () => {
    const bot = makeBot({ trades: [closedTrade(-100), closedTrade(-50)] });
    const m = computeMetrics(bot, 10_000, {}, 100, 1);
    expect(m.profitFactor).toBe(0);
  });

  it("computes gross profit / gross loss correctly", () => {
    // gross profit = 200, gross loss = 100 → factor = 2
    const bot = makeBot({ trades: [closedTrade(200), closedTrade(-100)] });
    const m = computeMetrics(bot, 10_000, {}, 100, 1);
    expect(m.profitFactor).toBeCloseTo(2);
  });
});

describe("computeMetrics: avgTrade", () => {
  it("returns 0 when no closed trades", () => {
    const bot = makeBot();
    const m = computeMetrics(bot, 10_000, {}, 100, 1);
    expect(m.avgTrade).toBe(0);
  });

  it("averages realized PnL across closed trades", () => {
    // (100 + -50 + 150) / 3 = 200/3
    const bot = makeBot({ trades: [closedTrade(100), closedTrade(-50), closedTrade(150)] });
    const m = computeMetrics(bot, 10_000, {}, 100, 1);
    expect(m.avgTrade).toBeCloseTo(200 / 3);
  });

  it("is negative when average PnL is negative", () => {
    const bot = makeBot({ trades: [closedTrade(-100), closedTrade(-50)] });
    const m = computeMetrics(bot, 10_000, {}, 100, 1);
    expect(m.avgTrade).toBeLessThan(0);
  });
});

describe("computeMetrics: exposureTime", () => {
  it("returns 0 when exposedCandles is 0", () => {
    const bot = makeBot({ exposedCandles: 0 });
    const m = computeMetrics(bot, 10_000, {}, 100, 1);
    expect(m.exposureTime).toBe(0);
  });

  it("returns 1 when exposed all candles", () => {
    const bot = makeBot({ exposedCandles: 100 });
    const m = computeMetrics(bot, 10_000, {}, 100, 1);
    expect(m.exposureTime).toBe(1);
  });

  it("returns correct fraction", () => {
    const bot = makeBot({ exposedCandles: 50 });
    const m = computeMetrics(bot, 10_000, {}, 200, 1);
    expect(m.exposureTime).toBeCloseTo(0.25);
  });

  it("returns 0 when totalCandles is 0", () => {
    const bot = makeBot({ exposedCandles: 5 });
    const m = computeMetrics(bot, 10_000, {}, 0, 1);
    expect(m.exposureTime).toBe(0);
  });
});
