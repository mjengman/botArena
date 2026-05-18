/**
 * M14 Slice 4B — Generation advance proposal.
 *
 * computeAdvanceProposal() runs the same scoring → selection → reproduction
 * logic as advanceGeneration(), but returns a pure value (GenerationAdvanceProposal)
 * without writing any state. The proposal is presented to the user for review;
 * when they approve, advanceGeneration() is called with proposal.advancedAt to
 * produce the identical committed state.
 *
 * Determinism invariant (tested):
 *   computeAdvanceProposal(state, season, T).proposedPop[i].child
 *   matches advanceGeneration(state, season, T).activePop[i] exactly.
 *
 * Error contract:
 *   Throws the same errors as advanceGeneration() — InvalidEvolutionConfigError,
 *   PopulationSizeMismatchError, InsufficientWindowsError, InvalidSeasonDataError,
 *   NoEligibleSurvivorsError, UnknownArchetypeError, InvalidChildSpecError.
 *   The caller may handle NoEligibleSurvivorsError gracefully (show season results
 *   with no proposal); other errors propagate as hard failures.
 */

import { mutateSpec } from "./mutate.ts";
import { validateEvolvableSpec } from "./validate.ts";
import { validateEvolutionConfig } from "./config.ts";
import { scorePopulation, MIN_EVOLUTION_WINDOWS } from "./fitness.ts";
import { selectSurvivors, planReproduction } from "./selection.ts";
import { ARCHETYPE_BOUNDS } from "./bounds.ts";
import {
  InsufficientWindowsError,
  NoEligibleSurvivorsError,
  PopulationSizeMismatchError,
  UnknownArchetypeError,
  InvalidChildSpecError,
} from "./lifecycle.ts";
import type {
  EvolutionRunState,
  EvolutionSeasonResult,
  BotFitnessRecord,
  EvolvableBotSpec,
} from "./types.ts";

// ─── Types ────────────────────────────────────────────────────────────────────

/**
 * A surviving bot, annotated with its fitness rank among eligible (scored) bots.
 */
export interface SurvivorDecision {
  spec: EvolvableBotSpec;
  fitnessScore: number;
  /** 1-based rank among all eligible (scored) bots, sorted by fitness descending. */
  rank: number;
  /** Total number of eligible (scored) bots in this generation. */
  eligibleCount: number;
}

/**
 * A retired bot, annotated with the reason for retirement.
 */
export interface RetirementDecision {
  spec: EvolvableBotSpec;
  retirementReason: "non-survivor" | "gate-failure";
  /** Present when retirementReason === "non-survivor" */
  fitnessScore?: number;
  /** 1-based rank; present when retirementReason === "non-survivor" */
  rank?: number;
  /** Total eligible bots; present when retirementReason === "non-survivor" */
  eligibleCount?: number;
  /** Present when retirementReason === "gate-failure" */
  gateFailureReason?: "activity" | "survival";
}

/**
 * A proposed next-generation child, paired with the parent it was mutated from.
 */
export interface ProposedChild {
  child: EvolvableBotSpec;
  /** The surviving parent this child was mutated from. */
  parent: EvolvableBotSpec;
}

/**
 * A deterministic preview of what advanceGeneration() will produce.
 *
 * This value is computed before any state is written. The user reviews it and
 * then either commits (by calling advanceGeneration() with proposal.advancedAt)
 * or cancels (proposal is discarded, run state unchanged).
 */
export interface GenerationAdvanceProposal {
  fromGeneration: number;
  toGeneration: number;
  /** Fitness records for every bot in the current active population. */
  fitnessRecords: BotFitnessRecord[];
  /** Bots selected to reproduce — will be archived as "reproduced". */
  survivors: SurvivorDecision[];
  /** Bots not selected — will be archived as "non-survivor" or "gate-failure". */
  retired: RetirementDecision[];
  /** The proposed next-generation active population, in reproduction order. */
  proposedPop: ProposedChild[];
  /**
   * ISO timestamp used to derive child specs (passed as createdAt to mutateSpec).
   * MUST be passed unchanged as the advancedAt argument when committing via
   * advanceGeneration() to guarantee the child specs match the preview exactly.
   */
  advancedAt: string;
}

// ─── Seed derivation (mirrors lifecycle.ts) ───────────────────────────────────

// Same djb2-style mixing as lifecycle.ts — must stay in sync.
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

// ─── computeAdvanceProposal ───────────────────────────────────────────────────

/**
 * Compute a GenerationAdvanceProposal — a complete, annotated preview of what
 * advanceGeneration() will produce — without writing any state.
 *
 * Calling advanceGeneration(state, seasonResult, proposal.advancedAt) after
 * this function produces child specs identical to proposal.proposedPop.
 *
 * @param state        - Current run state. Never mutated.
 * @param seasonResult - Completed season results for the current active population.
 * @param advancedAt   - ISO 8601 timestamp. Lock this before calling; pass the
 *                       same value to advanceGeneration() when committing.
 * @throws All the same errors as advanceGeneration() — see lifecycle.ts.
 */
export function computeAdvanceProposal(
  state: EvolutionRunState,
  seasonResult: EvolutionSeasonResult,
  advancedAt: string,
): GenerationAdvanceProposal {
  const { config, activePop, seed, generation } = state;
  const nextGeneration = generation + 1;

  // ── 0. Pre-flight validation ──────────────────────────────────────────────
  validateEvolutionConfig(config);

  if (activePop.length !== config.populationSize) {
    throw new PopulationSizeMismatchError(activePop.length, config.populationSize);
  }

  if (seasonResult.windows.length < MIN_EVOLUTION_WINDOWS) {
    throw new InsufficientWindowsError(seasonResult.windows.length);
  }

  // ── 1. Score ──────────────────────────────────────────────────────────────
  const fitnessRecords: BotFitnessRecord[] = scorePopulation(activePop, seasonResult, config);

  // ── 2. Select survivors ───────────────────────────────────────────────────
  const survivorRecords = selectSurvivors(fitnessRecords, config);

  if (survivorRecords.length === 0) {
    const gateFailureCount = fitnessRecords.filter((r) => r.fitness.kind === "gate-failure").length;
    throw new NoEligibleSurvivorsError(generation, gateFailureCount, fitnessRecords.length);
  }

  // ── 3. Build annotated survivor/retirement decisions ──────────────────────
  // Eligible bots = scored bots, sorted by fitness descending (same order as selectSurvivors)
  const eligible = fitnessRecords
    .filter((r) => r.fitness.kind === "scored")
    .sort((a, b) => {
      const aScore = a.fitness.kind === "scored" ? a.fitness.fitnessScore : -Infinity;
      const bScore = b.fitness.kind === "scored" ? b.fitness.fitnessScore : -Infinity;
      return bScore - aScore;
    });
  const eligibleCount = eligible.length;
  const survivorIds = new Set(survivorRecords.map((r) => r.spec.id));

  const survivors: SurvivorDecision[] = eligible
    .filter((r) => survivorIds.has(r.spec.id))
    .map((r, i) => ({
      spec: r.spec,
      fitnessScore: r.fitness.kind === "scored" ? r.fitness.fitnessScore : 0,
      rank: i + 1,
      eligibleCount,
    }));

  const retired: RetirementDecision[] = fitnessRecords
    .filter((r) => !survivorIds.has(r.spec.id))
    .map((r) => {
      if (r.fitness.kind === "gate-failure") {
        return {
          spec: r.spec,
          retirementReason: "gate-failure" as const,
          gateFailureReason: r.fitness.gateFailureReason,
        };
      }
      // Non-survivor: find rank in the eligible list
      const rank = eligible.findIndex((e) => e.spec.id === r.spec.id) + 1;
      return {
        spec: r.spec,
        retirementReason: "non-survivor" as const,
        fitnessScore: r.fitness.fitnessScore,
        rank,
        eligibleCount,
      };
    });

  // ── 4. Plan and execute reproduction (read-only) ──────────────────────────
  const reproductionPlan = planReproduction(survivorRecords, config.populationSize);

  const proposedPop: ProposedChild[] = reproductionPlan.map(({ parent, ordinal }) => {
    if (!(parent.archetype in ARCHETYPE_BOUNDS)) {
      throw new UnknownArchetypeError(parent.archetype);
    }
    const bounds = ARCHETYPE_BOUNDS[parent.archetype];
    const childSeed = deriveChildSeed(seed, nextGeneration, parent.id, ordinal);
    const child = mutateSpec(parent, childSeed, bounds, advancedAt);

    const validation = validateEvolvableSpec(child, bounds);
    if (!validation.valid) {
      throw new InvalidChildSpecError(child.id, parent.id, validation.errors);
    }

    return { child, parent };
  });

  return {
    fromGeneration: generation,
    toGeneration: nextGeneration,
    fitnessRecords,
    survivors,
    retired,
    proposedPop,
    advancedAt,
  };
}
