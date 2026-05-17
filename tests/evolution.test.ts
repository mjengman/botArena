/**
 * M14 Slice 1 + Slice 2 — evolution engine tests.
 *
 * Slice 1 coverage:
 *  A. Determinism — same (parent, seed, bounds, createdAt) → identical full spec
 *  B. Bounds compliance — fuzz across 50 seeds per archetype
 *  C. String params — copied verbatim, never mutated
 *  D. Boolean params — flipped with probability mutationRate
 *  E. Lineage metadata — generation, parentIds, mutationSummary, capital, notes NOT inherited
 *  F. bah edge case — no params, pure clone with generation+1
 *  G. validateEvolvableSpec — error detection (params + spec-level fields)
 *  H. validateEvolvableSpec — valid cases including negative zSell
 *
 * Slice 2 coverage:
 *  I. scorePopulation — fitness formula, gate failures (survival + activity)
 *  J. selectSurvivors — top-N, tiebreaker, gate failures excluded
 *  K. planReproduction — exact population size, remainder distribution, ordinals
 *  L. advanceGeneration — lifecycle, archive, champion history, determinism, error path
 */

import { describe, it, expect } from "vitest";
import {
  mutateSpec,
  mutateSpecNow,
  validateEvolvableSpec,
  ARCHETYPE_BOUNDS,
  BAH_BOUNDS,
  MAC_BOUNDS,
  MOM_BOUNDS,
  MR_BOUNDS,
  RND_BOUNDS,
  scorePopulation,
  selectSurvivors,
  planReproduction,
  advanceGeneration,
  validateEvolutionConfig,
  NoEligibleSurvivorsError,
  InsufficientWindowsError,
  InvalidChildSpecError,
  InvalidSeasonDataError,
  InvalidEvolutionConfigError,
  UnknownArchetypeError,
  PopulationSizeMismatchError,
  MIN_EVOLUTION_WINDOWS,
} from "../src/engine/evolution/index.ts";
import type {
  EvolvableBotSpec,
  ArchetypeParamBounds,
  EvolutionSeasonResult,
  EvolutionConfig,
  EvolutionRunState,
} from "../src/engine/evolution/index.ts";
import type { MetricSnapshot } from "../src/engine/types.ts";

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

  it("mutateSpecNow stamps a valid parseable wall-clock ISO timestamp", () => {
    const parent = makeParent("mac", MAC_DEFAULTS);
    const child = mutateSpecNow(parent, 1, MAC_BOUNDS);
    expect(new Date(child.metadata.createdAt).getTime()).not.toBeNaN();
  });
});

// ─── B. Bounds Compliance (fuzz) ─────────────────────────────────────────────

describe("mutateSpec — bounds compliance", () => {
  it("no child param exceeds bounds across 50 seeds — mac archetype", () => {
    const parent = makeParent("mac", MAC_DEFAULTS, 1.0);
    for (let seed = 1; seed <= 50; seed++) {
      const child = mutateSpecNow(parent, seed, MAC_BOUNDS);
      const result = validateEvolvableSpec(child, MAC_BOUNDS);
      expect(result.valid, `seed=${seed}: ${result.errors.join("; ")}`).toBe(true);
    }
  });

  it("no child param exceeds bounds across 50 seeds — mom archetype", () => {
    const parent = makeParent("mom", MOM_DEFAULTS, 1.0);
    for (let seed = 1; seed <= 50; seed++) {
      const child = mutateSpecNow(parent, seed, MOM_BOUNDS);
      const result = validateEvolvableSpec(child, MOM_BOUNDS);
      expect(result.valid, `seed=${seed}: ${result.errors.join("; ")}`).toBe(true);
    }
  });

  it("no child param exceeds bounds across 50 seeds — mr archetype", () => {
    const parent = makeParent("mr", MR_DEFAULTS, 1.0);
    for (let seed = 1; seed <= 50; seed++) {
      const child = mutateSpecNow(parent, seed, MR_BOUNDS);
      const result = validateEvolvableSpec(child, MR_BOUNDS);
      expect(result.valid, `seed=${seed}: ${result.errors.join("; ")}`).toBe(true);
    }
  });

  it("no child param exceeds bounds across 50 seeds — rnd archetype", () => {
    const parent = makeParent("rnd", RND_DEFAULTS, 1.0);
    for (let seed = 1; seed <= 50; seed++) {
      const child = mutateSpecNow(parent, seed, RND_BOUNDS);
      const result = validateEvolvableSpec(child, RND_BOUNDS);
      expect(result.valid, `seed=${seed}: ${result.errors.join("; ")}`).toBe(true);
    }
  });

  it("no child param exceeds bounds across 50 seeds — bah archetype (no-op)", () => {
    const parent = makeParent("bah", BAH_DEFAULTS, 1.0);
    for (let seed = 1; seed <= 50; seed++) {
      const child = mutateSpecNow(parent, seed, BAH_BOUNDS);
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
      const child = mutateSpecNow(parent, seed, syntheticBounds);
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
      .map((s) => mutateSpecNow(parent, s, boolBounds))
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
      const child = mutateSpecNow(parent, seed, boolBounds);
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

  it("child id encodes lineageId, generation, and seed", () => {
    // Format: {lineageId}-g{generation}-s{seed}-{paramsHash}
    // Uses lineageId (not parent.id) so IDs stay bounded across deep lineages.
    expect(child.id).toContain(parent.metadata.lineageId);
    expect(child.id).toContain(`g${child.generation}`);
    expect(child.id).toContain("s99");
  });

  it("child id includes a params hash segment (collision resistance)", () => {
    // The ID has 4 dash-separated segments; the last is the 8-hex-char params hash.
    const parts = child.id.split("-");
    const hashPart = parts[parts.length - 1];
    expect(hashPart).toMatch(/^[0-9a-f]{8}$/);
  });

  it("different params produce different child IDs (mutationRate=0, same lineageId, same seed)", () => {
    // With mutationRate=0 params carry through verbatim, so the hash reflects
    // genuinely different param values. With mutationRate=1 (full-range resampling)
    // child params depend only on the seed, not the parent's starting values.
    const parentA = makeParent("mac", { shortPeriod: 10, longPeriod: 30 }, 0);
    const parentB = makeParent("mac", { shortPeriod: 15, longPeriod: 40 }, 0);
    // Give both the same lineageId so only the params hash distinguishes them.
    parentA.metadata = { ...parentA.metadata, lineageId: "same-lineage" };
    parentB.metadata = { ...parentB.metadata, lineageId: "same-lineage" };
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

  it("child IDs stay bounded across deep lineages (use lineageId not parent.id)", () => {
    // If IDs used parent.id as prefix, each generation's ID would include all
    // ancestor IDs, growing without bound. lineageId-based IDs are always the
    // same length regardless of generation depth.
    let spec = makeParent("mac", MAC_DEFAULTS, 1.0);
    for (let g = 0; g < 10; g++) {
      spec = dm(spec, g, MAC_BOUNDS);
    }
    // ID should still be a single bounded string containing the lineageId prefix.
    expect(spec.id).toContain(parent.metadata.lineageId);
    // Should NOT contain nested generation markers (no ...-g1-...-g2-...-g3...)
    const gMatches = spec.id.match(/\bg\d+\b/g) ?? [];
    expect(gMatches.length).toBe(1);
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
    const child  = mutateSpecNow(parent, 1, BAH_BOUNDS);
    expect(child.generation).toBe(1);
    expect(child.metadata.mutationSummary).toBe("");
  });

  it("params object remains empty after mutation", () => {
    const parent = makeParent("bah", {}, 1.0);
    const child  = mutateSpecNow(parent, 1, BAH_BOUNDS);
    expect(Object.keys(child.params)).toHaveLength(0);
  });

  it("validateEvolvableSpec passes on bah child", () => {
    const parent = makeParent("bah", {}, 1.0);
    const child  = mutateSpecNow(parent, 1, BAH_BOUNDS);
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

  it("catches non-date string for createdAt ('banana')", () => {
    const spec = makeParent("mac", MAC_DEFAULTS);
    spec.metadata = { ...spec.metadata, createdAt: "banana" };
    expect(validateEvolvableSpec(spec, MAC_BOUNDS).valid).toBe(false);
    expect(validateEvolvableSpec(spec, MAC_BOUNDS).errors.some((e) => e.includes("createdAt"))).toBe(true);
  });

  it("catches non-canonical ISO form for createdAt ('May 16 2026')", () => {
    const spec = makeParent("mac", MAC_DEFAULTS);
    spec.metadata = { ...spec.metadata, createdAt: "May 16 2026" };
    expect(validateEvolvableSpec(spec, MAC_BOUNDS).valid).toBe(false);
    expect(validateEvolvableSpec(spec, MAC_BOUNDS).errors.some((e) => e.includes("createdAt"))).toBe(true);
  });

  it("catches impossible calendar date for createdAt ('2026-02-31T00:00:00.000Z' normalizes to Mar 3)", () => {
    const spec = makeParent("mac", MAC_DEFAULTS);
    spec.metadata = { ...spec.metadata, createdAt: "2026-02-31T00:00:00.000Z" };
    // Date.parse accepts this but normalises it — round-trip detects the mismatch.
    expect(validateEvolvableSpec(spec, MAC_BOUNDS).valid).toBe(false);
    expect(validateEvolvableSpec(spec, MAC_BOUNDS).errors.some((e) => e.includes("createdAt"))).toBe(true);
  });

  it("catches non-.000Z ISO form ('2026-05-17T05:00:00Z' — missing milliseconds)", () => {
    // new Date().toISOString() always produces .000Z; shorter forms are non-canonical.
    const spec = makeParent("mac", MAC_DEFAULTS);
    spec.metadata = { ...spec.metadata, createdAt: "2026-05-17T05:00:00Z" };
    expect(validateEvolvableSpec(spec, MAC_BOUNDS).valid).toBe(false);
    expect(validateEvolvableSpec(spec, MAC_BOUNDS).errors.some((e) => e.includes("createdAt"))).toBe(true);
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
        const child  = mutateSpecNow(parent, seed, bounds);
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

// ═══════════════════════════════════════════════════════════════════════════════
// M14 Slice 2 — fitness, selection, reproduction, lifecycle
// ═══════════════════════════════════════════════════════════════════════════════

/** Timestamp used for advanceGeneration calls — distinct from FIXED_DATE. */
const ADVANCED_DATE = "2026-05-17T00:00:00.000Z";

// ─── Slice 2 factories ────────────────────────────────────────────────────────

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
    params: archetype === "rnd" ? { buyProb: 0.1, sellProb: 0.1 } : {},
    generation: 0,
    parentIds: [],
    mutationRate: 0.5,
    capital: 100,
    metadata: {
      lineageId: `lineage-${id}`,
      createdAt: FIXED_DATE,
    },
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
    runId: "test-run-1",
    generation: 0,
    activePop,
    archive: [],
    championHistory: {},
    config: makeConfig({ populationSize: activePop.length, survivorCount: Math.max(1, Math.floor(activePop.length / 2)) }),
    seed: 12345,
    datasetManifest: {
      symbol: "SPY",
      fromDate: "2024-01-01",
      toDate: "2024-12-31",
      windowCount: 1,
      windowLengthDays: 90,
    },
    createdAt: FIXED_DATE,
    updatedAt: FIXED_DATE,
    ...overrides,
  };
}

// ─── I. scorePopulation ───────────────────────────────────────────────────────

describe("scorePopulation — fitness scoring", () => {
  it("healthy bot with positive return gets kind:'scored'", () => {
    const spec = makeSpec("a");
    const season = makeSeason([
      [makeSnapshot("a", { totalReturn: 0.1, tradeCount: 5 })],
      [makeSnapshot("a", { totalReturn: 0.1, tradeCount: 5 })],
    ]);
    const [record] = scorePopulation([spec], season, makeConfig());
    expect(record.fitness.kind).toBe("scored");
  });

  it("bot with finalEquity <= 0 in any window fails survival gate", () => {
    const spec = makeSpec("a");
    const season = makeSeason([
      [makeSnapshot("a", { finalEquity: 0 })],
      [makeSnapshot("a", { finalEquity: 0 })],
    ]);
    const [record] = scorePopulation([spec], season, makeConfig());
    expect(record.fitness.kind).toBe("gate-failure");
    if (record.fitness.kind === "gate-failure") {
      expect(record.fitness.gateFailureReason).toBe("survival");
    }
  });

  it("survival gate: one bad window out of two triggers failure", () => {
    const spec = makeSpec("a");
    const season = makeSeason([
      [makeSnapshot("a", { finalEquity: 10_500 })],
      [makeSnapshot("a", { finalEquity: -1 })],
    ]);
    const [record] = scorePopulation([spec], season, makeConfig());
    expect(record.fitness.kind).toBe("gate-failure");
    if (record.fitness.kind === "gate-failure") {
      expect(record.fitness.gateFailureReason).toBe("survival");
    }
  });

  it("bot with 0 trades fails activity gate (minTrades=1)", () => {
    const spec = makeSpec("a");
    const season = makeSeason([
      [makeSnapshot("a", { tradeCount: 0 })],
      [makeSnapshot("a", { tradeCount: 0 })],
    ]);
    const [record] = scorePopulation([spec], season, makeConfig({ minTrades: 1 }));
    expect(record.fitness.kind).toBe("gate-failure");
    if (record.fitness.kind === "gate-failure") {
      expect(record.fitness.gateFailureReason).toBe("activity");
    }
  });

  it("bot with exactly minTrades passes activity gate", () => {
    const spec = makeSpec("a");
    // minTrades=3, 1 trade per window × 2 windows = 2 total < 3 → still fails
    // Use 2 trades per window × 2 windows = 4 total ≥ 3 → passes
    const season = makeSeason([
      [makeSnapshot("a", { tradeCount: 2 })],
      [makeSnapshot("a", { tradeCount: 1 })],
    ]);
    const [record] = scorePopulation([spec], season, makeConfig({ minTrades: 3 }));
    expect(record.fitness.kind).toBe("scored");
  });

  it("bot absent from a season window throws InvalidSeasonDataError", () => {
    const spec = makeSpec("ghost");
    // ghost is in window 0 but missing from window 1 — completeness check throws
    const season = makeSeason([
      [makeSnapshot("ghost", { tradeCount: 5 })],
      [makeSnapshot("other-bot")],
    ]);
    expect(() => scorePopulation([spec], season, makeConfig()))
      .toThrow(InvalidSeasonDataError);
  });

  it("higher return → higher fitness (same drawdown and stddev)", () => {
    const specA = makeSpec("a");
    const specB = makeSpec("b");
    // Identical returns in both windows → stddev = 0 for both; only mean return differs
    const season = makeSeason([
      [makeSnapshot("a", { totalReturn: 0.20, tradeCount: 5 }), makeSnapshot("b", { totalReturn: 0.05, tradeCount: 5 })],
      [makeSnapshot("a", { totalReturn: 0.20, tradeCount: 5 }), makeSnapshot("b", { totalReturn: 0.05, tradeCount: 5 })],
    ]);
    const records = scorePopulation([specA, specB], season, makeConfig());
    const scoreA = records[0].fitness.kind === "scored" ? records[0].fitness.fitnessScore : -Infinity;
    const scoreB = records[1].fitness.kind === "scored" ? records[1].fitness.fitnessScore : -Infinity;
    expect(scoreA).toBeGreaterThan(scoreB);
  });

  it("higher drawdown → lower fitness (same return and stddev)", () => {
    const specA = makeSpec("a");
    const specB = makeSpec("b");
    const season = makeSeason([
      [makeSnapshot("a", { totalReturn: 0.1, maxDrawdown: 0.05, tradeCount: 5 }), makeSnapshot("b", { totalReturn: 0.1, maxDrawdown: 0.30, tradeCount: 5 })],
      [makeSnapshot("a", { totalReturn: 0.1, maxDrawdown: 0.05, tradeCount: 5 }), makeSnapshot("b", { totalReturn: 0.1, maxDrawdown: 0.30, tradeCount: 5 })],
    ]);
    const records = scorePopulation([specA, specB], season, makeConfig());
    const scoreA = records[0].fitness.kind === "scored" ? records[0].fitness.fitnessScore : -Infinity;
    const scoreB = records[1].fitness.kind === "scored" ? records[1].fitness.fitnessScore : -Infinity;
    expect(scoreA).toBeGreaterThan(scoreB);
  });

  it("worstWindowDrawdown uses worst across windows, not first", () => {
    const spec = makeSpec("a");
    const season = makeSeason([
      [makeSnapshot("a", { totalReturn: 0.1, maxDrawdown: 0.05, tradeCount: 5 })],
      [makeSnapshot("a", { totalReturn: 0.1, maxDrawdown: 0.40, tradeCount: 5 })],
    ]);
    const [record] = scorePopulation([spec], season, makeConfig());
    expect(record.fitness.kind).toBe("scored");
    if (record.fitness.kind === "scored") {
      expect(record.fitness.windowMetricsSummary.worstWindowDrawdown).toBeCloseTo(0.40);
    }
  });

  it("returnStdDev is non-zero for bots with unequal returns across windows", () => {
    const spec = makeSpec("a");
    const season = makeSeason([
      [makeSnapshot("a", { totalReturn: 0.0, tradeCount: 5 })],
      [makeSnapshot("a", { totalReturn: 0.2, tradeCount: 5 })],
    ]);
    const [record] = scorePopulation([spec], season, makeConfig());
    expect(record.fitness.kind).toBe("scored");
    if (record.fitness.kind === "scored") {
      expect(record.fitness.windowMetricsSummary.returnStdDev).toBeGreaterThan(0);
    }
  });

  it("scorePopulation preserves input order and returns one record per bot", () => {
    const pop = [makeSpec("z"), makeSpec("a"), makeSpec("m")];
    const season = makeSeason([
      [makeSnapshot("z"), makeSnapshot("a"), makeSnapshot("m")],
      [makeSnapshot("z"), makeSnapshot("a"), makeSnapshot("m")],
    ]);
    const records = scorePopulation(pop, season, makeConfig());
    expect(records).toHaveLength(3);
    expect(records.map((r) => r.spec.id)).toEqual(["z", "a", "m"]);
  });
});

// ─── J. selectSurvivors ───────────────────────────────────────────────────────

describe("selectSurvivors — selection", () => {
  it("selects top-N by fitness score", () => {
    const pop = [makeSpec("lo"), makeSpec("hi"), makeSpec("mid")];
    const standings = [
      makeSnapshot("lo",  { totalReturn: 0.01, tradeCount: 5 }),
      makeSnapshot("hi",  { totalReturn: 0.30, tradeCount: 5 }),
      makeSnapshot("mid", { totalReturn: 0.10, tradeCount: 5 }),
    ];
    const season = makeSeason([standings, standings]);
    const config = makeConfig({ survivorCount: 2, populationSize: 3 });
    const records = scorePopulation(pop, season, config);
    const survivors = selectSurvivors(records, config);
    expect(survivors).toHaveLength(2);
    expect(survivors[0].spec.id).toBe("hi");
    expect(survivors[1].spec.id).toBe("mid");
  });

  it("gate failures never appear in survivors", () => {
    const pop = [makeSpec("dead"), makeSpec("alive")];
    const standings = [
      makeSnapshot("dead",  { finalEquity: 0 }),
      makeSnapshot("alive", { totalReturn: 0.1, tradeCount: 5 }),
    ];
    const season = makeSeason([standings, standings]);
    const config = makeConfig({ survivorCount: 2, populationSize: 2 });
    const records = scorePopulation(pop, season, config);
    const survivors = selectSurvivors(records, config);
    expect(survivors.every((r) => r.spec.id !== "dead")).toBe(true);
  });

  it("tiebreak: ascending bot id when scores are equal", () => {
    const pop = [makeSpec("bot-z"), makeSpec("bot-a"), makeSpec("bot-m")];
    // Identical returns in both windows → stddev = 0; only id differs
    const standings = [
      makeSnapshot("bot-z", { totalReturn: 0.1, maxDrawdown: 0.1, tradeCount: 5 }),
      makeSnapshot("bot-a", { totalReturn: 0.1, maxDrawdown: 0.1, tradeCount: 5 }),
      makeSnapshot("bot-m", { totalReturn: 0.1, maxDrawdown: 0.1, tradeCount: 5 }),
    ];
    const season = makeSeason([standings, standings]);
    const config = makeConfig({ survivorCount: 2, populationSize: 3 });
    const records = scorePopulation(pop, season, config);
    const survivors = selectSurvivors(records, config);
    // Equal scores → ascending id: "bot-a" < "bot-m" < "bot-z"
    expect(survivors[0].spec.id).toBe("bot-a");
    expect(survivors[1].spec.id).toBe("bot-m");
  });

  it("survivorCount > eligible bots: returns all eligible bots", () => {
    const pop = [makeSpec("a"), makeSpec("b")];
    const standings = [makeSnapshot("a", { tradeCount: 5 }), makeSnapshot("b", { tradeCount: 5 })];
    const season = makeSeason([standings, standings]);
    const config = makeConfig({ survivorCount: 10, populationSize: 2 });
    const records = scorePopulation(pop, season, config);
    const survivors = selectSurvivors(records, config);
    expect(survivors).toHaveLength(2);
  });

  it("all bots are gate failures: returns empty array", () => {
    const pop = [makeSpec("a"), makeSpec("b")];
    const standings = [
      makeSnapshot("a", { finalEquity: 0 }),
      makeSnapshot("b", { tradeCount: 0 }),
    ];
    const season = makeSeason([standings, standings]);
    const config = makeConfig({ survivorCount: 2, populationSize: 2 });
    const records = scorePopulation(pop, season, config);
    const survivors = selectSurvivors(records, config);
    expect(survivors).toHaveLength(0);
  });
});

// ─── K. planReproduction ──────────────────────────────────────────────────────

describe("planReproduction — reproduction planning", () => {
  function scoredRecord(id: string): ReturnType<typeof scorePopulation>[0] {
    const spec = makeSpec(id);
    return {
      spec,
      fitness: { kind: "scored", fitnessScore: 0.1, windowMetricsSummary: { meanReturn: 0.1, worstWindowDrawdown: 0.1, returnStdDev: 0, totalTradeCount: 5, windowCount: 1 } },
    };
  }

  it("total children equals populationSize (no remainder)", () => {
    const survivors = [scoredRecord("a"), scoredRecord("b")];
    const plan = planReproduction(survivors, 4);
    expect(plan).toHaveLength(4);
  });

  it("total children equals populationSize (with remainder)", () => {
    // 3 survivors, populationSize=7: 7/3=2 each, top-1 gets +1 → 3+2+2=7
    const survivors = [scoredRecord("a"), scoredRecord("b"), scoredRecord("c")];
    const plan = planReproduction(survivors, 7);
    expect(plan).toHaveLength(7);
  });

  it("top survivors get extra child when remainder > 0", () => {
    // 2 survivors, populationSize=5: 5/2=2 each, top-1 gets +1 → 3+2=5
    const survivors = [scoredRecord("a"), scoredRecord("b")];
    const plan = planReproduction(survivors, 5);
    const aCount = plan.filter((e) => e.parent.id === "a").length;
    const bCount = plan.filter((e) => e.parent.id === "b").length;
    expect(aCount).toBe(3);
    expect(bCount).toBe(2);
  });

  it("single survivor: all children from one parent", () => {
    const survivors = [scoredRecord("a")];
    const plan = planReproduction(survivors, 4);
    expect(plan).toHaveLength(4);
    expect(plan.every((e) => e.parent.id === "a")).toBe(true);
  });

  it("ordinals are 0-based, sequential, non-repeating", () => {
    const survivors = [scoredRecord("a"), scoredRecord("b")];
    const plan = planReproduction(survivors, 4);
    const ordinals = plan.map((e) => e.ordinal);
    expect(ordinals).toEqual([0, 1, 2, 3]);
  });

  it("empty survivors: returns empty plan", () => {
    expect(planReproduction([], 4)).toHaveLength(0);
  });
});

// ─── L. advanceGeneration — lifecycle ────────────────────────────────────────

describe("advanceGeneration — lifecycle", () => {
  /** Four bots, two healthy, two gate failures — two windows (required by lifecycle). */
  function makeStandardState() {
    const pop = [makeSpec("hi"), makeSpec("lo"), makeSpec("dead"), makeSpec("lazy")];
    const state = makeRunState(pop, {
      config: makeConfig({ populationSize: 4, survivorCount: 2, minTrades: 1 }),
    });
    const season = makeSeason([
      [
        makeSnapshot("hi",   { totalReturn: 0.20, tradeCount: 10 }),
        makeSnapshot("lo",   { totalReturn: 0.02, tradeCount: 5  }),
        makeSnapshot("dead", { finalEquity: 0,    tradeCount: 0  }),  // survival gate
        makeSnapshot("lazy", { tradeCount: 0 }),                       // activity gate
      ],
      [
        makeSnapshot("hi",   { totalReturn: 0.15, tradeCount: 8 }),
        makeSnapshot("lo",   { totalReturn: 0.03, tradeCount: 4 }),
        makeSnapshot("dead", { finalEquity: 0,    tradeCount: 0 }),
        makeSnapshot("lazy", { tradeCount: 0 }),
      ],
    ]);
    return { state, season };
  }

  it("generation index increments by 1", () => {
    const { state, season } = makeStandardState();
    const next = advanceGeneration(state, season, ADVANCED_DATE);
    expect(next.generation).toBe(state.generation + 1);
  });

  it("active population has exactly populationSize bots", () => {
    const { state, season } = makeStandardState();
    const next = advanceGeneration(state, season, ADVANCED_DATE);
    expect(next.activePop).toHaveLength(state.config.populationSize);
  });

  it("original state is not mutated", () => {
    const { state, season } = makeStandardState();
    const originalPop = [...state.activePop];
    advanceGeneration(state, season, ADVANCED_DATE);
    expect(state.activePop).toEqual(originalPop);
    expect(state.generation).toBe(0);
  });

  it("all current bots are archived (archive grows by populationSize)", () => {
    const { state, season } = makeStandardState();
    const next = advanceGeneration(state, season, ADVANCED_DATE);
    expect(next.archive).toHaveLength(state.activePop.length);
  });

  it("survivors are archived as 'reproduced'", () => {
    const { state, season } = makeStandardState();
    const next = advanceGeneration(state, season, ADVANCED_DATE);
    const reproducedIds = next.archive
      .filter((r) => r.retirementReason === "reproduced")
      .map((r) => r.id);
    expect(reproducedIds).toContain("hi");
    expect(reproducedIds).toContain("lo");
  });

  it("gate failures are archived as 'gate-failure'", () => {
    const { state, season } = makeStandardState();
    const next = advanceGeneration(state, season, ADVANCED_DATE);
    const gateFailIds = next.archive
      .filter((r) => r.retirementReason === "gate-failure")
      .map((r) => r.id);
    expect(gateFailIds).toContain("dead");
    expect(gateFailIds).toContain("lazy");
  });

  it("non-survivors are archived as 'non-survivor'", () => {
    // Three scored bots, only top-1 survives
    const pop = [makeSpec("best"), makeSpec("mid"), makeSpec("worst")];
    const state = makeRunState(pop, {
      config: makeConfig({ populationSize: 3, survivorCount: 1, minTrades: 1 }),
    });
    const season = makeSeason([
      [
        makeSnapshot("best",  { totalReturn: 0.30, tradeCount: 5 }),
        makeSnapshot("mid",   { totalReturn: 0.10, tradeCount: 5 }),
        makeSnapshot("worst", { totalReturn: 0.01, tradeCount: 5 }),
      ],
      [
        makeSnapshot("best",  { totalReturn: 0.25, tradeCount: 4 }),
        makeSnapshot("mid",   { totalReturn: 0.08, tradeCount: 4 }),
        makeSnapshot("worst", { totalReturn: 0.00, tradeCount: 4 }),
      ],
    ]);
    const next = advanceGeneration(state, season, ADVANCED_DATE);
    const nonSurvivorIds = next.archive
      .filter((r) => r.retirementReason === "non-survivor")
      .map((r) => r.id);
    expect(nonSurvivorIds).toContain("mid");
    expect(nonSurvivorIds).toContain("worst");
  });

  it("children's parentIds point to their parent", () => {
    const { state, season } = makeStandardState();
    const next = advanceGeneration(state, season, ADVANCED_DATE);
    for (const child of next.activePop) {
      expect(child.parentIds).toHaveLength(1);
      expect(["hi", "lo"]).toContain(child.parentIds[0]);
    }
  });

  it("children inherit lineageId from their parent", () => {
    const { state, season } = makeStandardState();
    const next = advanceGeneration(state, season, ADVANCED_DATE);
    for (const child of next.activePop) {
      const parentLineageId = ["lineage-hi", "lineage-lo"];
      expect(parentLineageId).toContain(child.metadata.lineageId);
    }
  });

  it("advancedAt flows through to children createdAt", () => {
    const { state, season } = makeStandardState();
    const next = advanceGeneration(state, season, ADVANCED_DATE);
    for (const child of next.activePop) {
      expect(child.metadata.createdAt).toBe(ADVANCED_DATE);
    }
  });

  it("updatedAt is set to advancedAt on the returned state", () => {
    const { state, season } = makeStandardState();
    const next = advanceGeneration(state, season, ADVANCED_DATE);
    expect(next.updatedAt).toBe(ADVANCED_DATE);
  });

  it("is fully deterministic: same inputs produce identical next generation", () => {
    const { state, season } = makeStandardState();
    const next1 = advanceGeneration(state, season, ADVANCED_DATE);
    const next2 = advanceGeneration(state, season, ADVANCED_DATE);
    expect(next1.activePop).toEqual(next2.activePop);
    expect(next1.generation).toBe(next2.generation);
  });

  it("throws NoEligibleSurvivorsError when all bots fail gates", () => {
    const pop = [makeSpec("a"), makeSpec("b")];
    const state = makeRunState(pop, {
      config: makeConfig({ populationSize: 2, survivorCount: 2, minTrades: 100 }),
    });
    const season = makeSeason([
      [makeSnapshot("a", { tradeCount: 1 }), makeSnapshot("b", { tradeCount: 1 })],
      [makeSnapshot("a", { tradeCount: 1 }), makeSnapshot("b", { tradeCount: 1 })],
    ]);
    expect(() => advanceGeneration(state, season, ADVANCED_DATE))
      .toThrow(NoEligibleSurvivorsError);
  });

  it("state is unchanged after NoEligibleSurvivorsError", () => {
    const pop = [makeSpec("a")];
    const state = makeRunState(pop, {
      config: makeConfig({ populationSize: 1, survivorCount: 1, minTrades: 999 }),
    });
    const season = makeSeason([
      [makeSnapshot("a", { tradeCount: 0 })],
      [makeSnapshot("a", { tradeCount: 0 })],
    ]);
    try {
      advanceGeneration(state, season, ADVANCED_DATE);
    } catch {
      // expected
    }
    // original state is unchanged
    expect(state.generation).toBe(0);
    expect(state.archive).toHaveLength(0);
    expect(state.activePop).toHaveLength(1);
  });

  it("champion history updated when a bot beats the previous champion", () => {
    const pop = [makeSpec("champ"), makeSpec("weak")];
    const state = makeRunState(pop, {
      config: makeConfig({ populationSize: 2, survivorCount: 1, minTrades: 1 }),
      championHistory: {},
    });
    const season = makeSeason([
      [makeSnapshot("champ", { totalReturn: 0.50, tradeCount: 5 }), makeSnapshot("weak", { totalReturn: 0.01, tradeCount: 5 })],
      [makeSnapshot("champ", { totalReturn: 0.45, tradeCount: 4 }), makeSnapshot("weak", { totalReturn: 0.01, tradeCount: 4 })],
    ]);
    const next = advanceGeneration(state, season, ADVANCED_DATE);
    expect(next.championHistory["rnd"]).toBeDefined();
    expect(next.championHistory["rnd"].botId).toBe("champ");
  });

  it("champion history preserves better champion across generations", () => {
    const pop = [makeSpec("decent")];
    // Pre-seed champion history with a very strong champ
    const existingChamp = {
      botId: "old-legend",
      generation: 5,
      fitnessScore: 9999,
      spec: makeSpec("old-legend"),
    };
    const state = makeRunState(pop, {
      config: makeConfig({ populationSize: 1, survivorCount: 1, minTrades: 1 }),
      championHistory: { rnd: existingChamp },
    });
    const season = makeSeason([
      [makeSnapshot("decent", { totalReturn: 0.05, tradeCount: 5 })],
      [makeSnapshot("decent", { totalReturn: 0.04, tradeCount: 4 })],
    ]);
    const next = advanceGeneration(state, season, ADVANCED_DATE);
    // "decent" scored far below 9999 — old champ should be preserved
    expect(next.championHistory["rnd"].botId).toBe("old-legend");
    expect(next.championHistory["rnd"].fitnessScore).toBe(9999);
  });

  it("existing archive entries are preserved in the next state", () => {
    const { state, season } = makeStandardState();
    // Pre-populate archive with one entry
    const existingRecord = {
      id: "ancient",
      name: "Ancient Bot",
      archetype: "rnd",
      params: {},
      generation: 0,
      parentIds: [],
      lineageId: "lineage-ancient",
      fitness: { kind: "scored" as const, fitnessScore: 0.1, windowMetricsSummary: { meanReturn: 0.1, worstWindowDrawdown: 0.1, returnStdDev: 0, totalTradeCount: 5, windowCount: 2 } },
      retirementReason: "non-survivor" as const,
      retiredAtGeneration: 0,
    };
    const stateWithArchive = { ...state, archive: [existingRecord] };
    const next = advanceGeneration(stateWithArchive, season, ADVANCED_DATE);
    expect(next.archive.some((r) => r.id === "ancient")).toBe(true);
    expect(next.archive).toHaveLength(1 + state.activePop.length);
  });
});

// ─── M. New error paths introduced by hardening pass ─────────────────────────

describe("advanceGeneration — multi-window enforcement", () => {
  it(`rejects a season with fewer than ${MIN_EVOLUTION_WINDOWS} windows`, () => {
    const pop = [makeSpec("a"), makeSpec("b")];
    const state = makeRunState(pop, {
      config: makeConfig({ populationSize: 2, survivorCount: 1, minTrades: 1 }),
    });
    const singleWindowSeason = makeSeason([
      [makeSnapshot("a", { tradeCount: 5 }), makeSnapshot("b", { tradeCount: 5 })],
    ]);
    expect(() => advanceGeneration(state, singleWindowSeason, ADVANCED_DATE))
      .toThrow(InsufficientWindowsError);
  });

  it("InsufficientWindowsError carries the correct window count", () => {
    const pop = [makeSpec("a")];
    const state = makeRunState(pop, {
      config: makeConfig({ populationSize: 1, survivorCount: 1, minTrades: 1 }),
    });
    const season = makeSeason([[makeSnapshot("a", { tradeCount: 5 })]]);
    try {
      advanceGeneration(state, season, ADVANCED_DATE);
    } catch (e) {
      expect(e).toBeInstanceOf(InsufficientWindowsError);
      if (e instanceof InsufficientWindowsError) {
        expect(e.windowCount).toBe(1);
        expect(e.minimumRequired).toBe(MIN_EVOLUTION_WINDOWS);
      }
    }
  });
});

describe("advanceGeneration — config validation", () => {
  it("rejects config where survivorCount exceeds populationSize", () => {
    const pop = [makeSpec("a"), makeSpec("b")];
    const state = makeRunState(pop, {
      config: makeConfig({ populationSize: 2, survivorCount: 5 }),
    });
    const season = makeSeason([
      [makeSnapshot("a", { tradeCount: 5 }), makeSnapshot("b", { tradeCount: 5 })],
      [makeSnapshot("a", { tradeCount: 4 }), makeSnapshot("b", { tradeCount: 4 })],
    ]);
    expect(() => advanceGeneration(state, season, ADVANCED_DATE))
      .toThrow(InvalidEvolutionConfigError);
  });

  it("rejects config with populationSize < 1", () => {
    expect(() => validateEvolutionConfig(makeConfig({ populationSize: 0 })))
      .toThrow(InvalidEvolutionConfigError);
  });

  it("rejects config with survivorCount < 1", () => {
    expect(() => validateEvolutionConfig(makeConfig({ survivorCount: 0 })))
      .toThrow(InvalidEvolutionConfigError);
  });

  it("rejects config with negative minTrades", () => {
    expect(() => validateEvolutionConfig(makeConfig({ minTrades: -1 })))
      .toThrow(InvalidEvolutionConfigError);
  });

  it("rejects config with non-finite fitness weight", () => {
    expect(() => validateEvolutionConfig(makeConfig({
      fitnessWeights: { return: Infinity, drawdown: 0.3, inconsistency: 0.2 },
    }))).toThrow(InvalidEvolutionConfigError);
  });

  it("rejects config with negative fitness weight", () => {
    expect(() => validateEvolutionConfig(makeConfig({
      fitnessWeights: { return: 0.5, drawdown: -0.1, inconsistency: 0.2 },
    }))).toThrow(InvalidEvolutionConfigError);
  });

  it("accepts a valid config without throwing", () => {
    expect(() => validateEvolutionConfig(makeConfig())).not.toThrow();
  });
});

describe("scorePopulation — season data validation", () => {
  it("throws InvalidSeasonDataError when a bot is missing from a window", () => {
    const pop = [makeSpec("present"), makeSpec("absent")];
    const season = makeSeason([
      [makeSnapshot("present", { tradeCount: 5 }), makeSnapshot("absent", { tradeCount: 5 })],
      [makeSnapshot("present", { tradeCount: 4 })],  // "absent" missing from window 1
    ]);
    expect(() => scorePopulation(pop, season, makeConfig()))
      .toThrow(InvalidSeasonDataError);
  });

  it("throws InvalidSeasonDataError for NaN totalReturn in a snapshot", () => {
    const spec = makeSpec("a");
    const season = makeSeason([
      [makeSnapshot("a", { totalReturn: NaN, tradeCount: 5 })],
      [makeSnapshot("a", { tradeCount: 5 })],
    ]);
    expect(() => scorePopulation([spec], season, makeConfig()))
      .toThrow(InvalidSeasonDataError);
  });

  it("throws InvalidSeasonDataError for Infinity finalEquity in a snapshot", () => {
    const spec = makeSpec("a");
    const season = makeSeason([
      [makeSnapshot("a", { finalEquity: Infinity, tradeCount: 5 })],
      [makeSnapshot("a", { tradeCount: 5 })],
    ]);
    expect(() => scorePopulation([spec], season, makeConfig()))
      .toThrow(InvalidSeasonDataError);
  });

  it("throws InvalidSeasonDataError for negative tradeCount", () => {
    const spec = makeSpec("a");
    const season = makeSeason([
      [makeSnapshot("a", { tradeCount: -1 })],
      [makeSnapshot("a", { tradeCount: 5 })],
    ]);
    expect(() => scorePopulation([spec], season, makeConfig()))
      .toThrow(InvalidSeasonDataError);
  });
});

describe("InvalidChildSpecError — constructor and properties", () => {
  it("carries childId, parentId, and validation errors", () => {
    const err = new InvalidChildSpecError("child-id", "parent-id", ["param x out of bounds"]);
    expect(err).toBeInstanceOf(Error);
    expect(err.name).toBe("InvalidChildSpecError");
    expect(err.childId).toBe("child-id");
    expect(err.parentId).toBe("parent-id");
    expect(err.validationErrors).toEqual(["param x out of bounds"]);
  });
});

describe("advanceGeneration — unknown archetype", () => {
  it("throws UnknownArchetypeError when a survivor has an unknown archetype", () => {
    const pop = [makeSpec("alien", "mystery-archetype")];
    const state = makeRunState(pop, {
      config: makeConfig({ populationSize: 1, survivorCount: 1, minTrades: 1 }),
    });
    const season = makeSeason([
      [makeSnapshot("alien", { totalReturn: 0.1, tradeCount: 5 })],
      [makeSnapshot("alien", { totalReturn: 0.1, tradeCount: 5 })],
    ]);
    expect(() => advanceGeneration(state, season, ADVANCED_DATE))
      .toThrow(UnknownArchetypeError);
  });
});

// ─── N. Hardening-pass round 2 — gaps closed ─────────────────────────────────

describe("validateEvolutionConfig — required fitness weight keys", () => {
  it("rejects a config with a missing 'inconsistency' weight", () => {
    const bad = {
      ...makeConfig(),
      fitnessWeights: { return: 0.5, drawdown: 0.3 } as never,
    };
    expect(() => validateEvolutionConfig(bad)).toThrow(InvalidEvolutionConfigError);
  });

  it("rejects a config with a missing 'return' weight", () => {
    const bad = {
      ...makeConfig(),
      fitnessWeights: { drawdown: 0.3, inconsistency: 0.2 } as never,
    };
    expect(() => validateEvolutionConfig(bad)).toThrow(InvalidEvolutionConfigError);
  });

  it("rejects a config with a missing 'drawdown' weight", () => {
    const bad = {
      ...makeConfig(),
      fitnessWeights: { return: 0.5, inconsistency: 0.2 } as never,
    };
    expect(() => validateEvolutionConfig(bad)).toThrow(InvalidEvolutionConfigError);
  });

  it("accepts a config where all three required weight keys are present and valid", () => {
    expect(() => validateEvolutionConfig(makeConfig())).not.toThrow();
  });
});

describe("scorePopulation — single-window enforcement", () => {
  it("throws InsufficientWindowsError when called directly with one window", () => {
    const spec = makeSpec("a");
    const singleWindow = makeSeason([[makeSnapshot("a", { tradeCount: 5 })]]);
    expect(() => scorePopulation([spec], singleWindow, makeConfig()))
      .toThrow(InsufficientWindowsError);
  });

  it("accepts a two-window season", () => {
    const spec = makeSpec("a");
    const twoWindows = makeSeason([
      [makeSnapshot("a", { tradeCount: 5 })],
      [makeSnapshot("a", { tradeCount: 5 })],
    ]);
    expect(() => scorePopulation([spec], twoWindows, makeConfig())).not.toThrow();
  });
});

describe("advanceGeneration — population size invariant", () => {
  it("throws PopulationSizeMismatchError when activePop.length != config.populationSize", () => {
    // activePop has 2 bots but config says 4
    const pop = [makeSpec("a"), makeSpec("b")];
    const state = makeRunState(pop, {
      config: makeConfig({ populationSize: 4, survivorCount: 2, minTrades: 1 }),
    });
    const season = makeSeason([
      [makeSnapshot("a", { tradeCount: 5 }), makeSnapshot("b", { tradeCount: 5 })],
      [makeSnapshot("a", { tradeCount: 4 }), makeSnapshot("b", { tradeCount: 4 })],
    ]);
    expect(() => advanceGeneration(state, season, ADVANCED_DATE))
      .toThrow(PopulationSizeMismatchError);
  });

  it("PopulationSizeMismatchError carries actual and configured sizes", () => {
    const pop = [makeSpec("a")];
    const state = makeRunState(pop, {
      config: makeConfig({ populationSize: 3, survivorCount: 1, minTrades: 1 }),
    });
    const season = makeSeason([
      [makeSnapshot("a", { tradeCount: 5 })],
      [makeSnapshot("a", { tradeCount: 5 })],
    ]);
    try {
      advanceGeneration(state, season, ADVANCED_DATE);
    } catch (e) {
      expect(e).toBeInstanceOf(PopulationSizeMismatchError);
      if (e instanceof PopulationSizeMismatchError) {
        expect(e.actualSize).toBe(1);
        expect(e.configuredSize).toBe(3);
      }
    }
  });
});

describe("advanceGeneration — InvalidChildSpecError integration", () => {
  it("throws InvalidChildSpecError when advancedAt is not a canonical ISO timestamp", () => {
    // "not-a-valid-date" fails the round-trip ISO check in validateEvolvableSpec(),
    // which means every child produced by mutateSpec() will be invalid.
    const pop = [makeSpec("hi"), makeSpec("lo")];
    const state = makeRunState(pop, {
      config: makeConfig({ populationSize: 2, survivorCount: 1, minTrades: 1 }),
    });
    const season = makeSeason([
      [makeSnapshot("hi", { totalReturn: 0.2, tradeCount: 5 }), makeSnapshot("lo", { totalReturn: 0.05, tradeCount: 5 })],
      [makeSnapshot("hi", { totalReturn: 0.15, tradeCount: 4 }), makeSnapshot("lo", { totalReturn: 0.03, tradeCount: 4 })],
    ]);
    expect(() => advanceGeneration(state, season, "not-a-valid-date"))
      .toThrow(InvalidChildSpecError);
  });
});
