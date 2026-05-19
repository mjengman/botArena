// @vitest-environment jsdom
/**
 * M14 Slice 4E.1 — evaluationEnvironment.test.ts
 *
 * Coverage:
 *   A. buildEvaluationEnvironment — shape, name format, dataSource, id stability
 *   B. deriveEvaluationEnvironment — projects correctly from a stored context
 *   C. dataSource derivation — synthetic / csv / alpaca detection
 *   D. buildEvaluationEnvironment and deriveEvaluationEnvironment produce same id
 *   E. feed is included for alpaca, absent for synthetic/csv
 */

import { describe, it, expect } from "vitest";
import { sampleDataset } from "../src/data/sampleDataset.ts";
import { defaultMatchConfig } from "../src/app/matchConfig.ts";
import {
  buildEvaluationEnvironment,
  deriveEvaluationEnvironment,
  buildRunContext,
} from "../src/app/evolutionState.ts";
import type { EvolutionRunContext } from "../src/app/evolutionState.ts";

// ─── Fixtures ─────────────────────────────────────────────────────────────────

const MOCK_MC = defaultMatchConfig();
const MOCK_DATASET = sampleDataset;
const WINDOW_COUNT = 4;

// A minimal EvolutionRunContext built from real helpers
function makeContext(overrides: Partial<EvolutionRunContext> = {}): EvolutionRunContext {
  const base = buildRunContext(MOCK_MC, MOCK_DATASET, WINDOW_COUNT);
  return { ...base, ...overrides };
}

// ─── A. buildEvaluationEnvironment ───────────────────────────────────────────

describe("A. buildEvaluationEnvironment", () => {
  it("returns expected shape with required fields", () => {
    const env = buildEvaluationEnvironment(MOCK_MC, MOCK_DATASET, WINDOW_COUNT);
    expect(env).toMatchObject({
      id: expect.stringMatching(/^[0-9a-f]{8}$/),
      name: expect.stringContaining(MOCK_DATASET.manifest.symbol),
      timeframe: "1D",
      windowCount: WINDOW_COUNT,
      feeBps: MOCK_MC.feeBps,
      slippageBps: MOCK_MC.slippageBps,
      startingCash: MOCK_MC.startingCash,
    });
  });

  it("name contains the symbol and date range", () => {
    const env = buildEvaluationEnvironment(MOCK_MC, MOCK_DATASET, WINDOW_COUNT);
    expect(env.name).toContain(env.symbol);
    expect(env.name).toContain(env.dateRange.start.slice(0, 10));
    expect(env.name).toContain(env.dateRange.end.slice(0, 10));
  });

  it("id is stable across calls with same inputs", () => {
    const env1 = buildEvaluationEnvironment(MOCK_MC, MOCK_DATASET, WINDOW_COUNT);
    const env2 = buildEvaluationEnvironment(MOCK_MC, MOCK_DATASET, WINDOW_COUNT);
    expect(env1.id).toBe(env2.id);
  });

  it("id differs when windowCount differs", () => {
    const env1 = buildEvaluationEnvironment(MOCK_MC, MOCK_DATASET, 4);
    const env2 = buildEvaluationEnvironment(MOCK_MC, MOCK_DATASET, 6);
    expect(env1.id).not.toBe(env2.id);
  });

  it("datasetFingerprint is set", () => {
    const env = buildEvaluationEnvironment(MOCK_MC, MOCK_DATASET, WINDOW_COUNT);
    expect(env.datasetFingerprint).toBeTruthy();
    expect(typeof env.datasetFingerprint).toBe("string");
  });

  it("regimeSummary is absent (set externally after a season)", () => {
    const env = buildEvaluationEnvironment(MOCK_MC, MOCK_DATASET, WINDOW_COUNT);
    expect(env.regimeSummary).toBeUndefined();
  });
});

// ─── B. deriveEvaluationEnvironment ──────────────────────────────────────────

describe("B. deriveEvaluationEnvironment", () => {
  it("returns ctx.environment exactly (identity in v3)", () => {
    const ctx = makeContext();
    const env = deriveEvaluationEnvironment(ctx);
    expect(env).toBe(ctx.environment);
  });

  it("returned env has correct field values", () => {
    const ctx = makeContext();
    const env = deriveEvaluationEnvironment(ctx);
    expect(env.symbol).toBe(ctx.environment.symbol);
    expect(env.windowCount).toBe(ctx.environment.windowCount);
    expect(env.feeBps).toBe(ctx.environment.feeBps);
    expect(env.slippageBps).toBe(ctx.environment.slippageBps);
    expect(env.startingCash).toBe(ctx.environment.startingCash);
    expect(env.dateRange.start).toBe(ctx.environment.dateRange.start);
    expect(env.dateRange.end).toBe(ctx.environment.dateRange.end);
    expect(env.datasetFingerprint).toBe(ctx.environment.datasetFingerprint);
    expect(env.timeframe).toBe("1D");
  });

  it("name contains symbol and date range from context", () => {
    const ctx = makeContext();
    const env = deriveEvaluationEnvironment(ctx);
    expect(env.name).toContain(ctx.environment.symbol);
    expect(env.name).toContain(ctx.environment.dateRange.start);
    expect(env.name).toContain(ctx.environment.dateRange.end);
  });
});

// ─── Shared helper for C and E ───────────────────────────────────────────────

function datasetWithSource(source: string | undefined, feed: string | undefined) {
  return {
    ...MOCK_DATASET,
    manifest: { ...MOCK_DATASET.manifest, source: source as string, feed: feed as string },
  };
}

// ─── C. dataSource derivation ────────────────────────────────────────────────
// buildEvaluationEnvironment owns the derivation logic; deriveEvaluationEnvironment
// in v3 is a trivial accessor, so these tests target buildEvaluationEnvironment directly.

describe("C. dataSource derivation", () => {
  it("synthetic when no source", () => {
    const env = buildEvaluationEnvironment(MOCK_MC, datasetWithSource(undefined, undefined), WINDOW_COUNT);
    expect(env.dataSource).toBe("synthetic");
  });

  it("synthetic when source includes 'synthetic'", () => {
    const env = buildEvaluationEnvironment(MOCK_MC, datasetWithSource("SyntheticData", undefined), WINDOW_COUNT);
    expect(env.dataSource).toBe("synthetic");
  });

  it("csv when source is set but no feed and no 'alpaca' in source", () => {
    const env = buildEvaluationEnvironment(MOCK_MC, datasetWithSource("my-csv-file.csv", undefined), WINDOW_COUNT);
    expect(env.dataSource).toBe("csv");
  });

  it("alpaca when feed is present", () => {
    const env = buildEvaluationEnvironment(MOCK_MC, datasetWithSource("alpaca", "iex"), WINDOW_COUNT);
    expect(env.dataSource).toBe("alpaca");
  });

  it("alpaca when source contains 'alpaca' (case-insensitive)", () => {
    const env = buildEvaluationEnvironment(MOCK_MC, datasetWithSource("AlpacaHistorical", undefined), WINDOW_COUNT);
    expect(env.dataSource).toBe("alpaca");
  });
});

// ─── D. Same id from both factories ──────────────────────────────────────────

describe("D. buildEvaluationEnvironment and deriveEvaluationEnvironment produce same id", () => {
  it("ids match when built from the same underlying data", () => {
    const built = buildEvaluationEnvironment(MOCK_MC, MOCK_DATASET, WINDOW_COUNT);
    const ctx = buildRunContext(MOCK_MC, MOCK_DATASET, WINDOW_COUNT);
    const derived = deriveEvaluationEnvironment(ctx);
    expect(built.id).toBe(derived.id);
  });
});

// ─── E. feed field ───────────────────────────────────────────────────────────

describe("E. feed field", () => {
  it("feed is absent for synthetic dataset", () => {
    const env = buildEvaluationEnvironment(MOCK_MC, datasetWithSource(undefined, undefined), WINDOW_COUNT);
    expect(env.feed).toBeUndefined();
  });

  it("feed is present for alpaca dataset", () => {
    const env = buildEvaluationEnvironment(MOCK_MC, datasetWithSource("alpaca", "sip"), WINDOW_COUNT);
    expect(env.feed).toBe("sip");
  });
});
