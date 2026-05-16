/**
 * Evolution validation layer — M14 slice 1.
 *
 * Validates that all params in a spec conform to declared archetype bounds.
 *
 * What this validates:
 *  - Type correctness (number/boolean/string per bound declaration).
 *  - Numeric bounds: value in [min, max].
 *  - No NaN or non-finite values.
 *  - No params present in the spec that are absent from the bounds declaration.
 *
 * What this does NOT validate (deferred to future slices):
 *  - Cross-param constraints (e.g. mac shortPeriod < longPeriod).
 *  - Whether all bound keys are present in the spec — absent params fall back
 *    to strategy defaultParams, which is intentional and valid.
 *  - Paper/live deployment eligibility — that gate is separate.
 */

import type { EvolvableBotSpec, ArchetypeParamBounds, ValidationResult } from "./types.ts";

export function validateEvolvableSpec(
  spec: EvolvableBotSpec,
  bounds: ArchetypeParamBounds,
): ValidationResult {
  const errors: string[] = [];

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
