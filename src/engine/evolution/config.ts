/**
 * Evolution config validation for M14.
 *
 * validateEvolutionConfig() is called at the top of advanceGeneration() so
 * callers get a clear error immediately rather than odd downstream behaviour
 * (e.g. zero survivors from a population of size 0, or NaN fitness from an
 * Infinity weight).
 *
 * Checked invariants:
 *   populationSize  — positive integer
 *   survivorCount   — positive integer, ≤ populationSize
 *   minTrades       — non-negative integer
 *   fitnessWeights  — all three required keys (return, drawdown, inconsistency)
 *                    are present, finite, and non-negative
 */

import type { EvolutionConfig } from "./types.ts";

// ─── Error ────────────────────────────────────────────────────────────────────

export class InvalidEvolutionConfigError extends Error {
  readonly configErrors: string[];

  constructor(errors: string[]) {
    super(
      `Invalid EvolutionConfig:\n  ${errors.join("\n  ")}`,
    );
    this.name = "InvalidEvolutionConfigError";
    this.configErrors = errors;
  }
}

// ─── Validator ────────────────────────────────────────────────────────────────

/**
 * Throws InvalidEvolutionConfigError if the config contains invalid values.
 * Does nothing if the config is valid.
 */
export function validateEvolutionConfig(config: EvolutionConfig): void {
  const errors: string[] = [];

  if (!Number.isInteger(config.populationSize) || config.populationSize < 1) {
    errors.push(`populationSize must be a positive integer, got ${config.populationSize}`);
  }

  if (!Number.isInteger(config.survivorCount) || config.survivorCount < 1) {
    errors.push(`survivorCount must be a positive integer, got ${config.survivorCount}`);
  } else if (
    Number.isInteger(config.populationSize) &&
    config.populationSize >= 1 &&
    config.survivorCount > config.populationSize
  ) {
    errors.push(
      `survivorCount (${config.survivorCount}) must not exceed populationSize (${config.populationSize})`,
    );
  }

  if (!Number.isInteger(config.minTrades) || config.minTrades < 0) {
    errors.push(`minTrades must be a non-negative integer, got ${config.minTrades}`);
  }

  // Explicitly validate each required key rather than iterating Object.entries —
  // a persisted/loaded config with a missing key would pass the loop and then
  // produce `undefined * weight = NaN` silently inside the fitness formula.
  const REQUIRED_WEIGHT_KEYS = ["return", "drawdown", "inconsistency"] as const;
  for (const key of REQUIRED_WEIGHT_KEYS) {
    const val = (config.fitnessWeights as Record<string, unknown>)[key];
    if (val === undefined || val === null) {
      errors.push(`fitnessWeights.${key} is required but missing`);
    } else if (typeof val !== "number" || !Number.isFinite(val) || val < 0) {
      errors.push(
        `fitnessWeights.${key} must be a finite non-negative number, got ${val}`,
      );
    }
  }

  if (errors.length > 0) {
    throw new InvalidEvolutionConfigError(errors);
  }
}
