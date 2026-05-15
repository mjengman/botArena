/**
 * PaperLeagueRunner tests.
 *
 * Coverage:
 *   - Construction: sleeves initialised with correct starting capital
 *   - start(): gate check, session-start reconciliation (ok + drift)
 *   - tick(): active bots get strategy → fill; non-ACTIVE bots skipped
 *   - Bot eligibility lifecycle: pause / resume / eliminate / refund
 *   - Auto-elimination on equity threshold breach
 *   - Account-level reconciliation: drift disarms gate for ALL bots
 *   - getState() / getAllocations() accuracy
 *   - end(): session-end reconciliation + SESSION_END audit entry
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { PaperLeagueRunner } from "../src/engine/paperLeagueRunner.ts";
import { GovernanceEngine } from "../src/engine/governance/governanceEngine.ts";
import { ConcreteEnablementGate } from "../src/engine/governance/enablementGate.ts";
import { AuditLog } from "../src/engine/governance/auditLog.ts";
import { SimulatedPaperAdapter } from "../src/engine/adapters/simulatedPaperAdapter.ts";
import { buyAndHold } from "../src/strategies/buyAndHold.ts";
import { randomBaseline } from "../src/strategies/randomBaseline.ts";
import type { BotSpec, Candle, PortfolioSnapshot, SimulationConfig } from "../src/engine/types.ts";
import type { PaperAdapterConfig } from "../src/engine/brokerTypes.ts";
import type {
  BrokerAdapter,
  BrokerReconciliationResult,
} from "../src/engine/adapter.ts";
import type { AlpacaAccountSnapshot } from "../src/engine/brokerTypes.ts";
import { GateDisarmedError } from "../src/engine/brokerTypes.ts";
import { AUTO_ELIMINATION_THRESHOLD } from "../src/engine/leagueTypes.ts";

// ─── Fixtures ─────────────────────────────────────────────────────────────────

const SYMBOL = "LEAGUE";

const SIM_CONFIG: SimulationConfig = {
  startingCash: 10_000,
  feeBps: 5,
  slippageBps: 5,
  seed: 1,
};

const PAPER_CONFIG: PaperAdapterConfig = {
  allowedSymbols: [SYMBOL],
  maxOpenOrders: 10,
  maxOrdersPerDay: 20,
  maxOrderNotional: 100_000,
  driftToleranceShares: 1,
  driftToleranceCash: 10,
  autoDisarmAfterMs: 4 * 60 * 60 * 1000,
  maxPositionFractionOfEquity: 0.99,
  maxRealizedDailyLossUsd: 5_000,
  botCapitalAllocationUsd: 10_000, // overridden per-bot in league
};

const BOT_A: BotSpec = { id: "bot-a", name: "Buy & Hold A", strategy: buyAndHold };
const BOT_B: BotSpec = { id: "bot-b", name: "Random B",     strategy: randomBaseline };

function makeCandle(close: number, offset = 0): Candle {
  return {
    timestamp: Date.UTC(2024, 0, 2) + offset * 86_400_000,
    open: close * 0.99,
    high: close * 1.01,
    low: close * 0.98,
    close,
    volume: 100_000,
  };
}

/** A minimal BrokerAdapter that always reconciles OK. */
function makeOkAdapter(): BrokerAdapter {
  return {
    mode: "paper",
    executeAsync: vi.fn().mockRejectedValue(new Error("not implemented")),
    reconcileAccount: vi.fn().mockImplementation(
      async (snap: PortfolioSnapshot): Promise<BrokerReconciliationResult> => ({
        ok: true,
        drifts: [],
        engineSnapshot: snap,
        brokerSnapshot: {} as AlpacaAccountSnapshot,
        reconciledAt: Date.now(),
      }),
    ),
    ingestBrokerEvent: vi.fn(),
  };
}

/** A BrokerAdapter whose reconcileAccount returns drift. */
function makeDriftAdapter(): BrokerAdapter {
  return {
    mode: "paper",
    executeAsync: vi.fn().mockRejectedValue(new Error("not implemented")),
    reconcileAccount: vi.fn().mockResolvedValue({
      ok: false,
      drifts: [{ symbol: SYMBOL, engineValue: 10, brokerValue: 5, delta: -5 }],
      engineSnapshot: {} as PortfolioSnapshot,
      brokerSnapshot: {} as AlpacaAccountSnapshot,
      reconciledAt: Date.now(),
    } satisfies BrokerReconciliationResult),
    ingestBrokerEvent: vi.fn(),
  };
}

async function makeArmedStack(configOverride: Partial<PaperAdapterConfig> = {}) {
  const auditLog = new AuditLog();
  const gate = new ConcreteEnablementGate([], auditLog, 60_000);
  await gate.arm();
  const governance = new GovernanceEngine({ ...PAPER_CONFIG, ...configOverride }, gate, auditLog);
  return { auditLog, gate, governance };
}

// ─── Construction ─────────────────────────────────────────────────────────────

describe("PaperLeagueRunner — construction", () => {
  it("creates sleeves for each BotSpec with the correct starting capital", async () => {
    const adapter = new SimulatedPaperAdapter(SIM_CONFIG.feeBps, SIM_CONFIG.slippageBps);
    const { auditLog, gate, governance } = await makeArmedStack();

    const runner = new PaperLeagueRunner(
      SIM_CONFIG,
      [BOT_A, BOT_B],
      { "bot-a": 8_000, "bot-b": 2_000 },
      adapter, governance, auditLog, gate, SYMBOL,
    );

    const allocs = runner.getAllocations();
    expect(allocs).toHaveLength(2);
    expect(allocs.find((a) => a.botId === "bot-a")?.startingCapital).toBe(8_000);
    expect(allocs.find((a) => a.botId === "bot-b")?.startingCapital).toBe(2_000);
  });

  it("all bots start ACTIVE", async () => {
    const adapter = new SimulatedPaperAdapter(SIM_CONFIG.feeBps, SIM_CONFIG.slippageBps);
    const { auditLog, gate, governance } = await makeArmedStack();

    const runner = new PaperLeagueRunner(
      SIM_CONFIG, [BOT_A, BOT_B], {}, adapter, governance, auditLog, gate, SYMBOL,
    );

    for (const alloc of runner.getAllocations()) {
      expect(alloc.status).toBe("ACTIVE");
    }
  });

  it("falls back to config.startingCash for bots not in allocations map", async () => {
    const adapter = new SimulatedPaperAdapter(SIM_CONFIG.feeBps, SIM_CONFIG.slippageBps);
    const { auditLog, gate, governance } = await makeArmedStack();

    const runner = new PaperLeagueRunner(
      SIM_CONFIG, [BOT_A], {}, adapter, governance, auditLog, gate, SYMBOL,
    );

    expect(runner.getAllocations()[0]?.startingCapital).toBe(SIM_CONFIG.startingCash);
  });
});

// ─── start() ─────────────────────────────────────────────────────────────────

describe("PaperLeagueRunner — start()", () => {
  it("throws GateDisarmedError when gate is not ARMED", async () => {
    const auditLog = new AuditLog();
    const gate = new ConcreteEnablementGate([], auditLog, 60_000);
    // gate stays DISARMED
    const governance = new GovernanceEngine(PAPER_CONFIG, gate, auditLog);
    const adapter = new SimulatedPaperAdapter(SIM_CONFIG.feeBps, SIM_CONFIG.slippageBps);

    const runner = new PaperLeagueRunner(
      SIM_CONFIG, [BOT_A], {}, adapter, governance, auditLog, gate, SYMBOL,
    );
    await expect(runner.start()).rejects.toThrow(GateDisarmedError);
  });

  it("sets running = true after successful start()", async () => {
    const adapter = makeOkAdapter();
    const { auditLog, gate, governance } = await makeArmedStack();
    const runner = new PaperLeagueRunner(
      SIM_CONFIG, [BOT_A], {}, adapter, governance, auditLog, gate, SYMBOL,
    );

    await runner.start();
    expect(runner.getState().running).toBe(true);
  });

  it("records SESSION_START in the audit log", async () => {
    const adapter = makeOkAdapter();
    const { auditLog, gate, governance } = await makeArmedStack();
    const runner = new PaperLeagueRunner(
      SIM_CONFIG, [BOT_A], {}, adapter, governance, auditLog, gate, SYMBOL,
    );

    await runner.start();
    const starts = auditLog.filter("SESSION_START");
    expect(starts.length).toBeGreaterThanOrEqual(1);
    expect(starts.at(-1)?.payload["botCount"]).toBe(1);
  });

  it("throws and disarms gate when session-start reconciliation drifts", async () => {
    const adapter = makeDriftAdapter();
    const { auditLog, gate, governance } = await makeArmedStack();
    const runner = new PaperLeagueRunner(
      SIM_CONFIG, [BOT_A], {}, adapter, governance, auditLog, gate, SYMBOL,
    );

    await expect(runner.start()).rejects.toThrow(/drift/i);
    expect(gate.status).toBe("DISARMED_ON_ERROR");
  });

  it("throws if start() is called twice", async () => {
    const adapter = makeOkAdapter();
    const { auditLog, gate, governance } = await makeArmedStack();
    const runner = new PaperLeagueRunner(
      SIM_CONFIG, [BOT_A], {}, adapter, governance, auditLog, gate, SYMBOL,
    );

    await runner.start();
    await expect(runner.start()).rejects.toThrow(/already running/);
  });
});

// ─── tick() ──────────────────────────────────────────────────────────────────

describe("PaperLeagueRunner — tick()", () => {
  it("throws if tick() is called before start()", async () => {
    const adapter = new SimulatedPaperAdapter(SIM_CONFIG.feeBps, SIM_CONFIG.slippageBps);
    const { auditLog, gate, governance } = await makeArmedStack();
    const runner = new PaperLeagueRunner(
      SIM_CONFIG, [BOT_A], {}, adapter, governance, auditLog, gate, SYMBOL,
    );

    await expect(runner.tick(makeCandle(100), [makeCandle(100)])).rejects.toThrow(/start\(\) first/);
  });

  it("increments candlesProcessed after each tick()", async () => {
    const adapter = new SimulatedPaperAdapter(SIM_CONFIG.feeBps, SIM_CONFIG.slippageBps);
    const { auditLog, gate, governance } = await makeArmedStack();
    const runner = new PaperLeagueRunner(
      SIM_CONFIG, [BOT_A], { "bot-a": 10_000 }, adapter, governance, auditLog, gate, SYMBOL,
    );
    await runner.start();

    const candle = makeCandle(100);
    adapter.setCurrentCandle(candle.close, candle.timestamp);
    await runner.tick(candle, [candle]);
    expect(runner.getState().candlesProcessed).toBe(1);

    adapter.setCurrentCandle(candle.close, candle.timestamp + 86_400_000);
    await runner.tick(makeCandle(105, 1), [candle, makeCandle(105, 1)]);
    expect(runner.getState().candlesProcessed).toBe(2);
  });

  it("Buy & Hold bot receives a fill on the first candle", async () => {
    const adapter = new SimulatedPaperAdapter(SIM_CONFIG.feeBps, SIM_CONFIG.slippageBps);
    const { auditLog, gate, governance } = await makeArmedStack();
    const runner = new PaperLeagueRunner(
      SIM_CONFIG, [BOT_A], { "bot-a": 10_000 }, adapter, governance, auditLog, gate, SYMBOL,
    );
    await runner.start();

    const candle = makeCandle(100);
    adapter.setCurrentCandle(candle.close, candle.timestamp);
    await runner.tick(candle, [candle]);

    const fills = auditLog.filter("ORDER_FILL");
    expect(fills.length).toBe(1);
    expect(fills[0]?.payload["botId"]).toBe("bot-a");
  });

  it("PAUSED bot does not receive a fill", async () => {
    const adapter = new SimulatedPaperAdapter(SIM_CONFIG.feeBps, SIM_CONFIG.slippageBps);
    const { auditLog, gate, governance } = await makeArmedStack();
    const runner = new PaperLeagueRunner(
      SIM_CONFIG, [BOT_A], { "bot-a": 10_000 }, adapter, governance, auditLog, gate, SYMBOL,
    );
    await runner.start();
    runner.pauseBot("bot-a");

    const candle = makeCandle(100);
    adapter.setCurrentCandle(candle.close, candle.timestamp);
    await runner.tick(candle, [candle]);

    expect(auditLog.filter("ORDER_FILL")).toHaveLength(0);
  });

  it("ELIMINATED bot does not receive a fill", async () => {
    const adapter = new SimulatedPaperAdapter(SIM_CONFIG.feeBps, SIM_CONFIG.slippageBps);
    const { auditLog, gate, governance } = await makeArmedStack();
    const runner = new PaperLeagueRunner(
      SIM_CONFIG, [BOT_A], { "bot-a": 10_000 }, adapter, governance, auditLog, gate, SYMBOL,
    );
    await runner.start();
    runner.eliminateBot("bot-a");

    const candle = makeCandle(100);
    adapter.setCurrentCandle(candle.close, candle.timestamp);
    await runner.tick(candle, [candle]);

    expect(auditLog.filter("ORDER_FILL")).toHaveLength(0);
  });

  it("active bot still trades when another bot is paused", async () => {
    const adapter = new SimulatedPaperAdapter(SIM_CONFIG.feeBps, SIM_CONFIG.slippageBps);
    const { auditLog, gate, governance } = await makeArmedStack();
    const runner = new PaperLeagueRunner(
      SIM_CONFIG, [BOT_A, BOT_B],
      { "bot-a": 5_000, "bot-b": 5_000 },
      adapter, governance, auditLog, gate, SYMBOL,
    );
    await runner.start();
    runner.pauseBot("bot-b");

    const candle = makeCandle(100);
    adapter.setCurrentCandle(candle.close, candle.timestamp);
    await runner.tick(candle, [candle]);

    const fills = auditLog.filter("ORDER_FILL");
    expect(fills.every((f) => f.payload["botId"] === "bot-a")).toBe(true);
  });

  it("equityFraction is updated after mark-to-market", async () => {
    const adapter = new SimulatedPaperAdapter(SIM_CONFIG.feeBps, SIM_CONFIG.slippageBps);
    const { auditLog, gate, governance } = await makeArmedStack();
    const runner = new PaperLeagueRunner(
      SIM_CONFIG, [BOT_A], { "bot-a": 10_000 }, adapter, governance, auditLog, gate, SYMBOL,
    );
    await runner.start();

    // candle 1: B&H buys
    const c1 = makeCandle(100, 0);
    adapter.setCurrentCandle(c1.close, c1.timestamp);
    await runner.tick(c1, [c1]);

    // candle 2: price rises — equity should increase
    const c2 = makeCandle(110, 1);
    adapter.setCurrentCandle(c2.close, c2.timestamp);
    await runner.tick(c2, [c1, c2]);

    const alloc = runner.getAllocations().find((a) => a.botId === "bot-a")!;
    expect(alloc.equityFraction).toBeGreaterThan(1); // equity grew above starting
  });
});

// ─── Bot eligibility lifecycle ────────────────────────────────────────────────

describe("PaperLeagueRunner — bot eligibility lifecycle", () => {
  async function makeStartedRunner() {
    const adapter = new SimulatedPaperAdapter(SIM_CONFIG.feeBps, SIM_CONFIG.slippageBps);
    const { auditLog, gate, governance } = await makeArmedStack();
    const runner = new PaperLeagueRunner(
      SIM_CONFIG, [BOT_A], { "bot-a": 10_000 },
      adapter, governance, auditLog, gate, SYMBOL,
    );
    await runner.start();
    return { runner, adapter, auditLog, gate };
  }

  it("pauseBot: ACTIVE → PAUSED; status reflected in getAllocations", async () => {
    const { runner } = await makeStartedRunner();
    runner.pauseBot("bot-a");
    expect(runner.getAllocations()[0]?.status).toBe("PAUSED");
  });

  it("resumeBot: PAUSED → ACTIVE", async () => {
    const { runner } = await makeStartedRunner();
    runner.pauseBot("bot-a");
    runner.resumeBot("bot-a");
    expect(runner.getAllocations()[0]?.status).toBe("ACTIVE");
  });

  it("pauseBot throws when bot is not ACTIVE", async () => {
    const { runner } = await makeStartedRunner();
    runner.pauseBot("bot-a");
    expect(() => runner.pauseBot("bot-a")).toThrow(/must be ACTIVE/);
  });

  it("resumeBot throws when bot is not PAUSED", async () => {
    const { runner } = await makeStartedRunner();
    expect(() => runner.resumeBot("bot-a")).toThrow(/must be PAUSED/);
  });

  it("eliminateBot: marks bot as ELIMINATED (terminal)", async () => {
    const { runner } = await makeStartedRunner();
    runner.eliminateBot("bot-a", "test elimination");
    expect(runner.getAllocations()[0]?.status).toBe("ELIMINATED");
    expect(runner.getAllocations()[0]?.ineligibilityReason).toContain("test elimination");
  });

  it("eliminateBot is idempotent for already-terminal bots", async () => {
    const { runner } = await makeStartedRunner();
    runner.eliminateBot("bot-a");
    expect(() => runner.eliminateBot("bot-a")).not.toThrow();
    expect(runner.getAllocations()[0]?.status).toBe("ELIMINATED");
  });

  it("refundBot: ACTIVE → REFUNDED (terminal)", async () => {
    const { runner } = await makeStartedRunner();
    runner.refundBot("bot-a");
    expect(runner.getAllocations()[0]?.status).toBe("REFUNDED");
  });

  it("refundBot credits equity to unallocatedCash", async () => {
    const { runner } = await makeStartedRunner();
    const equityBefore = runner.getAllocations()[0]!.currentEquity;
    runner.refundBot("bot-a");
    expect(runner.getState().unallocatedCash).toBe(equityBefore);
  });

  it("refundBot throws on a terminal bot", async () => {
    const { runner } = await makeStartedRunner();
    runner.eliminateBot("bot-a");
    expect(() => runner.refundBot("bot-a")).toThrow(/terminal/);
  });

  it("throws when operating on an unknown botId", async () => {
    const { runner } = await makeStartedRunner();
    expect(() => runner.pauseBot("ghost-bot")).toThrow(/not found/);
    expect(() => runner.resumeBot("ghost-bot")).toThrow(/not found/);
    expect(() => runner.eliminateBot("ghost-bot")).toThrow(/not found/);
    expect(() => runner.refundBot("ghost-bot")).toThrow(/not found/);
  });

  it("PAUSED → ELIMINATED is allowed", async () => {
    const { runner } = await makeStartedRunner();
    runner.pauseBot("bot-a");
    runner.eliminateBot("bot-a", "admin action");
    expect(runner.getAllocations()[0]?.status).toBe("ELIMINATED");
  });
});

// ─── Auto-elimination ─────────────────────────────────────────────────────────

describe("PaperLeagueRunner — auto-elimination", () => {
  it("eliminates bot when equity falls below AUTO_ELIMINATION_THRESHOLD × startingCapital", async () => {
    // Use a candle price that will make the bot's equity fall below threshold.
    // Starting capital = $1,000. Threshold = 20% = $200.
    // After buying at $100, if price drops to $2, equity ≈ $2 × shares held.
    const adapter = new SimulatedPaperAdapter(SIM_CONFIG.feeBps, SIM_CONFIG.slippageBps);
    const { auditLog, gate, governance } = await makeArmedStack();
    const runner = new PaperLeagueRunner(
      SIM_CONFIG, [BOT_A], { "bot-a": 1_000 }, adapter, governance, auditLog, gate, SYMBOL,
    );
    await runner.start();

    // Candle 1: B&H buys in at $100 (bot has ~9 shares after fees/slippage)
    const c1 = makeCandle(100, 0);
    adapter.setCurrentCandle(c1.close, c1.timestamp);
    await runner.tick(c1, [c1]);

    // Candle 2: price collapses to $1 — equity ≈ $9 << $200 threshold
    const c2 = makeCandle(1, 1);
    adapter.setCurrentCandle(c2.close, c2.timestamp);
    await runner.tick(c2, [c1, c2]);

    expect(runner.getAllocations()[0]?.status).toBe("ELIMINATED");
    expect(runner.getAllocations()[0]?.ineligibilityReason).toMatch(/auto-eliminated/);
  });

  it(`AUTO_ELIMINATION_THRESHOLD is ${AUTO_ELIMINATION_THRESHOLD}`, () => {
    expect(AUTO_ELIMINATION_THRESHOLD).toBe(0.2);
  });

  it("bot is not eliminated when equity stays above threshold", async () => {
    const adapter = new SimulatedPaperAdapter(SIM_CONFIG.feeBps, SIM_CONFIG.slippageBps);
    const { auditLog, gate, governance } = await makeArmedStack();
    const runner = new PaperLeagueRunner(
      SIM_CONFIG, [BOT_A], { "bot-a": 10_000 }, adapter, governance, auditLog, gate, SYMBOL,
    );
    await runner.start();

    // Price stays healthy — equity should remain well above 20% of $10k = $2k
    const c1 = makeCandle(100, 0);
    adapter.setCurrentCandle(c1.close, c1.timestamp);
    await runner.tick(c1, [c1]);

    const c2 = makeCandle(99, 1); // slight dip, not enough to eliminate
    adapter.setCurrentCandle(c2.close, c2.timestamp);
    await runner.tick(c2, [c1, c2]);

    expect(runner.getAllocations()[0]?.status).toBe("ACTIVE");
  });
});

// ─── Account-level reconciliation ────────────────────────────────────────────

describe("PaperLeagueRunner — account-level reconciliation", () => {
  it("session-end drift disarms the gate", async () => {
    // start() with an ok adapter, end() with drift
    const okAdapter = makeOkAdapter();
    const { auditLog, gate, governance } = await makeArmedStack();
    const runner = new PaperLeagueRunner(
      SIM_CONFIG, [BOT_A], {}, okAdapter, governance, auditLog, gate, SYMBOL,
    );
    await runner.start();

    // Swap to a drift adapter for end()
    (okAdapter.reconcileAccount as ReturnType<typeof vi.fn>)
      .mockResolvedValue({
        ok: false,
        drifts: [{ symbol: SYMBOL, engineValue: 10, brokerValue: 5, delta: -5 }],
        engineSnapshot: {} as PortfolioSnapshot,
        brokerSnapshot: {} as AlpacaAccountSnapshot,
        reconciledAt: Date.now(),
      } satisfies BrokerReconciliationResult);

    await runner.end();
    expect(gate.status).toBe("DISARMED_ON_ERROR");
  });

  it("drift disarms the gate for ALL bots — no individual escape hatch", async () => {
    const driftAdapter = makeDriftAdapter();
    const { auditLog, gate, governance } = await makeArmedStack();
    // Manually skip start() reconciliation so we can test end() drift
    const runner = new PaperLeagueRunner(
      SIM_CONFIG, [BOT_A, BOT_B],
      { "bot-a": 5_000, "bot-b": 5_000 },
      driftAdapter, governance, auditLog, gate, SYMBOL,
    );

    // start() will drift → gate disarmed; all bots implicitly halted
    await expect(runner.start()).rejects.toThrow(/drift/i);

    // Gate is DISARMED_ON_ERROR regardless of which bot was ticking
    expect(gate.status).toBe("DISARMED_ON_ERROR");

    // Both bots are still in their initial ACTIVE status in the eligibility
    // map (the runner doesn't forcibly eliminate them on reconciliation drift;
    // the disarmed gate blocks all further orders at the governance layer).
    const allocs = runner.getAllocations();
    for (const a of allocs) {
      // Each bot's governance eligibility is still ACTIVE — the GATE_ARMED rule
      // fires first and blocks all orders, so there's no need to mark them PAUSED.
      expect(a.status).toBe("ACTIVE");
    }
  });

  it("RECONCILIATION_DRIFT event is emitted on drift", async () => {
    const driftAdapter = makeDriftAdapter();
    const { auditLog, gate, governance } = await makeArmedStack();
    const runner = new PaperLeagueRunner(
      SIM_CONFIG, [BOT_A], {}, driftAdapter, governance, auditLog, gate, SYMBOL,
    );
    await expect(runner.start()).rejects.toThrow();

    const events = runner.getEvents();
    expect(events.some((e) => e.type === "RECONCILIATION_DRIFT")).toBe(true);
  });

  it("RECONCILIATION_DRIFT is recorded in the audit log", async () => {
    const driftAdapter = makeDriftAdapter();
    const { auditLog, gate, governance } = await makeArmedStack();
    const runner = new PaperLeagueRunner(
      SIM_CONFIG, [BOT_A], {}, driftAdapter, governance, auditLog, gate, SYMBOL,
    );
    await expect(runner.start()).rejects.toThrow();

    expect(auditLog.filter("RECONCILIATION_DRIFT")).toHaveLength(1);
  });
});

// ─── getState / getAllocations ────────────────────────────────────────────────

describe("PaperLeagueRunner — getState / getAllocations", () => {
  it("getState().running is false before start()", async () => {
    const adapter = makeOkAdapter();
    const { auditLog, gate, governance } = await makeArmedStack();
    const runner = new PaperLeagueRunner(
      SIM_CONFIG, [BOT_A], {}, adapter, governance, auditLog, gate, SYMBOL,
    );
    expect(runner.getState().running).toBe(false);
    expect(runner.getState().startedAt).toBeNull();
  });

  it("getState().running is false after end()", async () => {
    const adapter = makeOkAdapter();
    const { auditLog, gate, governance } = await makeArmedStack();
    const runner = new PaperLeagueRunner(
      SIM_CONFIG, [BOT_A], {}, adapter, governance, auditLog, gate, SYMBOL,
    );
    await runner.start();
    await runner.end();
    expect(runner.getState().running).toBe(false);
  });

  it("getAllocations currentEquity equals startingCapital before any candles", async () => {
    const adapter = makeOkAdapter();
    const { auditLog, gate, governance } = await makeArmedStack();
    const runner = new PaperLeagueRunner(
      SIM_CONFIG, [BOT_A], { "bot-a": 7_500 }, adapter, governance, auditLog, gate, SYMBOL,
    );
    await runner.start();

    const alloc = runner.getAllocations().find((a) => a.botId === "bot-a")!;
    expect(alloc.currentEquity).toBe(7_500);
    expect(alloc.equityFraction).toBe(1);
  });

  it("getState().unallocatedCash starts at 0", async () => {
    const adapter = makeOkAdapter();
    const { auditLog, gate, governance } = await makeArmedStack();
    const runner = new PaperLeagueRunner(
      SIM_CONFIG, [BOT_A], {}, adapter, governance, auditLog, gate, SYMBOL,
    );
    expect(runner.getState().unallocatedCash).toBe(0);
  });
});

// ─── end() ───────────────────────────────────────────────────────────────────

describe("PaperLeagueRunner — end()", () => {
  it("is safe to call end() without start() (no-op)", async () => {
    const adapter = makeOkAdapter();
    const { auditLog, gate, governance } = await makeArmedStack();
    const runner = new PaperLeagueRunner(
      SIM_CONFIG, [BOT_A], {}, adapter, governance, auditLog, gate, SYMBOL,
    );
    await expect(runner.end()).resolves.toBeUndefined();
  });

  it("is safe to call end() twice", async () => {
    const adapter = makeOkAdapter();
    const { auditLog, gate, governance } = await makeArmedStack();
    const runner = new PaperLeagueRunner(
      SIM_CONFIG, [BOT_A], {}, adapter, governance, auditLog, gate, SYMBOL,
    );
    await runner.start();
    await runner.end();
    await expect(runner.end()).resolves.toBeUndefined();
  });

  it("records SESSION_END in the audit log", async () => {
    const adapter = makeOkAdapter();
    const { auditLog, gate, governance } = await makeArmedStack();
    const runner = new PaperLeagueRunner(
      SIM_CONFIG, [BOT_A], {}, adapter, governance, auditLog, gate, SYMBOL,
    );
    await runner.start();
    await runner.end();

    const ends = auditLog.filter("SESSION_END");
    expect(ends.length).toBe(1);
  });

  it("emits MATCH_END event", async () => {
    const adapter = makeOkAdapter();
    const { auditLog, gate, governance } = await makeArmedStack();
    const runner = new PaperLeagueRunner(
      SIM_CONFIG, [BOT_A], {}, adapter, governance, auditLog, gate, SYMBOL,
    );
    await runner.start();
    await runner.end();

    expect(runner.getEvents().some((e) => e.type === "MATCH_END")).toBe(true);
  });
});
