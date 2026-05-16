/**
 * M14 Slice 1 — evolution engine tests.
 *
 * Coverage:
 *  A. Determinism — same (parent, seed, bounds, createdAt) → identical full spec
 *  B. Bounds compliance — fuzz across 50 seeds per archetype
 *  C. String params — copied verbatim, never mutated
 *  D. Boolean params — flipped with probability mutationRate
 *  E. Lineage metadata — generation, parentIds, mutationSummary, capital, notes NOT inherited
 *  F. bah edge case — no params, pure clone with generation+1
 *  G. validateEvolvableSpec — error detection (params + spec-level fields)
 *  H. validateEvolvableSpec — valid cases including negative zSell
 */

import { describe, it, expect } from "vitest";
import {
  mutateSpec,
  validateEvolvableSpec,
  ARCHETYPE_BOUNDS,
  BAH_BOUNDS,
  MAC_BOUNDS,
  MOM_BOUNDS,
  MR_BOUNDS,
  RND_BOUNDS,
} from "../src/engine/evolution/index.ts";
import type { EvolvableBotSpec, ArchetypeParamBounds } from "../src/engine/evolution/index.ts";

// ─── Test Factories ───────────────────────────────────────────────────────────

/** Fixed timestamp used in determinism tests to make the full spec comparable. */
const FIXED_DATE = "2026-05-16T12:00:00.000Z";

function makeParent(
  archetype: string,
  params: Record<string, number | boolean | string>,
  mutationRate = 1.0,
): EvolvableBotSpec {
  return {
    id: `test-${archetype}-1`,
    name: `Test ${archetype} Gen 0`,
    archetype,
    params,
    generation: 0,
    parentIds: [],
    mutationRate,
    capital: 10_000,
    metadata: {
      lineageId: `lineage-${archetype}-1`,
      createdAt: "2026-05-16T00:00:00.000Z",
      notes: "test note",
    },
  };
}

/**
 * Deterministic mutateSpec wrapper: passes a fixed createdAt so the full
 * child spec (including createdAt) is identical across calls with the same inputs.
 */
function dm(
  parent: EvolvableBotSpec,
  seed: number,
  bounds: ArchetypeParamBounds,
): ReturnType<typeof mutateSpec> {
  return mutateSpec(parent, seed, bounds, FIXED_DATE);
}

// Default params taken from botRegistry.ts (ground truth).
const MAC_DEFAULTS = { shortPeriod: 10, longPeriod: 30 };
const MOM_DEFAULTS = { period: 20, threshold: 0.02 };
const MR_DEFAULTS  = { period: 20, zBuy: 1.5, zSell: 0 };
const RND_DEFAULTS = { buyProb: 0.05, sellProb: 0.1 };
const BAH_DEFAULTS = {} as Record<string, number>;

/**
 * Returns all deterministic fields of a spec.
 * createdAt is now included because it is caller-supplied and therefore deterministic
 * when tests use dm() (which passes FIXED_DATE).
 */
function deterministicFields(spec: EvolvableBotSpec) {
  return {
    id:              spec.id,
    name:            spec.name,
    archetype:       spec.archetype,
    params:          spec.params,
    generation:      spec.generation,
    parentIds:       spec.parentIds,
    mutationRate:    spec.mutationRate,
    capital:         spec.capital,
    lineageId:       spec.metadata.lineageId,
    createdAt:       spec.metadata.createdAt,
    mutationSummary: spec.metadata.mutationSummary,
    notes:           spec.metadata.notes,
  };
}

// ─── A. Determinism ───────────────────────────────────────────────────────────

describe("mutateSpec — determinism", () => {
  // dm() passes FIXED_DATE so createdAt is identical across calls;
  // deterministicFields() now includes createdAt, so this is a full-spec comparison.

  it("same seed produces identical full child spec (mac, seed 42) — run 1 of 3", () => {
    const parent = makeParent("mac", MAC_DEFAULTS);
    expect(deterministicFields(dm(parent, 42, MAC_BOUNDS)))
      .toEqual(deterministicFields(dm(parent, 42, MAC_BOUNDS)));
  });

  it("same seed produces identical full child spec (mom, seed 7777) — run 2 of 3", () => {
    const parent = makeParent("mom", MOM_DEFAULTS);
    expect(deterministicFields(dm(parent, 7777, MOM_BOUNDS)))
      .toEqual(deterministicFields(dm(parent, 7777, MOM_BOUNDS)));
  });

  it("same seed produces identical full child spec (mr, seed 123456789) — run 3 of 3", () => {
    const parent = makeParent("mr", MR_DEFAULTS);
    expect(deterministicFields(dm(parent, 123456789, MR_BOUNDS)))
      .toEqual(deterministicFields(dm(parent, 123456789, MR_BOUNDS)));
  });

  it("different seeds produce different children — mac archetype", () => {
    const parent = makeParent("mac", MAC_DEFAULTS, 1.0);
    const a = JSON.stringify(deterministicFields(dm(parent, 1, MAC_BOUNDS)));
    const b = JSON.stringify(deterministicFields(dm(parent, 2, MAC_BOUNDS)));
    expect(a).not.toBe(b);
  });

  it("different seeds produce different children — mom archetype", () => {
    const parent = makeParent("mom", MOM_DEFAULTS, 1.0);
    const a = JSON.stringify(deterministicFields(dm(parent, 1, MOM_BOUNDS)));
    const b = JSON.stringify(deterministicFields(dm(parent, 2, MOM_BOUNDS)));
    expect(a).not.toBe(b);
  });

  it("different seeds produce different children — mr archetype", () => {
    const parent = makeParent("mr", MR_DEFAULTS, 1.0);
    const a = JSON.stringify(deterministicFields(dm(parent, 1, MR_BOUNDS)));
    const b = JSON.stringify(deterministicFields(dm(parent, 2, MR_BOUNDS)));
    expect(a).not.toBe(b);
  });

  it("different seeds produce different children — rnd archetype", () => {
    const parent = makeParent("rnd", RND_DEFAULTS, 1.0);
    const a = JSON.stringify(deterministicFields(dm(parent, 1, RND_BOUNDS)));
    const b = JSON.stringify(deterministicFields(dm(parent, 2, RND_BOUNDS)));
    expect(a).not.toBe(b);
  });

  it("omitting createdAt produces a valid wall-clock timestamp (non-deterministic path)", () => {
    const parent = makeParent("mac", MAC_DEFAULTS);
    const child = mutateSpec(parent, 1, MAC_BOUNDS); // no createdAt arg
    expect(new Date(child.metadata.createdAt).getTime()).not.toBeNaN();
  });
});

// ─── B. Bounds Compliance (fuzz) ─────────────────────────────────────────────

describe("mutateSpec — bounds compliance", () => {
  it("no child param exceeds bounds across 50 seeds — mac archetype", () => {
    const parent = makeParent("mac", MAC_DEFAULTS, 1.0);
    for (let seed = 1; seed <= 50; seed++) {
      const child = mutateSpec(parent, seed, MAC_BOUNDS);
      const result = validateEvolvableSpec(child, MAC_BOUNDS);
      expect(result.valid, `seed=${seed}: ${result.errors.join("; ")}`).toBe(true);
    }
  });

  it("no child param exceeds bounds across 50 seeds — mom archetype", () => {
    const parent = makeParent("mom", MOM_DEFAULTS, 1.0);
    for (let seed = 1; seed <= 50; seed++) {
      const child = mutateSpec(parent, seed, MOM_BOUNDS);
      const result = validateEvolvableSpec(child, MOM_BOUNDS);
      expect(result.valid, `seed=${seed}: ${result.errors.join("; ")}`).toBe(true);
    }
  });

  it("no child param exceeds bounds across 50 seeds — mr archetype", () => {
    const parent = makeParent("mr", MR_DEFAULTS, 1.0);
    for (let seed = 1; seed <= 50; seed++) {
      const child = mutateSpec(parent, seed, MR_BOUNDS);
      const result = validateEvolvableSpec(child, MR_BOUNDS);
      expect(result.valid, `seed=${seed}: ${result.errors.join("; ")}`).toBe(true);
    }
  });

  it("no child param exceeds bounds across 50 seeds — rnd archetype", () => {
    const parent = makeParent("rnd", RND_DEFAULTS, 1.0);
    for (let seed = 1; seed <= 50; seed++) {
      const child = mutateSpec(parent, seed, RND_BOUNDS);
      const result = validateEvolvableSpec(child, RND_BOUNDS);
      expect(result.valid, `seed=${seed}: ${result.errors.join("; ")}`).toBe(true);
    }
  });

  it("no child param exceeds bounds across 50 seeds — bah archetype (no-op)", () => {
    const parent = makeParent("bah", BAH_DEFAULTS, 1.0);
    for (let seed = 1; seed <= 50; seed++) {
      const child = mutateSpec(parent, seed, BAH_BOUNDS);
      const result = validateEvolvableSpec(child, BAH_BOUNDS);
      expect(result.valid, `seed=${seed}: ${result.errors.join("; ")}`).toBe(true);
    }
  });
});

// ─── C. String Params ─────────────────────────────────────────────────────────

describe("mutateSpec — string params", () => {
  // No real archetype has string params in M14; use a synthetic bounds entry.
  const syntheticBounds: ArchetypeParamBounds = {
    tag:    { type: "string" },
    weight: { type: "number", min: 0, max: 1 },
  };

  it("string params are copied verbatim regardless of mutationRate", () => {
    const parent: EvolvableBotSpec = {
      id: "test-string-1",
      name: "Test String Bot",
      archetype: "synthetic",
      params: { tag: "fast-trend", weight: 0.5 },
      generation: 0,
      parentIds: [],
      mutationRate: 1.0,
      capital: 10_000,
      metadata: { lineageId: "l1", createdAt: "2026-05-16T00:00:00.000Z" },
    };
    for (let seed = 1; seed <= 20; seed++) {
      const child = mutateSpec(parent, seed, syntheticBounds);
      expect(child.params["tag"]).toBe("fast-trend");
    }
  });
});

// ─── D. Boolean Params ────────────────────────────────────────────────────────

describe("mutateSpec — boolean params", () => {
  const boolBounds: ArchetypeParamBounds = {
    useFilter: { type: "boolean" },
    period:    { type: "number", min: 5, max: 100, step: 1 },
  };

  it("boolean params flip with mutationRate=1 across multiple seeds", () => {
    const parent: EvolvableBotSpec = {
      id: "test-bool-1",
      name: "Test Bool Bot",
      archetype: "synthetic",
      params: { useFilter: true, period: 20 },
      generation: 0,
      parentIds: [],
      mutationRate: 1.0,
      capital: 10_000,
      metadata: { lineageId: "l2", createdAt: "2026-05-16T00:00:00.000Z" },
    };
    // With mutationRate=1, useFilter should flip on some seeds.
    const flips = [1, 2, 3, 4, 5]
      .map((s) => mutateSpec(parent, s, boolBounds))
      .filter((c) => c.params["useFilter"] !== parent.params["useFilter"]);
    expect(flips.length).toBeGreaterThan(0);
  });

  it("boolean params are not mutated when mutationRate=0", () => {
    const parent: EvolvableBotSpec = {
      id: "test-bool-2",
      name: "Test Bool Bot",
      archetype: "synthetic",
      params: { useFilter: false, period: 20 },
      generation: 0,
      parentIds: [],
      mutationRate: 0,
      capital: 10_000,
      metadata: { lineageId: "l3", createdAt: "2026-05-16T00:00:00.000Z" },
    };
    for (let seed = 1; seed <= 20; seed++) {
      const child = mutateSpec(parent, seed, boolBounds);
      expect(child.params["useFilter"]).toBe(false);
    }
  });
});

// ─── E. Lineage / Metadata ────────────────────────────────────────────────────

describe("mutateSpec — lineage", () => {
  const parent = makeParent("mac", MAC_DEFAULTS, 1.0);
  const child  = dm(parent, 99, MAC_BOUNDS);

  it("generation increments by exactly 1", () => {
    expect(child.generation).toBe(parent.generation + 1);
  });

  it("parentIds contains exactly the parent's id", () => {
    expect(child.parentIds).toEqual([parent.id]);
  });

  it("child id encodes parent id, generation, and seed", () => {
    // Format: {parentId}-g{generation}-s{seed}-{paramsHash}
    expect(child.id).toContain(parent.id);
    expect(child.id).toContain(`g${child.generation}`);
    expect(child.id).toContain("s99");
  });

  it("child id includes a params hash segment (collision resistance)", () => {
    // The ID has 4 dash-separated segments; the last is the 8-hex-char params hash.
    const parts = child.id.split("-");
    const hashPart = parts[parts.length - 1];
    expect(hashPart).toMatch(/^[0-9a-f]{8}$/);
  });

  it("different params produce different child IDs (mutationRate=0, same seed)", () => {
    // With mutationRate=0 params carry through verbatim, so the hash reflects
    // genuinely different param values. With mutationRate=1 (full-range resampling)
    // child params depend only on the seed, not the parent's starting values.
    const parentA = makeParent("mac", { shortPeriod: 10, longPeriod: 30 }, 0);
    const parentB = makeParent("mac", { shortPeriod: 15, longPeriod: 40 }, 0);
    parentA.id = "same-id";
    parentB.id = "same-id";
    const childA = dm(parentA, 42, MAC_BOUNDS);
    const childB = dm(parentB, 42, MAC_BOUNDS);
    // Different params → different hash → different child ID
    expect(childA.id).not.toBe(childB.id);
  });

  it("capital is copied verbatim from parent", () => {
    expect(child.capital).toBe(parent.capital);
  });

  it("mutationRate is copied verbatim from parent", () => {
    expect(child.mutationRate).toBe(parent.mutationRate);
  });

  it("lineageId is carried forward unchanged", () => {
    expect(child.metadata.lineageId).toBe(parent.metadata.lineageId);
  });

  it("notes are NOT inherited from parent — child notes is undefined", () => {
    // Parent has notes: "test note"; child should start fresh.
    expect(child.metadata.notes).toBeUndefined();
  });

  it("mutationSummary is a string", () => {
    expect(typeof child.metadata.mutationSummary).toBe("string");
  });

  it("mutationSummary is empty string when mutationRate=0 (perfect clone)", () => {
    const frozen = makeParent("mac", MAC_DEFAULTS, 0);
    const clone  = dm(frozen, 42, MAC_BOUNDS);
    expect(clone.metadata.mutationSummary).toBe("");
    expect(clone.params).toEqual(frozen.params);
  });

  it("mutationSummary lists at least one param across seeds 1-5 when mutationRate=1", () => {
    const parent2 = makeParent("mac", MAC_DEFAULTS, 1.0);
    const summaries = [1, 2, 3, 4, 5].map(
      (s) => dm(parent2, s, MAC_BOUNDS).metadata.mutationSummary ?? "",
    );
    expect(summaries.some((s) => s.length > 0)).toBe(true);
  });

  it("archetype and name are copied verbatim", () => {
    expect(child.archetype).toBe(parent.archetype);
    expect(child.name).toBe(parent.name);
  });

  it("multi-generation lineage accumulates correctly, notes not inherited at any generation", () => {
    const gen1 = dm(parent, 1, MAC_BOUNDS);
    const gen2 = dm(gen1, 2, MAC_BOUNDS);
    const gen3 = dm(gen2, 3, MAC_BOUNDS);
    expect(gen1.generation).toBe(1);
    expect(gen2.generation).toBe(2);
    expect(gen3.generation).toBe(3);
    expect(gen2.parentIds).toEqual([gen1.id]);
    expect(gen3.parentIds).toEqual([gen2.id]);
    expect(gen3.metadata.lineageId).toBe(parent.metadata.lineageId);
    expect(gen1.metadata.notes).toBeUndefined();
    expect(gen2.metadata.notes).toBeUndefined();
    expect(gen3.metadata.notes).toBeUndefined();
  });
});

// ─── F. bah Edge Case (no params) ────────────────────────────────────────────

describe("mutateSpec — bah archetype (no params)", () => {
  it("produces a child with generation+1 and empty mutationSummary", () => {
    const parent = makeParent("bah", {}, 1.0);
    const child  = mutateSpec(parent, 1, BAH_BOUNDS);
    expect(child.generation).toBe(1);
    expect(child.metadata.mutationSummary).toBe("");
  });

  it("params object remains empty after mutation", () => {
    const parent = makeParent("bah", {}, 1.0);
    const child  = mutateSpec(parent, 1, BAH_BOUNDS);
    expect(Object.keys(child.params)).toHaveLength(0);
  });

  it("validateEvolvableSpec passes on bah child", () => {
    const parent = makeParent("bah", {}, 1.0);
    const child  = mutateSpec(parent, 1, BAH_BOUNDS);
    expect(validateEvolvableSpec(child, BAH_BOUNDS).valid).toBe(true);
  });

  it("ARCHETYPE_BOUNDS['bah'] is the same object as BAH_BOUNDS", () => {
    expect(ARCHETYPE_BOUNDS["bah"]).toBe(BAH_BOUNDS);
  });
});

// ─── G. validateEvolvableSpec — error cases ───────────────────────────────────

describe("validateEvolvableSpec — error detection", () => {
  it("catches value below min (mac shortPeriod = 1, min is 2)", () => {
    const spec = makeParent("mac", { shortPeriod: 1, longPeriod: 30 });
    const result = validateEvolvableSpec(spec, MAC_BOUNDS);
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.includes("shortPeriod"))).toBe(true);
    expect(result.errors.some((e) => e.includes("below min"))).toBe(true);
  });

  it("catches value above max (mac longPeriod = 201, max is 200)", () => {
    const spec = makeParent("mac", { shortPeriod: 10, longPeriod: 201 });
    const result = validateEvolvableSpec(spec, MAC_BOUNDS);
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.includes("longPeriod"))).toBe(true);
    expect(result.errors.some((e) => e.includes("exceeds max"))).toBe(true);
  });

  it("catches NaN for a number param", () => {
    const spec = makeParent("mom", { period: NaN, threshold: 0.02 });
    const result = validateEvolvableSpec(spec, MOM_BOUNDS);
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.includes("NaN"))).toBe(true);
  });

  it("catches Infinity for a number param", () => {
    const spec = makeParent("mom", { period: Infinity, threshold: 0.02 });
    const result = validateEvolvableSpec(spec, MOM_BOUNDS);
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.includes("non-finite"))).toBe(true);
  });

  it("catches -Infinity for a number param", () => {
    const spec = makeParent("mom", { period: -Infinity, threshold: 0.02 });
    const result = validateEvolvableSpec(spec, MOM_BOUNDS);
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.includes("non-finite"))).toBe(true);
  });

  it("catches a param key not declared in bounds", () => {
    const spec = makeParent("mac", { shortPeriod: 10, longPeriod: 30, mystery: 99 });
    const result = validateEvolvableSpec(spec, MAC_BOUNDS);
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.includes("mystery"))).toBe(true);
  });

  it("catches wrong runtime type (string where number expected)", () => {
    const spec = makeParent("mac", { shortPeriod: "ten" as unknown as number, longPeriod: 30 });
    const result = validateEvolvableSpec(spec, MAC_BOUNDS);
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.includes("shortPeriod"))).toBe(true);
  });

  it("accumulates multiple errors when several params are invalid", () => {
    const spec = makeParent("mac", { shortPeriod: -1, longPeriod: 999 });
    const result = validateEvolvableSpec(spec, MAC_BOUNDS);
    expect(result.valid).toBe(false);
    expect(result.errors.length).toBeGreaterThanOrEqual(2);
  });

  // ── Spec-level field checks (validation hardening) ────────────────────────

  it("catches mutationRate below 0", () => {
    const spec = { ...makeParent("mac", MAC_DEFAULTS), mutationRate: -0.1 };
    const result = validateEvolvableSpec(spec, MAC_BOUNDS);
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.includes("mutationRate"))).toBe(true);
  });

  it("catches mutationRate above 1", () => {
    const spec = { ...makeParent("mac", MAC_DEFAULTS), mutationRate: 1.1 };
    const result = validateEvolvableSpec(spec, MAC_BOUNDS);
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.includes("mutationRate"))).toBe(true);
  });

  it("catches mutationRate of NaN", () => {
    const spec = { ...makeParent("mac", MAC_DEFAULTS), mutationRate: NaN };
    const result = validateEvolvableSpec(spec, MAC_BOUNDS);
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.includes("mutationRate"))).toBe(true);
  });

  it("catches negative capital", () => {
    const spec = { ...makeParent("mac", MAC_DEFAULTS), capital: -1 };
    const result = validateEvolvableSpec(spec, MAC_BOUNDS);
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.includes("capital"))).toBe(true);
  });

  it("catches Infinity capital", () => {
    const spec = { ...makeParent("mac", MAC_DEFAULTS), capital: Infinity };
    const result = validateEvolvableSpec(spec, MAC_BOUNDS);
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.includes("capital"))).toBe(true);
  });

  it("catches negative generation", () => {
    const spec = { ...makeParent("mac", MAC_DEFAULTS), generation: -1 };
    const result = validateEvolvableSpec(spec, MAC_BOUNDS);
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.includes("generation"))).toBe(true);
  });

  it("catches fractional generation", () => {
    const spec = { ...makeParent("mac", MAC_DEFAULTS), generation: 1.5 };
    const result = validateEvolvableSpec(spec, MAC_BOUNDS);
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.includes("generation"))).toBe(true);
  });

  it("catches empty lineageId", () => {
    const spec = makeParent("mac", MAC_DEFAULTS);
    spec.metadata = { ...spec.metadata, lineageId: "" };
    const result = validateEvolvableSpec(spec, MAC_BOUNDS);
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.includes("lineageId"))).toBe(true);
  });

  it("catches empty createdAt", () => {
    const spec = makeParent("mac", MAC_DEFAULTS);
    spec.metadata = { ...spec.metadata, createdAt: "" };
    const result = validateEvolvableSpec(spec, MAC_BOUNDS);
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.includes("createdAt"))).toBe(true);
  });

  it("passes spec-level checks for all valid makeParent defaults", () => {
    for (const [arch, params, bounds] of [
      ["mac", MAC_DEFAULTS, MAC_BOUNDS],
      ["mom", MOM_DEFAULTS, MOM_BOUNDS],
      ["mr",  MR_DEFAULTS,  MR_BOUNDS],
      ["rnd", RND_DEFAULTS, RND_BOUNDS],
      ["bah", BAH_DEFAULTS, BAH_BOUNDS],
    ] as const) {
      const result = validateEvolvableSpec(
        makeParent(arch, params as Record<string, number>),
        bounds as ArchetypeParamBounds,
      );
      expect(result.valid, `${arch}: ${result.errors.join("; ")}`).toBe(true);
    }
  });
});

// ─── H. validateEvolvableSpec — valid cases ───────────────────────────────────

describe("validateEvolvableSpec — valid cases", () => {
  it("passes on a valid mac spec at default values", () => {
    expect(validateEvolvableSpec(makeParent("mac", MAC_DEFAULTS), MAC_BOUNDS).valid).toBe(true);
  });

  it("passes on a valid mom spec at default values", () => {
    expect(validateEvolvableSpec(makeParent("mom", MOM_DEFAULTS), MOM_BOUNDS).valid).toBe(true);
  });

  it("passes on a valid mr spec at default values", () => {
    expect(validateEvolvableSpec(makeParent("mr", MR_DEFAULTS), MR_BOUNDS).valid).toBe(true);
  });

  it("passes on mr spec with negative zSell (-1.0) — min is -2", () => {
    const spec = makeParent("mr", { period: 20, zBuy: 1.5, zSell: -1.0 });
    expect(validateEvolvableSpec(spec, MR_BOUNDS).valid).toBe(true);
  });

  it("passes on mr spec with zSell at minimum (-2.0)", () => {
    const spec = makeParent("mr", { period: 20, zBuy: 0.1, zSell: -2.0 });
    expect(validateEvolvableSpec(spec, MR_BOUNDS).valid).toBe(true);
  });

  it("passes on a valid rnd spec at default values", () => {
    expect(validateEvolvableSpec(makeParent("rnd", RND_DEFAULTS), RND_BOUNDS).valid).toBe(true);
  });

  it("passes on output of mutateSpec across 10 seeds for all archetypes", () => {
    const cases: [string, ArchetypeParamBounds, Record<string, number>][] = [
      ["mac", MAC_BOUNDS, MAC_DEFAULTS],
      ["mom", MOM_BOUNDS, MOM_DEFAULTS],
      ["mr",  MR_BOUNDS,  MR_DEFAULTS],
      ["rnd", RND_BOUNDS, RND_DEFAULTS],
      ["bah", BAH_BOUNDS, BAH_DEFAULTS],
    ];
    for (const [archetype, bounds, defaults] of cases) {
      const parent = makeParent(archetype, defaults, 1.0);
      for (let seed = 100; seed <= 109; seed++) {
        const child  = mutateSpec(parent, seed, bounds);
        const result = validateEvolvableSpec(child, bounds);
        expect(
          result.valid,
          `${archetype} seed=${seed}: ${result.errors.join("; ")}`,
        ).toBe(true);
      }
    }
  });

  it("empty params object is valid for bah archetype", () => {
    const spec = makeParent("bah", {});
    expect(validateEvolvableSpec(spec, BAH_BOUNDS).valid).toBe(true);
  });
});
