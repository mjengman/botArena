/**
 * M14 Slice 4A — explainFitness() tests.
 *
 * Coverage:
 *   A. Scored explanations — exact score identity, component arithmetic,
 *      weights carried through, windowMetricsSummary preserved
 *   B. Gate-failure: activity — passthrough, no score field
 *   C. Gate-failure: survival — passthrough, no score field
 *   D. Edge cases — zero weights, all-zero metrics, negative mean return
 */

import { describe, it, expect } from "vitest";
import { explainFitness } from "../src/engine/evolution/index.ts";
import type {
  BotFitnessRecord,
  EvolutionConfig,
  WindowMetricsSummary,
  EvolvableBotSpec,
} from "../src/engine/evolution/index.ts";

// ─── Test helpers ─────────────────────────────────────────────────────────────

/** A BotFitnessRecord whose fitness is narrowed to the kind:"scored" variant. */
type ScoredBotFitnessRecord = Omit<BotFitnessRecord, "fitness"> & {
  fitness: Extract<BotFitnessRecord["fitness"], { kind: "scored" }>;
};

function makeSpec(id = "bot-1"): EvolvableBotSpec {
  return {
    id,
    name: `Test Bot ${id}`,
    archetype: "mac",
    params: { shortPeriod: 10, longPeriod: 30 },
    generation: 1,
    parentIds: ["parent-1"],
    mutationRate: 0.3,
    capital: 100,
    metadata: { lineageId: "lineage-1", createdAt: "2026-05-18T00:00:00.000Z" },
  };
}

function makeSummary(
  overrides: Partial<WindowMetricsSummary> = {},
): WindowMetricsSummary {
  return {
    meanReturn: 0.05,
    worstWindowDrawdown: 0.10,
    returnStdDev: 0.02,
    totalTradeCount: 8,
    windowCount: 3,
    ...overrides,
  };
}

function makeConfig(
  weights: EvolutionConfig["fitnessWeights"] = { return: 0.5, drawdown: 0.3, inconsistency: 0.2 },
): EvolutionConfig {
  return {
    populationSize: 5,
    survivorCount: 2,
    minTrades: 1,
    fitnessWeights: weights,
    mutationRate: 0.3,
  };
}

/**
 * Build a scored BotFitnessRecord by applying the same formula as fitness.ts.
 * Used to construct records that have the correct fitnessScore for the given
 * weights and metrics, so the exact-equality invariant can be tested.
 */
function makeScoredRecord(
  summary: WindowMetricsSummary,
  weights: EvolutionConfig["fitnessWeights"],
  id = "bot-1",
): ScoredBotFitnessRecord {
  const fitnessScore =
    weights.return * summary.meanReturn -
    weights.drawdown * summary.worstWindowDrawdown -
    weights.inconsistency * summary.returnStdDev;

  return {
    spec: makeSpec(id),
    fitness: {
      kind: "scored",
      fitnessScore,
      windowMetricsSummary: summary,
    },
  };
}

// ─── A. Scored explanations ───────────────────────────────────────────────────

describe("explainFitness — scored", () => {
  it("returns kind:'scored'", () => {
    const record = makeScoredRecord(makeSummary(), makeConfig().fitnessWeights);
    const ex = explainFitness(record, makeConfig());
    expect(ex.kind).toBe("scored");
  });

  it("score field exactly equals record.fitness.fitnessScore (no recomputation)", () => {
    const summary = makeSummary({ meanReturn: 0.07, worstWindowDrawdown: 0.12, returnStdDev: 0.03 });
    const weights = { return: 0.5, drawdown: 0.3, inconsistency: 0.2 };
    const record = makeScoredRecord(summary, weights);
    const ex = explainFitness(record, makeConfig(weights));
    if (ex.kind !== "scored") throw new Error("expected scored");
    expect(ex.score).toBe(record.fitness.fitnessScore);
  });

  it("returnComponent = weights.return × meanReturn", () => {
    const summary = makeSummary({ meanReturn: 0.10 });
    const weights = { return: 0.5, drawdown: 0.3, inconsistency: 0.2 };
    const record = makeScoredRecord(summary, weights);
    const ex = explainFitness(record, makeConfig(weights));
    if (ex.kind !== "scored") throw new Error("expected scored");
    expect(ex.returnComponent).toBeCloseTo(0.5 * 0.10, 10);
  });

  it("drawdownPenalty = weights.drawdown × worstWindowDrawdown", () => {
    const summary = makeSummary({ worstWindowDrawdown: 0.20 });
    const weights = { return: 0.5, drawdown: 0.3, inconsistency: 0.2 };
    const record = makeScoredRecord(summary, weights);
    const ex = explainFitness(record, makeConfig(weights));
    if (ex.kind !== "scored") throw new Error("expected scored");
    expect(ex.drawdownPenalty).toBeCloseTo(0.3 * 0.20, 10);
  });

  it("inconsistencyPenalty = weights.inconsistency × returnStdDev", () => {
    const summary = makeSummary({ returnStdDev: 0.05 });
    const weights = { return: 0.5, drawdown: 0.3, inconsistency: 0.2 };
    const record = makeScoredRecord(summary, weights);
    const ex = explainFitness(record, makeConfig(weights));
    if (ex.kind !== "scored") throw new Error("expected scored");
    expect(ex.inconsistencyPenalty).toBeCloseTo(0.2 * 0.05, 10);
  });

  it("components approximately decompose to the score (floating-point tolerance)", () => {
    const summary = makeSummary({ meanReturn: 0.07, worstWindowDrawdown: 0.12, returnStdDev: 0.03 });
    const weights = { return: 0.5, drawdown: 0.3, inconsistency: 0.2 };
    const record = makeScoredRecord(summary, weights);
    const ex = explainFitness(record, makeConfig(weights));
    if (ex.kind !== "scored") throw new Error("expected scored");
    const reconstructed = ex.returnComponent - ex.drawdownPenalty - ex.inconsistencyPenalty;
    expect(Math.abs(reconstructed - ex.score)).toBeLessThan(1e-10);
  });

  it("carries all three weights through to the weights field", () => {
    const weights = { return: 0.6, drawdown: 0.25, inconsistency: 0.15 };
    const record = makeScoredRecord(makeSummary(), weights);
    const ex = explainFitness(record, makeConfig(weights));
    if (ex.kind !== "scored") throw new Error("expected scored");
    expect(ex.weights.return).toBe(0.6);
    expect(ex.weights.drawdown).toBe(0.25);
    expect(ex.weights.inconsistency).toBe(0.15);
  });

  it("preserves windowMetricsSummary unchanged", () => {
    const summary = makeSummary({ meanReturn: 0.04, returnStdDev: 0.01, windowCount: 4 });
    const record = makeScoredRecord(summary, makeConfig().fitnessWeights);
    const ex = explainFitness(record, makeConfig());
    if (ex.kind !== "scored") throw new Error("expected scored");
    expect(ex.windowMetricsSummary).toEqual(summary);
  });

  it("score identity holds for a negative-scoring bot (high drawdown)", () => {
    const summary = makeSummary({ meanReturn: 0.01, worstWindowDrawdown: 0.40, returnStdDev: 0.05 });
    const weights = { return: 0.5, drawdown: 0.3, inconsistency: 0.2 };
    const record = makeScoredRecord(summary, weights);
    const ex = explainFitness(record, makeConfig(weights));
    if (ex.kind !== "scored") throw new Error("expected scored");
    expect(ex.score).toBe(record.fitness.fitnessScore);
    expect(ex.score).toBeLessThan(0);
  });

  it("score identity holds when meanReturn is negative", () => {
    const summary = makeSummary({ meanReturn: -0.05, worstWindowDrawdown: 0.08, returnStdDev: 0.02 });
    const weights = { return: 0.5, drawdown: 0.3, inconsistency: 0.2 };
    const record = makeScoredRecord(summary, weights);
    const ex = explainFitness(record, makeConfig(weights));
    if (ex.kind !== "scored") throw new Error("expected scored");
    expect(ex.score).toBe(record.fitness.fitnessScore);
    expect(ex.returnComponent).toBeCloseTo(-0.025, 10);
  });
});

// ─── B. Gate-failure: activity ────────────────────────────────────────────────

describe("explainFitness — gate-failure: activity", () => {
  const summary = makeSummary({ totalTradeCount: 0 });
  const record: BotFitnessRecord = {
    spec: makeSpec(),
    fitness: {
      kind: "gate-failure",
      gateFailureReason: "activity",
      windowMetricsSummary: summary,
    },
  };

  it("returns kind:'gate-failure'", () => {
    const ex = explainFitness(record, makeConfig());
    expect(ex.kind).toBe("gate-failure");
  });

  it("preserves gateFailureReason: 'activity'", () => {
    const ex = explainFitness(record, makeConfig());
    if (ex.kind !== "gate-failure") throw new Error("expected gate-failure");
    expect(ex.gateFailureReason).toBe("activity");
  });

  it("preserves windowMetricsSummary", () => {
    const ex = explainFitness(record, makeConfig());
    if (ex.kind !== "gate-failure") throw new Error("expected gate-failure");
    expect(ex.windowMetricsSummary).toEqual(summary);
  });

  it("has no 'score' field", () => {
    const ex = explainFitness(record, makeConfig());
    expect("score" in ex).toBe(false);
  });
});

// ─── C. Gate-failure: survival ────────────────────────────────────────────────

describe("explainFitness — gate-failure: survival", () => {
  const summary = makeSummary({ worstWindowDrawdown: 1.0 });
  const record: BotFitnessRecord = {
    spec: makeSpec(),
    fitness: {
      kind: "gate-failure",
      gateFailureReason: "survival",
      windowMetricsSummary: summary,
    },
  };

  it("returns kind:'gate-failure'", () => {
    const ex = explainFitness(record, makeConfig());
    expect(ex.kind).toBe("gate-failure");
  });

  it("preserves gateFailureReason: 'survival'", () => {
    const ex = explainFitness(record, makeConfig());
    if (ex.kind !== "gate-failure") throw new Error("expected gate-failure");
    expect(ex.gateFailureReason).toBe("survival");
  });

  it("preserves windowMetricsSummary unchanged", () => {
    const ex = explainFitness(record, makeConfig());
    if (ex.kind !== "gate-failure") throw new Error("expected gate-failure");
    expect(ex.windowMetricsSummary).toEqual(summary);
  });
});

// ─── D. Edge cases ────────────────────────────────────────────────────────────

describe("explainFitness — edge cases", () => {
  it("all-zero metrics produce score=0 and all-zero components", () => {
    const summary = makeSummary({ meanReturn: 0, worstWindowDrawdown: 0, returnStdDev: 0 });
    const weights = { return: 0.5, drawdown: 0.3, inconsistency: 0.2 };
    const record = makeScoredRecord(summary, weights);
    const ex = explainFitness(record, makeConfig(weights));
    if (ex.kind !== "scored") throw new Error("expected scored");
    expect(ex.score).toBe(0);
    expect(ex.returnComponent).toBe(0);
    expect(ex.drawdownPenalty).toBe(0);
    expect(ex.inconsistencyPenalty).toBe(0);
  });

  it("zero weights produce score=0 regardless of metrics", () => {
    const summary = makeSummary({ meanReturn: 0.10, worstWindowDrawdown: 0.20, returnStdDev: 0.05 });
    const weights = { return: 0, drawdown: 0, inconsistency: 0 };
    const record = makeScoredRecord(summary, weights);
    const ex = explainFitness(record, makeConfig(weights));
    if (ex.kind !== "scored") throw new Error("expected scored");
    expect(ex.score).toBe(0);
    expect(ex.returnComponent).toBe(0);
    expect(ex.drawdownPenalty).toBe(0);
    expect(ex.inconsistencyPenalty).toBe(0);
  });

  it("return-only weights: score equals returnComponent", () => {
    const summary = makeSummary({ meanReturn: 0.08, worstWindowDrawdown: 0.15, returnStdDev: 0.04 });
    const weights = { return: 1.0, drawdown: 0, inconsistency: 0 };
    const record = makeScoredRecord(summary, weights);
    const ex = explainFitness(record, makeConfig(weights));
    if (ex.kind !== "scored") throw new Error("expected scored");
    expect(ex.score).toBe(record.fitness.fitnessScore);
    expect(ex.drawdownPenalty).toBe(0);
    expect(ex.inconsistencyPenalty).toBe(0);
    expect(ex.returnComponent).toBeCloseTo(0.08, 10);
  });

  it("config weights do not affect gate-failure explanations", () => {
    const summary = makeSummary();
    const record: BotFitnessRecord = {
      spec: makeSpec(),
      fitness: { kind: "gate-failure", gateFailureReason: "activity", windowMetricsSummary: summary },
    };
    // Different configs should produce the same gate-failure explanation
    const ex1 = explainFitness(record, makeConfig({ return: 0.5, drawdown: 0.3, inconsistency: 0.2 }));
    const ex2 = explainFitness(record, makeConfig({ return: 1.0, drawdown: 0, inconsistency: 0 }));
    expect(ex1).toEqual(ex2);
  });
});
