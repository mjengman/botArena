/**
 * M14 Slice 4A — computeRegimeLabel() tests.
 *
 * Coverage:
 *   A. Classification thresholds — Uptrend, Downtrend, Sideways
 *   B. Boundary values — exactly ±3% stays Sideways
 *   C. Single-candle windows (startIdx === endIdx)
 *   D. Edge cases — missing candles, zero/negative close, out-of-range indices
 */

import { describe, it, expect } from "vitest";
import { computeRegimeLabel } from "../src/engine/evolution/regime.ts";
import type { Dataset } from "../src/engine/types.ts";

// ─── Test helpers ─────────────────────────────────────────────────────────────

/**
 * Build a minimal Dataset with candles at the given close prices.
 * Only `close` is populated — computeRegimeLabel only reads close.
 */
function makeDataset(closes: number[]): Dataset {
  return {
    manifest: {
      symbol: "TEST",
      timeframe: "1d",
      source: "test",
      startDate: "2026-01-01",
      endDate: "2026-01-01",
      candleCount: closes.length,
    },
    candles: closes.map((close, i) => ({
      timestamp: i * 86400000,
      open: close,
      high: close,
      low: close,
      close,
      volume: 1000,
    })),
  };
}

// ─── A. Classification thresholds ────────────────────────────────────────────

describe("computeRegimeLabel — classification thresholds", () => {
  it("returns 'Uptrend' when last/first > 1.03 (slope > +3%)", () => {
    const ds = makeDataset([100, 110, 105, 104]);
    // slope = (104 - 100) / 100 = 0.04 > 0.03
    expect(computeRegimeLabel(ds, 0, 3)).toBe("Uptrend");
  });

  it("returns 'Downtrend' when last/first < 0.97 (slope < −3%)", () => {
    const ds = makeDataset([100, 95, 92, 96]);
    // slope = (96 - 100) / 100 = -0.04 < -0.03
    expect(computeRegimeLabel(ds, 0, 3)).toBe("Downtrend");
  });

  it("returns 'Sideways' when slope is within ±3%", () => {
    const ds = makeDataset([100, 98, 103, 102]);
    // slope = (102 - 100) / 100 = 0.02, within bounds
    expect(computeRegimeLabel(ds, 0, 3)).toBe("Sideways");
  });

  it("returns 'Sideways' for a flat window (slope = 0)", () => {
    const ds = makeDataset([100, 100, 100, 100]);
    expect(computeRegimeLabel(ds, 0, 3)).toBe("Sideways");
  });

  it("returns 'Downtrend' for a strongly negative window", () => {
    const ds = makeDataset([200, 180, 160, 140]);
    // slope = (140 - 200) / 200 = -0.30
    expect(computeRegimeLabel(ds, 0, 3)).toBe("Downtrend");
  });

  it("returns 'Uptrend' for a strongly positive window", () => {
    const ds = makeDataset([50, 55, 60, 65]);
    // slope = (65 - 50) / 50 = 0.30
    expect(computeRegimeLabel(ds, 0, 3)).toBe("Uptrend");
  });
});

// ─── B. Boundary values ───────────────────────────────────────────────────────

describe("computeRegimeLabel — boundary values (±3% is Sideways)", () => {
  it("slope of exactly +3% is Sideways (threshold is exclusive)", () => {
    // last = 103, first = 100 → slope = 0.03 exactly
    const ds = makeDataset([100, 103]);
    expect(computeRegimeLabel(ds, 0, 1)).toBe("Sideways");
  });

  it("slope of exactly −3% is Sideways (threshold is exclusive)", () => {
    // last = 97, first = 100 → slope = −0.03 exactly
    const ds = makeDataset([100, 97]);
    expect(computeRegimeLabel(ds, 0, 1)).toBe("Sideways");
  });

  it("slope just above +3% is Uptrend", () => {
    // last = 103.1, first = 100 → slope ≈ 0.031
    const ds = makeDataset([100, 103.1]);
    expect(computeRegimeLabel(ds, 0, 1)).toBe("Uptrend");
  });

  it("slope just below −3% is Downtrend", () => {
    // last = 96.9, first = 100 → slope ≈ −0.031
    const ds = makeDataset([100, 96.9]);
    expect(computeRegimeLabel(ds, 0, 1)).toBe("Downtrend");
  });
});

// ─── C. Single-candle windows ─────────────────────────────────────────────────

describe("computeRegimeLabel — single-candle windows (startIdx === endIdx)", () => {
  it("single candle window: first === last → slope = 0 → Sideways", () => {
    const ds = makeDataset([100, 200, 50]);
    // Window is just candle at index 1
    expect(computeRegimeLabel(ds, 1, 1)).toBe("Sideways");
  });

  it("single candle window works at index 0", () => {
    const ds = makeDataset([75]);
    expect(computeRegimeLabel(ds, 0, 0)).toBe("Sideways");
  });
});

// ─── D. Edge cases ────────────────────────────────────────────────────────────

describe("computeRegimeLabel — edge cases", () => {
  it("returns Sideways when startIdx is out of range (candle is undefined)", () => {
    const ds = makeDataset([100, 110]);
    // startIdx = 5 is beyond the dataset
    expect(computeRegimeLabel(ds, 5, 6)).toBe("Sideways");
  });

  it("returns Sideways when endIdx is out of range", () => {
    const ds = makeDataset([100, 110]);
    expect(computeRegimeLabel(ds, 0, 99)).toBe("Sideways");
  });

  it("returns Sideways when first close is zero", () => {
    const ds = makeDataset([0, 110]);
    expect(computeRegimeLabel(ds, 0, 1)).toBe("Sideways");
  });

  it("returns Sideways when first close is negative", () => {
    // Negative close prices are invalid but must not throw
    const ds = makeDataset([-100, 110]);
    expect(computeRegimeLabel(ds, 0, 1)).toBe("Sideways");
  });

  it("can use a non-zero startIdx (sub-window within a larger dataset)", () => {
    // Window is candles 2..4: closes [80, 85, 90]
    // slope = (90 - 80) / 80 = 0.125 → Uptrend
    const ds = makeDataset([100, 95, 80, 85, 90, 70]);
    expect(computeRegimeLabel(ds, 2, 4)).toBe("Uptrend");
  });

  it("sub-window Downtrend within a larger dataset", () => {
    // Window is candles 1..3: closes [95, 80, 60]
    // slope = (60 - 95) / 95 ≈ -0.368 → Downtrend
    const ds = makeDataset([100, 95, 80, 60, 55]);
    expect(computeRegimeLabel(ds, 1, 3)).toBe("Downtrend");
  });
});
