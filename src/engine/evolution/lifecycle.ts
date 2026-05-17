/**
 * Generation lifecycle for M14 Slice 2.
 *
 * advanceGeneration() is the single public entry point. Given the current
 * EvolutionRunState and a completed season result, it:
 *
 *   1. Scores the active population (fitness.ts).
 *   2. Selects survivors (selection.ts).
 *   3. Throws NoEligibleSurvivorsError if no bot passes the gates — state
 *      is left UNCHANGED so the caller can handle recovery (relax gates,
 *      resurrect an archived bot, reset the population).
 *   4. Archives ALL current bots:
 *        survivors → "reproduced"  (they produced children; are no longer active)
 *        non-survivors → "non-survivor"
 *        gate failures → "gate-failure"
 *   5. Produces next-generation children via mutateSpec with deterministic seeds.
 *   6. Updates champion history (best-fitness bot per archetype, all-time).
 *   7. Returns a new EvolutionRunState; the input state is never mutated.
 *
 * Determinism contract:
 *   `advancedAt` is REQUIRED — no internal Date.now() calls.
 *   Same (state, seasonResult, advancedAt) → identical output every time.
 *
 * Child seed derivation:
 *   childSeed = djb2hash(runSeed, nextGeneration, parentId, childOrdinal)
 *   Each child gets a unique seed regardless of how many siblings share the
 *   same parent, and different parents never produce the same seed for the
 *   same ordinal position.
 */

import { mutateSpec } from "./mutate.ts";
import { scorePopulation } from "./fitness.ts";
import { selectSurvivors, planReproduction } from "./selection.ts";
import { ARCHETYPE_BOUNDS } from "./bounds.ts";
import type {
  EvolutionRunState,
  EvolutionSeasonResult,
  ArchivedBotRecord,
  BotFitnessRecord,
  ChampionRecord,
} from "./types.ts";

// ─── Error ────────────────────────────────────────────────────────────────────

/**
 * Thrown by advanceGeneration() when no bot in the active population passes
 * the fitness gates and qualifies as a survivor.
 *
 * The run state is left UNCHANGED. Callers should offer the user options:
 *   - Relax the activity gate (lower minTrades)
 *   - Resurrect an archived bot into the next generation
 *   - Reset the population entirely
 */
export class NoEligibleSurvivorsError extends Error {
  readonly generation: number;
  readonly gateFailureCount: number;
  readonly totalBots: number;

  constructor(generation: number, gateFailureCount: number, totalBots: number) {
    super(
      `Evolution stalled at generation ${generation}: all ${totalBots} bot` +
      `${totalBots === 1 ? "" : "s"} failed fitness gates ` +
      `(${gateFailureCount} gate failure${gateFailureCount === 1 ? "" : "s"}, ` +
      `0 eligible survivors). ` +
      `Consider relaxing minTrades, reviewing dataset quality, or resetting the population.`,
    );
    this.name = "NoEligibleSurvivorsError";
    this.generation = generation;
    this.gateFailureCount = gateFailureCount;
    this.totalBots = totalBots;
  }
}

// ─── Child seed derivation ────────────────────────────────────────────────────

/**
 * Derive a deterministic uint32 seed for a specific child using djb2-style mixing.
 *
 * Inputs: run seed, next-generation index, parent bot ID, child ordinal.
 * Each unique (runSeed, generation, parentId, ordinal) tuple maps to a distinct
 * seed with overwhelming probability — even when one parent produces many children.
 */
function deriveChildSeed(
  runSeed: number,
  generation: number,
  parentId: string,
  childOrdinal: number,
): number {
  let h = 5381;
  h = ((h << 5) + h + (runSeed >>> 0)) >>> 0;
  h = ((h << 5) + h + (generation >>> 0)) >>> 0;
  for (let i = 0; i < parentId.length; i++) {
    h = ((h << 5) + h + parentId.charCodeAt(i)) >>> 0;
  }
  h = ((h << 5) + h + (childOrdinal >>> 0)) >>> 0;
  return h;
}

// ─── Archive helpers ──────────────────────────────────────────────────────────

function toArchivedRecord(
  record: BotFitnessRecord,
  retirementReason: ArchivedBotRecord["retirementReason"],
  retiredAtGeneration: number,
): ArchivedBotRecord {
  return {
    id: record.spec.id,
    name: record.spec.name,
    archetype: record.spec.archetype,
    params: record.spec.params,
    generation: record.spec.generation,
    parentIds: record.spec.parentIds,
    lineageId: record.spec.metadata.lineageId,
    fitness: record.fitness,
    retirementReason,
    retiredAtGeneration,
  };
}

// ─── Champion history update ──────────────────────────────────────────────────

function updateChampionHistory(
  currentHistory: Record<string, ChampionRecord>,
  records: BotFitnessRecord[],
): Record<string, ChampionRecord> {
  const updated: Record<string, ChampionRecord> = { ...currentHistory };

  for (const record of records) {
    if (record.fitness.kind !== "scored") continue;
    const { archetype } = record.spec;
    const { fitnessScore } = record.fitness;
    const current = updated[archetype];
    if (current === undefined || fitnessScore > current.fitnessScore) {
      updated[archetype] = {
        botId: record.spec.id,
        generation: record.spec.generation,
        fitnessScore,
        spec: record.spec,
      };
    }
  }

  return updated;
}

// ─── Main entry point ─────────────────────────────────────────────────────────

/**
 * Advance the evolution run by one generation.
 *
 * @param state        - Current run state. Never mutated.
 * @param seasonResult - Completed season results for the current active population.
 * @param advancedAt   - ISO 8601 timestamp (required; not defaulted). Passed
 *                       verbatim to mutateSpec as each child's createdAt.
 * @returns            A new EvolutionRunState for the next generation.
 * @throws NoEligibleSurvivorsError when no bot passes the fitness gates.
 *         The input state is left unchanged — the caller decides recovery.
 */
export function advanceGeneration(
  state: EvolutionRunState,
  seasonResult: EvolutionSeasonResult,
  advancedAt: string,
): EvolutionRunState {
  const { config, activePop, archive, championHistory, seed, generation } = state;
  const nextGeneration = generation + 1;

  // ── 1. Score ──────────────────────────────────────────────────────────────
  const records = scorePopulation(activePop, seasonResult, config);

  // ── 2. Select survivors ───────────────────────────────────────────────────
  const survivors = selectSurvivors(records, config);

  if (survivors.length === 0) {
    const gateFailureCount = records.filter((r) => r.fitness.kind === "gate-failure").length;
    throw new NoEligibleSurvivorsError(generation, gateFailureCount, records.length);
  }

  // ── 3. Archive current generation ────────────────────────────────────────
  // ALL bots leave the active population — survivors are archived as "reproduced".
  const survivorIds = new Set(survivors.map((r) => r.spec.id));
  const newArchiveEntries: ArchivedBotRecord[] = records.map((record) => {
    let reason: ArchivedBotRecord["retirementReason"];
    if (record.fitness.kind === "gate-failure") {
      reason = "gate-failure";
    } else if (survivorIds.has(record.spec.id)) {
      reason = "reproduced";
    } else {
      reason = "non-survivor";
    }
    return toArchivedRecord(record, reason, generation);
  });

  // ── 4. Reproduce ──────────────────────────────────────────────────────────
  const reproductionPlan = planReproduction(survivors, config.populationSize);

  const nextActivePop = reproductionPlan.map(({ parent, ordinal }) => {
    const childSeed = deriveChildSeed(seed, nextGeneration, parent.id, ordinal);
    const bounds = ARCHETYPE_BOUNDS[parent.archetype] ?? {};
    return mutateSpec(parent, childSeed, bounds, advancedAt);
  });

  // ── 5. Update champion history ────────────────────────────────────────────
  const nextChampionHistory = updateChampionHistory(championHistory, records);

  // ── 6. Return new state ───────────────────────────────────────────────────
  return {
    ...state,
    generation: nextGeneration,
    activePop: nextActivePop,
    archive: [...archive, ...newArchiveEntries],
    championHistory: nextChampionHistory,
    updatedAt: advancedAt,
  };
}
