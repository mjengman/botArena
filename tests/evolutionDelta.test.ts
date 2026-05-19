/**
 * M14 Slice 4E.1 — evolutionDelta.test.ts
 *
 * Coverage:
 *   A. Same params → empty delta (clone)
 *   B. Numeric delta with pctChange and boundsLabel
 *   C. Boolean delta: enabled/disabled interpretation
 *   D. Template interpretations per archetype (mac, mom, mr, rnd)
 *   E. Unknown archetype falls back to "Increased" / "Decreased"
 *   F. bah (no mutable params) → always empty delta
 *   G. computeEvolutionDelta matches computeDeltaFromParams for same inputs
 *   H. String params are never included in delta
 *   I. pctChange sign (increase vs decrease)
 */

import { describe, it, expect } from "vitest";
import { computeEvolutionDelta, computeDeltaFromParams } from "../src/engine/evolution/delta.ts";
import { MAC_BOUNDS, MOM_BOUNDS, MR_BOUNDS, RND_BOUNDS, BAH_BOUNDS } from "../src/engine/evolution/bounds.ts";
import type { EvolvableBotSpec } from "../src/engine/evolution/types.ts";

// ─── Fixture helpers ──────────────────────────────────────────────────────────

function makeSpec(
  archetype: string,
  params: Record<string, number | boolean | string>,
  id = "test-id",
): EvolvableBotSpec {
  return {
    id,
    name: "Test Bot",
    archetype,
    params,
    generation: 0,
    parentIds: [],
    mutationRate: 0.3,
    capital: 10_000,
    metadata: {
      lineageId: "lin-1",
      createdAt: "2026-01-01T00:00:00.000Z",
      mutationSummary: "",
    },
  };
}

// ─── A. Same params → empty delta ────────────────────────────────────────────

describe("A. Same params → empty delta", () => {
  it("returns [] when parent and child params are identical (mac)", () => {
    const params = { longPeriod: 20, shortPeriod: 5 };
    const parent = makeSpec("mac", params, "p1");
    const child  = makeSpec("mac", params, "c1");
    expect(computeEvolutionDelta(parent, child, MAC_BOUNDS)).toEqual([]);
  });

  it("returns [] when parent and child params are identical (mom)", () => {
    const params = { period: 10, threshold: 0.02 };
    const parent = makeSpec("mom", params, "p2");
    const child  = makeSpec("mom", params, "c2");
    expect(computeEvolutionDelta(parent, child, MOM_BOUNDS)).toEqual([]);
  });
});

// ─── B. Numeric delta ────────────────────────────────────────────────────────

describe("B. Numeric delta with pctChange and boundsLabel", () => {
  it("includes pctChange for numeric params", () => {
    const parent = makeSpec("mac", { longPeriod: 20, shortPeriod: 5 });
    const child  = makeSpec("mac", { longPeriod: 30, shortPeriod: 5 });
    const delta = computeEvolutionDelta(parent, child, MAC_BOUNDS);
    expect(delta).toHaveLength(1);
    expect(delta[0].param).toBe("longPeriod");
    expect(delta[0].from).toBe(20);
    expect(delta[0].to).toBe(30);
    expect(delta[0].pctChange).toBeCloseTo(0.5, 5); // +50%
  });

  it("includes boundsLabel for step-based params", () => {
    const parent = makeSpec("mac", { longPeriod: 20, shortPeriod: 5 });
    const child  = makeSpec("mac", { longPeriod: 30, shortPeriod: 5 });
    const delta = computeEvolutionDelta(parent, child, MAC_BOUNDS);
    expect(delta[0].boundsLabel).toMatch(/range \d+–\d+, step \d+/);
  });

  it("pctChange is negative for a decrease", () => {
    const parent = makeSpec("mac", { longPeriod: 20, shortPeriod: 5 });
    const child  = makeSpec("mac", { longPeriod: 10, shortPeriod: 5 });
    const delta = computeEvolutionDelta(parent, child, MAC_BOUNDS);
    expect(delta[0].pctChange).toBeCloseTo(-0.5, 5); // -50%
  });
});

// ─── C. Boolean delta ────────────────────────────────────────────────────────

describe("C. Boolean delta: enabled/disabled interpretation", () => {
  it("produces 'enabled' interpretation when flipped to true", () => {
    const bounds = {
      active: { type: "boolean" as const },
    };
    const parent = makeSpec("rnd", { active: false });
    const child  = makeSpec("rnd", { active: true });
    const delta = computeDeltaFromParams("rnd", parent.params, child.params, bounds);
    expect(delta).toHaveLength(1);
    expect(delta[0].param).toBe("active");
    expect(delta[0].interpretation).toBe("active enabled");
    expect(delta[0].boundsLabel).toBe("boolean");
    expect(delta[0].pctChange).toBeUndefined();
  });

  it("produces 'disabled' interpretation when flipped to false", () => {
    const bounds = {
      active: { type: "boolean" as const },
    };
    const parent = makeSpec("rnd", { active: true });
    const child  = makeSpec("rnd", { active: false });
    const delta = computeDeltaFromParams("rnd", parent.params, child.params, bounds);
    expect(delta[0].interpretation).toBe("active disabled");
  });
});

// ─── D. Template interpretations per archetype ───────────────────────────────

describe("D. Template interpretations", () => {
  it("mac longPeriod increase → 'Slower trend filter'", () => {
    const parent = makeSpec("mac", { longPeriod: 20, shortPeriod: 5 });
    const child  = makeSpec("mac", { longPeriod: 30, shortPeriod: 5 });
    const [entry] = computeEvolutionDelta(parent, child, MAC_BOUNDS);
    expect(entry.interpretation).toBe("Slower trend filter");
  });

  it("mac longPeriod decrease → 'Faster trend filter'", () => {
    const parent = makeSpec("mac", { longPeriod: 30, shortPeriod: 5 });
    const child  = makeSpec("mac", { longPeriod: 20, shortPeriod: 5 });
    const [entry] = computeEvolutionDelta(parent, child, MAC_BOUNDS);
    expect(entry.interpretation).toBe("Faster trend filter");
  });

  it("mom period increase → 'More patient entries'", () => {
    const parent = makeSpec("mom", { period: 5, threshold: 0.02 });
    const child  = makeSpec("mom", { period: 15, threshold: 0.02 });
    const [entry] = computeEvolutionDelta(parent, child, MOM_BOUNDS);
    expect(entry.interpretation).toBe("More patient entries");
  });

  it("mr zBuy numerical increase → 'Buys on deeper dips'", () => {
    // zBuy: increase = higher z-threshold → "Buys on deeper dips" per template
    const parent = makeSpec("mr", { period: 10, zBuy: -2.0, zSell: 1.0 });
    const child  = makeSpec("mr", { period: 10, zBuy: -1.0, zSell: 1.0 });
    const [entry] = computeEvolutionDelta(parent, child, MR_BOUNDS);
    expect(entry.param).toBe("zBuy");
    expect(entry.interpretation).toBe("Buys on deeper dips");
  });

  it("rnd buyProb decrease → 'Less frequent buys'", () => {
    const parent = makeSpec("rnd", { buyProb: 0.5, sellProb: 0.5 });
    const child  = makeSpec("rnd", { buyProb: 0.3, sellProb: 0.5 });
    const [entry] = computeEvolutionDelta(parent, child, RND_BOUNDS);
    expect(entry.interpretation).toBe("Less frequent buys");
  });
});

// ─── E. Unknown archetype fallback ───────────────────────────────────────────

describe("E. Unknown archetype → generic fallback", () => {
  it("falls back to 'Increased' for an unknown archetype", () => {
    const bounds = {
      speed: { type: "number" as const, min: 1, max: 10 },
    };
    const delta = computeDeltaFromParams("unknown-arch", { speed: 3 }, { speed: 7 }, bounds);
    expect(delta[0].interpretation).toBe("Increased");
  });

  it("falls back to 'Decreased' for an unknown archetype", () => {
    const bounds = {
      speed: { type: "number" as const, min: 1, max: 10 },
    };
    const delta = computeDeltaFromParams("unknown-arch", { speed: 7 }, { speed: 3 }, bounds);
    expect(delta[0].interpretation).toBe("Decreased");
  });
});

// ─── F. bah (no mutable params) ──────────────────────────────────────────────

describe("F. bah always empty delta", () => {
  it("returns [] for bah since it has no mutable params", () => {
    const parent = makeSpec("bah", {});
    const child  = makeSpec("bah", {});
    expect(computeEvolutionDelta(parent, child, BAH_BOUNDS)).toEqual([]);
  });
});

// ─── G. computeEvolutionDelta vs computeDeltaFromParams ──────────────────────

describe("G. computeEvolutionDelta matches computeDeltaFromParams", () => {
  it("produces identical output for the same inputs", () => {
    const parent = makeSpec("mac", { longPeriod: 20, shortPeriod: 5 });
    const child  = makeSpec("mac", { longPeriod: 30, shortPeriod: 8 });
    const fromSpecs  = computeEvolutionDelta(parent, child, MAC_BOUNDS);
    const fromParams = computeDeltaFromParams("mac", parent.params, child.params, MAC_BOUNDS);
    expect(fromSpecs).toEqual(fromParams);
  });
});

// ─── H. String params never included ─────────────────────────────────────────

describe("H. String params excluded from delta", () => {
  it("ignores string params even if they differ", () => {
    const bounds = {
      mode: { type: "string" as const },
      speed: { type: "number" as const, min: 1, max: 10 },
    };
    const delta = computeDeltaFromParams(
      "x",
      { mode: "slow", speed: 3 },
      { mode: "fast", speed: 3 },
      bounds,
    );
    expect(delta).toEqual([]);
  });
});

// ─── I. pctChange sign ───────────────────────────────────────────────────────

describe("I. pctChange is always relative to |from|", () => {
  it("computes correct pct when from is negative (mr zSell)", () => {
    // zSell can be negative; pctChange must still be correct
    const parent = makeSpec("mr", { period: 10, zBuy: -1.0, zSell: -0.5 });
    const child  = makeSpec("mr", { period: 10, zBuy: -1.0, zSell: -1.0 });
    const delta = computeEvolutionDelta(parent, child, MR_BOUNDS);
    const entry = delta.find((d) => d.param === "zSell");
    expect(entry).toBeDefined();
    // from = -0.5, to = -1.0: change = -0.5, pct = -0.5 / |-0.5| = -1.0
    expect(entry!.pctChange).toBeCloseTo(-1.0, 5);
  });
});
