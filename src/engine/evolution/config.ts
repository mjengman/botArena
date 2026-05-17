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
 *   fitnessWeights  — every weight is a finite, non-negative number
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

  for (const [key, val] of Object.entries(config.fitnessWeights)) {
    if (!Number.isFinite(val) || val < 0) {
      errors.push(
        `fitnessWeights.${key} must be a finite non-negative number, got ${val}`,
      );
    }
  }

  if (errors.length > 0) {
    throw new InvalidEvolutionConfigError(errors);
  }
}
