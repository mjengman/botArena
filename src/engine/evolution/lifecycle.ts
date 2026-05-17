/**
 * Generation lifecycle for M14 Slice 2.
 *
 * advanceGeneration() is the single public entry point. Given the current
 * EvolutionRunState and a completed season result, it:
 *
 *   0. Validates config (InvalidEvolutionConfigError) and window count
 *      (InsufficientWindowsError) before any computation. Fails fast.
 *   1. Scores the active population (fitness.ts — throws on incomplete data).
 *   2. Selects survivors (selection.ts).
 *   3. Throws NoEligibleSurvivorsError if no bot passes the gates — state
 *      is left UNCHANGED so the caller can handle recovery.
 *   4. Archives ALL current bots:
 *        survivors   → "reproduced"   (produced children; no longer active)
 *        non-survivors → "non-survivor"
 *        gate failures → "gate-failure"
 *   5. Produces next-generation children via mutateSpec with deterministic
 *      seeds. Each child is validated before being admitted to nextActivePop.
 *      Throws InvalidChildSpecError if validation fails, UnknownArchetypeError
 *      if a parent's archetype is not in ARCHETYPE_BOUNDS.
 *   6. Updates champion history (best-fitness bot per archetype, all-time).
 *   7. Returns a new EvolutionRunState; the input state is never mutated.
 *
 * Determinism contract:
 *   `advancedAt` is REQUIRED — no internal Date.now() calls.
 *   Same (state, seasonResult, advancedAt) → identical output every time.
 *
 * Child seed derivation:
 *   childSeed = djb2hash(runSeed, nextGeneration, parentId, childOrdinal)
 */

import { mutateSpec } from "./mutate.ts";
import { validateEvolvableSpec } from "./validate.ts";
import { validateEvolutionConfig } from "./config.ts";
import { scorePopulation, MIN_EVOLUTION_WINDOWS, InsufficientWindowsError } from "./fitness.ts";
import { selectSurvivors, planReproduction } from "./selection.ts";
import { ARCHETYPE_BOUNDS } from "./bounds.ts";
import type {
  EvolutionRunState,
  EvolutionSeasonResult,
  ArchivedBotRecord,
  BotFitnessRecord,
  ChampionRecord,
} from "./types.ts";

// ─── Re-exports (owned by fitness.ts; re-exported here for convenience) ───────
export { MIN_EVOLUTION_WINDOWS, InsufficientWindowsError };

// ─── Errors ───────────────────────────────────────────────────────────────────

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

/**
 * Thrown when a parent bot's archetype is not found in ARCHETYPE_BOUNDS.
 * Unknown archetypes cannot be mutated safely — treating them as no-op clones
 * would silently produce invalid children.
 */
export class UnknownArchetypeError extends Error {
  readonly archetype: string;

  constructor(archetype: string) {
    super(
      `Unknown archetype "${archetype}": not found in ARCHETYPE_BOUNDS. ` +
      `Register the archetype's bounds before using it in an evolution run.`,
    );
    this.name = "UnknownArchetypeError";
    this.archetype = archetype;
  }
}

/**
 * Thrown when state.activePop.length does not match config.populationSize.
 * This indicates a corrupted run state or a config modified after the run was
 * created. planReproduction() would silently resize the population without this
 * guard — an explicit error is safer.
 */
export class PopulationSizeMismatchError extends Error {
  readonly actualSize: number;
  readonly configuredSize: number;

  constructor(actualSize: number, configuredSize: number) {
    super(
      `Active population size (${actualSize}) does not match config.populationSize ` +
      `(${configuredSize}). The run state may be corrupted or the config was ` +
      `modified after the run was created.`,
    );
    this.name = "PopulationSizeMismatchError";
    this.actualSize = actualSize;
    this.configuredSize = configuredSize;
  }
}

/**
 * Thrown when a child spec produced by mutateSpec() fails validateEvolvableSpec().
 * This indicates a bug in the mutation engine or bounds configuration, since
 * mutateSpec is designed to always produce valid specs within declared bounds.
 */
export class InvalidChildSpecError extends Error {
  readonly childId: string;
  readonly parentId: string;
  readonly validationErrors: string[];

  constructor(childId: string, parentId: string, errors: string[]) {
    super(
      `Child spec "${childId}" (from parent "${parentId}") failed validation:\n` +
      errors.map((e) => `  ${e}`).join("\n"),
    );
    this.name = "InvalidChildSpecError";
    this.childId = childId;
    this.parentId = parentId;
    this.validationErrors = errors;
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
 * @throws InvalidEvolutionConfigError    if state.config has invalid values.
 * @throws PopulationSizeMismatchError    if state.activePop.length ≠ config.populationSize.
 * @throws InsufficientWindowsError       if seasonResult has < MIN_EVOLUTION_WINDOWS windows.
 * @throws InvalidSeasonDataError         if any bot is missing from a window or
 *                                        a snapshot has non-finite metrics.
 * @throws NoEligibleSurvivorsError       if no bot passes the fitness gates.
 *                                        Input state is left unchanged.
 * @throws UnknownArchetypeError          if a parent's archetype is not in ARCHETYPE_BOUNDS.
 * @throws InvalidChildSpecError          if a child spec fails validateEvolvableSpec().
 */
export function advanceGeneration(
  state: EvolutionRunState,
  seasonResult: EvolutionSeasonResult,
  advancedAt: string,
): EvolutionRunState {
  const { config, activePop, archive, championHistory, seed, generation } = state;
  const nextGeneration = generation + 1;

  // ── 0. Pre-flight checks ──────────────────────────────────────────────────
  validateEvolutionConfig(config);

  if (activePop.length !== config.populationSize) {
    throw new PopulationSizeMismatchError(activePop.length, config.populationSize);
  }

  // scorePopulation() also checks this, but failing fast here gives a cleaner
  // error message before we pay the cost of season completeness validation.
  if (seasonResult.windows.length < MIN_EVOLUTION_WINDOWS) {
    throw new InsufficientWindowsError(seasonResult.windows.length);
  }

  // ── 1. Score (also validates season completeness and metric values) ────────
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
    // Reject unknown archetypes rather than silently cloning with empty bounds.
    if (!(parent.archetype in ARCHETYPE_BOUNDS)) {
      throw new UnknownArchetypeError(parent.archetype);
    }
    const bounds = ARCHETYPE_BOUNDS[parent.archetype];

    const childSeed = deriveChildSeed(seed, nextGeneration, parent.id, ordinal);
    const child = mutateSpec(parent, childSeed, bounds, advancedAt);

    // Validate each child before admitting it to the next generation.
    const validation = validateEvolvableSpec(child, bounds);
    if (!validation.valid) {
      throw new InvalidChildSpecError(child.id, parent.id, validation.errors);
    }

    return child;
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
