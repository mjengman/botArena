/**
 * Per-archetype parameter bounds for M14 mutation.
 *
 * All min/max/step values are taken directly from botRegistry.ts paramDefs.
 * No values are invented here — if botRegistry changes, these must stay in sync.
 *
 * Known limitation (deferred to a later slice):
 *   Cross-param constraints are not encoded here. For example, the mac archetype
 *   requires shortPeriod < longPeriod, but independent mutation of both params
 *   can violate this. A future archetype-specific validator should catch this.
 */

import type { ArchetypeParamBounds } from "./types.ts";

// ─── Buy & Hold ───────────────────────────────────────────────────────────────
// No tunable params. mutateSpec on bah produces a generation+1 clone with
// empty mutationSummary. This is valid and defined behavior.

export const BAH_BOUNDS: ArchetypeParamBounds = {};

// ─── MA Crossover ─────────────────────────────────────────────────────────────

export const MAC_BOUNDS: ArchetypeParamBounds = {
  longPeriod:  { type: "number", min: 5,   max: 200, step: 1 },
  shortPeriod: { type: "number", min: 2,   max: 50,  step: 1 },
};

// ─── Momentum ────────────────────────────────────────────────────────────────

export const MOM_BOUNDS: ArchetypeParamBounds = {
  period:    { type: "number", min: 5,     max: 100, step: 1     },
  threshold: { type: "number", min: 0.001, max: 0.2, step: 0.001 },
};

// ─── Mean Reversion ───────────────────────────────────────────────────────────
// Note: zSell has min: -2, meaning negative values are explicitly valid.
// The validator must not flag negative zSell as an error.

export const MR_BOUNDS: ArchetypeParamBounds = {
  period: { type: "number", min: 5,   max: 100, step: 1   },
  zBuy:   { type: "number", min: 0.1, max: 4,   step: 0.1 },
  zSell:  { type: "number", min: -2,  max: 2,   step: 0.1 },
};

// ─── Random Baseline ─────────────────────────────────────────────────────────

export const RND_BOUNDS: ArchetypeParamBounds = {
  buyProb:  { type: "number", min: 0.01, max: 0.5, step: 0.01 },
  sellProb: { type: "number", min: 0.01, max: 0.5, step: 0.01 },
};

// ─── Master Map ───────────────────────────────────────────────────────────────

export const ARCHETYPE_BOUNDS: Record<string, ArchetypeParamBounds> = {
  bah: BAH_BOUNDS,
  mac: MAC_BOUNDS,
  mom: MOM_BOUNDS,
  mr:  MR_BOUNDS,
  rnd: RND_BOUNDS,
};
