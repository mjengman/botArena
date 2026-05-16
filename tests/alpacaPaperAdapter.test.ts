import { describe, it, expect, vi, afterEach } from "vitest";
import {
  AlpacaPaperAdapter,
  DEFAULT_ALPACA_PAPER_ADAPTER_CONFIG,
  type AlpacaPaperAdapterConfig,
} from "../src/engine/adapters/alpacaPaperAdapter.ts";
import { makeAlpacaArmingPreconditions } from "../src/engine/adapters/alpacaArmingPreconditions.ts";
import { ConcreteCredentialStore } from "../src/engine/governance/credentialStore.ts";
import { ConcreteEnablementGate } from "../src/engine/governance/enablementGate.ts";
import { AuditLog } from "../src/engine/governance/auditLog.ts";
import { GateDisarmedError } from "../src/engine/brokerTypes.ts";
import type { OrderIntent, PortfolioSnapshot } from "../src/engine/types.ts";
import type { OrderExecutionContext } from "../src/engine/adapter.ts";

// ─── Fixtures ─────────────────────────────────────────────────────────────────

const CREDS = {
  apiKey: "PKTEST",
  apiSecret: "secret123",
  baseUrl: "https://paper-api.alpaca.markets",
};

function makeStore(armed = false): ConcreteCredentialStore {
  const store = new ConcreteCredentialStore();
  store.set(CREDS);
  if (armed) store.onArmed();
  return store;
}

function makePortfolio(overrides: Partial<PortfolioSnapshot> = {}): PortfolioSnapshot {
  return {
    cash: 10_000,
    equity: 10_000,
    positions: [],
    realizedPnl: 0,
    unrealizedPnl: 0,
    exposure: 0,
    ...overrides,
  };
}

function makeBuyIntent(overrides: Partial<OrderIntent> = {}): OrderIntent {
  return {
    side: "buy",
    symbol: "SPY",
    size: { type: "quantity", quantity: 10 },
    ...overrides,
  };
}

function makeSellIntent(overrides: Partial<OrderIntent> = {}): OrderIntent {
  return {
    side: "sell",
    symbol: "SPY",
    size: { type: "closePosition" },
    ...overrides,
  };
}

const CTX: OrderExecutionContext = { botId: "bah", clientOrderId: "client-order-1" };

/** Adapter config with poll interval = 0 for fast tests */
const FAST_CONFIG: AlpacaPaperAdapterConfig = {
  ...DEFAULT_ALPACA_PAPER_ADAPTER_CONFIG,
  fillPollIntervalMs: 0,
  fillPollMaxRetries: 3,
};

function makeFilledOrderResponse(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    id: "order-abc",
    client_order_id: "client-order-1",
    symbol: "SPY",
    side: "buy",
    type: "market",
    status: "filled",
    qty: "10",
    filled_qty: "10",
    filled_avg_price: "510.00",
    created_at: "2024-01-03T14:30:00Z",
    filled_at: "2024-01-03T14:30:01Z",
    ...overrides,
  };
}

// ─── adapter interface compliance ─────────────────────────────────────────────

describe("AlpacaPaperAdapter interface", () => {
  it("has mode === 'paper'", () => {
    const store = makeStore(true);
    const adapter = new AlpacaPaperAdapter(store);
    expect(adapter.mode).toBe("paper");
  });

  it("exposes executeAsync, reconcileAccount, ingestBrokerEvent", () => {
    const store = makeStore(true);
    const adapter = new AlpacaPaperAdapter(store);
    expect(typeof adapter.executeAsync).toBe("function");
    expect(typeof adapter.reconcileAccount).toBe("function");
    expect(typeof adapter.ingestBrokerEvent).toBe("function");
  });
});

// ─── toAlpacaOrder ────────────────────────────────────────────────────────────

describe("AlpacaPaperAdapter.toAlpacaOrder", () => {
  const store = makeStore(true);
  const adapter = new AlpacaPaperAdapter(store);

  it("maps quantity buy to { qty }", () => {
    const req = adapter.toAlpacaOrder(makeBuyIntent(), makePortfolio(), CTX);
    expect(req.symbol).toBe("SPY");
    expect(req.side).toBe("buy");
    expect(req.type).toBe("market");
    expect(req.qty).toBe("10");
    expect(req.notional).toBeUndefined();
    expect(req.client_order_id).toBe("client-order-1");
  });

  it("maps targetAllocation buy to { notional }", () => {
    const intent = makeBuyIntent({ size: { type: "targetAllocation", fraction: 0.5 } });
    const req = adapter.toAlpacaOrder(intent, makePortfolio({ equity: 10_000 }), CTX);
    expect(req.notional).toBe("5000.00");
    expect(req.qty).toBeUndefined();
  });

  it("maps closePosition sell to { qty: positionQty }", () => {
    const portfolio = makePortfolio({
      positions: [{ symbol: "SPY", quantity: 7, avgCost: 500 }],
    });
    const req = adapter.toAlpacaOrder(makeSellIntent(), portfolio, CTX);
    expect(req.side).toBe("sell");
    expect(req.qty).toBe("7");
  });

  it("maps sellPercent sell to floored fractional qty", () => {
    const portfolio = makePortfolio({
      positions: [{ symbol: "SPY", quantity: 10, avgCost: 500 }],
    });
    const intent = makeSellIntent({ size: { type: "sellPercent", fraction: 0.5 } });
    const req = adapter.toAlpacaOrder(intent, portfolio, CTX);
    expect(req.qty).toBe("5");
  });

  it("maps quantity sell capped at position qty", () => {
    const portfolio = makePortfolio({
      positions: [{ symbol: "SPY", quantity: 3, avgCost: 500 }],
    });
    const intent = makeSellIntent({ size: { type: "quantity", quantity: 100 } });
    const req = adapter.toAlpacaOrder(intent, portfolio, CTX);
    expect(req.qty).toBe("3");
  });
});

// ─── fromAlpacaFill ───────────────────────────────────────────────────────────

describe("AlpacaPaperAdapter.fromAlpacaFill", () => {
  const store = makeStore(true);
  const adapter = new AlpacaPaperAdapter(store);

  it("converts a filled order response to ExecutionFill", () => {
    const fill = adapter.fromAlpacaFill(makeFilledOrderResponse() as never);
    expect(fill.side).toBe("buy");
    expect(fill.symbol).toBe("SPY");
    expect(fill.quantity).toBe(10);
    expect(fill.price).toBe(510);
    expect(fill.fee).toBe(0); // Alpaca Paper = $0 commission
    expect(typeof fill.timestamp).toBe("number");
  });

  it("throws if order is not filled", () => {
    expect(() =>
      adapter.fromAlpacaFill(makeFilledOrderResponse({ status: "new" }) as never),
    ).toThrow(/not filled/i);
  });

  it("throws if filled_avg_price is null", () => {
    expect(() =>
      adapter.fromAlpacaFill(
        makeFilledOrderResponse({ status: "filled", filled_avg_price: null }) as never,
      ),
    ).toThrow(/null filled_avg_price/i);
  });
});

// ─── executeAsync ─────────────────────────────────────────────────────────────

describe("AlpacaPaperAdapter.executeAsync", () => {
  afterEach(() => vi.restoreAllMocks());

  it("throws GateDisarmedError when store is not armed", async () => {
    const store = new ConcreteCredentialStore();
    store.set(CREDS);
    // store is NOT armed (onArmed() not called)
    const adapter = new AlpacaPaperAdapter(store, FAST_CONFIG);
    await expect(
      adapter.executeAsync(makeBuyIntent(), makePortfolio(), CTX),
    ).rejects.toThrow(GateDisarmedError);
  });

  it("submits order and returns fill on immediate response", async () => {
    const store = makeStore(true);
    const adapter = new AlpacaPaperAdapter(store, FAST_CONFIG);
    const filled = makeFilledOrderResponse();

    vi.stubGlobal("fetch", vi.fn()
      // POST /v2/orders → returns order (starts as "new", but we test immediate fill too)
      .mockResolvedValueOnce({ ok: true, json: async () => filled })
      // GET /v2/orders/{id} → filled on first poll
      .mockResolvedValueOnce({ ok: true, json: async () => filled }),
    );

    const fill = await adapter.executeAsync(makeBuyIntent(), makePortfolio(), CTX);
    expect(fill.side).toBe("buy");
    expect(fill.symbol).toBe("SPY");
    expect(fill.quantity).toBe(10);
  });

  it("polls until order is filled", async () => {
    const store = makeStore(true);
    const adapter = new AlpacaPaperAdapter(store, FAST_CONFIG);

    const pending = makeFilledOrderResponse({ status: "new", filled_qty: "0", filled_avg_price: null });
    const filled  = makeFilledOrderResponse();

    const mockFetch = vi.fn()
      .mockResolvedValueOnce({ ok: true, json: async () => ({ ...pending, id: "order-abc" }) }) // POST
      .mockResolvedValueOnce({ ok: true, json: async () => pending })                            // poll 1
      .mockResolvedValueOnce({ ok: true, json: async () => filled });                             // poll 2

    vi.stubGlobal("fetch", mockFetch);

    const fill = await adapter.executeAsync(makeBuyIntent(), makePortfolio(), CTX);
    expect(fill.price).toBe(510);
    expect(mockFetch).toHaveBeenCalledTimes(3);
  });

  it("throws on fill timeout", async () => {
    const store = makeStore(true);
    const config: AlpacaPaperAdapterConfig = { ...FAST_CONFIG, fillPollMaxRetries: 2 };
    const adapter = new AlpacaPaperAdapter(store, config);

    const pending = makeFilledOrderResponse({ status: "new", filled_qty: "0", filled_avg_price: null });
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: true, json: async () => pending }));

    await expect(
      adapter.executeAsync(makeBuyIntent(), makePortfolio(), CTX),
    ).rejects.toThrow(/fill timeout/i);
  });

  it("throws on terminal order status (rejected)", async () => {
    const store = makeStore(true);
    const adapter = new AlpacaPaperAdapter(store, FAST_CONFIG);

    const rejected = makeFilledOrderResponse({ status: "rejected", filled_qty: "0", filled_avg_price: null });
    vi.stubGlobal("fetch", vi.fn()
      .mockResolvedValueOnce({ ok: true, json: async () => rejected }) // POST
      .mockResolvedValueOnce({ ok: true, json: async () => rejected }) // poll
    );

    await expect(
      adapter.executeAsync(makeBuyIntent(), makePortfolio(), CTX),
    ).rejects.toThrow(/terminal status.*rejected/i);
  });

  it("throws descriptive message on HTTP 403", async () => {
    const store = makeStore(true);
    const adapter = new AlpacaPaperAdapter(store, FAST_CONFIG);

    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({
      ok: false, status: 403, text: async () => "forbidden",
    }));

    await expect(
      adapter.executeAsync(makeBuyIntent(), makePortfolio(), CTX),
    ).rejects.toThrow(/403/);
  });

  it("wraps network errors with descriptive message", async () => {
    const store = makeStore(true);
    const adapter = new AlpacaPaperAdapter(store, FAST_CONFIG);

    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new TypeError("Failed to fetch")));

    await expect(
      adapter.executeAsync(makeBuyIntent(), makePortfolio(), CTX),
    ).rejects.toThrow(/network error/i);
  });
});

// ─── reconcileAccount ─────────────────────────────────────────────────────────

describe("AlpacaPaperAdapter.reconcileAccount", () => {
  afterEach(() => vi.restoreAllMocks());

  const accountResponse = {
    id: "acct-1",
    account_number: "PA12345",
    status: "ACTIVE",
    cash: "10000.00",
    portfolio_value: "10000.00",
    buying_power: "20000.00",
  };

  it("returns ok: true when cash and positions match", async () => {
    const store = makeStore(true);
    const adapter = new AlpacaPaperAdapter(store, FAST_CONFIG);

    vi.stubGlobal("fetch", vi.fn()
      .mockResolvedValueOnce({ ok: true, json: async () => accountResponse })
      .mockResolvedValueOnce({ ok: true, json: async () => [] }),
    );

    const result = await adapter.reconcileAccount(makePortfolio({ cash: 10_000 }));
    expect(result.ok).toBe(true);
    expect(result.drifts).toHaveLength(0);
  });

  it("detects cash drift beyond tolerance", async () => {
    const store = makeStore(true);
    const config = { ...FAST_CONFIG, driftToleranceCash: 5 };
    const adapter = new AlpacaPaperAdapter(store, config);

    // Broker cash = $10,000, engine cash = $9,900 → drift = $100 > $5 tolerance
    vi.stubGlobal("fetch", vi.fn()
      .mockResolvedValueOnce({ ok: true, json: async () => accountResponse })
      .mockResolvedValueOnce({ ok: true, json: async () => [] }),
    );

    const result = await adapter.reconcileAccount(makePortfolio({ cash: 9_900 }));
    expect(result.ok).toBe(false);
    expect(result.drifts.some((d) => d.symbol === undefined)).toBe(true);
    const cashDrift = result.drifts.find((d) => d.symbol === undefined)!;
    expect(cashDrift.delta).toBeCloseTo(100, 1);
  });

  it("detects position quantity drift beyond tolerance", async () => {
    const store = makeStore(true);
    const config = { ...FAST_CONFIG, driftToleranceShares: 0 };
    const adapter = new AlpacaPaperAdapter(store, config);

    // Broker has 10 SPY; engine has 8 SPY
    const positions = [{ symbol: "SPY", qty: "10", avg_entry_price: "500", market_value: "5000", unrealized_pl: "0" }];
    vi.stubGlobal("fetch", vi.fn()
      .mockResolvedValueOnce({ ok: true, json: async () => accountResponse })
      .mockResolvedValueOnce({ ok: true, json: async () => positions }),
    );

    const portfolio = makePortfolio({
      positions: [{ symbol: "SPY", quantity: 8, avgCost: 500 }],
    });
    const result = await adapter.reconcileAccount(portfolio);
    expect(result.ok).toBe(false);
    const spyDrift = result.drifts.find((d) => d.symbol === "SPY")!;
    expect(spyDrift.brokerValue).toBe(10);
    expect(spyDrift.engineValue).toBe(8);
  });

  it("no drift when position quantities match within tolerance", async () => {
    const store = makeStore(true);
    const config = { ...FAST_CONFIG, driftToleranceShares: 2 };
    const adapter = new AlpacaPaperAdapter(store, config);

    // Broker has 10 SPY; engine has 9 SPY → delta = 1 ≤ tolerance 2
    const positions = [{ symbol: "SPY", qty: "10", avg_entry_price: "500", market_value: "5000", unrealized_pl: "0" }];
    vi.stubGlobal("fetch", vi.fn()
      .mockResolvedValueOnce({ ok: true, json: async () => accountResponse })
      .mockResolvedValueOnce({ ok: true, json: async () => positions }),
    );

    const portfolio = makePortfolio({
      positions: [{ symbol: "SPY", quantity: 9, avgCost: 500 }],
    });
    const result = await adapter.reconcileAccount(portfolio);
    expect(result.ok).toBe(true);
  });

  it("surfaces symbol present in broker but absent in engine as drift", async () => {
    const store = makeStore(true);
    const config = { ...FAST_CONFIG, driftToleranceShares: 0 };
    const adapter = new AlpacaPaperAdapter(store, config);

    // Broker has AAPL position; engine has none
    const positions = [{ symbol: "AAPL", qty: "5", avg_entry_price: "180", market_value: "900", unrealized_pl: "0" }];
    vi.stubGlobal("fetch", vi.fn()
      .mockResolvedValueOnce({ ok: true, json: async () => accountResponse })
      .mockResolvedValueOnce({ ok: true, json: async () => positions }),
    );

    const result = await adapter.reconcileAccount(makePortfolio());
    expect(result.ok).toBe(false);
    expect(result.drifts.some((d) => d.symbol === "AAPL")).toBe(true);
  });

  it("throws GateDisarmedError when store is not armed", async () => {
    const store = new ConcreteCredentialStore();
    store.set(CREDS);
    // NOT armed
    const adapter = new AlpacaPaperAdapter(store, FAST_CONFIG);
    await expect(adapter.reconcileAccount(makePortfolio())).rejects.toThrow(GateDisarmedError);
  });
});

// ─── ingestBrokerEvent ────────────────────────────────────────────────────────

describe("AlpacaPaperAdapter.ingestBrokerEvent", () => {
  const store = makeStore(true);
  const adapter = new AlpacaPaperAdapter(store);
  const now = Date.now();

  it("maps trade_updates fill to ORDER_FILL", () => {
    const event = adapter.ingestBrokerEvent({
      type: "trade_updates",
      receivedAt: now,
      raw: { event: "fill", client_order_id: "bah_league_1234567890_1" },
    });
    expect(event.type).toBe("ORDER_FILL");
  });

  it("extracts botId from clientOrderId on fill", () => {
    const event = adapter.ingestBrokerEvent({
      type: "trade_updates",
      receivedAt: now,
      raw: { event: "fill", client_order_id: "mom_league_1234567890_2" },
    });
    expect(event.botId).toBe("mom");
  });

  it("sets botId to null when clientOrderId lacks _league_ separator", () => {
    const event = adapter.ingestBrokerEvent({
      type: "trade_updates",
      receivedAt: now,
      raw: { event: "fill", client_order_id: "some-other-format" },
    });
    expect(event.botId).toBeNull();
  });

  it("maps trade_updates rejected to ORDER_REJECTED", () => {
    const event = adapter.ingestBrokerEvent({
      type: "trade_updates",
      receivedAt: now,
      raw: { event: "rejected" },
    });
    expect(event.type).toBe("ORDER_REJECTED");
  });

  it("maps connection_error to WARNING", () => {
    const event = adapter.ingestBrokerEvent({
      type: "connection_error",
      receivedAt: now,
      raw: { message: "websocket closed" },
    });
    expect(event.type).toBe("WARNING");
  });

  it("maps auth_error to WARNING", () => {
    const event = adapter.ingestBrokerEvent({
      type: "auth_error",
      receivedAt: now,
      raw: { message: "unauthorized" },
    });
    expect(event.type).toBe("WARNING");
  });

  it("uses receivedAt as event timestamp", () => {
    const event = adapter.ingestBrokerEvent({
      type: "connection_error",
      receivedAt: now,
      raw: {},
    });
    expect(event.timestamp).toBe(now);
  });
});

// ─── fetchAccountCash ─────────────────────────────────────────────────────────

describe("AlpacaPaperAdapter.fetchAccountCash", () => {
  afterEach(() => vi.restoreAllMocks());

  it("returns parsed cash from /v2/account", async () => {
    const store = makeStore(true);
    const adapter = new AlpacaPaperAdapter(store, FAST_CONFIG);

    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        id: "a1", account_number: "PA123", status: "ACTIVE",
        cash: "97000.00", portfolio_value: "100000.00", buying_power: "97000.00",
      }),
    }));

    const cash = await adapter.fetchAccountCash();
    expect(cash).toBe(97_000);
  });

  it("throws GateDisarmedError when gate is not armed", async () => {
    const store = makeStore(false); // not armed
    const adapter = new AlpacaPaperAdapter(store, FAST_CONFIG);
    await expect(adapter.fetchAccountCash()).rejects.toThrow(GateDisarmedError);
  });

  it("throws on HTTP error", async () => {
    const store = makeStore(true);
    const adapter = new AlpacaPaperAdapter(store, FAST_CONFIG);

    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({
      ok: false, status: 401, text: async () => "unauthorized",
    }));

    await expect(adapter.fetchAccountCash()).rejects.toThrow(/401/);
  });
});

// ─── makeAlpacaArmingPreconditions ────────────────────────────────────────────

describe("makeAlpacaArmingPreconditions", () => {
  afterEach(() => vi.restoreAllMocks());

  it("returns an array of 3 preconditions", () => {
    const store = new ConcreteCredentialStore();
    const preconditions = makeAlpacaArmingPreconditions(store);
    expect(preconditions).toHaveLength(3);
  });

  it("fails credentials-present when store is empty", async () => {
    const store = new ConcreteCredentialStore();
    const [p1] = makeAlpacaArmingPreconditions(store);
    const result = await p1!();
    expect(result.check).toBe("credentials-present");
    expect(result.passed).toBe(false);
    expect(result.detail).toBeTruthy();
  });

  it("passes credentials-present when store has creds", async () => {
    const store = new ConcreteCredentialStore();
    store.set(CREDS);
    const [p1] = makeAlpacaArmingPreconditions(store);
    const result = await p1!();
    expect(result.passed).toBe(true);
  });

  it("fails account-reachable on HTTP 401", async () => {
    const store = new ConcreteCredentialStore();
    store.set(CREDS);

    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({
      ok: false, status: 401, text: async () => "unauthorized",
    }));

    const [, p2] = makeAlpacaArmingPreconditions(store);
    const result = await p2!();
    expect(result.check).toBe("account-reachable");
    expect(result.passed).toBe(false);
    expect(result.detail).toMatch(/401/);
  });

  it("fails account-reachable on network error", async () => {
    const store = new ConcreteCredentialStore();
    store.set(CREDS);

    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new TypeError("Failed to fetch")));

    const [, p2] = makeAlpacaArmingPreconditions(store);
    const result = await p2!();
    expect(result.passed).toBe(false);
    expect(result.detail).toMatch(/network error/i);
  });

  it("fails account-active when account status is not ACTIVE", async () => {
    const store = new ConcreteCredentialStore();
    store.set(CREDS);

    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ id: "a1", account_number: "PA123", status: "ACCOUNT_UPDATED" }),
    }));

    const [, p2, p3] = makeAlpacaArmingPreconditions(store);
    await p2!(); // run fetch (populates shared closure)
    const result = await p3!();
    expect(result.check).toBe("account-active");
    expect(result.passed).toBe(false);
    expect(result.detail).toMatch(/ACCOUNT_UPDATED/);
  });

  it("all 3 preconditions pass for an ACTIVE account", async () => {
    const store = new ConcreteCredentialStore();
    store.set(CREDS);

    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ id: "a1", account_number: "PA123", status: "ACTIVE" }),
    }));

    const [p1, p2, p3] = makeAlpacaArmingPreconditions(store);
    const r1 = await p1!();
    const r2 = await p2!();
    const r3 = await p3!();
    expect(r1.passed).toBe(true);
    expect(r2.passed).toBe(true);
    expect(r3.passed).toBe(true);
  });

  it("full gate arm succeeds with a mocked ACTIVE account", async () => {
    const store = new ConcreteCredentialStore();
    store.set(CREDS);

    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ id: "a1", account_number: "PA123", status: "ACTIVE" }),
    }));

    const preconditions = makeAlpacaArmingPreconditions(store);
    const auditLog = new AuditLog();
    const gate = new ConcreteEnablementGate(preconditions, auditLog, 999_999);
    gate.subscribe(store);

    const ok = await gate.arm();
    expect(ok).toBe(true);
    expect(gate.status).toBe("ARMED");
  });

  it("full gate arm fails on HTTP 403", async () => {
    const store = new ConcreteCredentialStore();
    store.set(CREDS);

    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({
      ok: false, status: 403, text: async () => "forbidden",
    }));

    const preconditions = makeAlpacaArmingPreconditions(store);
    const auditLog = new AuditLog();
    const gate = new ConcreteEnablementGate(preconditions, auditLog, 999_999);
    gate.subscribe(store);

    const ok = await gate.arm();
    expect(ok).toBe(false);
    expect(gate.status).toBe("DISARMED");
  });
});

// ─── resetStats boundary (GovernanceEngine) ───────────────────────────────────

describe("GovernanceEngine.resetStats forceReset boundary", () => {
  it("full reset clears all counters regardless of UTC day", async () => {
    const { GovernanceEngine } = await import("../src/engine/governance/governanceEngine.ts");
    const { ConcreteEnablementGate } = await import("../src/engine/governance/enablementGate.ts");
    const { AuditLog } = await import("../src/engine/governance/auditLog.ts");
    const { GateDisarmedError: _GDE } = await import("../src/engine/brokerTypes.ts");

    const auditLog = new AuditLog();
    const gate = new ConcreteEnablementGate([], auditLog, 999_999);
    // No preconditions — arm() passes immediately.
    const ok = await gate.arm();
    expect(ok).toBe(true);

    const config = {
      allowedSymbols: ["SPY"],
      maxOpenOrders: 5,
      maxOrdersPerDay: 20,
      maxOrderNotional: 100_000,
      driftToleranceShares: 1,
      driftToleranceCash: 10,
      autoDisarmAfterMs: 999_999,
      maxPositionFractionOfEquity: 0.99,
      maxRealizedDailyLossUsd: 1_000,
      botCapitalAllocationUsd: 10_000,
    };
    const governance = new GovernanceEngine(config, gate, auditLog);

    governance.recordOrderSubmitted("bot1");
    governance.recordOrderSubmitted("bot1");
    governance.recordRealisedPnl("bot1", -200);
    governance.setCommittedCapital("bot1", 5_000);

    let stats = governance.getStats("bot1");
    expect(stats.dailyOrderCount).toBe(2);
    expect(stats.realizedDailyLossUsd).toBe(200);
    expect(stats.committedCapitalUsd).toBe(5_000);

    // Force reset: clears everything
    governance.resetStats("bot1", true);
    stats = governance.getStats("bot1");
    expect(stats.dailyOrderCount).toBe(0);
    expect(stats.realizedDailyLossUsd).toBe(0);
    expect(stats.committedCapitalUsd).toBe(0);
  });

  it("date-aware reset preserves daily counters within the same UTC day", async () => {
    const { GovernanceEngine } = await import("../src/engine/governance/governanceEngine.ts");
    const { ConcreteEnablementGate } = await import("../src/engine/governance/enablementGate.ts");
    const { AuditLog } = await import("../src/engine/governance/auditLog.ts");

    const auditLog = new AuditLog();
    const gate = new ConcreteEnablementGate([], auditLog, 999_999);
    await gate.arm();

    const config = {
      allowedSymbols: ["SPY"],
      maxOpenOrders: 5,
      maxOrdersPerDay: 20,
      maxOrderNotional: 100_000,
      driftToleranceShares: 1,
      driftToleranceCash: 10,
      autoDisarmAfterMs: 999_999,
      maxPositionFractionOfEquity: 0.99,
      maxRealizedDailyLossUsd: 1_000,
      botCapitalAllocationUsd: 10_000,
    };
    const governance = new GovernanceEngine(config, gate, auditLog);

    governance.recordOrderSubmitted("bot1");
    governance.recordOrderSubmitted("bot1");
    governance.recordRealisedPnl("bot1", -150);
    governance.setCommittedCapital("bot1", 3_000);

    // Date-aware reset within the same UTC day: daily counters preserved
    governance.resetStats("bot1", false);
    const stats = governance.getStats("bot1");
    expect(stats.dailyOrderCount).toBe(2);           // preserved
    expect(stats.realizedDailyLossUsd).toBe(150);    // preserved
    expect(stats.committedCapitalUsd).toBe(0);        // always reset
  });
});
