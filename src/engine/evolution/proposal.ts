/**
 * M14 Slice 4B/4C — Generation advance proposal.
 *
 * computeAdvanceProposal() runs the same scoring → selection → reproduction
 * logic as advanceGeneration(), but returns a pure value (GenerationAdvanceProposal)
 * without writing any state. The proposal is presented to the user for review;
 * when they approve, commitProposal() (commit.ts) is called to materialise it.
 *
 * Slice 4C adds human override support:
 *   - pinnedIds   — force specific scored bots into survivors regardless of rank
 *   - vetoedIds   — exclude specific scored bots from survivor selection
 *   - rerollCounts — per-slot reroll counters; each increment produces a distinct
 *                    deterministic mutation of the same parent (XOR-mixes the seed)
 *
 * Determinism invariant (tested):
 *   computeAdvanceProposal(state, season, T).proposedPop[i].child
 *   matches advanceGeneration(state, season, T).activePop[i] exactly
 *   when no overrides are applied.
 *
 * Pin semantics:
 *   Pinning adds a bot to survivors *in addition to* the normal top-N selection.
 *   The normal selection is not reduced — e.g. pinning a rank-#4 bot with
 *   survivorCount=2 yields [#1, #2, #4-pinned] = 3 survivors.
 *
 * Veto semantics:
 *   Vetoed bots are excluded from the eligible pool before ranking. They appear
 *   in `retired` with retirementReason="vetoed". Veto takes priority over pin
 *   (a bot in both sets is treated as vetoed).
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
import { planReproduction, compareScored } from "./selection.ts";
import { ARCHETYPE_BOUNDS } from "./bounds.ts";
import {
  InsufficientWindowsError,
  NoEligibleSurvivorsError,
  PopulationSizeMismatchError,
  UnknownArchetypeError,
  InvalidChildSpecError,
  deriveChildSeed,
} from "./lifecycle.ts";
import type {
  EvolutionRunState,
  EvolutionSeasonResult,
  BotFitnessRecord,
  EvolvableBotSpec,
} from "./types.ts";

// ─── Override types ───────────────────────────────────────────────────────────

/**
 * Human overrides applied to the selection and reproduction steps.
 * All fields are optional; omitting a field means no override for that category.
 *
 * Pin/veto are mutually exclusive for a given bot — veto takes priority if
 * a bot appears in both sets.
 */
export interface AdvanceOverrides {
  /**
   * Bot IDs forced into survivors regardless of fitness rank.
   * Only scored (non-gate-failed) bots can be effectively pinned.
   * Pinning adds to the normal top-N pool — it does not displace ranked survivors.
   */
  pinnedIds?: ReadonlySet<string>;
  /**
   * Bot IDs excluded from the eligible pool for selection.
   * Vetoed bots are retired with retirementReason:"vetoed".
   * Takes priority over pinnedIds.
   */
  vetoedIds?: ReadonlySet<string>;
  /**
   * Per-slot reroll counts. Key = 0-based slot index in proposedPop; value ≥ 1.
   * Each count produces a distinct deterministic mutation of the same parent.
   * Cleared when pin/veto overrides change (slot positions may shift).
   */
  rerollCounts?: ReadonlyMap<number, number>;
  /**
   * User-supplied reasons for pin overrides, keyed by bot ID.
   * Propagated to SurvivorDecision.userReason and archived in overrideNotes.
   */
  pinReasons?: ReadonlyMap<string, string>;
  /**
   * User-supplied reasons for veto overrides, keyed by bot ID.
   * Propagated to RetirementDecision.userReason and archived in overrideNotes.
   */
  vetoReasons?: ReadonlyMap<string, string>;
}

// ─── Proposal types ───────────────────────────────────────────────────────────

/**
 * A surviving bot, annotated with its fitness rank among eligible (scored,
 * non-vetoed) bots.
 */
export interface SurvivorDecision {
  spec: EvolvableBotSpec;
  fitnessScore: number;
  /** 1-based rank among eligible (scored, non-vetoed) bots, sorted by fitness descending. */
  rank: number;
  /** Total number of eligible (scored, non-vetoed) bots in this generation. */
  eligibleCount: number;
  /** True when this bot was forced into survivors via a pin override. */
  pinned?: true;
  /** User-supplied reason for the pin override, if any. Archived in overrideNotes. */
  userReason?: string;
}

/**
 * A retired bot, annotated with the reason for retirement.
 */
export interface RetirementDecision {
  spec: EvolvableBotSpec;
  retirementReason: "non-survivor" | "gate-failure" | "vetoed";
  /** Present when retirementReason === "non-survivor" or "vetoed" */
  fitnessScore?: number;
  /** 1-based rank; present when retirementReason === "non-survivor" */
  rank?: number;
  /** Total eligible bots; present when retirementReason === "non-survivor" */
  eligibleCount?: number;
  /** Present when retirementReason === "gate-failure" */
  gateFailureReason?: "activity" | "survival";
  /** User-supplied reason for the veto override, if any. Archived in overrideNotes. */
  userReason?: string;
}

/**
 * A proposed next-generation child, paired with the parent it was mutated from.
 */
export interface ProposedChild {
  child: EvolvableBotSpec;
  /** The surviving parent this child was mutated from. */
  parent: EvolvableBotSpec;
  /** The reroll count used to produce this child. 0 = default seed; ≥1 = rerolled. */
  rerollCount: number;
}

/**
 * A deterministic preview of what the next generation will look like.
 *
 * This value is computed before any state is written. The user reviews it
 * (and may adjust overrides), then either commits (via commitProposal()) or
 * cancels (proposal is discarded, run state unchanged).
 */
export interface GenerationAdvanceProposal {
  fromGeneration: number;
  toGeneration: number;
  /** Fitness records for every bot in the current active population. */
  fitnessRecords: BotFitnessRecord[];
  /** Bots selected to reproduce — will be archived as "reproduced". */
  survivors: SurvivorDecision[];
  /** Bots not selected — will be archived according to their retirementReason. */
  retired: RetirementDecision[];
  /** The proposed next-generation active population, in reproduction order. */
  proposedPop: ProposedChild[];
  /**
   * ISO timestamp used to derive child specs (passed as createdAt to mutateSpec).
   * Locked when the season runs; passed unchanged to commitProposal() when committing.
   */
  advancedAt: string;
  /** The overrides that produced this proposal. Always defined (empty when no overrides). */
  overrides: AdvanceOverrides;
}

// ─── computeAdvanceProposal ───────────────────────────────────────────────────

/**
 * Compute a GenerationAdvanceProposal — a complete, annotated preview of the
 * next generation — without writing any state.
 *
 * Calling commitProposal(state, proposal) after this function materialises the
 * proposal into a new EvolutionRunState.
 *
 * @param state        - Current run state. Never mutated.
 * @param seasonResult - Completed season results for the current active population.
 * @param advancedAt   - ISO 8601 timestamp. Lock this before calling; pass the
 *                       same value to commitProposal() when committing.
 * @param overrides    - Optional human overrides (pin/veto/reroll). Defaults to
 *                       empty (no overrides) when omitted.
 * @throws All the same errors as advanceGeneration() — see lifecycle.ts.
 */
export function computeAdvanceProposal(
  state: EvolutionRunState,
  seasonResult: EvolutionSeasonResult,
  advancedAt: string,
  overrides: AdvanceOverrides = {},
): GenerationAdvanceProposal {
  const { config, activePop, seed, generation } = state;
  const nextGeneration = generation + 1;

  const pinnedIds = overrides.pinnedIds ?? new Set<string>();
  const vetoedIds = overrides.vetoedIds ?? new Set<string>();
  const rerollCounts = overrides.rerollCounts ?? new Map<number, number>();
  const pinReasons = overrides.pinReasons ?? new Map<string, string>();
  const vetoReasons = overrides.vetoReasons ?? new Map<string, string>();

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

  // ── 2. Apply overrides and select survivors ───────────────────────────────
  // Eligible = scored (not gate-failed) AND not vetoed. Sorted by compareScored.
  const eligible = fitnessRecords
    .filter((r) => r.fitness.kind === "scored" && !vetoedIds.has(r.spec.id))
    .sort(compareScored);
  const eligibleCount = eligible.length;

  // Standard selection: top-N from the full eligible pool (pin status is
  // irrelevant here — pinning adds extra survivors, it does not displace ranked ones).
  const standardSelected = eligible.slice(0, config.survivorCount);
  const standardSelectedIds = new Set(standardSelected.map((r) => r.spec.id));

  // Extra pinned: eligible bots with a pin override that aren't already in the top-N.
  const extraPinned = eligible.filter(
    (r) => pinnedIds.has(r.spec.id) && !standardSelectedIds.has(r.spec.id),
  );

  const survivorRecords = [...standardSelected, ...extraPinned];

  if (survivorRecords.length === 0) {
    const gateFailureCount = fitnessRecords.filter((r) => r.fitness.kind === "gate-failure").length;
    throw new NoEligibleSurvivorsError(generation, gateFailureCount, fitnessRecords.length);
  }

  // ── 3. Build annotated survivor/retirement decisions ──────────────────────
  const survivorIds = new Set(survivorRecords.map((r) => r.spec.id));

  const survivors: SurvivorDecision[] = [
    // Standard survivors (in rank order among eligible).
    // Carry pinned:true even here — a pinned bot that made it through normal
    // selection (e.g. because vetoes cleared the field) still reflects the intent.
    ...standardSelected.map((r) => ({
      spec: r.spec,
      fitnessScore: r.fitness.kind === "scored" ? r.fitness.fitnessScore : 0,
      rank: eligible.findIndex((e) => e.spec.id === r.spec.id) + 1,
      eligibleCount,
      ...(pinnedIds.has(r.spec.id) ? { pinned: true as const } : {}),
      ...(pinReasons.has(r.spec.id) ? { userReason: pinReasons.get(r.spec.id) } : {}),
    })),
    // Extra pinned survivors (in rank order, appended after standard survivors).
    ...extraPinned.map((r) => ({
      spec: r.spec,
      fitnessScore: r.fitness.kind === "scored" ? r.fitness.fitnessScore : 0,
      rank: eligible.findIndex((e) => e.spec.id === r.spec.id) + 1,
      eligibleCount,
      pinned: true as const,
      ...(pinReasons.has(r.spec.id) ? { userReason: pinReasons.get(r.spec.id) } : {}),
    })),
  ];

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
      if (vetoedIds.has(r.spec.id)) {
        return {
          spec: r.spec,
          retirementReason: "vetoed" as const,
          fitnessScore: r.fitness.fitnessScore,
          // rank omitted — vetoed bots are outside the eligible ranking pool
          ...(vetoReasons.has(r.spec.id) ? { userReason: vetoReasons.get(r.spec.id) } : {}),
        };
      }
      // Non-survivor: ranked but below the survivorCount threshold
      const rank = eligible.findIndex((e) => e.spec.id === r.spec.id) + 1;
      return {
        spec: r.spec,
        retirementReason: "non-survivor" as const,
        fitnessScore: r.fitness.fitnessScore,
        rank,
        eligibleCount,
      };
    });

  // ── 4. Plan and execute reproduction ─────────────────────────────────────
  const reproductionPlan = planReproduction(survivorRecords, config.populationSize);

  const proposedPop: ProposedChild[] = reproductionPlan.map(({ parent, ordinal }, slotIndex) => {
    if (!(parent.archetype in ARCHETYPE_BOUNDS)) {
      throw new UnknownArchetypeError(parent.archetype);
    }
    const bounds = ARCHETYPE_BOUNDS[parent.archetype];

    const baseChildSeed = deriveChildSeed(seed, nextGeneration, parent.id, ordinal);
    const rerollCount = rerollCounts.get(slotIndex) ?? 0;
    // XOR-mix the base seed with a hash of the reroll count for a distinct,
    // stable seed each reroll. rerollCount=0 is a no-op (XOR with 0 is identity).
    const effectiveSeed = rerollCount > 0
      ? ((baseChildSeed ^ (rerollCount * 0x9e3779b9)) >>> 0)
      : baseChildSeed;

    const child = mutateSpec(parent, effectiveSeed, bounds, advancedAt);

    const validation = validateEvolvableSpec(child, bounds);
    if (!validation.valid) {
      throw new InvalidChildSpecError(child.id, parent.id, validation.errors);
    }

    // Stamp reroll count in child's metadata.notes so the lineage carries the
    // evidence even after this proposal object is discarded.
    const childWithNotes = rerollCount > 0
      ? { ...child, metadata: { ...child.metadata, notes: `reroll:${rerollCount}` } }
      : child;

    return { child: childWithNotes, parent, rerollCount };
  });

  return {
    fromGeneration: generation,
    toGeneration: nextGeneration,
    fitnessRecords,
    survivors,
    retired,
    proposedPop,
    advancedAt,
    overrides,
  };
}
