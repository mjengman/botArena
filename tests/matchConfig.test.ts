import { describe, it, expect } from "vitest";
import { validateMatchConfig, defaultMatchConfig, buildDataset } from "../src/app/matchConfig.ts";
import type { MatchConfig } from "../src/app/matchConfig.ts";
import type { Dataset } from "../src/engine/types.ts";

function valid(overrides: Partial<MatchConfig> = {}): MatchConfig {
  return { ...defaultMatchConfig(), ...overrides };
}

describe("validateMatchConfig", () => {
  it("accepts default config with no errors", () => {
    expect(validateMatchConfig(defaultMatchConfig())).toHaveLength(0);
  });

  it("rejects startingCash of 0", () => {
    const errors = validateMatchConfig(valid({ startingCash: 0 }));
    expect(errors.some((e) => e.field === "startingCash")).toBe(true);
  });

  it("rejects negative startingCash", () => {
    const errors = validateMatchConfig(valid({ startingCash: -100 }));
    expect(errors.some((e) => e.field === "startingCash")).toBe(true);
  });

  it("rejects NaN startingCash", () => {
    const errors = validateMatchConfig(valid({ startingCash: NaN }));
    expect(errors.some((e) => e.field === "startingCash")).toBe(true);
  });

  it("rejects negative feeBps", () => {
    const errors = validateMatchConfig(valid({ feeBps: -1 }));
    expect(errors.some((e) => e.field === "feeBps")).toBe(true);
  });

  it("accepts feeBps of 0", () => {
    expect(validateMatchConfig(valid({ feeBps: 0 }))).toHaveLength(0);
  });

  it("rejects negative slippageBps", () => {
    const errors = validateMatchConfig(valid({ slippageBps: -1 }));
    expect(errors.some((e) => e.field === "slippageBps")).toBe(true);
  });

  it("rejects non-integer seed", () => {
    const errors = validateMatchConfig(valid({ seed: 1.5 }));
    expect(errors.some((e) => e.field === "seed")).toBe(true);
  });

  it("rejects negative seed", () => {
    const errors = validateMatchConfig(valid({ seed: -1 }));
    expect(errors.some((e) => e.field === "seed")).toBe(true);
  });

  it("rejects NaN seed", () => {
    const errors = validateMatchConfig(valid({ seed: NaN }));
    expect(errors.some((e) => e.field === "seed")).toBe(true);
  });

  it("rejects empty activeBotIds", () => {
    const errors = validateMatchConfig(valid({ activeBotIds: [] }));
    expect(errors.some((e) => e.field === "activeBotIds")).toBe(true);
  });

  it("rejects dataStartIdx >= dataEndIdx", () => {
    const errors = validateMatchConfig(valid({ dataStartIdx: 100, dataEndIdx: 100 }));
    expect(errors.some((e) => e.field === "dateRange")).toBe(true);
  });

  it("rejects dataStartIdx out of bounds", () => {
    const errors = validateMatchConfig(valid({ dataStartIdx: -1 }));
    expect(errors.some((e) => e.field === "dateRange")).toBe(true);
  });

  it("rejects dataEndIdx past dataset length", () => {
    const errors = validateMatchConfig(valid({ dataStartIdx: 0, dataEndIdx: 9999 }));
    expect(errors.some((e) => e.field === "dateRange")).toBe(true);
  });

  it("returns multiple errors for multiple invalid fields", () => {
    const errors = validateMatchConfig(
      valid({ startingCash: 0, feeBps: -1, activeBotIds: [] }),
    );
    expect(errors.length).toBeGreaterThanOrEqual(3);
  });
});

// ─── buildDataset — feed / manifest provenance ────────────────────────────────

function makeAlpacaDataset(overrides: Partial<Dataset["manifest"]> = {}): Dataset {
  // Minimal 5-candle dataset with an Alpaca manifest
  const candles = Array.from({ length: 5 }, (_, i) => ({
    timestamp: Date.UTC(2023, 0, 3 + i), // 2023-01-03 … 2023-01-07
    open: 100 + i,
    high: 105 + i,
    low:  95  + i,
    close: 102 + i,
    volume: 1_000_000,
  }));
  return {
    manifest: {
      symbol: "SPY",
      timeframe: "1d",
      source: "alpaca",
      feed: "iex",
      startDate: "2023-01-03",
      endDate:   "2023-01-07",
      candleCount: 5,
      ...overrides,
    },
    candles,
  };
}

describe("buildDataset — feed provenance regression", () => {
  it("preserves feed from an Alpaca source dataset", () => {
    const src = makeAlpacaDataset();
    const mc: MatchConfig = { ...defaultMatchConfig(), dataStartIdx: 0, dataEndIdx: 4 };
    const result = buildDataset(mc, src);
    expect(result.manifest.feed).toBe("iex");
  });

  it("preserves feed after slicing to a subset", () => {
    const src = makeAlpacaDataset();
    const mc: MatchConfig = { ...defaultMatchConfig(), dataStartIdx: 1, dataEndIdx: 3 };
    const result = buildDataset(mc, src);
    expect(result.manifest.feed).toBe("iex");
    expect(result.manifest.candleCount).toBe(3);
  });

  it("omits feed for a synthetic dataset (feed was undefined)", () => {
    // sampleDataset has source "synthetic-gbm-seed-0xdeadbeef" and no feed
    const mc: MatchConfig = defaultMatchConfig();
    const result = buildDataset(mc);
    expect(result.manifest.feed).toBeUndefined();
  });

  it("omits feed for a CSV-import dataset (feed absent)", () => {
    const src = makeAlpacaDataset({ source: "csv-import", feed: undefined });
    const mc: MatchConfig = { ...defaultMatchConfig(), dataStartIdx: 0, dataEndIdx: 4 };
    const result = buildDataset(mc, src);
    expect(result.manifest.feed).toBeUndefined();
  });
});
