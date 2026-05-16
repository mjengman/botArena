/**
 * Evolution validation layer — M14 Slice 1.
 *
 * What this validates:
 *  - Spec-level fields: mutationRate ∈ [0,1], capital finite & ≥ 0,
 *    generation is a non-negative integer, required metadata strings present.
 *  - Per-param checks: type correctness, numeric bounds [min, max],
 *    NaN and non-finite rejection, unknown param keys flagged.
 *
 * What this does NOT validate (explicitly deferred — not an oversight):
 *  - Cross-param constraints (e.g. mac shortPeriod < longPeriod).
 *    These require archetype-specific logic and are deferred to a later slice.
 *  - Step-grid alignment — checked implicitly by mutateSpec; not re-checked here.
 *  - Whether all bound keys are present in spec.params — absent params fall back
 *    to strategy defaultParams, which is intentional and valid.
 *  - Paper/live deployment eligibility — that gate is separate from spec validity.
 *
 * This is NOT a complete validation layer. Future slices will add cross-param
 * constraints and archetype-specific sanity rules.
 */

import type { EvolvableBotSpec, ArchetypeParamBounds, ValidationResult } from "./types.ts";

export function validateEvolvableSpec(
  spec: EvolvableBotSpec,
  bounds: ArchetypeParamBounds,
): ValidationResult {
  const errors: string[] = [];

  // ── Spec-level checks ────────────────────────────────────────────────────────

  if (
    typeof spec.mutationRate !== "number" ||
    !Number.isFinite(spec.mutationRate) ||
    spec.mutationRate < 0 ||
    spec.mutationRate > 1
  ) {
    errors.push(
      `mutationRate must be a finite number in [0, 1], got ${spec.mutationRate}`,
    );
  }

  if (
    typeof spec.capital !== "number" ||
    !Number.isFinite(spec.capital) ||
    spec.capital < 0
  ) {
    errors.push(
      `capital must be a finite non-negative number, got ${spec.capital}`,
    );
  }

  if (!Number.isInteger(spec.generation) || spec.generation < 0) {
    errors.push(
      `generation must be a non-negative integer, got ${spec.generation}`,
    );
  }

  if (!spec.metadata?.lineageId || typeof spec.metadata.lineageId !== "string") {
    errors.push("metadata.lineageId must be a non-empty string");
  }

  if (!spec.metadata?.createdAt || typeof spec.metadata.createdAt !== "string") {
    errors.push("metadata.createdAt must be a non-empty string");
  }

  // ── Per-param checks ─────────────────────────────────────────────────────────

  for (const key of Object.keys(spec.params)) {
    const bound = bounds[key];
    const value = spec.params[key];

    if (bound === undefined) {
      errors.push(
        `Unknown param "${key}" not declared in bounds for archetype "${spec.archetype}"`,
      );
      continue;
    }

    if (bound.type === "string") {
      if (typeof value !== "string") {
        errors.push(`Param "${key}": expected string, got ${typeof value}`);
      }
      continue;
    }

    if (bound.type === "boolean") {
      if (typeof value !== "boolean") {
        errors.push(`Param "${key}": expected boolean, got ${typeof value}`);
      }
      continue;
    }

    // bound.type === "number"
    if (typeof value !== "number") {
      errors.push(`Param "${key}": expected number, got ${typeof value}`);
      continue;
    }
    if (Number.isNaN(value)) {
      errors.push(`Param "${key}": value is NaN`);
      continue;
    }
    if (!Number.isFinite(value)) {
      errors.push(`Param "${key}": value is non-finite (${value})`);
      continue;
    }
    if (value < bound.min) {
      errors.push(`Param "${key}": ${value} is below min ${bound.min}`);
      continue;
    }
    if (value > bound.max) {
      errors.push(`Param "${key}": ${value} exceeds max ${bound.max}`);
    }
  }

  return { valid: errors.length === 0, errors };
}
