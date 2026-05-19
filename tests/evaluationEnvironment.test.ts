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
  it("projects all context fields correctly", () => {
    const ctx = makeContext();
    const env = deriveEvaluationEnvironment(ctx);
    expect(env.symbol).toBe(ctx.symbol);
    expect(env.windowCount).toBe(ctx.windowCount);
    expect(env.feeBps).toBe(ctx.feeBps);
    expect(env.slippageBps).toBe(ctx.slippageBps);
    expect(env.startingCash).toBe(ctx.startingCash);
    expect(env.dateRange.start).toBe(ctx.startDate);
    expect(env.dateRange.end).toBe(ctx.endDate);
    expect(env.datasetFingerprint).toBe(ctx.datasetFingerprint);
    expect(env.timeframe).toBe("1D");
  });

  it("name contains symbol and date range from context", () => {
    const ctx = makeContext();
    const env = deriveEvaluationEnvironment(ctx);
    expect(env.name).toContain(ctx.symbol);
    expect(env.name).toContain(ctx.startDate);
    expect(env.name).toContain(ctx.endDate);
  });
});

// ─── C. dataSource derivation ────────────────────────────────────────────────

describe("C. dataSource derivation", () => {
  it("synthetic when no source", () => {
    const ctx = makeContext({ source: undefined, feed: undefined });
    const env = deriveEvaluationEnvironment(ctx);
    expect(env.dataSource).toBe("synthetic");
  });

  it("synthetic when source includes 'synthetic'", () => {
    const ctx = makeContext({ source: "SyntheticData", feed: undefined });
    const env = deriveEvaluationEnvironment(ctx);
    expect(env.dataSource).toBe("synthetic");
  });

  it("csv when source is set but no feed and no 'alpaca' in source", () => {
    const ctx = makeContext({ source: "my-csv-file.csv", feed: undefined });
    const env = deriveEvaluationEnvironment(ctx);
    expect(env.dataSource).toBe("csv");
  });

  it("alpaca when feed is present", () => {
    const ctx = makeContext({ source: "alpaca", feed: "iex" });
    const env = deriveEvaluationEnvironment(ctx);
    expect(env.dataSource).toBe("alpaca");
  });

  it("alpaca when source contains 'alpaca' (case-insensitive)", () => {
    const ctx = makeContext({ source: "AlpacaHistorical", feed: undefined });
    const env = deriveEvaluationEnvironment(ctx);
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
  it("feed is absent for synthetic context", () => {
    const ctx = makeContext({ source: undefined, feed: undefined });
    const env = deriveEvaluationEnvironment(ctx);
    expect(env.feed).toBeUndefined();
  });

  it("feed is present for alpaca context", () => {
    const ctx = makeContext({ source: "alpaca", feed: "sip" });
    const env = deriveEvaluationEnvironment(ctx);
    expect(env.feed).toBe("sip");
  });
});
