/**
 * M14 Slice 4C — commitProposal() tests.
 *
 * Coverage:
 *   A. Archive correctness — survivors → "reproduced", retired by reason
 *   B. Active population — set to proposedPop.map(p => p.child)
 *   C. Champion history — updated from proposal.fitnessRecords
 *   D. State metadata — generation incremented, updatedAt = proposal.advancedAt
 *   E. Determinism — commitProposal matches advanceGeneration for no-override proposals
 *   F. Override commit — vetoed bots archived as "vetoed"; pinned archived as "reproduced"
 */

import { describe, it, expect } from "vitest";
import {
  computeAdvanceProposal,
  commitProposal,
  advanceGeneration,
  StaleProposalError,
} from "../src/engine/evolution/index.ts";
import type {
  EvolvableBotSpec,
  EvolutionSeasonResult,
  EvolutionConfig,
  EvolutionRunState,
  AdvanceOverrides,
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
    runId: "commit-test-run",
    generation: 0,
    activePop,
    archive: [],
    championHistory: {},
    config: makeConfig({
      populationSize: activePop.length,
      survivorCount: Math.max(1, Math.floor(activePop.length / 2)),
    }),
    seed: 42424,
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

function makeStandardSeason(ids: string[]): EvolutionSeasonResult {
  const returns = [0.15, 0.10, 0.05, 0.01];
  return makeSeason([
    ids.map((id, i) => makeSnapshot(id, { totalReturn: returns[i] ?? 0.01, tradeCount: 5 })),
    ids.map((id, i) => makeSnapshot(id, { totalReturn: returns[i] ?? 0.01, tradeCount: 5 })),
  ]);
}

// ─── A. Archive correctness ───────────────────────────────────────────────────

describe("commitProposal — archive correctness", () => {
  it("survivors are archived as 'reproduced'", () => {
    const pop = ["a", "b", "c", "d"].map((id) => makeSpec(id));
    const state = makeRunState(pop);
    const season = makeStandardSeason(pop.map((s) => s.id));

    const proposal = computeAdvanceProposal(state, season, ADVANCED_DATE);
    const nextState = commitProposal(state, proposal);

    const reproducedIds = nextState.archive
      .filter((a) => a.retirementReason === "reproduced")
      .map((a) => a.id)
      .sort();
    const survivorIds = proposal.survivors.map((s) => s.spec.id).sort();
    expect(reproducedIds).toEqual(survivorIds);
  });

  it("non-survivors are archived as 'non-survivor'", () => {
    const pop = ["a", "b", "c", "d"].map((id) => makeSpec(id));
    const state = makeRunState(pop);
    const season = makeStandardSeason(pop.map((s) => s.id));

    const proposal = computeAdvanceProposal(state, season, ADVANCED_DATE);
    const nextState = commitProposal(state, proposal);

    const nonSurvivorIds = nextState.archive
      .filter((a) => a.retirementReason === "non-survivor")
      .map((a) => a.id)
      .sort();
    const expectedNonSurvivors = proposal.retired
      .filter((r) => r.retirementReason === "non-survivor")
      .map((r) => r.spec.id)
      .sort();
    expect(nonSurvivorIds).toEqual(expectedNonSurvivors);
  });

  it("gate-failed bots are archived as 'gate-failure'", () => {
    const pop = ["a", "b", "c", "zero"].map((id) => makeSpec(id));
    const state = makeRunState(pop, { config: makeConfig({ populationSize: 4, survivorCount: 2, minTrades: 5 }) });
    const season = makeSeason([
      [
        makeSnapshot("a", { totalReturn: 0.15, tradeCount: 10 }),
        makeSnapshot("b", { totalReturn: 0.10, tradeCount: 10 }),
        makeSnapshot("c", { totalReturn: 0.05, tradeCount: 10 }),
        makeSnapshot("zero", { totalReturn: 0.00, tradeCount: 0 }),
      ],
      [
        makeSnapshot("a", { totalReturn: 0.15, tradeCount: 10 }),
        makeSnapshot("b", { totalReturn: 0.10, tradeCount: 10 }),
        makeSnapshot("c", { totalReturn: 0.05, tradeCount: 10 }),
        makeSnapshot("zero", { totalReturn: 0.00, tradeCount: 0 }),
      ],
    ]);

    const proposal = computeAdvanceProposal(state, season, ADVANCED_DATE);
    const nextState = commitProposal(state, proposal);

    const zeroRecord = nextState.archive.find((a) => a.id === "zero");
    expect(zeroRecord?.retirementReason).toBe("gate-failure");
  });

  it("every bot in activePop appears exactly once in the archive", () => {
    const pop = ["a", "b", "c", "d"].map((id) => makeSpec(id));
    const state = makeRunState(pop);
    const season = makeStandardSeason(pop.map((s) => s.id));

    const proposal = computeAdvanceProposal(state, season, ADVANCED_DATE);
    const nextState = commitProposal(state, proposal);

    const archivedIds = nextState.archive.map((a) => a.id).sort();
    const popIds = pop.map((s) => s.id).sort();
    expect(archivedIds).toEqual(popIds);
  });
});

// ─── B. Active population ─────────────────────────────────────────────────────

describe("commitProposal — active population", () => {
  it("activePop is set to proposal.proposedPop children", () => {
    const pop = ["a", "b", "c", "d"].map((id) => makeSpec(id));
    const state = makeRunState(pop);
    const season = makeStandardSeason(pop.map((s) => s.id));

    const proposal = computeAdvanceProposal(state, season, ADVANCED_DATE);
    const nextState = commitProposal(state, proposal);

    expect(nextState.activePop.length).toBe(proposal.proposedPop.length);
    for (let i = 0; i < proposal.proposedPop.length; i++) {
      expect(nextState.activePop[i].id).toBe(proposal.proposedPop[i].child.id);
    }
  });

  it("activePop children have generation = toGeneration", () => {
    const pop = ["a", "b", "c", "d"].map((id) => makeSpec(id));
    const state = makeRunState(pop);
    const season = makeStandardSeason(pop.map((s) => s.id));

    const proposal = computeAdvanceProposal(state, season, ADVANCED_DATE);
    const nextState = commitProposal(state, proposal);

    for (const child of nextState.activePop) {
      expect(child.generation).toBe(proposal.toGeneration);
    }
  });
});

// ─── C. Champion history ──────────────────────────────────────────────────────

describe("commitProposal — champion history", () => {
  it("champion history is updated with the best scorer per archetype", () => {
    const pop = ["a", "b", "c", "d"].map((id) => makeSpec(id));
    const state = makeRunState(pop);
    const season = makeStandardSeason(pop.map((s) => s.id));

    expect(Object.keys(state.championHistory)).toHaveLength(0);

    const proposal = computeAdvanceProposal(state, season, ADVANCED_DATE);
    const nextState = commitProposal(state, proposal);

    // All bots are "rnd" archetype — champion should be "a" (best fitness)
    expect(nextState.championHistory["rnd"]).toBeDefined();
    expect(nextState.championHistory["rnd"].botId).toBe("a");
  });
});

// ─── D. State metadata ────────────────────────────────────────────────────────

describe("commitProposal — state metadata", () => {
  it("generation is incremented to proposal.toGeneration", () => {
    const pop = ["a", "b", "c", "d"].map((id) => makeSpec(id));
    const state = makeRunState(pop, { generation: 5 });
    const season = makeStandardSeason(pop.map((s) => s.id));

    const proposal = computeAdvanceProposal(state, season, ADVANCED_DATE);
    const nextState = commitProposal(state, proposal);

    expect(nextState.generation).toBe(6);
  });

  it("updatedAt is set to proposal.advancedAt", () => {
    const pop = ["a", "b", "c", "d"].map((id) => makeSpec(id));
    const state = makeRunState(pop);
    const season = makeStandardSeason(pop.map((s) => s.id));

    const proposal = computeAdvanceProposal(state, season, ADVANCED_DATE);
    const nextState = commitProposal(state, proposal);

    expect(nextState.updatedAt).toBe(ADVANCED_DATE);
  });

  it("input state is never mutated", () => {
    const pop = ["a", "b", "c", "d"].map((id) => makeSpec(id));
    const state = makeRunState(pop);
    const originalGen = state.generation;
    const originalArchiveLen = state.archive.length;
    const season = makeStandardSeason(pop.map((s) => s.id));

    const proposal = computeAdvanceProposal(state, season, ADVANCED_DATE);
    commitProposal(state, proposal);

    expect(state.generation).toBe(originalGen);
    expect(state.archive.length).toBe(originalArchiveLen);
  });
});

// ─── E. Determinism vs advanceGeneration ─────────────────────────────────────

describe("commitProposal — determinism vs advanceGeneration", () => {
  it("commitProposal(state, proposal) produces the same activePop as advanceGeneration (no overrides)", () => {
    const pop = ["a", "b", "c", "d"].map((id) => makeSpec(id));
    const state = makeRunState(pop);
    const season = makeStandardSeason(pop.map((s) => s.id));

    const proposal = computeAdvanceProposal(state, season, ADVANCED_DATE);
    const committed = commitProposal(state, proposal);
    const direct = advanceGeneration(state, season, ADVANCED_DATE);

    expect(committed.generation).toBe(direct.generation);
    expect(committed.activePop.map((s) => s.id)).toEqual(direct.activePop.map((s) => s.id));
    for (let i = 0; i < committed.activePop.length; i++) {
      expect(committed.activePop[i].params).toEqual(direct.activePop[i].params);
    }
  });

  it("committed archive IDs match advanceGeneration archive IDs (no overrides)", () => {
    const pop = ["a", "b", "c", "d"].map((id) => makeSpec(id));
    const state = makeRunState(pop);
    const season = makeStandardSeason(pop.map((s) => s.id));

    const proposal = computeAdvanceProposal(state, season, ADVANCED_DATE);
    const committed = commitProposal(state, proposal);
    const direct = advanceGeneration(state, season, ADVANCED_DATE);

    expect(committed.archive.map((a) => a.id).sort())
      .toEqual(direct.archive.map((a) => a.id).sort());

    expect(committed.archive.map((a) => a.retirementReason).sort())
      .toEqual(direct.archive.map((a) => a.retirementReason).sort());
  });
});

// ─── F. Override commit ───────────────────────────────────────────────────────

describe("commitProposal — override commit", () => {
  it("vetoed bots are archived with retirementReason:'vetoed'", () => {
    const pop = ["a", "b", "c", "d"].map((id) => makeSpec(id));
    const state = makeRunState(pop, { config: makeConfig({ populationSize: 4, survivorCount: 2 }) });
    const season = makeStandardSeason(["a", "b", "c", "d"]);

    // Veto a (rank #1) — b,c survive
    const overrides: AdvanceOverrides = { vetoedIds: new Set(["a"]) };
    const proposal = computeAdvanceProposal(state, season, ADVANCED_DATE, overrides);
    const nextState = commitProposal(state, proposal);

    const aRecord = nextState.archive.find((r) => r.id === "a");
    expect(aRecord?.retirementReason).toBe("vetoed");
  });

  it("pinned bots are archived as 'reproduced'", () => {
    const pop = ["a", "b", "c", "d"].map((id) => makeSpec(id));
    const state = makeRunState(pop, { config: makeConfig({ populationSize: 4, survivorCount: 2 }) });
    const season = makeStandardSeason(["a", "b", "c", "d"]);

    // Pin d (rank #4) — a,b,d survive
    const overrides: AdvanceOverrides = { pinnedIds: new Set(["d"]) };
    const proposal = computeAdvanceProposal(state, season, ADVANCED_DATE, overrides);
    const nextState = commitProposal(state, proposal);

    const dRecord = nextState.archive.find((r) => r.id === "d");
    expect(dRecord?.retirementReason).toBe("reproduced");
  });

  it("rerolled slot produces a different child in activePop than without reroll", () => {
    const pop = ["a", "b", "c", "d"].map((id) => makeSpec(id));
    const state = makeRunState(pop);
    const season = makeStandardSeason(pop.map((s) => s.id));

    const baseProposal = computeAdvanceProposal(state, season, ADVANCED_DATE);
    const rerolledProposal = computeAdvanceProposal(state, season, ADVANCED_DATE, {
      rerollCounts: new Map([[0, 1]]),
    });

    const baseState = commitProposal(state, baseProposal);
    const rerolledState = commitProposal(state, rerolledProposal);

    // Slot 0 should differ
    expect(rerolledState.activePop[0].id).not.toBe(baseState.activePop[0].id);
    // Other slots should be the same
    expect(rerolledState.activePop[1].id).toBe(baseState.activePop[1].id);
  });
});

// ─── G. Override metadata in archive ─────────────────────────────────────────

describe("commitProposal — override metadata in archive", () => {
  it("pinned survivor is archived with pinnedOverride:true", () => {
    const pop = ["a", "b", "c", "d"].map((id) => makeSpec(id));
    const state = makeRunState(pop, { config: makeConfig({ populationSize: 4, survivorCount: 2 }) });
    const season = makeStandardSeason(["a", "b", "c", "d"]);

    // Pin d (rank #4 — extra-pinned survivor)
    const overrides: AdvanceOverrides = { pinnedIds: new Set(["d"]) };
    const proposal = computeAdvanceProposal(state, season, ADVANCED_DATE, overrides);
    const nextState = commitProposal(state, proposal);

    const dRecord = nextState.archive.find((r) => r.id === "d");
    expect(dRecord?.retirementReason).toBe("reproduced");
    expect(dRecord?.pinnedOverride).toBe(true);
  });

  it("standard survivor also receives pinnedOverride:true when pinned (pin intent reflected even if already in top-N)", () => {
    const pop = ["a", "b", "c", "d"].map((id) => makeSpec(id));
    const state = makeRunState(pop, { config: makeConfig({ populationSize: 4, survivorCount: 2 }) });
    const season = makeStandardSeason(["a", "b", "c", "d"]);

    // Pin a (rank #1 — already in standard top-N)
    const overrides: AdvanceOverrides = { pinnedIds: new Set(["a"]) };
    const proposal = computeAdvanceProposal(state, season, ADVANCED_DATE, overrides);
    const nextState = commitProposal(state, proposal);

    const aRecord = nextState.archive.find((r) => r.id === "a");
    expect(aRecord?.retirementReason).toBe("reproduced");
    expect(aRecord?.pinnedOverride).toBe(true);
  });

  it("non-pinned survivor does not receive pinnedOverride", () => {
    const pop = ["a", "b", "c", "d"].map((id) => makeSpec(id));
    const state = makeRunState(pop, { config: makeConfig({ populationSize: 4, survivorCount: 2 }) });
    const season = makeStandardSeason(["a", "b", "c", "d"]);

    // Pin d only; a and b survive normally
    const overrides: AdvanceOverrides = { pinnedIds: new Set(["d"]) };
    const proposal = computeAdvanceProposal(state, season, ADVANCED_DATE, overrides);
    const nextState = commitProposal(state, proposal);

    const aRecord = nextState.archive.find((r) => r.id === "a");
    expect(aRecord?.pinnedOverride).toBeUndefined();
  });

  it("pin reason flows into overrideNotes on the archived record", () => {
    const pop = ["a", "b", "c", "d"].map((id) => makeSpec(id));
    const state = makeRunState(pop, { config: makeConfig({ populationSize: 4, survivorCount: 2 }) });
    const season = makeStandardSeason(["a", "b", "c", "d"]);

    const overrides: AdvanceOverrides = {
      pinnedIds: new Set(["d"]),
      pinReasons: new Map([["d", "long winning streak"]]),
    };
    const proposal = computeAdvanceProposal(state, season, ADVANCED_DATE, overrides);
    const nextState = commitProposal(state, proposal);

    const dRecord = nextState.archive.find((r) => r.id === "d");
    expect(dRecord?.overrideNotes).toBe("long winning streak");
  });

  it("pin reason is absent when pinReasons contains an ID not in pinnedIds", () => {
    // Guards against the bug: a normal survivor receiving overrideNotes from
    // pinReasons without actually being pinned.
    const pop = ["a", "b", "c", "d"].map((id) => makeSpec(id));
    const state = makeRunState(pop, { config: makeConfig({ populationSize: 4, survivorCount: 2 }) });
    const season = makeStandardSeason(["a", "b", "c", "d"]);

    // Intentionally supply a pinReason for "a" without adding "a" to pinnedIds
    const overrides: AdvanceOverrides = {
      pinnedIds: new Set<string>(),
      pinReasons: new Map([["a", "spurious note"]]),
    };
    const proposal = computeAdvanceProposal(state, season, ADVANCED_DATE, overrides);
    const nextState = commitProposal(state, proposal);

    const aRecord = nextState.archive.find((r) => r.id === "a");
    expect(aRecord?.overrideNotes).toBeUndefined();
    expect(aRecord?.pinnedOverride).toBeUndefined();
  });

  it("veto reason flows into overrideNotes on the archived record", () => {
    const pop = ["a", "b", "c", "d"].map((id) => makeSpec(id));
    const state = makeRunState(pop, { config: makeConfig({ populationSize: 4, survivorCount: 2 }) });
    const season = makeStandardSeason(["a", "b", "c", "d"]);

    const overrides: AdvanceOverrides = {
      vetoedIds: new Set(["a"]),
      vetoReasons: new Map([["a", "overfitted to last window"]]),
    };
    const proposal = computeAdvanceProposal(state, season, ADVANCED_DATE, overrides);
    const nextState = commitProposal(state, proposal);

    const aRecord = nextState.archive.find((r) => r.id === "a");
    expect(aRecord?.retirementReason).toBe("vetoed");
    expect(aRecord?.overrideNotes).toBe("overfitted to last window");
  });

  it("rerolled child has metadata.notes = 'reroll:N' stamped in activePop", () => {
    const pop = ["a", "b", "c", "d"].map((id) => makeSpec(id));
    const state = makeRunState(pop);
    const season = makeStandardSeason(pop.map((s) => s.id));

    const proposal = computeAdvanceProposal(state, season, ADVANCED_DATE, {
      rerollCounts: new Map([[0, 3]]),
    });
    const nextState = commitProposal(state, proposal);

    expect(nextState.activePop[0].metadata.notes).toBe("reroll:3");
    // Other slots should have no reroll note
    expect(nextState.activePop[1].metadata.notes).toBeUndefined();
  });

  it("reroll count = 0 (default) does not stamp metadata.notes", () => {
    const pop = ["a", "b", "c", "d"].map((id) => makeSpec(id));
    const state = makeRunState(pop);
    const season = makeStandardSeason(pop.map((s) => s.id));

    const proposal = computeAdvanceProposal(state, season, ADVANCED_DATE);
    const nextState = commitProposal(state, proposal);

    for (const child of nextState.activePop) {
      expect(child.metadata.notes).toBeUndefined();
    }
  });
});

// ─── H. StaleProposalError — invariant enforcement ───────────────────────────

describe("commitProposal — StaleProposalError invariant enforcement", () => {
  it("throws StaleProposalError when proposal.fromGeneration does not match state.generation", () => {
    const pop = ["a", "b", "c", "d"].map((id) => makeSpec(id));
    const state = makeRunState(pop);
    const season = makeStandardSeason(pop.map((s) => s.id));

    const proposal = computeAdvanceProposal(state, season, ADVANCED_DATE);
    // Advance state by one generation, then try to commit the stale proposal
    const advancedState = commitProposal(state, proposal);

    expect(() => commitProposal(advancedState, proposal)).toThrow(StaleProposalError);
  });

  it("throws StaleProposalError when fitnessRecords contain duplicate IDs", () => {
    const pop = ["a", "b", "c", "d"].map((id) => makeSpec(id));
    const state = makeRunState(pop);
    const season = makeStandardSeason(pop.map((s) => s.id));

    const proposal = computeAdvanceProposal(state, season, ADVANCED_DATE);
    // Duplicate fitnessRecords — same IDs but length doubles; a Set check would pass
    // if the duplicated IDs happen to cover activePop, but length check catches it
    const tampered = {
      ...proposal,
      fitnessRecords: [...proposal.fitnessRecords, ...proposal.fitnessRecords],
    };

    expect(() => commitProposal(state, tampered)).toThrow(StaleProposalError);
  });

  it("throws StaleProposalError when survivor + retired list contains duplicates", () => {
    const pop = ["a", "b", "c", "d"].map((id) => makeSpec(id));
    const state = makeRunState(pop);
    const season = makeStandardSeason(pop.map((s) => s.id));

    const proposal = computeAdvanceProposal(state, season, ADVANCED_DATE);
    // Duplicate a survivor decision — total decisions > activePop.length
    const tampered = {
      ...proposal,
      survivors: [...proposal.survivors, proposal.survivors[0]],
    };

    expect(() => commitProposal(state, tampered)).toThrow(StaleProposalError);
  });

  it("throws StaleProposalError when proposedPop.length mismatches populationSize", () => {
    const pop = ["a", "b", "c", "d"].map((id) => makeSpec(id));
    const state = makeRunState(pop);
    const season = makeStandardSeason(pop.map((s) => s.id));

    const proposal = computeAdvanceProposal(state, season, ADVANCED_DATE);
    const tampered = {
      ...proposal,
      proposedPop: proposal.proposedPop.slice(0, 2),
    };

    expect(() => commitProposal(state, tampered)).toThrow(StaleProposalError);
  });
});
