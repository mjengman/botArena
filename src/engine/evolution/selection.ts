/**
 * Survivor selection and reproduction planning for M14 Slice 2.
 *
 * selectSurvivors():
 *   - Filters out gate-failure bots before ranking; they never consume survivor slots.
 *   - Sorts eligible bots by fitnessScore descending.
 *   - Tiebreaker: ascending bot id (lexicographic) — deterministic, never wall-clock.
 *   - Returns the top-N where N = config.survivorCount.
 *     If fewer than survivorCount bots are eligible, all eligible bots are returned.
 *
 * planReproduction():
 *   - Distributes exactly totalPop children among S survivors.
 *   - Base allocation: q = floor(totalPop / S) children per survivor.
 *   - Remainder: top-r survivors (by rank) each get one extra child
 *     where r = totalPop % S.
 *   - Children are ordered: all children of rank-0 survivor first, then rank-1, etc.
 *   - `ordinal` is a 0-based global index used by lifecycle.ts for child seed derivation.
 */

import type { BotFitnessRecord, EvolutionConfig, EvolvableBotSpec } from "./types.ts";

// ─── Internal comparator ──────────────────────────────────────────────────────

/**
 * Sort two scored BotFitnessRecords for survivor ranking.
 * Both inputs are guaranteed to have kind:"scored" (gate failures are pre-filtered).
 * Primary: fitnessScore descending. Tiebreak: bot id ascending (lexicographic).
 *
 * Exported so that callers that annotate ranks (e.g. proposal.ts) produce rankings
 * identical to the selection order — including tied-score cases.
 */
export function compareScored(a: BotFitnessRecord, b: BotFitnessRecord): number {
  const aScore = (a.fitness as Extract<typeof a.fitness, { kind: "scored" }>).fitnessScore;
  const bScore = (b.fitness as Extract<typeof b.fitness, { kind: "scored" }>).fitnessScore;
  if (bScore !== aScore) return bScore - aScore;
  return a.spec.id < b.spec.id ? -1 : a.spec.id > b.spec.id ? 1 : 0;
}

// ─── Public API ───────────────────────────────────────────────────────────────

/**
 * Select the top-N survivors from a scored population.
 *
 * Gate failures are excluded before ranking and never consume survivor slots.
 * Returns survivors sorted by fitness descending (index 0 = best fitness).
 * May return fewer than survivorCount if fewer bots are eligible.
 */
export function selectSurvivors(
  records: BotFitnessRecord[],
  config: EvolutionConfig,
): BotFitnessRecord[] {
  const eligible = records.filter((r) => r.fitness.kind === "scored");
  eligible.sort(compareScored);
  return eligible.slice(0, config.survivorCount);
}

// ─── Reproduction plan ────────────────────────────────────────────────────────

export type ReproductionEntry = {
  parent: EvolvableBotSpec;
  /**
   * 0-based global index across all children in this generation.
   * Used by lifecycle.ts to derive a deterministic, unique per-child seed.
   */
  ordinal: number;
};

/**
 * Plan how many children each survivor produces so the next generation
 * has exactly `totalPop` bots.
 *
 * Children are ordered: all children of survivors[0] first, then survivors[1], etc.
 * The top-r survivors get one extra child when totalPop % S ≠ 0.
 * Returns an empty array if survivors is empty (caller should throw before reaching here).
 */
export function planReproduction(
  survivors: BotFitnessRecord[],
  totalPop: number,
): ReproductionEntry[] {
  const S = survivors.length;
  if (S === 0) return [];

  const q = Math.floor(totalPop / S);
  const r = totalPop % S;
  const entries: ReproductionEntry[] = [];

  for (let i = 0; i < S; i++) {
    const childCount = q + (i < r ? 1 : 0);
    for (let j = 0; j < childCount; j++) {
      entries.push({ parent: survivors[i].spec, ordinal: entries.length });
    }
  }

  return entries;
}
