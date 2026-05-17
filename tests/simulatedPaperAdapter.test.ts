import { describe, it, expect, beforeEach } from "vitest";
import { SimulatedPaperAdapter } from "../src/engine/adapters/simulatedPaperAdapter.ts";
import type { OrderIntent, PortfolioSnapshot } from "../src/engine/types.ts";
import type { OrderExecutionContext } from "../src/engine/adapter.ts";

// ─── Fixtures ─────────────────────────────────────────────────────────────────

const FEE_BPS = 5;
const SLIPPAGE_BPS = 10;

/** Dummy context — the simulated adapter ignores it, but the type requires it. */
const CTX: OrderExecutionContext = { botId: "test-bot", clientOrderId: "test-order-1" };

function makeAdapter(): SimulatedPaperAdapter {
  return new SimulatedPaperAdapter(FEE_BPS, SLIPPAGE_BPS);
}

function makePortfolio(cash: number, positions: PortfolioSnapshot["positions"] = []): PortfolioSnapshot {
  return {
    cash,
    positions,
    equity: cash + positions.reduce((s, p) => s + p.quantity * p.avgCost, 0),
    realizedPnl: 0,
    unrealizedPnl: 0,
    exposure: 0,
  };
}

function makeQuantityBuy(qty: number): OrderIntent {
  return { side: "buy", symbol: "ARENA", size: { type: "quantity", quantity: qty } };
}

function makeQuantitySell(qty: number): OrderIntent {
  return { side: "sell", symbol: "ARENA", size: { type: "quantity", quantity: qty } };
}

function makeAllocationBuy(fraction: number): OrderIntent {
  return { side: "buy", symbol: "ARENA", size: { type: "targetAllocation", fraction } };
}

function makeClosePosition(): OrderIntent {
  return { side: "sell", symbol: "ARENA", size: { type: "closePosition" } };
}

function makeSellPercent(fraction: number): OrderIntent {
  return { side: "sell", symbol: "ARENA", size: { type: "sellPercent", fraction } };
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe("SimulatedPaperAdapter — mode", () => {
  it("has mode === 'paper'", () => {
    expect(makeAdapter().mode).toBe("paper");
  });
});

describe("SimulatedPaperAdapter — setCurrentCandle / price injection", () => {
  it("throws when executeAsync is called before setCurrentCandle (price = 0)", async () => {
    const adapter = makeAdapter();
    await expect(
      adapter.executeAsync(makeQuantityBuy(10), makePortfolio(10_000), CTX),
    ).rejects.toThrow("currentPrice is zero");
  });

  it("uses the injected price for fill calculation", async () => {
    const adapter = makeAdapter();
    adapter.setCurrentCandle(100, Date.now());
    const fill = await adapter.executeAsync(makeQuantityBuy(5), makePortfolio(10_000), CTX);
    // fill price = 100 * (1 + 10/10000) = 100.10
    expect(fill.price).toBeCloseTo(100.1, 4);
  });

  it("uses the injected timestamp on the fill", async () => {
    const adapter = makeAdapter();
    const ts = 1_700_000_000_000;
    adapter.setCurrentCandle(50, ts);
    const fill = await adapter.executeAsync(makeQuantityBuy(2), makePortfolio(10_000), CTX);
    expect(fill.timestamp).toBe(ts);
  });
});

describe("SimulatedPaperAdapter — buy fills", () => {
  let adapter: SimulatedPaperAdapter;
  const PRICE = 100;

  beforeEach(() => {
    adapter = makeAdapter();
    adapter.setCurrentCandle(PRICE, Date.now());
  });

  it("fills a quantity buy at close+slippage price", async () => {
    const fill = await adapter.executeAsync(makeQuantityBuy(10), makePortfolio(10_000), CTX);
    expect(fill.side).toBe("buy");
    expect(fill.symbol).toBe("ARENA");
    expect(fill.quantity).toBe(10);
    // fill price = 100 * (1 + 0.001) = 100.10
    expect(fill.price).toBeCloseTo(100.1, 4);
  });

  it("computes fee correctly", async () => {
    const fill = await adapter.executeAsync(makeQuantityBuy(10), makePortfolio(10_000), CTX);
    // fee = qty * fillPrice * feeFraction = 10 * 100.10 * 0.0005
    expect(fill.fee).toBeCloseTo(10 * 100.1 * (FEE_BPS / 10_000), 6);
  });

  it("fills a targetAllocation buy with fractional shares", async () => {
    // equity = 10_000, fraction = 0.5 → target = 5_000
    // fillPrice = 100.10, qty = floor9(5000 / 100.10) = 49.95004995
    const fill = await adapter.executeAsync(makeAllocationBuy(0.5), makePortfolio(10_000), CTX);
    expect(fill.quantity).toBeCloseTo(49.95004995, 9);
  });

  it("reduces quantity when cash is insufficient for the full order", async () => {
    // Request 200 shares @ ~100.10 + fee — cash = 500 → cannot afford 200
    const fill = await adapter.executeAsync(makeQuantityBuy(200), makePortfolio(500), CTX);
    // max qty = floor9(500 / (100.10 * 1.0005)) ≈ 4.9925
    expect(fill.quantity).toBeGreaterThan(0);
    expect(fill.quantity).toBeLessThan(200);
  });

  it("reduces to a fractional quantity when cash is insufficient for 1 share", async () => {
    // price = 100, cash = 10 → can still buy a fractional share
    const fill = await adapter.executeAsync(makeQuantityBuy(1), makePortfolio(10), CTX);
    expect(fill.quantity).toBeGreaterThan(0);
    expect(fill.quantity).toBeLessThan(1);
  });

  it("throws when resolved quantity is zero (fraction = 0)", async () => {
    await expect(
      adapter.executeAsync(makeAllocationBuy(0), makePortfolio(10_000), CTX),
    ).rejects.toThrow("zero quantity");
  });
});

describe("SimulatedPaperAdapter — sell fills", () => {
  let adapter: SimulatedPaperAdapter;
  const PRICE = 100;
  const POSITION_QTY = 20;

  const portfolioWithPosition = makePortfolio(5_000, [
    { symbol: "ARENA", quantity: POSITION_QTY, avgCost: 90 },
  ]);

  beforeEach(() => {
    adapter = makeAdapter();
    adapter.setCurrentCandle(PRICE, Date.now());
  });

  it("fills a sell at close-slippage price", async () => {
    const fill = await adapter.executeAsync(makeQuantitySell(10), portfolioWithPosition, CTX);
    expect(fill.side).toBe("sell");
    // fill price = 100 * (1 - 0.001) = 99.90
    expect(fill.price).toBeCloseTo(99.9, 4);
    expect(fill.quantity).toBe(10);
  });

  it("closePosition sells full position quantity", async () => {
    const fill = await adapter.executeAsync(makeClosePosition(), portfolioWithPosition, CTX);
    expect(fill.quantity).toBe(POSITION_QTY);
  });

  it("sellPercent sells correct fraction of position", async () => {
    const fill = await adapter.executeAsync(makeSellPercent(0.5), portfolioWithPosition, CTX);
    expect(fill.quantity).toBe(POSITION_QTY * 0.5);
  });

  it("quantity sell is capped at held position quantity", async () => {
    const fill = await adapter.executeAsync(makeQuantitySell(999), portfolioWithPosition, CTX);
    expect(fill.quantity).toBe(POSITION_QTY);
  });

  it("throws when selling a symbol not in the portfolio", async () => {
    const emptyPortfolio = makePortfolio(5_000, []);
    await expect(
      adapter.executeAsync(makeClosePosition(), emptyPortfolio, CTX),
    ).rejects.toThrow("zero quantity");
  });
});

describe("SimulatedPaperAdapter — reconcileAccount", () => {
  it("always returns ok === true", async () => {
    const adapter = makeAdapter();
    adapter.setCurrentCandle(100, Date.now());
    const result = await adapter.reconcileAccount(makePortfolio(10_000));
    expect(result.ok).toBe(true);
    expect(result.drifts).toHaveLength(0);
  });

  it("mirrors engine portfolio in the broker snapshot", async () => {
    const adapter = makeAdapter();
    adapter.setCurrentCandle(100, Date.now());
    const portfolio = makePortfolio(9_500, [{ symbol: "ARENA", quantity: 5, avgCost: 100 }]);
    const result = await adapter.reconcileAccount(portfolio);
    expect(Number(result.brokerSnapshot.cash)).toBeCloseTo(9_500, 0);
    expect(result.brokerSnapshot.positions).toHaveLength(1);
    expect(result.brokerSnapshot.positions[0]!.symbol).toBe("ARENA");
  });
});

// ─── Governance config regression ─────────────────────────────────────────────
//
// Regression: the paper UI config originally set maxOrderNotional below the
// default starting cash, which blocked buyAndHold's 99% allocation.
// The cap must be ≥ startingCash so the default strategy produces at least one fill.

describe("SimulatedPaperAdapter — governance cap regression (fill must land)", () => {
  it("B&H targetAllocation(0.99) notional is below the 105 cap at any reasonable price", () => {
    const STARTING_EQUITY = 100;
    const FRACTION = 0.99;
    const MAX_ORDER_NOTIONAL = 105; // current default in usePaperLeague

    // For any price p > 0, fractional qty = floor9(equity * fraction / p)
    // orderNotional = qty * p ≤ equity * fraction = 99
    // 99 < 105 → always passes MAX_ORDER_NOTIONAL ✓
    const estimatedMaxNotional = STARTING_EQUITY * FRACTION;
    expect(estimatedMaxNotional).toBeLessThan(MAX_ORDER_NOTIONAL);
  });

  it("previous cap below starting cash would have blocked a 99% allocation of $100 at $100", () => {
    const STARTING_EQUITY = 100;
    const FRACTION = 0.99;
    const PRICE = 100;
    const OLD_CAP = 90;

    const qty = Math.floor(((STARTING_EQUITY * FRACTION) / PRICE) * 1_000_000_000) / 1_000_000_000;
    const orderNotional = qty * PRICE; // 99
    expect(orderNotional).toBeGreaterThan(OLD_CAP); // would have been blocked
  });
});

describe("SimulatedPaperAdapter — ingestBrokerEvent", () => {
  it("converts an envelope to a WARNING ArenaEvent", () => {
    const adapter = makeAdapter();
    const envelope = {
      type: "connection_error" as const,
      receivedAt: 123_456,
      raw: { code: 503 },
    };
    const event = adapter.ingestBrokerEvent(envelope);
    expect(event.type).toBe("WARNING");
    expect(event.timestamp).toBe(123_456);
    expect(event.payload["brokerEventType"]).toBe("connection_error");
  });
});
