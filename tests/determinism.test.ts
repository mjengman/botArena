import { describe, it, expect } from "vitest";
import { createSimulation } from "../src/engine/simulation.ts";
import { sampleDataset } from "../src/data/sampleDataset.ts";
import { buyAndHold } from "../src/strategies/buyAndHold.ts";
import { movingAverageCrossover } from "../src/strategies/movingAverageCrossover.ts";
import { momentum } from "../src/strategies/momentum.ts";
import { meanReversion } from "../src/strategies/meanReversion.ts";
import { randomBaseline } from "../src/strategies/randomBaseline.ts";
import type { SimulationConfig, BotSpec } from "../src/engine/types.ts";

const config: SimulationConfig = {
  startingCash: 10_000,
  feeBps: 5,
  slippageBps: 3,
  seed: 42,
};

const botSpecs: BotSpec[] = [
  { id: "bah", name: "Buy & Hold", strategy: buyAndHold },
  { id: "mac", name: "MA Crossover", strategy: movingAverageCrossover },
  { id: "mom", name: "Momentum", strategy: momentum },
  { id: "mr", name: "Mean Reversion", strategy: meanReversion },
  { id: "rnd", name: "Random", strategy: randomBaseline },
];

function runMatch() {
  const sim = createSimulation(config, sampleDataset, botSpecs);
  sim.runToEnd();
  return {
    standings: sim.getStandings(),
    eventCount: sim.getEvents().length,
  };
}

describe("Determinism", () => {
  it("produces identical standings on two runs", () => {
    const run1 = runMatch();
    const run2 = runMatch();
    expect(run1.standings).toEqual(run2.standings);
  });

  it("produces identical event counts on two runs", () => {
    const run1 = runMatch();
    const run2 = runMatch();
    expect(run1.eventCount).toBe(run2.eventCount);
  });

  it("produces identical event sequences on two runs", () => {
    const sim1 = createSimulation(config, sampleDataset, botSpecs);
    const sim2 = createSimulation(config, sampleDataset, botSpecs);
    sim1.runToEnd();
    sim2.runToEnd();
    const events1 = JSON.stringify(sim1.getEvents());
    const events2 = JSON.stringify(sim2.getEvents());
    expect(events1).toBe(events2);
  });

  it("reset and re-run produces the same result", () => {
    const sim = createSimulation(config, sampleDataset, botSpecs);
    sim.runToEnd();
    const run1 = JSON.stringify(sim.getStandings());

    sim.reset();
    sim.runToEnd();
    const run2 = JSON.stringify(sim.getStandings());

    expect(run1).toBe(run2);
  });

  it("step-by-step and runToEnd produce the same final standings", () => {
    const sim1 = createSimulation(config, sampleDataset, botSpecs);
    sim1.runToEnd();
    const fast = JSON.stringify(sim1.getStandings());

    const sim2 = createSimulation(config, sampleDataset, botSpecs);
    while (sim2.step()) { /* advance */ }
    const slow = JSON.stringify(sim2.getStandings());

    expect(fast).toBe(slow);
  });
});
