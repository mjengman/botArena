/**
 * M14 Slice 4D — confidence indicators and Evidence Ladder tests.
 *
 * Coverage:
 *   A. computeRegimeCoverage — counts by regime label
 *   B. lineageAge — founding generation detection
 *   C. generationsSurvived — "reproduced" archive record counting
 *   D. windowsEvaluated — historical + current accumulation
 *   E. gateFailureCount — gate-failure archive record counting
 *   F. paramStabilityRate — mutation summary vs archetype bounds
 *   G. computeEvidenceTier — threshold and tier assignment
 *   H. Determinism — same inputs → same outputs
 *   I. No side-effects on selection or mutation output
 */

import { describe, it, expect } from "vitest";
import {
  computeRegimeCoverage,
  computeConfidenceIndicators,
  computeEvidenceTier,
  DEFERRED_TIERS,
  EVIDENCE_TIER_ORDER,
  computeAdvanceProposal,
} from "../src/engine/evolution/index.ts";
import type {
  EvolvableBotSpec,
  ArchivedBotRecord,
  FitnessResult,
  EvolutionRunState,
  EvolutionSeasonResult,
  ConfidenceIndicators,
  RegimeCoverage,
} from "../src/engine/evolution/index.ts";
import type { RegimeLabel } from "../src/engine/evolution/regime.ts";
import type { MetricSnapshot } from "../src/engine/types.ts";

// ─── Test helpers ─────────────────────────────────────────────────────────────

const FIXED_DATE = "2026-05-18T00:00:00.000Z";
const ADVANCED_DATE = "2026-05-18T12:00:00.000Z";

function makeSpec(
  lineageId: string,
  generation: number,
  archetype = "rnd",
  mutationSummary?: string,
): EvolvableBotSpec {
  return {
    id: `${lineageId}-g${generation}`,
    name: `Bot ${lineageId}-g${generation}`,
    archetype,
    params: { buyProb: 0.3, sellProb: 0.3 },
    generation,
    parentIds: [],
    mutationRate: 0.3,
    capital: 100,
    metadata: {
      lineageId,
      createdAt: FIXED_DATE,
      ...(mutationSummary !== undefined ? { mutationSummary } : {}),
    },
  };
}

function makeFitnessResult(
  kind: "scored" | "gate-failure",
  windowCount = 4,
): FitnessResult {
  if (kind === "gate-failure") {
    return {
      kind: "gate-failure",
      gateFailureReason: "activity",
      windowMetricsSummary: {
        meanReturn: 0,
        worstWindowDrawdown: 0,
        returnStdDev: 0,
        totalTradeCount: 0,
        windowCount,
      },
    };
  }
  return {
    kind: "scored",
    fitnessScore: 0.05,
    windowMetricsSummary: {
      meanReturn: 0.05,
      worstWindowDrawdown: 0.02,
      returnStdDev: 0.01,
      totalTradeCount: 10,
      windowCount,
    },
  };
}

function makeArchiveRecord(
  lineageId: string,
  generation: number,
  retirementReason: ArchivedBotRecord["retirementReason"],
  windowCount = 4,
  archetype = "rnd",
): ArchivedBotRecord {
  const isGateFail = retirementReason === "gate-failure";
  return {
    id: `${lineageId}-g${generation}`,
    name: `Bot ${lineageId}-g${generation}`,
    archetype,
    params: { buyProb: 0.3, sellProb: 0.3 },
    generation,
    parentIds: [],
    lineageId,
    fitness: makeFitnessResult(isGateFail ? "gate-failure" : "scored", windowCount),
    retirementReason,
    retiredAtGeneration: generation,
  };
}

function makeIndicators(overrides: Partial<ConfidenceIndicators> = {}): ConfidenceIndicators {
  return {
    lineageAge: 0,
    generationsSurvived: 0,
    windowsEvaluated: 4,
    gateFailureCount: 0,
    regimeCoverage: null,
    paramStabilityRate: null,
    ...overrides,
  };
}

// ─── A. computeRegimeCoverage ─────────────────────────────────────────────────

describe("computeRegimeCoverage", () => {
  it("empty array returns all zeros", () => {
    const result = computeRegimeCoverage([]);
    expect(result).toEqual({ uptrend: 0, sideways: 0, downtrend: 0 });
  });

  it("all Uptrend labels counted correctly", () => {
    const result = computeRegimeCoverage(["Uptrend", "Uptrend", "Uptrend"]);
    expect(result).toEqual({ uptrend: 3, sideways: 0, downtrend: 0 });
  });

  it("all Sideways labels counted correctly", () => {
    const result = computeRegimeCoverage(["Sideways", "Sideways"]);
    expect(result).toEqual({ uptrend: 0, sideways: 2, downtrend: 0 });
  });

  it("all Downtrend labels counted correctly", () => {
    const result = computeRegimeCoverage(["Downtrend"]);
    expect(result).toEqual({ uptrend: 0, sideways: 0, downtrend: 1 });
  });

  it("mixed labels counted correctly", () => {
    const labels: RegimeLabel[] = ["Uptrend", "Sideways", "Downtrend", "Uptrend"];
    const result = computeRegimeCoverage(labels);
    expect(result).toEqual({ uptrend: 2, sideways: 1, downtrend: 1 });
  });

  it("order of labels does not affect counts", () => {
    const a = computeRegimeCoverage(["Uptrend", "Sideways", "Downtrend"]);
    const b = computeRegimeCoverage(["Downtrend", "Uptrend", "Sideways"]);
    expect(a).toEqual(b);
  });
});

// ─── B. lineageAge ────────────────────────────────────────────────────────────

describe("computeConfidenceIndicators — lineageAge", () => {
  it("returns 0 when there are no archive records for the lineage (founding member)", () => {
    const spec = makeSpec("lin-a", 0);
    const result = computeConfidenceIndicators(spec, [], 4);
    expect(result.lineageAge).toBe(0);
  });

  it("returns 0 when archive has records for other lineages only", () => {
    const spec = makeSpec("lin-a", 3);
    const archive = [
      makeArchiveRecord("lin-b", 0, "reproduced"),
      makeArchiveRecord("lin-c", 1, "non-survivor"),
    ];
    const result = computeConfidenceIndicators(spec, archive, 4);
    expect(result.lineageAge).toBe(0); // no records for lin-a → founding = spec.generation
  });

  it("returns correct age when archive contains founding ancestor", () => {
    // Lineage founded at gen 0, current spec at gen 3 → age 3
    const spec = makeSpec("lin-a", 3);
    const archive = [
      makeArchiveRecord("lin-a", 0, "reproduced"),
      makeArchiveRecord("lin-a", 1, "reproduced"),
      makeArchiveRecord("lin-a", 2, "reproduced"),
    ];
    const result = computeConfidenceIndicators(spec, archive, 4);
    expect(result.lineageAge).toBe(3);
  });

  it("uses the minimum generation in archive as founding generation", () => {
    const spec = makeSpec("lin-a", 5);
    const archive = [
      makeArchiveRecord("lin-a", 3, "reproduced"), // not the oldest
      makeArchiveRecord("lin-a", 1, "reproduced"), // oldest
    ];
    const result = computeConfidenceIndicators(spec, archive, 4);
    expect(result.lineageAge).toBe(4); // 5 - 1
  });
});

// ─── C. generationsSurvived ───────────────────────────────────────────────────

describe("computeConfidenceIndicators — generationsSurvived", () => {
  it("returns 0 for an empty archive", () => {
    const spec = makeSpec("lin-a", 0);
    const result = computeConfidenceIndicators(spec, [], 4);
    expect(result.generationsSurvived).toBe(0);
  });

  it("counts only 'reproduced' records for this lineage", () => {
    const spec = makeSpec("lin-a", 3);
    const archive = [
      makeArchiveRecord("lin-a", 0, "reproduced"),
      makeArchiveRecord("lin-a", 1, "reproduced"),
      makeArchiveRecord("lin-a", 2, "non-survivor"), // not reproduced
      makeArchiveRecord("lin-b", 0, "reproduced"),    // different lineage
    ];
    const result = computeConfidenceIndicators(spec, archive, 4);
    expect(result.generationsSurvived).toBe(2);
  });

  it("gate-failures and non-survivors are not counted as survived", () => {
    const spec = makeSpec("lin-a", 2);
    const archive = [
      makeArchiveRecord("lin-a", 0, "gate-failure"),
      makeArchiveRecord("lin-a", 1, "non-survivor"),
    ];
    const result = computeConfidenceIndicators(spec, archive, 4);
    expect(result.generationsSurvived).toBe(0);
  });
});

// ─── D. windowsEvaluated ─────────────────────────────────────────────────────

describe("computeConfidenceIndicators — windowsEvaluated", () => {
  it("returns currentSeasonWindowCount when archive is empty", () => {
    const spec = makeSpec("lin-a", 0);
    const result = computeConfidenceIndicators(spec, [], 4);
    expect(result.windowsEvaluated).toBe(4);
  });

  it("sums historical windows from scored archive records + current season", () => {
    const spec = makeSpec("lin-a", 2);
    const archive = [
      makeArchiveRecord("lin-a", 0, "reproduced", 4),
      makeArchiveRecord("lin-a", 1, "reproduced", 4),
    ];
    const result = computeConfidenceIndicators(spec, archive, 4);
    expect(result.windowsEvaluated).toBe(12); // 4 + 4 + 4 (current)
  });

  it("includes gate-failure records in historical window count", () => {
    const spec = makeSpec("lin-a", 2);
    const archive = [
      makeArchiveRecord("lin-a", 0, "gate-failure", 4),
      makeArchiveRecord("lin-a", 1, "reproduced", 4),
    ];
    const result = computeConfidenceIndicators(spec, archive, 4);
    expect(result.windowsEvaluated).toBe(12); // gate-fail windows still count
  });

  it("excludes records from other lineages", () => {
    const spec = makeSpec("lin-a", 1);
    const archive = [
      makeArchiveRecord("lin-a", 0, "reproduced", 4),
      makeArchiveRecord("lin-b", 0, "reproduced", 100), // different lineage
    ];
    const result = computeConfidenceIndicators(spec, archive, 4);
    expect(result.windowsEvaluated).toBe(8); // 4 (lin-a history) + 4 (current)
  });

  it("handles varying window counts across archive records", () => {
    const spec = makeSpec("lin-a", 3);
    const archive = [
      makeArchiveRecord("lin-a", 0, "reproduced", 2),
      makeArchiveRecord("lin-a", 1, "reproduced", 6),
      makeArchiveRecord("lin-a", 2, "reproduced", 4),
    ];
    const result = computeConfidenceIndicators(spec, archive, 3);
    expect(result.windowsEvaluated).toBe(15); // 2 + 6 + 4 + 3
  });
});

// ─── E. gateFailureCount ─────────────────────────────────────────────────────

describe("computeConfidenceIndicators — gateFailureCount", () => {
  it("returns 0 for an empty archive", () => {
    const spec = makeSpec("lin-a", 0);
    const result = computeConfidenceIndicators(spec, [], 4);
    expect(result.gateFailureCount).toBe(0);
  });

  it("counts only gate-failure records for this lineage", () => {
    const spec = makeSpec("lin-a", 3);
    const archive = [
      makeArchiveRecord("lin-a", 0, "gate-failure"),
      makeArchiveRecord("lin-a", 1, "reproduced"),
      makeArchiveRecord("lin-a", 2, "gate-failure"),
      makeArchiveRecord("lin-b", 0, "gate-failure"), // different lineage
    ];
    const result = computeConfidenceIndicators(spec, archive, 4);
    expect(result.gateFailureCount).toBe(2);
  });

  it("non-survivors and reproduced records are not counted", () => {
    const spec = makeSpec("lin-a", 2);
    const archive = [
      makeArchiveRecord("lin-a", 0, "reproduced"),
      makeArchiveRecord("lin-a", 1, "non-survivor"),
    ];
    const result = computeConfidenceIndicators(spec, archive, 4);
    expect(result.gateFailureCount).toBe(0);
  });
});

// ─── F. paramStabilityRate ────────────────────────────────────────────────────

describe("computeConfidenceIndicators — paramStabilityRate", () => {
  it("returns 1.0 when mutationSummary is absent (clone)", () => {
    const spec = makeSpec("lin-a", 1, "rnd"); // no mutationSummary
    const result = computeConfidenceIndicators(spec, [], 4);
    expect(result.paramStabilityRate).toBe(1.0);
  });

  it("returns 1.0 when mutationSummary is empty string (clone)", () => {
    const spec = makeSpec("lin-a", 1, "rnd", "");
    const result = computeConfidenceIndicators(spec, [], 4);
    expect(result.paramStabilityRate).toBe(1.0);
  });

  it("returns 0.5 when 1 of 2 mutable params changed (rnd archetype)", () => {
    // rnd has 2 mutable params: buyProb, sellProb
    const spec = makeSpec("lin-a", 1, "rnd", "buyProb");
    const result = computeConfidenceIndicators(spec, [], 4);
    expect(result.paramStabilityRate).toBe(0.5);
  });

  it("returns 0.0 when all mutable params changed", () => {
    const spec = makeSpec("lin-a", 1, "rnd", "buyProb,sellProb");
    const result = computeConfidenceIndicators(spec, [], 4);
    expect(result.paramStabilityRate).toBe(0.0);
  });

  it("returns null for bah archetype (no mutable params)", () => {
    const bahSpec: EvolvableBotSpec = {
      ...makeSpec("lin-a", 1, "bah"),
      params: {},
    };
    const result = computeConfidenceIndicators(bahSpec, [], 4);
    expect(result.paramStabilityRate).toBeNull();
  });

  it("returns null for unknown archetype", () => {
    const spec = makeSpec("lin-a", 1, "unknown-archetype");
    const result = computeConfidenceIndicators(spec, [], 4);
    expect(result.paramStabilityRate).toBeNull();
  });

  it("ignores mutationSummary keys not in archetype bounds (non-mutable keys)", () => {
    // If a non-mutable key appears in mutationSummary (shouldn't happen, but defensive)
    // rnd has 2 mutable params; "ghost" is not one of them
    const spec = makeSpec("lin-a", 1, "rnd", "ghost");
    const result = computeConfidenceIndicators(spec, [], 4);
    // 0 of 2 mutable params changed → stability = 1.0
    expect(result.paramStabilityRate).toBe(1.0);
  });

  it("counts only mutable (number|boolean) params, not string params", () => {
    // mac has 2 mutable (number) params: longPeriod, shortPeriod
    const macSpec: EvolvableBotSpec = {
      ...makeSpec("lin-a", 1, "mac"),
      params: { longPeriod: 50, shortPeriod: 10 },
    };
    // Only longPeriod changed
    const specWithSummary: EvolvableBotSpec = {
      ...macSpec,
      metadata: { ...macSpec.metadata, mutationSummary: "longPeriod" },
    };
    const result = computeConfidenceIndicators(specWithSummary, [], 4);
    expect(result.paramStabilityRate).toBe(0.5); // 1 of 2 mutable params changed
  });
});

// ─── G. computeEvidenceTier ───────────────────────────────────────────────────

describe("computeEvidenceTier", () => {
  it("returns 'hatchling' when generationsSurvived = 0", () => {
    expect(computeEvidenceTier(makeIndicators({ generationsSurvived: 0 }))).toBe("hatchling");
  });

  it("returns 'arena-contender' when generationsSurvived = 1", () => {
    expect(computeEvidenceTier(makeIndicators({ generationsSurvived: 1 }))).toBe("arena-contender");
  });

  it("returns 'arena-contender' when generationsSurvived = 2", () => {
    expect(computeEvidenceTier(makeIndicators({ generationsSurvived: 2 }))).toBe("arena-contender");
  });

  it("returns 'backtest-champion' when generationsSurvived = 3 and no regime data", () => {
    expect(computeEvidenceTier(makeIndicators({ generationsSurvived: 3, regimeCoverage: null }))).toBe("backtest-champion");
  });

  it("returns 'backtest-champion' when generationsSurvived = 3 and only 1 distinct regime", () => {
    const coverage: RegimeCoverage = { uptrend: 4, sideways: 0, downtrend: 0 };
    expect(computeEvidenceTier(makeIndicators({ generationsSurvived: 3, regimeCoverage: coverage }))).toBe("backtest-champion");
  });

  it("returns 'regime-specialist' when generationsSurvived = 3 and 2 distinct regimes", () => {
    const coverage: RegimeCoverage = { uptrend: 2, sideways: 2, downtrend: 0 };
    expect(computeEvidenceTier(makeIndicators({ generationsSurvived: 3, regimeCoverage: coverage }))).toBe("regime-specialist");
  });

  it("returns 'regime-specialist' when generationsSurvived = 3 and all 3 regimes seen", () => {
    const coverage: RegimeCoverage = { uptrend: 1, sideways: 2, downtrend: 1 };
    expect(computeEvidenceTier(makeIndicators({ generationsSurvived: 3, regimeCoverage: coverage }))).toBe("regime-specialist");
  });

  it("requires both generationsSurvived >= 3 AND ≥2 regimes for regime-specialist", () => {
    // Survived only 2 times but has multi-regime coverage → not specialist
    const coverage: RegimeCoverage = { uptrend: 2, sideways: 2, downtrend: 0 };
    expect(computeEvidenceTier(makeIndicators({ generationsSurvived: 2, regimeCoverage: coverage }))).toBe("arena-contender");
  });

  it("returns 'backtest-champion' when generationsSurvived >= 3 but regimeCoverage is null", () => {
    expect(computeEvidenceTier(makeIndicators({ generationsSurvived: 5, regimeCoverage: null }))).toBe("backtest-champion");
  });

  it("deferred tiers (paper, live) are never returned by computeEvidenceTier", () => {
    // Test all plausible indicator combinations
    const allPossibleTiers = new Set<string>();
    for (const survived of [0, 1, 2, 3, 5, 10]) {
      for (const coverage of [
        null,
        { uptrend: 4, sideways: 0, downtrend: 0 },
        { uptrend: 2, sideways: 2, downtrend: 0 },
        { uptrend: 1, sideways: 1, downtrend: 2 },
      ]) {
        allPossibleTiers.add(computeEvidenceTier(makeIndicators({ generationsSurvived: survived, regimeCoverage: coverage })));
      }
    }
    for (const tier of DEFERRED_TIERS) {
      expect(allPossibleTiers.has(tier)).toBe(false);
    }
  });

  it("EVIDENCE_TIER_ORDER contains all 8 tiers with no duplicates", () => {
    expect(EVIDENCE_TIER_ORDER).toHaveLength(8);
    expect(new Set(EVIDENCE_TIER_ORDER).size).toBe(8);
  });
});

// ─── H. Determinism ───────────────────────────────────────────────────────────

describe("computeConfidenceIndicators — determinism", () => {
  it("returns identical indicators for identical inputs", () => {
    const spec = makeSpec("lin-a", 3, "rnd", "buyProb");
    const archive = [
      makeArchiveRecord("lin-a", 0, "reproduced", 4),
      makeArchiveRecord("lin-a", 1, "gate-failure", 4),
      makeArchiveRecord("lin-a", 2, "reproduced", 4),
    ];
    const regimeLabels: RegimeLabel[] = ["Uptrend", "Sideways", "Downtrend", "Uptrend"];

    const r1 = computeConfidenceIndicators(spec, archive, 4, regimeLabels);
    const r2 = computeConfidenceIndicators(spec, archive, 4, regimeLabels);

    expect(r1).toEqual(r2);
  });

  it("computeEvidenceTier is deterministic for fixed indicators", () => {
    const indicators = makeIndicators({ generationsSurvived: 3, regimeCoverage: { uptrend: 2, sideways: 2, downtrend: 0 } });
    expect(computeEvidenceTier(indicators)).toBe(computeEvidenceTier(indicators));
  });

  it("computeRegimeCoverage is deterministic for fixed input", () => {
    const labels: RegimeLabel[] = ["Uptrend", "Downtrend", "Sideways"];
    expect(computeRegimeCoverage(labels)).toEqual(computeRegimeCoverage(labels));
  });
});

// ─── I. No side-effects on selection or mutation ──────────────────────────────

describe("confidence indicators — no effect on selection or mutation", () => {
  function makeRunState(): EvolutionRunState {
    const pop: EvolvableBotSpec[] = ["a", "b", "c", "d"].map((id) => ({
      id,
      name: `Bot ${id}`,
      archetype: "rnd",
      params: { buyProb: 0.3, sellProb: 0.3 },
      generation: 0,
      parentIds: [],
      mutationRate: 0.3,
      capital: 100,
      metadata: { lineageId: `lineage-${id}`, createdAt: FIXED_DATE },
    }));
    return {
      runId: "test-run",
      generation: 0,
      activePop: pop,
      archive: [],
      championHistory: {},
      config: {
        populationSize: 4,
        survivorCount: 2,
        minTrades: 1,
        fitnessWeights: { return: 0.5, drawdown: 0.3, inconsistency: 0.2 },
        mutationRate: 0.3,
      },
      seed: 99,
      datasetManifest: { symbol: "TEST", fromDate: "2026-01-01", toDate: "2026-12-31", windowCount: 4, windowLengthDays: 90 },
      createdAt: FIXED_DATE,
      updatedAt: FIXED_DATE,
    };
  }

  function makeSeasonResult(): EvolutionSeasonResult {
    const ids = ["a", "b", "c", "d"];
    const returns = [0.15, 0.10, 0.05, 0.01];
    const makeSnap = (id: string, i: number): MetricSnapshot => ({
      botId: id, botName: `Bot ${id}`, totalReturn: returns[i] ?? 0.01,
      finalEquity: 10_500, maxDrawdown: 0.05, winRate: 0.6, tradeCount: 8,
      closedTradeCount: 6, realizedPnl: 500, unrealizedPnl: 0,
      profitFactor: 1.5, avgTrade: 62.5, exposureTime: 0.4, rank: i + 1,
    });
    return {
      windows: [
        { index: 0, standings: ids.map((id, i) => makeSnap(id, i)) },
        { index: 1, standings: ids.map((id, i) => makeSnap(id, i)) },
      ],
    };
  }

  it("computing confidence indicators does not change computeAdvanceProposal output", () => {
    const state = makeRunState();
    const season = makeSeasonResult();

    // Baseline proposal
    const proposal1 = computeAdvanceProposal(state, season, ADVANCED_DATE);

    // Compute confidence for every active bot (potential side-effect path)
    for (const spec of state.activePop) {
      computeConfidenceIndicators(spec, state.archive, 2, ["Uptrend", "Sideways"]);
    }

    // Proposal computed after confidence reads should be identical
    const proposal2 = computeAdvanceProposal(state, season, ADVANCED_DATE);

    expect(proposal2.proposedPop.map((p) => p.child.id))
      .toEqual(proposal1.proposedPop.map((p) => p.child.id));
    expect(proposal2.survivors.map((s) => s.spec.id))
      .toEqual(proposal1.survivors.map((s) => s.spec.id));
    expect(proposal2.fromGeneration).toBe(proposal1.fromGeneration);
  });

  it("computeRegimeCoverage does not affect archive or state", () => {
    const state = makeRunState();
    const archiveLenBefore = state.archive.length;

    computeRegimeCoverage(["Uptrend", "Sideways", "Downtrend", "Uptrend"]);

    expect(state.archive.length).toBe(archiveLenBefore);
    expect(state.generation).toBe(0);
  });
});
