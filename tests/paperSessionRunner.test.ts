import { describe, it, expect, vi } from "vitest";
import { PaperSessionRunner } from "../src/engine/paperSessionRunner.ts";
import { GovernanceEngine } from "../src/engine/governance/governanceEngine.ts";
import { ConcreteEnablementGate } from "../src/engine/governance/enablementGate.ts";
import { AuditLog } from "../src/engine/governance/auditLog.ts";
import { GateDisarmedError } from "../src/engine/brokerTypes.ts";
import type { BrokerAdapter } from "../src/engine/adapter.ts";
import type { BotSpec, Candle, ExecutionFill, OrderIntent, PortfolioSnapshot } from "../src/engine/types.ts";
import type { ArenaEvent } from "../src/engine/types.ts";
import type { BrokerEventEnvelope, BrokerReconciliationResult, PaperAdapterConfig } from "../src/engine/brokerTypes.ts";
import { buyAndHold } from "../src/strategies/buyAndHold.ts";
import { sampleDataset } from "../src/data/sampleDataset.ts";

// ─── Fixtures ─────────────────────────────────────────────────────────────────

const simConfig = { startingCash: 10_000, feeBps: 5, slippageBps: 3, seed: 42 };

const paperConfig: PaperAdapterConfig = {
  allowedSymbols: ["ARENA"],
  maxOpenOrders: 10,
  maxOrdersPerDay: 10,
  maxOrderNotional: 999_999,
  driftToleranceShares: 1,
  driftToleranceCash: 1,
  autoDisarmAfterMs: 4 * 60 * 60 * 1000,
  maxPositionFractionOfEquity: 1.0,
  maxRealizedDailyLossUsd: 999_999,
  botCapitalAllocationUsd: 999_999,
};

const buyAndHoldSpec: BotSpec = { id: "bah", name: "B&H", strategy: buyAndHold };

function makeFill(candle: Candle): ExecutionFill {
  return {
    side: "buy",
    symbol: "ARENA",
    quantity: 10,
    price: candle.close,
    fee: 0.5,
    timestamp: candle.timestamp,
  };
}

function makeOkReconciliation(portfolio: PortfolioSnapshot): BrokerReconciliationResult {
  return {
    ok: true,
    drifts: [],
    engineSnapshot: portfolio,
    brokerSnapshot: {
      id: "acct1",
      account_number: "PA-TEST",
      status: "ACTIVE",
      cash: String(portfolio.cash),
      portfolio_value: String(portfolio.equity),
      buying_power: String(portfolio.cash * 2),
      positions: [],
      orders_pending: [],
      fetched_at: Date.now(),
    },
    reconciledAt: Date.now(),
  };
}

function makeDriftReconciliation(portfolio: PortfolioSnapshot): BrokerReconciliationResult {
  return {
    ok: false,
    drifts: [{ symbol: "ARENA", engineValue: 10, brokerValue: 9, delta: -1 }],
    engineSnapshot: portfolio,
    brokerSnapshot: {
      id: "acct1",
      account_number: "PA-TEST",
      status: "ACTIVE",
      cash: "9999",
      portfolio_value: "9999",
      buying_power: "9999",
      positions: [],
      orders_pending: [],
      fetched_at: Date.now(),
    },
    reconciledAt: Date.now(),
  };
}

function makeMockAdapter(
  fillFactory?: (intent: OrderIntent, portfolio: PortfolioSnapshot) => ExecutionFill,
  reconcileFactory?: (portfolio: PortfolioSnapshot) => BrokerReconciliationResult,
): BrokerAdapter {
  return {
    mode: "paper",
    executeAsync: vi.fn(async (intent, portfolio) =>
      fillFactory ? fillFactory(intent, portfolio) : makeFill(sampleDataset.candles[0]!),
    ),
    reconcileAccount: vi.fn(async (portfolio) =>
      reconcileFactory ? reconcileFactory(portfolio) : makeOkReconciliation(portfolio),
    ),
    ingestBrokerEvent: vi.fn((_envelope: BrokerEventEnvelope): ArenaEvent => ({
      type: "WARNING",
      timestamp: Date.now(),
      candleIndex: 0,
      botId: null,
      payload: {},
    })),
  };
}

async function makeRunner(adapterOverride?: BrokerAdapter) {
  const auditLog = new AuditLog();
  const gate = new ConcreteEnablementGate([], auditLog, 60_000);
  await gate.arm();
  const engine = new GovernanceEngine(paperConfig, gate, auditLog);
  const adapter = adapterOverride ?? makeMockAdapter();
  const runner = new PaperSessionRunner(
    simConfig,
    buyAndHoldSpec,   // ← single BotSpec
    adapter,
    engine,
    auditLog,
    gate,
    "ARENA",
  );
  return { runner, gate, engine, auditLog, adapter };
}

// ─── start() ─────────────────────────────────────────────────────────────────

describe("PaperSessionRunner — start()", () => {
  it("throws GateDisarmedError if gate is not ARMED", async () => {
    const auditLog = new AuditLog();
    const gate = new ConcreteEnablementGate([], auditLog);
    const engine = new GovernanceEngine(paperConfig, gate, auditLog);
    const runner = new PaperSessionRunner(
      simConfig, buyAndHoldSpec, makeMockAdapter(), engine, auditLog, gate, "ARENA",
    );
    await expect(runner.start()).rejects.toThrow(GateDisarmedError);
  });

  it("sets running = true after successful start()", async () => {
    const { runner } = await makeRunner();
    await runner.start();
    expect(runner.getState().running).toBe(true);
  });

  it("emits MATCH_START and PAPER_MODE_ARMED events", async () => {
    const { runner } = await makeRunner();
    await runner.start();
    const types = runner.getEvents().map((e) => e.type);
    expect(types).toContain("MATCH_START");
    expect(types).toContain("PAPER_MODE_ARMED");
  });

  it("throws if start() called twice", async () => {
    const { runner } = await makeRunner();
    await runner.start();
    await expect(runner.start()).rejects.toThrow();
  });

  it("performs session-start reconciliation for the bot", async () => {
    const mockAdapter = makeMockAdapter();
    const { runner } = await makeRunner(mockAdapter);
    await runner.start();
    expect(mockAdapter.reconcileAccount).toHaveBeenCalledTimes(1);
  });

  it("records RECONCILIATION in audit log on successful start", async () => {
    const { runner, auditLog } = await makeRunner();
    await runner.start();
    const recons = auditLog.filter("RECONCILIATION");
    expect(recons.length).toBeGreaterThanOrEqual(1);
    expect(recons[0]!.payload["ok"]).toBe(true);
  });

  it("records SESSION_START in audit log", async () => {
    const { runner, auditLog } = await makeRunner();
    await runner.start();
    const entries = auditLog.filter("SESSION_START");
    const sessionStart = entries.find((e) => e.message.includes("Paper session started"));
    expect(sessionStart).toBeDefined();
  });

  // ── Fail-closed: reconcile throws ────────────────────────────────────────

  it("disarms gate and throws when session-start reconciliation throws", async () => {
    const throwingAdapter = makeMockAdapter(
      undefined,
      () => { throw new Error("NOT_IMPLEMENTED"); },
    );
    const { runner, gate } = await makeRunner(throwingAdapter);
    await expect(runner.start()).rejects.toThrow("NOT_IMPLEMENTED");
    expect(gate.status).toBe("DISARMED_ON_ERROR");
  });

  it("records ERROR in audit log when reconciliation throws", async () => {
    const throwingAdapter = makeMockAdapter(
      undefined,
      () => { throw new Error("connection refused"); },
    );
    const { runner, auditLog } = await makeRunner(throwingAdapter);
    await expect(runner.start()).rejects.toThrow();
    const errors = auditLog.filter("ERROR");
    expect(errors.length).toBeGreaterThanOrEqual(1);
    expect(errors[0]!.message).toContain("connection refused");
  });

  // ── Fail-closed: reconcile returns drift ─────────────────────────────────

  it("disarms gate and throws when session-start reconciliation has drift", async () => {
    const driftAdapter = makeMockAdapter(undefined, makeDriftReconciliation);
    const { runner, gate } = await makeRunner(driftAdapter);
    await expect(runner.start()).rejects.toThrow("drift");
    expect(gate.status).not.toBe("ARMED");
  });

  it("emits RECONCILIATION_DRIFT event when session-start drift is detected", async () => {
    const driftAdapter = makeMockAdapter(undefined, makeDriftReconciliation);
    const { runner } = await makeRunner(driftAdapter);
    await expect(runner.start()).rejects.toThrow();
    expect(runner.getEvents().some((e) => e.type === "RECONCILIATION_DRIFT")).toBe(true);
  });
});

// ─── tick() ──────────────────────────────────────────────────────────────────

describe("PaperSessionRunner — tick()", () => {
  it("throws if tick() called before start()", async () => {
    const { runner } = await makeRunner();
    const candle = sampleDataset.candles[0]!;
    await expect(runner.tick(candle, [candle])).rejects.toThrow();
  });

  it("emits CANDLE_OPEN for each tick", async () => {
    const { runner } = await makeRunner();
    await runner.start();
    const candle = sampleDataset.candles[0]!;
    await runner.tick(candle, [candle]);
    expect(runner.getEvents().some((e) => e.type === "CANDLE_OPEN")).toBe(true);
  });

  it("increments candlesProcessed after each tick", async () => {
    const { runner } = await makeRunner();
    await runner.start();
    for (let i = 0; i < 3; i++) {
      await runner.tick(sampleDataset.candles[i]!, sampleDataset.candles.slice(0, i + 1));
    }
    expect(runner.getState().candlesProcessed).toBe(3);
  });

  it("calls adapter.executeAsync when strategy emits an intent", async () => {
    const mockAdapter = makeMockAdapter();
    const { runner } = await makeRunner(mockAdapter);
    await runner.start();
    await runner.tick(sampleDataset.candles[0]!, [sampleDataset.candles[0]!]);
    expect(mockAdapter.executeAsync).toHaveBeenCalledTimes(1);
  });

  it("emits ORDER_FILL event after successful fill", async () => {
    const { runner } = await makeRunner();
    await runner.start();
    await runner.tick(sampleDataset.candles[0]!, [sampleDataset.candles[0]!]);
    expect(runner.getEvents().some((e) => e.type === "ORDER_FILL")).toBe(true);
  });

  it("does not call executeAsync on candles after initial buy (B&H)", async () => {
    const mockAdapter = makeMockAdapter();
    const { runner } = await makeRunner(mockAdapter);
    await runner.start();
    for (let i = 0; i < 5; i++) {
      await runner.tick(sampleDataset.candles[i]!, sampleDataset.candles.slice(0, i + 1));
    }
    expect(mockAdapter.executeAsync).toHaveBeenCalledTimes(1);
  });

  it("disarms gate and emits WARNING when adapter.executeAsync throws", async () => {
    const errorAdapter: BrokerAdapter = {
      mode: "paper",
      executeAsync: vi.fn(async () => { throw new Error("network timeout"); }),
      reconcileAccount: vi.fn(async (p) => makeOkReconciliation(p)),
      ingestBrokerEvent: vi.fn((_e: BrokerEventEnvelope): ArenaEvent => ({
        type: "WARNING", timestamp: Date.now(), candleIndex: 0, botId: null, payload: {},
      })),
    };
    const { runner, gate } = await makeRunner(errorAdapter);
    await runner.start();
    await runner.tick(sampleDataset.candles[0]!, [sampleDataset.candles[0]!]);
    expect(gate.status).toBe("DISARMED_ON_ERROR");
    expect(runner.getEvents().some((e) => e.type === "WARNING")).toBe(true);
  });

  it("governance block emits ORDER_REJECTED without calling adapter", async () => {
    const badSpec: BotSpec = {
      id: "bad",
      name: "Bad",
      strategy: {
        name: "bad-symbol",
        fn: () => ({ side: "buy" as const, symbol: "BADSTOCK", size: { type: "quantity" as const, quantity: 1 } }),
      },
    };
    const auditLog = new AuditLog();
    const gate = new ConcreteEnablementGate([], auditLog, 60_000);
    await gate.arm();
    const engine = new GovernanceEngine(paperConfig, gate, auditLog);
    const mockAdapter = makeMockAdapter();
    const runner = new PaperSessionRunner(
      simConfig, badSpec, mockAdapter, engine, auditLog, gate, "ARENA",
    );
    await runner.start();
    await runner.tick(sampleDataset.candles[0]!, [sampleDataset.candles[0]!]);
    expect(mockAdapter.executeAsync).not.toHaveBeenCalled();
    expect(runner.getEvents().some((e) => e.type === "ORDER_REJECTED")).toBe(true);
  });

  it("builds equityHistory for each candle", async () => {
    const { runner } = await makeRunner();
    await runner.start();
    for (let i = 0; i < 4; i++) {
      await runner.tick(sampleDataset.candles[i]!, sampleDataset.candles.slice(0, i + 1));
    }
    expect(runner.getState().bot.equityHistory).toHaveLength(4);
  });
});

// ─── end() ───────────────────────────────────────────────────────────────────

describe("PaperSessionRunner — end()", () => {
  it("sets running = false", async () => {
    const { runner } = await makeRunner();
    await runner.start();
    await runner.end();
    expect(runner.getState().running).toBe(false);
  });

  it("records SESSION_END in audit log", async () => {
    const { runner, auditLog } = await makeRunner();
    await runner.start();
    await runner.end();
    expect(auditLog.filter("SESSION_END").length).toBeGreaterThanOrEqual(1);
  });

  it("emits MATCH_END to event log", async () => {
    const { runner } = await makeRunner();
    await runner.start();
    await runner.end();
    expect(runner.getEvents().some((e) => e.type === "MATCH_END")).toBe(true);
  });

  it("calls reconcileAccount on start and end", async () => {
    const mockAdapter = makeMockAdapter();
    const { runner } = await makeRunner(mockAdapter);
    await runner.start();
    await runner.end();
    expect(mockAdapter.reconcileAccount).toHaveBeenCalledTimes(2); // start + end
  });

  it("is safe to call end() without start()", async () => {
    const { runner } = await makeRunner();
    await expect(runner.end()).resolves.not.toThrow();
  });

  it("is safe to call end() twice", async () => {
    const { runner } = await makeRunner();
    await runner.start();
    await runner.end();
    await expect(runner.end()).resolves.not.toThrow();
  });

  // ── Fail-closed: end-of-session reconciliation ────────────────────────────

  it("disarms gate when end-of-session reconciliation throws", async () => {
    let callCount = 0;
    const adapter = makeMockAdapter(
      undefined,
      (p) => {
        callCount++;
        if (callCount === 2) throw new Error("ws disconnected");
        return makeOkReconciliation(p);
      },
    );
    const { runner, gate } = await makeRunner(adapter);
    await runner.start();
    await runner.end();
    expect(gate.status).toBe("DISARMED_ON_ERROR");
  });

  it("disarms gate when end-of-session reconciliation has drift", async () => {
    let callCount = 0;
    const adapter = makeMockAdapter(
      undefined,
      (p) => {
        callCount++;
        return callCount === 2 ? makeDriftReconciliation(p) : makeOkReconciliation(p);
      },
    );
    const { runner, gate } = await makeRunner(adapter);
    await runner.start();
    await runner.end();
    expect(gate.status).not.toBe("ARMED");
    expect(runner.getEvents().some((e) => e.type === "RECONCILIATION_DRIFT")).toBe(true);
  });
});

// ─── Single bot/account architecture ─────────────────────────────────────────

describe("PaperSessionRunner — single bot/account boundary", () => {
  it("one runner manages exactly one BotSpec", async () => {
    const { runner } = await makeRunner();
    await runner.start();
    expect(runner.getState().bot.spec.id).toBe("bah");
  });

  it("accepts the same BotSpec type as createSimulation", async () => {
    const { createSimulation } = await import("../src/engine/simulation.ts");
    const sim = createSimulation(simConfig, sampleDataset, [buyAndHoldSpec]);
    sim.runToEnd();
    expect(sim.getStandings()[0]!.botId).toBe("bah");

    const { runner } = await makeRunner();
    await runner.start();
    expect(runner.getState().bot.spec.id).toBe("bah");
  });
});
