/**
 * M14 Slice 4B — computeAdvanceProposal() tests.
 *
 * Coverage:
 *   A. Determinism invariant — proposedPop child specs match advanceGeneration output exactly
 *   B. Proposal structure — fromGeneration, toGeneration, advancedAt
 *   C. fitnessRecords — contains all bots, correct kinds
 *   D. Survivor decisions — rank, fitnessScore, eligibleCount
 *   E. Retirement decisions — non-survivor with rank, gate-failure with reason
 *   F. Error paths — NoEligibleSurvivorsError, PopulationSizeMismatchError
 *   G. Cancel semantics — proposal is pure value; state is unchanged before commit
 */

import { describe, it, expect } from "vitest";
import {
  computeAdvanceProposal,
  advanceGeneration,
  scorePopulation,
  NoEligibleSurvivorsError,
  PopulationSizeMismatchError,
} from "../src/engine/evolution/index.ts";
import type {
  EvolvableBotSpec,
  EvolutionSeasonResult,
  EvolutionConfig,
  EvolutionRunState,
} from "../src/engine/evolution/index.ts";
import type { MetricSnapshot } from "../src/engine/types.ts";

// ─── Test helpers ─────────────────────────────────────────────────────────────

const FIXED_DATE = "2026-05-18T00:00:00.000Z";
const ADVANCED_DATE = "2026-05-18T12:00:00.000Z";

function makeSnapshot(
  botId: string,
  overrides: Partial<MetricSnapshot> = {},
): MetricSnapshot {
  return {
    botId,
    botName: `Bot ${botId}`,
    totalReturn: 0.05,
    finalEquity: 10_500,
    maxDrawdown: 0.10,
    winRate: 0.6,
    tradeCount: 10,
    closedTradeCount: 8,
    realizedPnl: 500,
    unrealizedPnl: 0,
    profitFactor: 1.5,
    avgTrade: 62.5,
    exposureTime: 0.4,
    rank: 1,
    ...overrides,
  };
}

function makeSeason(windows: Array<MetricSnapshot[]>): EvolutionSeasonResult {
  return {
    windows: windows.map((standings, index) => ({ index, standings })),
  };
}

function makeSpec(
  id: string,
  archetype = "rnd",
  overrides: Partial<EvolvableBotSpec> = {},
): EvolvableBotSpec {
  return {
    id,
    name: `Bot ${id}`,
    archetype,
    params: { buyProb: 0.1, sellProb: 0.1 },
    generation: 0,
    parentIds: [],
    mutationRate: 0.5,
    capital: 100,
    metadata: { lineageId: `lineage-${id}`, createdAt: FIXED_DATE },
    ...overrides,
  };
}

function makeConfig(overrides: Partial<EvolutionConfig> = {}): EvolutionConfig {
  return {
    populationSize: 4,
    survivorCount: 2,
    minTrades: 1,
    fitnessWeights: { return: 0.5, drawdown: 0.3, inconsistency: 0.2 },
    mutationRate: 0.5,
    ...overrides,
  };
}

function makeRunState(
  activePop: EvolvableBotSpec[],
  overrides: Partial<EvolutionRunState> = {},
): EvolutionRunState {
  return {
    runId: "proposal-test-run",
    generation: 0,
    activePop,
    archive: [],
    championHistory: {},
    config: makeConfig({
      populationSize: activePop.length,
      survivorCount: Math.max(1, Math.floor(activePop.length / 2)),
    }),
    seed: 99999,
    datasetManifest: {
      symbol: "TEST",
      fromDate: "2026-01-01",
      toDate: "2026-12-31",
      windowCount: 2,
      windowLengthDays: 90,
    },
    createdAt: FIXED_DATE,
    updatedAt: FIXED_DATE,
    ...overrides,
  };
}

/**
 * Build a season where all four bots pass gates with distinct returns.
 * Bot a: best (0.15), b: second (0.10), c: third (0.05), d: worst (0.01)
 */
function makeStandardSeason(ids: string[]): EvolutionSeasonResult {
  const returns = [0.15, 0.10, 0.05, 0.01];
  return makeSeason([
    ids.map((id, i) => makeSnapshot(id, { totalReturn: returns[i] ?? 0.01, tradeCount: 5 })),
    ids.map((id, i) => makeSnapshot(id, { totalReturn: returns[i] ?? 0.01, tradeCount: 5 })),
  ]);
}

// ─── A. Determinism invariant ─────────────────────────────────────────────────

describe("computeAdvanceProposal — determinism invariant", () => {
  it("proposedPop children match activePop from advanceGeneration at the same timestamp", () => {
    const pop = ["a", "b", "c", "d"].map((id) => makeSpec(id));
    const state = makeRunState(pop);
    const season = makeStandardSeason(pop.map((s) => s.id));

    const proposal = computeAdvanceProposal(state, season, ADVANCED_DATE);
    const nextState = advanceGeneration(state, season, ADVANCED_DATE);

    expect(proposal.proposedPop.length).toBe(nextState.activePop.length);
    for (let i = 0; i < proposal.proposedPop.length; i++) {
      const proposedChild = proposal.proposedPop[i].child;
      const committedChild = nextState.activePop[i];
      expect(proposedChild.id).toBe(committedChild.id);
      expect(proposedChild.archetype).toBe(committedChild.archetype);
      expect(proposedChild.generation).toBe(committedChild.generation);
      expect(proposedChild.params).toEqual(committedChild.params);
      expect(proposedChild.parentIds).toEqual(committedChild.parentIds);
    }
  });

  it("calling computeAdvanceProposal twice with the same timestamp produces identical proposals", () => {
    const pop = ["a", "b", "c", "d"].map((id) => makeSpec(id));
    const state = makeRunState(pop);
    const season = makeStandardSeason(pop.map((s) => s.id));

    const p1 = computeAdvanceProposal(state, season, ADVANCED_DATE);
    const p2 = computeAdvanceProposal(state, season, ADVANCED_DATE);

    for (let i = 0; i < p1.proposedPop.length; i++) {
      expect(p1.proposedPop[i].child.id).toBe(p2.proposedPop[i].child.id);
      expect(p1.proposedPop[i].child.params).toEqual(p2.proposedPop[i].child.params);
    }
  });

  it("different advancedAt timestamps produce different child createdAt dates", () => {
    const pop = ["a", "b", "c", "d"].map((id) => makeSpec(id));
    const state = makeRunState(pop);
    const season = makeStandardSeason(pop.map((s) => s.id));

    const p1 = computeAdvanceProposal(state, season, ADVANCED_DATE);
    const p2 = computeAdvanceProposal(state, season, "2026-06-01T00:00:00.000Z");

    // Same id (from seed, not timestamp), but different createdAt
    expect(p1.proposedPop[0].child.metadata.createdAt).toBe(ADVANCED_DATE);
    expect(p2.proposedPop[0].child.metadata.createdAt).toBe("2026-06-01T00:00:00.000Z");
  });
});

  it("tied fitness scores break by bot id ascending — rank annotations match selectSurvivors order", () => {
    // All four bots return the same score. selectSurvivors breaks ties by id ascending,
    // so "a" < "b" < "c" < "d". With survivorCount=2, "a" and "b" survive.
    const pop = ["c", "d", "a", "b"].map((id) => makeSpec(id)); // intentionally shuffled
    const state = makeRunState(pop, { config: makeConfig({ populationSize: 4, survivorCount: 2 }) });
    // All bots get identical per-window snapshots → identical fitnessScore
    const season = makeSeason([
      pop.map((s) => makeSnapshot(s.id, { totalReturn: 0.05, tradeCount: 5 })),
      pop.map((s) => makeSnapshot(s.id, { totalReturn: 0.05, tradeCount: 5 })),
    ]);

    const proposal = computeAdvanceProposal(state, season, ADVANCED_DATE);
    const survivorIds = proposal.survivors.map((s) => s.spec.id).sort();

    // "a" and "b" survive (lowest ids win ties)
    expect(survivorIds).toEqual(["a", "b"]);

    // rank 1 = "a" (lexicographically first among ties)
    const rank1 = proposal.survivors.find((s) => s.rank === 1);
    expect(rank1?.spec.id).toBe("a");

    // "c" and "d" are retired as non-survivors
    const retiredIds = proposal.retired.map((r) => r.spec.id).sort();
    expect(retiredIds).toEqual(["c", "d"]);

    // Committed state uses the same tiebreaker — survivors match proposal exactly
    const nextState = advanceGeneration(state, season, ADVANCED_DATE);
    const committedSurvivorIds = nextState.archive
      .filter((a) => a.retirementReason === "reproduced")
      .map((a) => a.id)
      .sort();
    expect(committedSurvivorIds).toEqual(["a", "b"]);
  });

// ─── B. Proposal structure ────────────────────────────────────────────────────

describe("computeAdvanceProposal — proposal structure", () => {
  it("fromGeneration matches state.generation", () => {
    const pop = ["a", "b"].map((id) => makeSpec(id));
    const state = makeRunState(pop, { generation: 3, config: makeConfig({ populationSize: 2, survivorCount: 1 }) });
    const season = makeStandardSeason(["a", "b"]);
    const proposal = computeAdvanceProposal(state, season, ADVANCED_DATE);
    expect(proposal.fromGeneration).toBe(3);
  });

  it("toGeneration is fromGeneration + 1", () => {
    const pop = ["a", "b"].map((id) => makeSpec(id));
    const state = makeRunState(pop, { generation: 3, config: makeConfig({ populationSize: 2, survivorCount: 1 }) });
    const season = makeStandardSeason(["a", "b"]);
    const proposal = computeAdvanceProposal(state, season, ADVANCED_DATE);
    expect(proposal.toGeneration).toBe(4);
  });

  it("advancedAt is preserved exactly", () => {
    const pop = ["a", "b"].map((id) => makeSpec(id));
    const state = makeRunState(pop, { config: makeConfig({ populationSize: 2, survivorCount: 1 }) });
    const season = makeStandardSeason(["a", "b"]);
    const proposal = computeAdvanceProposal(state, season, ADVANCED_DATE);
    expect(proposal.advancedAt).toBe(ADVANCED_DATE);
  });

  it("proposedPop has exactly populationSize entries", () => {
    const pop = ["a", "b", "c", "d"].map((id) => makeSpec(id));
    const state = makeRunState(pop);
    const season = makeStandardSeason(pop.map((s) => s.id));
    const proposal = computeAdvanceProposal(state, season, ADVANCED_DATE);
    expect(proposal.proposedPop.length).toBe(state.config.populationSize);
  });
});

// ─── C. fitnessRecords ────────────────────────────────────────────────────────

describe("computeAdvanceProposal — fitnessRecords", () => {
  it("fitnessRecords contains all bots from the active population", () => {
    const pop = ["a", "b", "c", "d"].map((id) => makeSpec(id));
    const state = makeRunState(pop);
    const season = makeStandardSeason(pop.map((s) => s.id));
    const proposal = computeAdvanceProposal(state, season, ADVANCED_DATE);
    const ids = proposal.fitnessRecords.map((r) => r.spec.id).sort();
    expect(ids).toEqual(["a", "b", "c", "d"]);
  });

  it("fitnessRecords match scorePopulation output exactly", () => {
    const pop = ["a", "b", "c", "d"].map((id) => makeSpec(id));
    const state = makeRunState(pop);
    const season = makeStandardSeason(pop.map((s) => s.id));
    const proposal = computeAdvanceProposal(state, season, ADVANCED_DATE);
    const directRecords = scorePopulation(pop, season, state.config);

    for (const direct of directRecords) {
      const fromProposal = proposal.fitnessRecords.find((r) => r.spec.id === direct.spec.id);
      expect(fromProposal).toBeDefined();
      expect(fromProposal!.fitness).toEqual(direct.fitness);
    }
  });

  it("all scored bots have kind:'scored' in fitnessRecords", () => {
    const pop = ["a", "b", "c", "d"].map((id) => makeSpec(id));
    const state = makeRunState(pop);
    const season = makeStandardSeason(pop.map((s) => s.id));
    const proposal = computeAdvanceProposal(state, season, ADVANCED_DATE);
    const kinds = proposal.fitnessRecords.map((r) => r.fitness.kind);
    expect(kinds.every((k) => k === "scored")).toBe(true);
  });
});

// ─── D. Survivor decisions ────────────────────────────────────────────────────

describe("computeAdvanceProposal — survivor decisions", () => {
  it("survivors count equals config.survivorCount", () => {
    const pop = ["a", "b", "c", "d"].map((id) => makeSpec(id));
    const state = makeRunState(pop, { config: makeConfig({ populationSize: 4, survivorCount: 2 }) });
    const season = makeStandardSeason(pop.map((s) => s.id));
    const proposal = computeAdvanceProposal(state, season, ADVANCED_DATE);
    expect(proposal.survivors.length).toBe(2);
  });

  it("survivors are ranked 1..survivorCount and contain the highest-scoring bots", () => {
    const pop = ["a", "b", "c", "d"].map((id) => makeSpec(id));
    const state = makeRunState(pop, { config: makeConfig({ populationSize: 4, survivorCount: 2 }) });
    // a has the highest return (rank 1), b second (rank 2)
    const season = makeStandardSeason(["a", "b", "c", "d"]);
    const proposal = computeAdvanceProposal(state, season, ADVANCED_DATE);

    const survivorIds = proposal.survivors.map((s) => s.spec.id);
    expect(survivorIds).toContain("a");
    expect(survivorIds).toContain("b");

    const rank1 = proposal.survivors.find((s) => s.rank === 1);
    expect(rank1?.spec.id).toBe("a");
    const rank2 = proposal.survivors.find((s) => s.rank === 2);
    expect(rank2?.spec.id).toBe("b");
  });

  it("each survivor carries a valid fitnessScore", () => {
    const pop = ["a", "b", "c", "d"].map((id) => makeSpec(id));
    const state = makeRunState(pop, { config: makeConfig({ populationSize: 4, survivorCount: 2 }) });
    const season = makeStandardSeason(pop.map((s) => s.id));
    const proposal = computeAdvanceProposal(state, season, ADVANCED_DATE);
    for (const s of proposal.survivors) {
      expect(typeof s.fitnessScore).toBe("number");
      expect(isFinite(s.fitnessScore)).toBe(true);
    }
  });

  it("eligibleCount equals total scored (non-gate-failed) bots", () => {
    const pop = ["a", "b", "c", "d"].map((id) => makeSpec(id));
    const state = makeRunState(pop, { config: makeConfig({ populationSize: 4, survivorCount: 2 }) });
    const season = makeStandardSeason(pop.map((s) => s.id));
    const proposal = computeAdvanceProposal(state, season, ADVANCED_DATE);
    for (const s of proposal.survivors) {
      expect(s.eligibleCount).toBe(4); // all 4 bots scored
    }
  });
});

// ─── E. Retirement decisions ──────────────────────────────────────────────────

describe("computeAdvanceProposal — retirement decisions", () => {
  it("retired count equals (total - survivors) bots", () => {
    const pop = ["a", "b", "c", "d"].map((id) => makeSpec(id));
    const state = makeRunState(pop, { config: makeConfig({ populationSize: 4, survivorCount: 2 }) });
    const season = makeStandardSeason(pop.map((s) => s.id));
    const proposal = computeAdvanceProposal(state, season, ADVANCED_DATE);
    expect(proposal.retired.length).toBe(2);
  });

  it("non-survivor bots carry retirementReason:'non-survivor' with rank and fitnessScore", () => {
    const pop = ["a", "b", "c", "d"].map((id) => makeSpec(id));
    const state = makeRunState(pop, { config: makeConfig({ populationSize: 4, survivorCount: 2 }) });
    const season = makeStandardSeason(["a", "b", "c", "d"]);
    const proposal = computeAdvanceProposal(state, season, ADVANCED_DATE);

    // c and d should be non-survivors (ranks 3 and 4)
    const nonSurvivors = proposal.retired.filter((r) => r.retirementReason === "non-survivor");
    expect(nonSurvivors.length).toBe(2);
    for (const r of nonSurvivors) {
      expect(r.fitnessScore).toBeDefined();
      expect(r.rank).toBeDefined();
      expect(r.rank).toBeGreaterThan(2); // below survivor threshold
    }
  });

  it("gate-failed bots carry retirementReason:'gate-failure' with gateFailureReason", () => {
    // bot "zero" fails the activity gate (0 trades)
    const pop = ["a", "b", "c", "zero"].map((id) => makeSpec(id));
    const state = makeRunState(pop, { config: makeConfig({ populationSize: 4, survivorCount: 2, minTrades: 5 }) });
    const season = makeSeason([
      [
        makeSnapshot("a", { totalReturn: 0.15, tradeCount: 10 }),
        makeSnapshot("b", { totalReturn: 0.10, tradeCount: 10 }),
        makeSnapshot("c", { totalReturn: 0.05, tradeCount: 10 }),
        makeSnapshot("zero", { totalReturn: 0.00, tradeCount: 0 }), // fails activity
      ],
      [
        makeSnapshot("a", { totalReturn: 0.15, tradeCount: 10 }),
        makeSnapshot("b", { totalReturn: 0.10, tradeCount: 10 }),
        makeSnapshot("c", { totalReturn: 0.05, tradeCount: 10 }),
        makeSnapshot("zero", { totalReturn: 0.00, tradeCount: 0 }),
      ],
    ]);
    const proposal = computeAdvanceProposal(state, season, ADVANCED_DATE);

    const zeroDec = proposal.retired.find((r) => r.spec.id === "zero");
    expect(zeroDec).toBeDefined();
    expect(zeroDec!.retirementReason).toBe("gate-failure");
    expect(zeroDec!.gateFailureReason).toBe("activity");
    expect(zeroDec!.fitnessScore).toBeUndefined();
    expect(zeroDec!.rank).toBeUndefined();
  });

  it("survival gate failure is carried through retirementDecision", () => {
    const pop = ["a", "b", "c", "bust"].map((id) => makeSpec(id));
    const state = makeRunState(pop, { config: makeConfig({ populationSize: 4, survivorCount: 2 }) });
    const season = makeSeason([
      [
        makeSnapshot("a", { totalReturn: 0.10, tradeCount: 5, finalEquity: 11000 }),
        makeSnapshot("b", { totalReturn: 0.05, tradeCount: 5, finalEquity: 10500 }),
        makeSnapshot("c", { totalReturn: 0.01, tradeCount: 5, finalEquity: 10100 }),
        makeSnapshot("bust", { totalReturn: -1.0, tradeCount: 5, finalEquity: 0 }), // bust
      ],
      [
        makeSnapshot("a", { totalReturn: 0.10, tradeCount: 5, finalEquity: 11000 }),
        makeSnapshot("b", { totalReturn: 0.05, tradeCount: 5, finalEquity: 10500 }),
        makeSnapshot("c", { totalReturn: 0.01, tradeCount: 5, finalEquity: 10100 }),
        makeSnapshot("bust", { totalReturn: -1.0, tradeCount: 5, finalEquity: 0 }),
      ],
    ]);
    const proposal = computeAdvanceProposal(state, season, ADVANCED_DATE);

    const bustDec = proposal.retired.find((r) => r.spec.id === "bust");
    expect(bustDec!.retirementReason).toBe("gate-failure");
    expect(bustDec!.gateFailureReason).toBe("survival");
  });
});

// ─── F. Error paths ───────────────────────────────────────────────────────────

describe("computeAdvanceProposal — error paths", () => {
  it("throws NoEligibleSurvivorsError when all bots fail the activity gate", () => {
    const pop = ["a", "b", "c", "d"].map((id) => makeSpec(id));
    const state = makeRunState(pop, { config: makeConfig({ populationSize: 4, survivorCount: 2, minTrades: 100 }) });
    // All bots have 0 trades → all fail activity gate
    const season = makeSeason([
      pop.map((s) => makeSnapshot(s.id, { tradeCount: 0 })),
      pop.map((s) => makeSnapshot(s.id, { tradeCount: 0 })),
    ]);
    expect(() => computeAdvanceProposal(state, season, ADVANCED_DATE))
      .toThrow(NoEligibleSurvivorsError);
  });

  it("throws PopulationSizeMismatchError when activePop length ≠ config.populationSize", () => {
    const pop = ["a", "b", "c"].map((id) => makeSpec(id));
    const state = makeRunState(pop, { config: makeConfig({ populationSize: 5, survivorCount: 2 }) });
    const season = makeStandardSeason(["a", "b", "c"]);
    expect(() => computeAdvanceProposal(state, season, ADVANCED_DATE))
      .toThrow(PopulationSizeMismatchError);
  });

  it("NoEligibleSurvivorsError carries correct generation and gateFailureCount", () => {
    const pop = ["a", "b"].map((id) => makeSpec(id));
    const state = makeRunState(pop, { generation: 2, config: makeConfig({ populationSize: 2, survivorCount: 1, minTrades: 999 }) });
    const season = makeSeason([
      [makeSnapshot("a", { tradeCount: 0 }), makeSnapshot("b", { tradeCount: 0 })],
      [makeSnapshot("a", { tradeCount: 0 }), makeSnapshot("b", { tradeCount: 0 })],
    ]);
    try {
      computeAdvanceProposal(state, season, ADVANCED_DATE);
      throw new Error("should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(NoEligibleSurvivorsError);
      const e = err as NoEligibleSurvivorsError;
      expect(e.generation).toBe(2);
      expect(e.gateFailureCount).toBe(2);
      expect(e.totalBots).toBe(2);
    }
  });
});

// ─── G. Cancel semantics ──────────────────────────────────────────────────────

describe("computeAdvanceProposal — cancel semantics", () => {
  it("original run state is not mutated when proposal is computed", () => {
    const pop = ["a", "b", "c", "d"].map((id) => makeSpec(id));
    const state = makeRunState(pop);
    const originalGen = state.generation;
    const originalArchiveLen = state.archive.length;
    const originalPopIds = state.activePop.map((s) => s.id);
    const season = makeStandardSeason(pop.map((s) => s.id));

    computeAdvanceProposal(state, season, ADVANCED_DATE);

    // State is unchanged — proposal is pure
    expect(state.generation).toBe(originalGen);
    expect(state.archive.length).toBe(originalArchiveLen);
    expect(state.activePop.map((s) => s.id)).toEqual(originalPopIds);
  });

  it("discarding the proposal (not calling advanceGeneration) leaves no side effects", () => {
    const pop = ["a", "b", "c", "d"].map((id) => makeSpec(id));
    const state = makeRunState(pop);
    const season = makeStandardSeason(pop.map((s) => s.id));

    // Compute and immediately discard (return value intentionally unused)
    computeAdvanceProposal(state, season, ADVANCED_DATE);

    // State is still pristine
    expect(state.generation).toBe(0);
    expect(state.archive).toHaveLength(0);
    expect(state.activePop).toHaveLength(4);
  });

  it("committing after computing produces the same result as never using the proposal", () => {
    const pop = ["a", "b", "c", "d"].map((id) => makeSpec(id));
    const state = makeRunState(pop);
    const season = makeStandardSeason(pop.map((s) => s.id));

    // Path A: compute proposal then commit with proposal.advancedAt
    const proposal = computeAdvanceProposal(state, season, ADVANCED_DATE);
    const committed = advanceGeneration(state, season, proposal.advancedAt);

    // Path B: direct advance with the same timestamp
    const direct = advanceGeneration(state, season, ADVANCED_DATE);

    // Both paths produce identical state
    expect(committed.generation).toBe(direct.generation);
    expect(committed.activePop.map((s) => s.id)).toEqual(direct.activePop.map((s) => s.id));
    expect(committed.archive.map((a) => a.id).sort()).toEqual(direct.archive.map((a) => a.id).sort());
  });
});
