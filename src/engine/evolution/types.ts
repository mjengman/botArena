/**
 * Core types for the M14 Parameter Evolution Sandbox.
 *
 * Design constraints (M14 scope):
 *  - number and boolean params are mutable within declared bounds.
 *  - string params are NOT mutated — copied verbatim from parent to child.
 *  - capital is NOT evolvable — set externally by the season runner or user.
 *  - Cross-param constraints (e.g. mac shortPeriod < longPeriod) are deferred
 *    to a future validation slice.
 */

import type { MetricSnapshot } from "../types.ts";

// ─── Param Bound Entries ──────────────────────────────────────────────────────

export type ParamBoundEntry =
  | { type: "number"; min: number; max: number; step?: number }
  | { type: "boolean" }
  | { type: "string" }; // not mutated in M14 — copied verbatim

/**
 * Declares the mutable parameter space for one archetype.
 * Keys must match the param keys used in the strategy's defaultParams
 * and in botRegistry.ts paramDefs.
 */
export type ArchetypeParamBounds = Record<string, ParamBoundEntry>;

// ─── Evolvable Bot Spec ───────────────────────────────────────────────────────

export type EvolvableBotSpec = {
  /**
   * Deterministic: `${lineageId}-g${generation}-s${seed}-${paramsHash}`.
   * Uses lineageId (not parentId) so IDs stay bounded across deep lineages.
   * See mutate.ts for full format and hash algorithm.
   */
  id: string;
  name: string;
  /** Matches a key in ARCHETYPE_BOUNDS — e.g. "mac", "mom", "mr", "rnd", "bah". */
  archetype: string;
  /**
   * All params for this bot. Types may be number, boolean, or string.
   * Only number and boolean params with declared bounds are mutated in M14.
   * String params are metadata/categorical values and are copied verbatim.
   */
  params: Record<string, number | boolean | string>;
  generation: number;
  parentIds: string[];
  /**
   * Probability [0, 1] that any individual mutable param is perturbed during
   * one mutation pass. mutationRate=0 produces a perfect clone (generation+1,
   * no param changes). mutationRate=1 mutates every eligible param.
   */
  mutationRate: number;
  /** Not evolvable — copied verbatim from parent. Set externally. */
  capital: number;
  metadata: {
    lineageId: string;
    /** ISO 8601 wall-clock timestamp of when this spec was generated. Not deterministic. */
    createdAt: string;
    /** Comma-separated list of param keys that changed during this mutation. */
    mutationSummary?: string;
    /**
     * Per-generation annotations set externally after mutation.
     * NOT inherited from parent — mutateSpec always sets this to undefined.
     * Carry ancestry through parentIds/lineageId, not notes.
     */
    notes?: string;
  };
};

// ─── Validation Result ────────────────────────────────────────────────────────

export interface ValidationResult {
  valid: boolean;
  errors: string[];
}

// ─── Evolution Season Result (engine-local; no src/app dependency) ───────────
//
// The app layer adapts SeasonResult → EvolutionSeasonResult before passing it
// to the evolution engine. This keeps src/engine/evolution free of app imports.

export type EvolutionSeasonResult = {
  windows: Array<{
    index: number;
    standings: MetricSnapshot[];
  }>;
};

// ─── Window Metrics Summary ───────────────────────────────────────────────────

export type WindowMetricsSummary = {
  meanReturn: number;
  /** Worst per-window maxDrawdown across all season windows (not averaged). */
  worstWindowDrawdown: number;
  returnStdDev: number;
  totalTradeCount: number;
  windowCount: number;
};

// ─── Fitness Result (discriminated union — JSON-safe, no ±Infinity) ───────────
//
// Gate failures use kind:"gate-failure" rather than fitnessScore:-Infinity.
// This is JSON-safe (Infinity serialises to null in JSON.stringify) and makes
// the distinction explicit at the type level, so callers cannot accidentally
// treat a gate failure as a scored bot.

export type FitnessResult =
  | {
      kind: "scored";
      fitnessScore: number;
      windowMetricsSummary: WindowMetricsSummary;
    }
  | {
      kind: "gate-failure";
      gateFailureReason: "survival" | "activity";
      windowMetricsSummary: WindowMetricsSummary;
    };

// ─── Bot Fitness Record ───────────────────────────────────────────────────────
//
// Pairs a spec with its fitness result. Used internally by the scoring →
// selection → lifecycle pipeline.

export type BotFitnessRecord = {
  spec: EvolvableBotSpec;
  fitness: FitnessResult;
};

// ─── Archived Bot Record ──────────────────────────────────────────────────────
//
// Compact record for every bot that leaves the active population. Deep detail
// (trade logs, equity curves) is a future concern (Slice 3+).
//
// retirementReason values:
//   "reproduced"       — survivor that produced children; now archived
//   "non-survivor"     — lost selection ranking (fitness scored, but below cut)
//   "gate-failure"     — failed survival or activity gate; see fitness.gateFailureReason
//   "population-reset" — explicit reset by user
//   "vetoed"           — excluded from reproduction by human override (Slice 4C)

export type ArchivedBotRecord = {
  id: string;
  name: string;
  archetype: string;
  params: Record<string, number | boolean | string>;
  generation: number;
  parentIds: string[];
  lineageId: string;
  fitness: FitnessResult;
  retirementReason: "reproduced" | "non-survivor" | "gate-failure" | "population-reset" | "vetoed";
  retiredAtGeneration: number;
};

// ─── Champion Record ──────────────────────────────────────────────────────────

export type ChampionRecord = {
  botId: string;
  generation: number;
  fitnessScore: number;
  spec: EvolvableBotSpec;
};

// ─── Evolution Config ─────────────────────────────────────────────────────────

export type EvolutionConfig = {
  populationSize: number;
  /** Top-N survivors selected each generation. Minimum 1. */
  survivorCount: number;
  /**
   * Activity gate: a bot's total tradeCount across all windows must be >=
   * minTrades to pass. Default 1 (any trade). Use tradeCount (not
   * closedTradeCount) so Buy & Hold is not unfairly penalised.
   */
  minTrades: number;
  fitnessWeights: {
    /** Multiplier on meanWindowReturn (reward). */
    return: number;
    /** Multiplier on worstWindowDrawdown (penalty). */
    drawdown: number;
    /** Multiplier on returnStdDev (penalty). */
    inconsistency: number;
  };
  /**
   * mutationRate assigned to initial population specs. Children inherit the
   * parent's mutationRate via mutateSpec; this field is not consumed by
   * advanceGeneration itself.
   */
  mutationRate: number;
};

// ─── Dataset Manifest ─────────────────────────────────────────────────────────

export type DatasetManifest = {
  symbol: string;
  fromDate: string;
  toDate: string;
  windowCount: number;
  windowLengthDays: number;
};

// ─── Evolution Run State ──────────────────────────────────────────────────────
//
// Complete, self-contained snapshot of an evolution run. Persisting this is
// sufficient to resume — no other state is required.

export type EvolutionRunState = {
  /** Stable identifier for this run across all generations. */
  runId: string;
  /** Current generation index. 0 = initial population (before any advance). */
  generation: number;
  activePop: EvolvableBotSpec[];
  archive: ArchivedBotRecord[];
  /** Best-fitness bot seen per archetype across all generations, keyed by archetype. */
  championHistory: Record<string, ChampionRecord>;
  config: EvolutionConfig;
  /** Base seed for this run. Per-generation child seeds are derived from this. */
  seed: number;
  datasetManifest: DatasetManifest;
  /** ISO 8601 — set once when the run is created. */
  createdAt: string;
  /** ISO 8601 — updated to advancedAt each time advanceGeneration() is called. */
  updatedAt: string;
};
