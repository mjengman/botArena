import { describe, it, expect } from "vitest";
import { GovernanceEngine } from "../src/engine/governance/governanceEngine.ts";
import { ConcreteEnablementGate } from "../src/engine/governance/enablementGate.ts";
import { AuditLog } from "../src/engine/governance/auditLog.ts";
import type { PaperAdapterConfig } from "../src/engine/brokerTypes.ts";
import type { OrderIntent, PortfolioSnapshot } from "../src/engine/types.ts";

// ─── Fixtures ─────────────────────────────────────────────────────────────────

const baseConfig: PaperAdapterConfig = {
  allowedSymbols: ["ARENA", "TSLA"],
  maxOpenOrders: 10,
  maxOrdersPerDay: 5,
  maxOrderNotional: 10_000,
  driftToleranceShares: 1,
  driftToleranceCash: 1,
  autoDisarmAfterMs: 4 * 60 * 60 * 1000,
  maxPositionFractionOfEquity: 0.5,
  maxRealizedDailyLossUsd: 500,
  botCapitalAllocationUsd: 10_000,
};

const BOT = "test-bot";

function makePortfolio(overrides: Partial<PortfolioSnapshot> = {}): PortfolioSnapshot {
  return {
    cash: 10_000,
    positions: [],
    equity: 10_000,
    realizedPnl: 0,
    unrealizedPnl: 0,
    exposure: 0,
    ...overrides,
  };
}

function buyIntent(symbol = "ARENA", qty = 10): OrderIntent {
  return { side: "buy", symbol, size: { type: "quantity", quantity: qty } };
}

function sellIntent(symbol = "ARENA"): OrderIntent {
  return { side: "sell", symbol, size: { type: "closePosition" } };
}

async function makeArmedGovernance(configOverride: Partial<PaperAdapterConfig> = {}): Promise<{
  engine: GovernanceEngine;
  gate: ConcreteEnablementGate;
  auditLog: AuditLog;
}> {
  const auditLog = new AuditLog();
  const gate = new ConcreteEnablementGate([], auditLog, 60_000);
  await gate.arm();
  const engine = new GovernanceEngine({ ...baseConfig, ...configOverride }, gate, auditLog);
  return { engine, gate, auditLog };
}

// ─── Rule 1: GATE_ARMED ───────────────────────────────────────────────────────

describe("GovernanceEngine — GATE_ARMED rule", () => {
  it("blocks orders when gate is DISARMED", () => {
    const auditLog = new AuditLog();
    const gate = new ConcreteEnablementGate([], auditLog);
    // gate stays DISARMED
    const engine = new GovernanceEngine(baseConfig, gate, auditLog);
    const result = engine.check(buyIntent(), makePortfolio(), 100, BOT);
    expect(result.ok).toBe(false);
    expect(result.blockedBy).toBe("GATE_ARMED");
  });

  it("allows orders when gate is ARMED", async () => {
    const { engine } = await makeArmedGovernance();
    const result = engine.check(buyIntent(), makePortfolio(), 10, BOT);
    expect(result.ok).toBe(true);
  });
});

// ─── Rule 2: SYMBOL_ALLOWLIST ─────────────────────────────────────────────────

describe("GovernanceEngine — SYMBOL_ALLOWLIST rule", () => {
  it("blocks orders for symbols not in the allowlist", async () => {
    const { engine } = await makeArmedGovernance();
    const intent: OrderIntent = { side: "buy", symbol: "AAPL", size: { type: "quantity", quantity: 1 } };
    const result = engine.check(intent, makePortfolio(), 100, BOT);
    expect(result.ok).toBe(false);
    expect(result.blockedBy).toBe("SYMBOL_ALLOWLIST");
    expect(result.reason).toContain("AAPL");
  });

  it("allows orders for symbols in the allowlist", async () => {
    const { engine } = await makeArmedGovernance();
    const result = engine.check(buyIntent("TSLA", 1), makePortfolio(), 10, BOT);
    expect(result.ok).toBe(true);
  });
});

// ─── Rule 3: MAX_ORDERS_PER_DAY ───────────────────────────────────────────────

describe("GovernanceEngine — MAX_ORDERS_PER_DAY rule", () => {
  it("blocks when daily order count reaches maxOrdersPerDay", async () => {
    const { engine } = await makeArmedGovernance({ maxOrdersPerDay: 2 });

    engine.recordOrderSubmitted(BOT);
    engine.recordOrderSubmitted(BOT);

    const result = engine.check(buyIntent(), makePortfolio(), 10, BOT);
    expect(result.ok).toBe(false);
    expect(result.blockedBy).toBe("MAX_ORDERS_PER_DAY");
  });

  it("allows orders below the daily limit", async () => {
    const { engine } = await makeArmedGovernance({ maxOrdersPerDay: 5 });
    engine.recordOrderSubmitted(BOT);
    const result = engine.check(buyIntent(), makePortfolio(), 10, BOT);
    expect(result.ok).toBe(true);
  });

  it("per-bot isolation: bot-A orders do not count against bot-B", async () => {
    const { engine } = await makeArmedGovernance({ maxOrdersPerDay: 1 });
    engine.recordOrderSubmitted("bot-a");
    engine.recordOrderSubmitted("bot-a");
    // bot-b still has 0 orders today
    const result = engine.check(buyIntent(), makePortfolio(), 10, "bot-b");
    expect(result.ok).toBe(true);
  });
});

// ─── Rule 4: MAX_REALIZED_DAILY_LOSS ───────────────────────────────────────────────────

describe("GovernanceEngine — MAX_REALIZED_DAILY_LOSS rule", () => {
  it("blocks when daily loss reaches maxRealizedDailyLossUsd", async () => {
    const { engine } = await makeArmedGovernance({ maxRealizedDailyLossUsd: 100 });
    engine.recordRealisedPnl(BOT, -100); // exactly at limit
    const result = engine.check(buyIntent(), makePortfolio(), 10, BOT);
    expect(result.ok).toBe(false);
    expect(result.blockedBy).toBe("MAX_REALIZED_DAILY_LOSS");
  });

  it("does not block when daily loss is below limit", async () => {
    const { engine } = await makeArmedGovernance({ maxRealizedDailyLossUsd: 500 });
    engine.recordRealisedPnl(BOT, -99);
    const result = engine.check(buyIntent(), makePortfolio(), 10, BOT);
    expect(result.ok).toBe(true);
  });

  it("profits do not affect daily loss accumulator", async () => {
    const { engine } = await makeArmedGovernance({ maxRealizedDailyLossUsd: 100 });
    engine.recordRealisedPnl(BOT, +200); // profit
    engine.recordRealisedPnl(BOT, -50);  // loss, under limit
    const stats = engine.getStats(BOT);
    expect(stats.realizedDailyLossUsd).toBe(50);
  });

  it("per-bot isolation: bot-A loss does not affect bot-B", async () => {
    const { engine } = await makeArmedGovernance({ maxRealizedDailyLossUsd: 100 });
    engine.recordRealisedPnl("bot-a", -200); // bot-a over limit
    const result = engine.check(buyIntent(), makePortfolio(), 10, "bot-b");
    // bot-b limit not reached
    expect(result.ok).toBe(true);
  });
});

// ─── Rule 5: MAX_ORDER_NOTIONAL ───────────────────────────────────────────────

describe("GovernanceEngine — MAX_ORDER_NOTIONAL rule", () => {
  it("blocks a buy whose notional exceeds maxOrderNotional", async () => {
    // maxOrderNotional = 500; buy 100 shares @ $10 = $1,000 — exceeds $500
    const { engine } = await makeArmedGovernance({ maxOrderNotional: 500 });
    const result = engine.check(buyIntent("ARENA", 100), makePortfolio(), 10, BOT);
    expect(result.ok).toBe(false);
    expect(result.blockedBy).toBe("MAX_ORDER_NOTIONAL");
    expect(result.reason).toContain("$1000.00");
  });

  it("allows a buy within maxOrderNotional", async () => {
    // buy 5 shares @ $10 = $50 — well within $500
    const { engine } = await makeArmedGovernance({ maxOrderNotional: 500 });
    const result = engine.check(buyIntent("ARENA", 5), makePortfolio(), 10, BOT);
    expect(result.ok).toBe(true);
  });

  it("does not apply to sell orders", async () => {
    const { engine } = await makeArmedGovernance({ maxOrderNotional: 1 });
    const result = engine.check(sellIntent(), makePortfolio(), 100, BOT);
    if (!result.ok) {
      expect(result.blockedBy).not.toBe("MAX_ORDER_NOTIONAL");
    }
  });
});

// ─── Rule 6: MAX_POSITION_SIZE ────────────────────────────────────────────────

describe("GovernanceEngine — MAX_POSITION_SIZE rule", () => {
  it("blocks a buy that would exceed maxPositionFractionOfEquity", async () => {
    // equity = 10_000, maxFraction = 0.1 → max = $1,000
    // buy 200 shares @ $10 = $2,000 — exceeds $1,000
    const { engine } = await makeArmedGovernance({ maxPositionFractionOfEquity: 0.1 });
    const result = engine.check(buyIntent("ARENA", 200), makePortfolio(), 10, BOT);
    expect(result.ok).toBe(false);
    expect(result.blockedBy).toBe("MAX_POSITION_SIZE");
  });

  it("allows a buy within maxPositionFractionOfEquity", async () => {
    // equity = 10_000, maxFraction = 0.5 → max = $5,000
    // buy 10 shares @ $100 = $1,000 — within $5,000
    const { engine } = await makeArmedGovernance({ maxPositionFractionOfEquity: 0.5 });
    const result = engine.check(buyIntent("ARENA", 10), makePortfolio(), 100, BOT);
    expect(result.ok).toBe(true);
  });

  it("does not apply to sell orders", async () => {
    const { engine } = await makeArmedGovernance({ maxPositionFractionOfEquity: 0.01 });
    const result = engine.check(sellIntent(), makePortfolio(), 100, BOT);
    if (!result.ok) {
      expect(result.blockedBy).not.toBe("MAX_POSITION_SIZE");
    }
  });
});

// ─── Rule 7: BOT_CAPITAL_ALLOC ────────────────────────────────────────────────

describe("GovernanceEngine — BOT_CAPITAL_ALLOC rule", () => {
  it("blocks a buy that exceeds remaining bot capital allocation", async () => {
    // allocation = 500, committed 400 → remaining = 100
    // order: 10 shares @ $20 = $200 — exceeds $100 remaining
    const { engine } = await makeArmedGovernance({ botCapitalAllocationUsd: 500 });
    engine.setCommittedCapital(BOT, 400);
    const result = engine.check(buyIntent("ARENA", 10), makePortfolio(), 20, BOT);
    expect(result.ok).toBe(false);
    expect(result.blockedBy).toBe("BOT_CAPITAL_ALLOC");
  });

  it("allows a buy within remaining bot capital allocation", async () => {
    const { engine } = await makeArmedGovernance({ botCapitalAllocationUsd: 10_000 });
    engine.setCommittedCapital(BOT, 0);
    const result = engine.check(buyIntent("ARENA", 5), makePortfolio(), 100, BOT);
    expect(result.ok).toBe(true);
  });

  it("per-bot isolation: bot-A committed capital does not affect bot-B", async () => {
    const { engine } = await makeArmedGovernance({ botCapitalAllocationUsd: 500 });
    engine.setCommittedCapital("bot-a", 499); // bot-a nearly exhausted
    const result = engine.check(buyIntent("ARENA", 5), makePortfolio(), 10, "bot-b");
    // bot-b has full allocation
    expect(result.ok).toBe(true);
  });

  it("does not apply to sell orders", async () => {
    const { engine } = await makeArmedGovernance({ botCapitalAllocationUsd: 1 });
    engine.setCommittedCapital(BOT, 999);
    const result = engine.check(sellIntent(), makePortfolio(), 100, BOT);
    if (!result.ok) {
      expect(result.blockedBy).not.toBe("BOT_CAPITAL_ALLOC");
    }
  });
});

// ─── Rule priority order ──────────────────────────────────────────────────────

describe("GovernanceEngine — rule priority", () => {
  it("GATE_ARMED blocks before SYMBOL_ALLOWLIST", () => {
    const auditLog = new AuditLog();
    const gate = new ConcreteEnablementGate([], auditLog);
    const engine = new GovernanceEngine(baseConfig, gate, auditLog);
    const intent: OrderIntent = { side: "buy", symbol: "BADSTOCK", size: { type: "quantity", quantity: 1 } };
    const result = engine.check(intent, makePortfolio(), 100, BOT);
    expect(result.blockedBy).toBe("GATE_ARMED");
  });

  it("SYMBOL_ALLOWLIST blocks before MAX_ORDER_NOTIONAL", async () => {
    // Bad symbol AND would-be huge notional — should be blocked by allowlist first
    const { engine } = await makeArmedGovernance({ maxOrderNotional: 1 });
    const intent: OrderIntent = { side: "buy", symbol: "BADSTOCK", size: { type: "quantity", quantity: 10_000 } };
    const result = engine.check(intent, makePortfolio(), 100, BOT);
    expect(result.blockedBy).toBe("SYMBOL_ALLOWLIST");
  });

  it("MAX_ORDERS_PER_DAY blocks before MAX_REALIZED_DAILY_LOSS", async () => {
    const { engine } = await makeArmedGovernance({ maxOrdersPerDay: 0, maxRealizedDailyLossUsd: 0 });
    engine.recordRealisedPnl(BOT, -999);
    const result = engine.check(buyIntent(), makePortfolio(), 10, BOT);
    expect(result.blockedBy).toBe("MAX_ORDERS_PER_DAY");
  });
});

// ─── Session stats ────────────────────────────────────────────────────────────

describe("GovernanceEngine — session stats", () => {
  it("getStats(botId) reflects per-bot counters", async () => {
    const { engine } = await makeArmedGovernance();
    engine.recordOrderSubmitted(BOT);
    engine.recordOrderSubmitted(BOT);
    engine.recordRealisedPnl(BOT, -75.5);
    engine.setCommittedCapital(BOT, 2000);

    const stats = engine.getStats(BOT);
    expect(stats.dailyOrderCount).toBe(2);
    expect(stats.realizedDailyLossUsd).toBeCloseTo(75.5);
    expect(stats.committedCapitalUsd).toBe(2000);
  });

  it("getStats returns independent values for different bots", async () => {
    const { engine } = await makeArmedGovernance();
    engine.recordOrderSubmitted("bot-a");
    engine.recordOrderSubmitted("bot-a");
    engine.recordOrderSubmitted("bot-b");

    expect(engine.getStats("bot-a").dailyOrderCount).toBe(2);
    expect(engine.getStats("bot-b").dailyOrderCount).toBe(1);
  });

  it("setCommittedCapital clamps to zero for negative values", async () => {
    const { engine } = await makeArmedGovernance();
    engine.setCommittedCapital(BOT, -500);
    expect(engine.getStats(BOT).committedCapitalUsd).toBe(0);
  });

  it("getStats(unknownBot) returns zeroed stats", async () => {
    const { engine } = await makeArmedGovernance();
    const stats = engine.getStats("never-seen-bot");
    expect(stats.dailyOrderCount).toBe(0);
    expect(stats.realizedDailyLossUsd).toBe(0);
    expect(stats.committedCapitalUsd).toBe(0);
  });
});

// ─── Audit log integration ────────────────────────────────────────────────────

describe("GovernanceEngine — audit log", () => {
  it("records a GOVERNANCE_CHECK entry when an order is blocked", async () => {
    const { engine, auditLog } = await makeArmedGovernance();
    const intent: OrderIntent = { side: "buy", symbol: "BADSTOCK", size: { type: "quantity", quantity: 1 } };
    engine.check(intent, makePortfolio(), 100, BOT);

    const checks = auditLog.filter("GOVERNANCE_CHECK");
    expect(checks.length).toBeGreaterThanOrEqual(1);
    expect(checks[0]!.payload["blockedBy"]).toBe("SYMBOL_ALLOWLIST");
    expect(checks[0]!.payload["botId"]).toBe(BOT);
  });

  it("records a GOVERNANCE_CHECK entry when all rules pass", async () => {
    const { engine, auditLog } = await makeArmedGovernance();
    engine.check(buyIntent(), makePortfolio(), 10, BOT);

    const checks = auditLog.filter("GOVERNANCE_CHECK");
    expect(checks.length).toBeGreaterThanOrEqual(1);
    const last = checks[checks.length - 1]!;
    expect(last.message).toContain("passed");
    expect(last.payload["botId"]).toBe(BOT);
  });
});

describe("GovernanceEngine — resetStats()", () => {
  it("zeroes all per-bot counters so a subsequent session starts clean", async () => {
    const { engine } = await makeArmedGovernance();

    // Simulate an active session: accumulate orders, loss, and committed capital
    engine.recordOrderSubmitted(BOT);
    engine.recordOrderSubmitted(BOT);
    engine.recordRealisedPnl(BOT, -300);
    engine.setCommittedCapital(BOT, 8_000);

    const before = engine.getStats(BOT);
    expect(before.dailyOrderCount).toBe(2);
    expect(before.realizedDailyLossUsd).toBe(300);
    expect(before.committedCapitalUsd).toBe(8_000);

    // Start a new session — governance engine is reused, stats must reset
    engine.resetStats(BOT);

    const after = engine.getStats(BOT);
    expect(after.dailyOrderCount).toBe(0);
    expect(after.realizedDailyLossUsd).toBe(0);
    expect(after.committedCapitalUsd).toBe(0);
  });

  it("resetStats() does not affect other bots", async () => {
    const { engine } = await makeArmedGovernance();
    const OTHER = "other-bot";

    engine.recordOrderSubmitted(BOT);
    engine.recordOrderSubmitted(OTHER);
    engine.setCommittedCapital(OTHER, 5_000);

    engine.resetStats(BOT);

    // BOT is zeroed; OTHER is untouched
    expect(engine.getStats(BOT).dailyOrderCount).toBe(0);
    expect(engine.getStats(OTHER).dailyOrderCount).toBe(1);
    expect(engine.getStats(OTHER).committedCapitalUsd).toBe(5_000);
  });

  it("BOT_CAPITAL_ALLOC passes on a fresh session even when previous session used full allocation", async () => {
    // Regression: without resetStats(), committedCapitalUsd ≈ $9,900 from a
    // completed B&H session blocks the first buy of the next session.
    //
    // The test config has maxPositionFractionOfEquity: 0.25 (max $2,500) and
    // botCapitalAllocationUsd: 10_000. We use 2 shares @ $100 = $200 notional
    // so MAX_POSITION_SIZE ($200 < $2,500) and MAX_ORDER_NOTIONAL are not the
    // blocking rule — only BOT_CAPITAL_ALLOC fires when remaining < $200.
    const { engine, gate } = await makeArmedGovernance();

    // $9,901 committed → $99 remaining; a $200 order exceeds that
    engine.setCommittedCapital(BOT, 9_901);

    const twoShareBuy: OrderIntent = {
      side: "buy",
      symbol: "ARENA",
      size: { type: "quantity", quantity: 2 },
    };

    // Without reset — BOT_CAPITAL_ALLOC blocks (regression guard)
    const withoutReset = engine.check(twoShareBuy, makePortfolio({ cash: 10_000, equity: 10_000 }), 100, BOT);
    expect(withoutReset.ok).toBe(false);
    expect(withoutReset.blockedBy).toBe("BOT_CAPITAL_ALLOC");

    // Re-arm (simulates the user re-arming for a second session)
    gate.disarm("end of session 1");
    await gate.arm();

    // After reset — remaining = $10,000; same $200 order must pass
    engine.resetStats(BOT);
    const afterReset = engine.check(twoShareBuy, makePortfolio({ cash: 10_000, equity: 10_000 }), 100, BOT);
    expect(afterReset.ok).toBe(true);
  });
});

// ─── Rule 2: BOT_ELIGIBILITY ──────────────────────────────────────────────────

describe("GovernanceEngine — BOT_ELIGIBILITY rule", () => {
  it("allows orders when bot has no eligibility record (defaults to ACTIVE)", async () => {
    const { engine } = await makeArmedGovernance();
    const result = engine.check(buyIntent(), makePortfolio(), 100, BOT);
    expect(result.ok).toBe(true);
  });

  it("blocks orders when bot is PAUSED", async () => {
    const { engine } = await makeArmedGovernance();
    engine.setEligibilityStatus(BOT, "PAUSED", "paused by user");
    const result = engine.check(buyIntent(), makePortfolio(), 100, BOT);
    expect(result.ok).toBe(false);
    expect(result.blockedBy).toBe("BOT_ELIGIBILITY");
    expect(result.reason).toMatch(/PAUSED/);
  });

  it("blocks orders when bot is ELIMINATED", async () => {
    const { engine } = await makeArmedGovernance();
    engine.setEligibilityStatus(BOT, "ELIMINATED", "equity wiped out");
    const result = engine.check(buyIntent(), makePortfolio(), 100, BOT);
    expect(result.ok).toBe(false);
    expect(result.blockedBy).toBe("BOT_ELIGIBILITY");
    expect(result.reason).toMatch(/ELIMINATED/);
  });

  it("blocks orders when bot is RETIRED", async () => {
    const { engine } = await makeArmedGovernance();
    engine.setEligibilityStatus(BOT, "RETIRED");
    const result = engine.check(buyIntent(), makePortfolio(), 100, BOT);
    expect(result.ok).toBe(false);
    expect(result.blockedBy).toBe("BOT_ELIGIBILITY");
  });

  it("blocks orders when bot is NEEDS_REVIEW", async () => {
    const { engine } = await makeArmedGovernance();
    engine.setEligibilityStatus(BOT, "NEEDS_REVIEW", "safety rule fired");
    const result = engine.check(buyIntent(), makePortfolio(), 100, BOT);
    expect(result.ok).toBe(false);
    expect(result.blockedBy).toBe("BOT_ELIGIBILITY");
    expect(result.reason).toContain("NEEDS_REVIEW");
  });

  it("BOT_ELIGIBILITY blocks before SYMBOL_ALLOWLIST — disallowed symbol + paused bot → BOT_ELIGIBILITY wins", async () => {
    const { engine } = await makeArmedGovernance();
    engine.setEligibilityStatus(BOT, "PAUSED");
    // GOOG is not in the allowlist, but eligibility should fire first.
    const result = engine.check(buyIntent("GOOG"), makePortfolio(), 100, BOT);
    expect(result.blockedBy).toBe("BOT_ELIGIBILITY");
  });

  it("allows orders again after status is restored to ACTIVE", async () => {
    const { engine } = await makeArmedGovernance();
    engine.setEligibilityStatus(BOT, "PAUSED");
    expect(engine.check(buyIntent(), makePortfolio(), 100, BOT).ok).toBe(false);

    engine.setEligibilityStatus(BOT, "ACTIVE");
    expect(engine.check(buyIntent(), makePortfolio(), 100, BOT).ok).toBe(true);
  });

  it("ineligibility reason is included in the rejection reason string", async () => {
    const { engine } = await makeArmedGovernance();
    engine.setEligibilityStatus(BOT, "PAUSED", "daily loss limit hit");
    const result = engine.check(buyIntent(), makePortfolio(), 100, BOT);
    expect(result.reason).toContain("daily loss limit hit");
  });

  it("getEligibility returns ACTIVE for unknown bot", async () => {
    const { engine } = await makeArmedGovernance();
    expect(engine.getEligibility("unknown-bot").status).toBe("ACTIVE");
  });

  it("getEligibility reflects the last setEligibilityStatus call", async () => {
    const { engine } = await makeArmedGovernance();
    engine.setEligibilityStatus(BOT, "ELIMINATED", "wiped");
    const rec = engine.getEligibility(BOT);
    expect(rec.status).toBe("ELIMINATED");
    expect(rec.reason).toBe("wiped");
  });
});

// ─── setBotCapitalAllocation ──────────────────────────────────────────────────

describe("GovernanceEngine — setBotCapitalAllocation", () => {
  it("per-bot override takes precedence over config.botCapitalAllocationUsd", async () => {
    // Global config allows $10k; set per-bot to only $500.
    const { engine } = await makeArmedGovernance({ botCapitalAllocationUsd: 10_000 });
    engine.setBotCapitalAllocation(BOT, 500);

    // A $600 order (6 shares @ $100) should be blocked by the per-bot limit.
    const bigBuy: OrderIntent = { side: "buy", symbol: "ARENA", size: { type: "quantity", quantity: 6 } };
    const result = engine.check(bigBuy, makePortfolio(), 100, BOT);
    expect(result.ok).toBe(false);
    expect(result.blockedBy).toBe("BOT_CAPITAL_ALLOC");
  });

  it("without a per-bot override, falls back to config.botCapitalAllocationUsd", async () => {
    // Config allows $10k; no per-bot override — a $500 order should pass.
    const { engine } = await makeArmedGovernance({ botCapitalAllocationUsd: 10_000 });
    const result = engine.check(buyIntent("ARENA", 5), makePortfolio(), 100, BOT);
    expect(result.ok).toBe(true);
  });

  it("per-bot override is independent per bot", async () => {
    const { engine } = await makeArmedGovernance({ botCapitalAllocationUsd: 10_000 });
    engine.setBotCapitalAllocation("bot-a", 200);
    engine.setBotCapitalAllocation("bot-b", 5_000);

    const threeShareBuy: OrderIntent = {
      side: "buy", symbol: "ARENA", size: { type: "quantity", quantity: 3 },
    };
    // $300 > $200 alloc for bot-a → blocked
    expect(engine.check(threeShareBuy, makePortfolio(), 100, "bot-a").ok).toBe(false);
    // $300 < $5,000 alloc for bot-b → allowed
    expect(engine.check(threeShareBuy, makePortfolio(), 100, "bot-b").ok).toBe(true);
  });
});
