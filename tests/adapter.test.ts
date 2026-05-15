import { describe, it, expect, vi } from "vitest";
import { createSimulation } from "../src/engine/simulation.ts";
import { simulatedAdapter } from "../src/engine/adapters/simulatedAdapter.ts";
import { PaperBrokerAdapter } from "../src/engine/adapters/paperAdapter.ts";
import type { SimulationExecutionAdapter, BrokerAdapter } from "../src/engine/adapter.ts";
import { sampleDataset } from "../src/data/sampleDataset.ts";
import { buyAndHold } from "../src/strategies/buyAndHold.ts";
import { defaultMatchConfig } from "../src/app/matchConfig.ts";
import { runSeason } from "../src/app/season.ts";

const config = { startingCash: 10_000, feeBps: 5, slippageBps: 3, seed: 42 };
const specs = [{ id: "bah", name: "B&H", strategy: buyAndHold }];

// ─── simulatedAdapter ─────────────────────────────────────────────────────────

describe("simulatedAdapter", () => {
  it("has mode === 'simulation'", () => {
    expect(simulatedAdapter.mode).toBe("simulation");
  });
});

// ─── createSimulation — adapter injection ────────────────────────────────────

describe("createSimulation with default adapter", () => {
  it("produces the same standings as when simulatedAdapter is passed explicitly", () => {
    const simDefault = createSimulation(config, sampleDataset, specs);
    simDefault.runToEnd();

    const simExplicit = createSimulation(config, sampleDataset, specs, simulatedAdapter);
    simExplicit.runToEnd();

    const standingsA = simDefault.getStandings().map((s) => ({ id: s.botId, ret: s.totalReturn }));
    const standingsB = simExplicit.getStandings().map((s) => ({ id: s.botId, ret: s.totalReturn }));
    expect(standingsA).toEqual(standingsB);
  });
});

describe("adapter.execute call count", () => {
  it("calls adapter.execute once per order intent emitted", () => {
    const spyAdapter: SimulationExecutionAdapter = {
      mode: "simulation",
      execute: vi.fn(simulatedAdapter.execute),
    };
    const sim = createSimulation(config, sampleDataset, specs, spyAdapter);
    sim.runToEnd();
    // buy-and-hold emits one intent on candle 0 and never sells
    expect(spyAdapter.execute).toHaveBeenCalledTimes(1);
  });
});

describe("custom adapter that rejects all orders", () => {
  it("produces zero fills and zero closed trades", () => {
    const rejectAll: SimulationExecutionAdapter = {
      mode: "simulation",
      execute: () => ({ ok: false, reason: "INSUFFICIENT_CASH" }),
    };
    const sim = createSimulation(config, sampleDataset, specs, rejectAll);
    sim.runToEnd();
    const bot = sim.getSnapshot().bots[0]!;
    expect(bot.fillHistory.length).toBe(0);
    expect(bot.trades.length).toBe(0);
  });
});

// ─── PaperBrokerAdapter — interface compliance ───────────────────────────────

const paperConfig = {
  allowedSymbols: ["ARENA"],
  maxOpenOrders: 5,
  maxOrderNotional: 10_000,
  driftToleranceShares: 1,
  driftToleranceCash: 1,
  autoDisarmAfterMs: 4 * 60 * 60 * 1000,
};

describe("PaperBrokerAdapter", () => {
  it("has mode === 'paper'", () => {
    const adapter = new PaperBrokerAdapter(paperConfig, {} as never);
    expect(adapter.mode).toBe("paper");
  });

  it("satisfies the BrokerAdapter interface at compile time (mode discriminant check)", () => {
    // PaperBrokerAdapter implements BrokerAdapter. If the class diverged from
    // the interface, tsc would catch it at build time. The BrokerAdapter type
    // is imported at the top of this file; this runtime check verifies the
    // mode discriminant is "paper" (not "simulation").
    const adapter: BrokerAdapter = new PaperBrokerAdapter(paperConfig, {} as never);
    expect(adapter.mode).toBe("paper");
  });

  it("throws NOT_IMPLEMENTED when executeAsync() is called", async () => {
    const adapter = new PaperBrokerAdapter(paperConfig, {} as never);
    await expect(
      adapter.executeAsync({} as never, {} as never),
    ).rejects.toThrow("NOT_IMPLEMENTED");
  });
});

// ─── Season runner still works with default adapter ──────────────────────────

describe("runSeason still uses simulatedAdapter by default", () => {
  it("produces deterministic aggregate standings", () => {
    const mc = defaultMatchConfig();
    const r1 = runSeason(mc, 2);
    const r2 = runSeason(mc, 2);
    expect(r1.aggregate.map((a) => a.botId)).toEqual(r2.aggregate.map((a) => a.botId));
  });
});
