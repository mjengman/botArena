/**
 * Deterministic, seeded parameter mutation engine.
 *
 * Design invariants:
 *  - `mutateSpec` is fully deterministic: same (parent, seed, bounds, createdAt)
 *    quad → identical child spec every time. `createdAt` is REQUIRED — the engine
 *    never calls Date.now(). Use `mutateSpecNow` for production callers that want
 *    wall-clock stamping without thinking about it.
 *  - Child ID format: `${lineageId}-g${generation}-s${seed}-${paramsHash}`.
 *    Uses lineageId (stable across all generations in a lineage) instead of
 *    parent.id so IDs stay bounded regardless of depth. The params hash (djb2
 *    over sorted canonical param pairs) makes IDs collision-resistant across
 *    different params, bounds versions, or algorithm changes.
 *  - number params: mutated with probability mutationRate; new value drawn
 *    uniformly over the FULL [min, max] range (full-range resampling, not
 *    perturbation from parent value). Slice 2 may add per-param magnitude control.
 *  - boolean params: flipped with probability mutationRate.
 *  - string params: copied verbatim — never mutated in M14.
 *  - capital: copied verbatim — not evolvable; set externally.
 *  - notes: NOT inherited — child notes are always undefined. Notes are
 *    per-generation annotations set externally after mutation.
 *
 * Per-param PRNG isolation:
 *   Each param gets a fresh Mulberry32 PRNG seeded by combining the top-level
 *   seed with the param's sorted-key index via a golden-ratio hash. This means
 *   the mutation of any one param does not affect any other, and insertion order
 *   of keys in the parent's params object is irrelevant — only alphabetical sort
 *   index determines the per-param seed.
 */

import { makePrng } from "../prng.ts";
import type { EvolvableBotSpec, ArchetypeParamBounds } from "./types.ts";
import { computeDeltaFromParams } from "./delta.ts";

/**
 * djb2-style hash of a canonical param map.
 * Used to make child IDs collision-resistant across params, bounds versions, and
 * algorithm changes — identical params → identical hash, different params
 * → (almost certainly) different hash.
 */
function hashChildParams(params: Record<string, number | boolean | string>): string {
  const canonical = Object.keys(params)
    .sort()
    .map((k) => `${k}:${params[k]}`)
    .join(",");
  let h = 5381;
  for (let i = 0; i < canonical.length; i++) {
    h = ((h << 5) + h + canonical.charCodeAt(i)) >>> 0;
  }
  return h.toString(16).padStart(8, "0");
}

/** Returns the number of decimal places encoded in a step value. */
function decimalPlaces(step: number): number {
  const s = step.toString();
  const dot = s.indexOf(".");
  return dot === -1 ? 0 : s.length - dot - 1;
}

/**
 * Snap `value` to the nearest step-grid point anchored at `min`, then clamp
 * to [min, max]. Uses the step's decimal precision to eliminate floating-point
 * drift (e.g. 0.001-step params accumulating rounding errors over many snaps).
 */
function snapToStep(value: number, min: number, max: number, step: number): number {
  const dp = decimalPlaces(step);
  const factor = Math.pow(10, dp);
  const steps = Math.round((value - min) / step);
  const snapped = min + steps * step;
  const clamped = Math.max(min, Math.min(max, snapped));
  // Eliminate floating-point drift by rounding to step's declared precision.
  return Math.round(clamped * factor) / factor;
}

/**
 * Mutates a bot spec deterministically.
 *
 * `createdAt` is required — pass `new Date().toISOString()` at the call site
 * for production use, or a fixed string for fully reproducible output.
 * Use `mutateSpecNow` as a convenience wrapper when wall-clock time is fine.
 *
 * @param parent    - The parent spec to mutate from.
 * @param seed      - Integer seed. Same inputs → same child.
 * @param bounds    - Archetype bounds declaring which params are mutable and their ranges.
 * @param createdAt - ISO 8601 timestamp for the child spec (required; not defaulted).
 * @returns A new child EvolvableBotSpec. The parent is never mutated.
 */
export function mutateSpec(
  parent: EvolvableBotSpec,
  seed: number,
  bounds: ArchetypeParamBounds,
  createdAt: string,
): EvolvableBotSpec {
  const generation = parent.generation + 1;
  // ID is computed after params mutation so the hash reflects the actual child state.
  const params: Record<string, number | boolean | string> = { ...parent.params };
  const changedParams: string[] = [];

  // Sort keys alphabetically so key ordering in the parent object never affects
  // any param's mutation — only the sorted index i determines the per-param seed.
  const sortedKeys = Object.keys(bounds).sort();

  for (let i = 0; i < sortedKeys.length; i++) {
    const key = sortedKeys[i];
    const bound = bounds[key];

    // Derive a stable per-param seed by XOR-ing the top-level seed with a
    // golden-ratio multiple of the key index. The >>> 0 coerces to uint32.
    const paramSeed = (seed ^ (i * 0x9e3779b9)) >>> 0;
    const prng = makePrng(paramSeed);

    const rollMutate = prng(); // should this param mutate?
    const rollValue  = prng(); // what is the new value?

    if (bound.type === "string") {
      // String params are not mutated in M14 — copy verbatim.
      // (rollMutate and rollValue are consumed to keep per-param PRNG state
      // consistent regardless of whether a param is a string or not.)
      continue;
    }

    if (bound.type === "boolean") {
      if (rollMutate < parent.mutationRate) {
        const prev = params[key];
        params[key] = !params[key];
        if (params[key] !== prev) changedParams.push(key);
      }
      continue;
    }

    // bound.type === "number"
    if (rollMutate < parent.mutationRate) {
      const { min, max, step } = bound;
      // Uniform draw in [min, max] (full-range resampling — see module docstring).
      const raw = min + rollValue * (max - min);
      const newValue = step !== undefined
        ? snapToStep(raw, min, max, step)
        : Math.max(min, Math.min(max, raw));

      if (newValue !== params[key]) {
        params[key] = newValue;
        changedParams.push(key);
      }
    }
  }

  // Build ID after params are finalised so the hash reflects actual child state.
  // Use lineageId (not parent.id) so IDs stay bounded across arbitrarily deep
  // lineages — parent.id prefixing would cause IDs to grow with every generation.
  const id = `${parent.metadata.lineageId}-g${generation}-s${seed}-${hashChildParams(params)}`;

  const mutationDelta = computeDeltaFromParams(parent.archetype, parent.params, params, bounds);

  return {
    id,
    name: parent.name,
    archetype: parent.archetype,
    params,
    generation,
    parentIds: [parent.id],
    mutationRate: parent.mutationRate,
    capital: parent.capital,
    metadata: {
      lineageId: parent.metadata.lineageId,
      createdAt,
      mutationSummary: changedParams.join(", "),
      mutationDelta: mutationDelta.length > 0 ? mutationDelta : undefined,
      // notes are NOT inherited — child starts fresh. Set externally after mutation.
      notes: undefined,
    },
  };
}

/**
 * Convenience wrapper: calls `mutateSpec` with the current wall-clock time.
 * Use this in production when determinism isn't required.
 * Use `mutateSpec` directly (with a fixed timestamp) when reproducibility matters.
 */
export function mutateSpecNow(
  parent: EvolvableBotSpec,
  seed: number,
  bounds: ArchetypeParamBounds,
): EvolvableBotSpec {
  return mutateSpec(parent, seed, bounds, new Date().toISOString());
}
