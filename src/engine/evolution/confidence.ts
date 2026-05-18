/**
 * M14 Slice 4D — Confidence indicators and Evidence Ladder.
 *
 * Pure, stateless helpers that derive evidence-of-trustworthiness signals from
 * what the engine already tracks: lineage survival history, window counts, regime
 * exposure, and param mutation depth.
 *
 * None of these functions read or write EvolutionRunState. They are read-only
 * evidence aggregators — they never affect selection, mutation, or fitness scoring.
 *
 * Regime coverage note (M14 limitation):
 *   Regime labels are computed from price data at render time and are not stored
 *   in ArchivedBotRecord. For M14, regime coverage is computed from the current
 *   season's window labels only. Cross-generation regime accumulation is deferred
 *   to a future slice when labels are persisted alongside archive records.
 *
 * Evidence Ladder tiers (M14 achievable subset):
 *   hatchling          — lineage never survived an advance (0 generations survived)
 *   arena-contender    — survived ≥ 1 advance
 *   backtest-champion  — survived ≥ 3 advances
 *   regime-specialist  — survived ≥ 3 advances AND ≥ 2 distinct regime types in season
 *
 * Deferred tiers (shown locked in UI, not achievable in M14):
 *   paper-candidate, paper-active, live-eligible, live-active
 *
 * Determinism guarantee: for any fixed (spec, archive, windowCount, regimeLabels),
 * computeConfidenceIndicators() returns the same value. No timestamps, random
 * numbers, or external state are consumed.
 */

import type { EvolvableBotSpec, ArchivedBotRecord } from "./types.ts";
import type { RegimeLabel } from "./regime.ts";
import { ARCHETYPE_BOUNDS } from "./bounds.ts";

// ─── Regime Coverage ──────────────────────────────────────────────────────────

/**
 * Count of season windows belonging to each regime type.
 * Only covers the current season in M14; cross-season accumulation is deferred.
 */
export type RegimeCoverage = {
  uptrend: number;
  sideways: number;
  downtrend: number;
};

/**
 * Count how many season windows belong to each regime type.
 * Pure function — fully determined by the input array.
 */
export function computeRegimeCoverage(regimeLabels: RegimeLabel[]): RegimeCoverage {
  let uptrend = 0;
  let sideways = 0;
  let downtrend = 0;
  for (const label of regimeLabels) {
    if (label === "Uptrend") uptrend++;
    else if (label === "Sideways") sideways++;
    else if (label === "Downtrend") downtrend++;
  }
  return { uptrend, sideways, downtrend };
}

// ─── Confidence Indicators ────────────────────────────────────────────────────

/**
 * Evidence-of-trustworthiness signals derived from a bot's lineage history.
 * Read-only — never affects selection, mutation, or fitness scoring.
 */
export type ConfidenceIndicators = {
  /**
   * Generations elapsed since the founding ancestor of this lineage.
   * 0 = this spec is the founding member (no older lineage records in archive).
   */
  lineageAge: number;
  /**
   * Times any member of this lineage has been archived with retirementReason
   * "reproduced" — i.e. how many generation advances the lineage has survived.
   */
  generationsSurvived: number;
  /**
   * Total season windows in which this lineage was evaluated:
   * sum of all historical archive window counts + current season window count.
   * Gate-failure windows are included — the data was gathered even if the gate failed.
   */
  windowsEvaluated: number;
  /**
   * Times any member of this lineage was retired due to gate-failure.
   * High counts here suggest a fragile strategy that often fails survival or
   * activity gates — even if survivors occasionally score well.
   */
  gateFailureCount: number;
  /**
   * Counts of each regime type seen in the current season's windows.
   * Null when no regime labels are provided (historical labels not yet stored).
   */
  regimeCoverage: RegimeCoverage | null;
  /**
   * Fraction of mutable params unchanged from parent to this bot [0, 1].
   * 1.0 = perfect clone (no mutation). 0.0 = every mutable param changed.
   * Null when the archetype has no declared mutable params or is unknown.
   */
  paramStabilityRate: number | null;
};

// ─── Evidence Ladder ──────────────────────────────────────────────────────────

/** All eight Evidence Ladder tiers, in display-order progression. */
export type EvidenceTier =
  | "hatchling"
  | "arena-contender"
  | "backtest-champion"
  | "paper-candidate"   // deferred in M14
  | "paper-active"      // deferred in M14
  | "regime-specialist"
  | "live-eligible"     // deferred in M14
  | "live-active";      // deferred in M14

/** Tiers not achievable in M14. Shown locked in the Evidence Ladder UI. */
export const DEFERRED_TIERS: ReadonlySet<EvidenceTier> = new Set<EvidenceTier>([
  "paper-candidate",
  "paper-active",
  "live-eligible",
  "live-active",
]);

/** Canonical display order for the Evidence Ladder. */
export const EVIDENCE_TIER_ORDER: readonly EvidenceTier[] = [
  "hatchling",
  "arena-contender",
  "backtest-champion",
  "paper-candidate",
  "paper-active",
  "regime-specialist",
  "live-eligible",
  "live-active",
] as const;

// ─── Internal helpers ─────────────────────────────────────────────────────────

/**
 * Fraction of mutable params unchanged in this mutation [0, 1].
 * Returns null when the archetype is unknown or has no mutable params.
 * Returns 1.0 when mutationSummary is absent or empty (perfect clone).
 */
function computeParamStabilityRate(spec: EvolvableBotSpec): number | null {
  const bounds = ARCHETYPE_BOUNDS[spec.archetype];
  if (!bounds) return null;

  const mutableKeys = Object.entries(bounds)
    .filter(([, b]) => b.type === "number" || b.type === "boolean")
    .map(([k]) => k);

  if (mutableKeys.length === 0) return null;

  const summary = spec.metadata.mutationSummary;
  if (!summary || summary.trim() === "") return 1.0;

  const changedKeys = new Set(
    summary.split(",").map((k) => k.trim()).filter(Boolean),
  );
  const changedCount = mutableKeys.filter((k) => changedKeys.has(k)).length;
  return 1 - changedCount / mutableKeys.length;
}

// ─── Main entry points ────────────────────────────────────────────────────────

/**
 * Derive all confidence indicators for a bot spec from its lineage archive history.
 *
 * @param spec                     - The bot spec being evaluated (current active member).
 * @param archive                  - Full archive from EvolutionRunState. Never mutated.
 * @param currentSeasonWindowCount - Number of windows in the season just run.
 * @param regimeLabels             - Regime labels for the current season's windows.
 *                                   Pass undefined to omit regime coverage (returns null).
 * @returns                        ConfidenceIndicators — pure read-only data; never
 *                                 affects selection, mutation, or fitness scoring.
 */
export function computeConfidenceIndicators(
  spec: EvolvableBotSpec,
  archive: ArchivedBotRecord[],
  currentSeasonWindowCount: number,
  regimeLabels?: RegimeLabel[],
): ConfidenceIndicators {
  const { lineageId } = spec.metadata;

  // Filter archive to records belonging to this lineage
  const lineageRecords = archive.filter((r) => r.lineageId === lineageId);

  // lineageAge: generations elapsed since the founding ancestor
  const generationNumbers = lineageRecords.map((r) => r.generation);
  const foundingGeneration = generationNumbers.length > 0
    ? Math.min(...generationNumbers)
    : spec.generation;
  const lineageAge = spec.generation - foundingGeneration;

  // generationsSurvived: how many times this lineage reproduced
  const generationsSurvived = lineageRecords.filter(
    (r) => r.retirementReason === "reproduced",
  ).length;

  // windowsEvaluated: historical windows (from archive) + current season
  // Both "scored" and "gate-failure" records have windowMetricsSummary.
  const historicalWindows = lineageRecords.reduce(
    (sum, r) => sum + r.fitness.windowMetricsSummary.windowCount,
    0,
  );
  const windowsEvaluated = historicalWindows + currentSeasonWindowCount;

  // gateFailureCount: times this lineage hit a fitness gate
  const gateFailureCount = lineageRecords.filter(
    (r) => r.retirementReason === "gate-failure",
  ).length;

  // regimeCoverage: count regime types from current season
  const regimeCoverage = regimeLabels != null
    ? computeRegimeCoverage(regimeLabels)
    : null;

  // paramStabilityRate: fraction of mutable params unchanged from parent
  const paramStabilityRate = computeParamStabilityRate(spec);

  return {
    lineageAge,
    generationsSurvived,
    windowsEvaluated,
    gateFailureCount,
    regimeCoverage,
    paramStabilityRate,
  };
}

/**
 * Assign the highest Evidence Ladder tier achieved by a bot, given its indicators.
 *
 * Tier thresholds (M14):
 *   hatchling         — default (0 generations survived)
 *   arena-contender   — generationsSurvived ≥ 1
 *   backtest-champion — generationsSurvived ≥ 3
 *   regime-specialist — generationsSurvived ≥ 3 AND ≥ 2 distinct regime types seen
 *
 * Paper and live tiers are deferred; they are never returned by this function.
 * They appear in DEFERRED_TIERS and are shown locked in the UI ladder.
 */
export function computeEvidenceTier(indicators: ConfidenceIndicators): EvidenceTier {
  const { generationsSurvived, regimeCoverage } = indicators;

  // Regime specialist: sustained survival AND multi-regime exposure in this season
  if (generationsSurvived >= 3 && regimeCoverage !== null) {
    const distinctRegimes =
      (regimeCoverage.uptrend > 0 ? 1 : 0) +
      (regimeCoverage.sideways > 0 ? 1 : 0) +
      (regimeCoverage.downtrend > 0 ? 1 : 0);
    if (distinctRegimes >= 2) {
      return "regime-specialist";
    }
  }

  if (generationsSurvived >= 3) return "backtest-champion";
  if (generationsSurvived >= 1) return "arena-contender";
  return "hatchling";
}
