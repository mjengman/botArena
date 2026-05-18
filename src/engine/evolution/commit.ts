/**
 * M14 Slice 4C — Commit an approved advance proposal.
 *
 * commitProposal() is the second step of the two-phase advance flow:
 *
 *   1. computeAdvanceProposal()  — score, select, reproduce (no state written)
 *   2. [user reviews; may apply pin/veto/reroll overrides and recompute]
 *   3. commitProposal()          — archive old generation, set new active pop
 *
 * Because the proposal already contains the approved proposedPop (children
 * computed with any overrides applied), commitProposal() never re-runs
 * selection or reproduction. It only archives the current generation and
 * assembles the new EvolutionRunState.
 *
 * This replaces the previous pattern of calling advanceGeneration() to commit,
 * which could not honour pin/veto/reroll overrides. advanceGeneration() is
 * kept for non-proposal use cases (batch runs, tests) and its output still
 * matches commitProposal(state, computeAdvanceProposal(state, season, T))
 * when no overrides are applied (tested in evolutionCommit.test.ts).
 *
 * Determinism: output is fully determined by (state, proposal). No timestamp
 * is consumed — proposal.advancedAt is used verbatim for updatedAt.
 */

import type {
  EvolutionRunState,
  ArchivedBotRecord,
  BotFitnessRecord,
  ChampionRecord,
} from "./types.ts";
import type { GenerationAdvanceProposal } from "./proposal.ts";

// ─── Helpers ──────────────────────────────────────────────────────────────────

function buildArchiveEntries(
  proposal: GenerationAdvanceProposal,
): ArchivedBotRecord[] {
  const fitnessById = new Map(
    proposal.fitnessRecords.map((r) => [r.spec.id, r.fitness]),
  );
  const entries: ArchivedBotRecord[] = [];

  // Survivors → "reproduced"
  for (const s of proposal.survivors) {
    const fitness = fitnessById.get(s.spec.id);
    if (fitness === undefined) continue; // should never happen
    entries.push({
      id: s.spec.id,
      name: s.spec.name,
      archetype: s.spec.archetype,
      params: s.spec.params,
      generation: s.spec.generation,
      parentIds: s.spec.parentIds,
      lineageId: s.spec.metadata.lineageId,
      fitness,
      retirementReason: "reproduced",
      retiredAtGeneration: proposal.fromGeneration,
      // Record pin override in lineage so it is visible in archive queries.
      ...(s.pinned ? { pinnedOverride: true as const } : {}),
      ...(s.userReason ? { overrideNotes: s.userReason } : {}),
    });
  }

  // Retired → reason from RetirementDecision
  for (const r of proposal.retired) {
    const fitness = fitnessById.get(r.spec.id);
    if (fitness === undefined) continue;
    const retirementReason: ArchivedBotRecord["retirementReason"] =
      r.retirementReason === "gate-failure"
        ? "gate-failure"
        : r.retirementReason === "vetoed"
        ? "vetoed"
        : "non-survivor";
    entries.push({
      id: r.spec.id,
      name: r.spec.name,
      archetype: r.spec.archetype,
      params: r.spec.params,
      generation: r.spec.generation,
      parentIds: r.spec.parentIds,
      lineageId: r.spec.metadata.lineageId,
      fitness,
      retirementReason,
      retiredAtGeneration: proposal.fromGeneration,
      ...(r.userReason ? { overrideNotes: r.userReason } : {}),
    });
  }

  return entries;
}

function updateChampionHistory(
  currentHistory: Record<string, ChampionRecord>,
  fitnessRecords: BotFitnessRecord[],
): Record<string, ChampionRecord> {
  const updated: Record<string, ChampionRecord> = { ...currentHistory };
  for (const record of fitnessRecords) {
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

// ─── Invariant errors ─────────────────────────────────────────────────────────

/**
 * Thrown by commitProposal() when the proposal does not match the current
 * run state. Indicates a stale or corrupted proposal — e.g. the user computed
 * a proposal at generation N and then somehow committed it at generation N+1.
 */
export class StaleProposalError extends Error {
  constructor(reason: string) {
    super(`Cannot commit proposal: ${reason}`);
    this.name = "StaleProposalError";
  }
}

// ─── Invariant check ──────────────────────────────────────────────────────────

function assertProposalMatchesState(
  state: EvolutionRunState,
  proposal: GenerationAdvanceProposal,
): void {
  const errors: string[] = [];

  if (proposal.fromGeneration !== state.generation) {
    errors.push(
      `fromGeneration (${proposal.fromGeneration}) ≠ state.generation (${state.generation})`,
    );
  }

  if (proposal.toGeneration !== state.generation + 1) {
    errors.push(
      `toGeneration (${proposal.toGeneration}) ≠ state.generation + 1 (${state.generation + 1})`,
    );
  }

  if (proposal.proposedPop.length !== state.config.populationSize) {
    errors.push(
      `proposedPop.length (${proposal.proposedPop.length}) ≠ config.populationSize (${state.config.populationSize})`,
    );
  }

  // fitnessRecords must cover every bot in activePop exactly once.
  // Check the count first (catches duplicates that a Set would silently merge).
  const activePopIds = new Set(state.activePop.map((s) => s.id));
  if (proposal.fitnessRecords.length !== state.activePop.length) {
    errors.push(
      `fitnessRecords.length (${proposal.fitnessRecords.length}) ≠ activePop.length (${state.activePop.length})`,
    );
  }
  const fitnessIds = new Set(proposal.fitnessRecords.map((r) => r.spec.id));
  if (fitnessIds.size !== activePopIds.size || [...activePopIds].some((id) => !fitnessIds.has(id))) {
    errors.push(
      `fitnessRecords IDs do not match activePop IDs (duplicates or missing)`,
    );
  }

  // survivor + retired must cover every active-pop bot exactly once.
  // Length check first — Set-based coverage check cannot detect duplicates.
  const totalDecisions = proposal.survivors.length + proposal.retired.length;
  if (totalDecisions !== state.activePop.length) {
    errors.push(
      `survivors (${proposal.survivors.length}) + retired (${proposal.retired.length}) = ${totalDecisions} ≠ activePop.length (${state.activePop.length})`,
    );
  }
  const decisionIds = new Set([
    ...proposal.survivors.map((s) => s.spec.id),
    ...proposal.retired.map((r) => r.spec.id),
  ]);
  if (
    decisionIds.size !== activePopIds.size ||
    [...activePopIds].some((id) => !decisionIds.has(id))
  ) {
    errors.push(
      `survivors + retired IDs do not cover activePop exactly once (duplicates or missing)`,
    );
  }

  if (errors.length > 0) {
    throw new StaleProposalError(errors.join("; "));
  }
}

// ─── Main entry point ─────────────────────────────────────────────────────────

/**
 * Materialise an approved GenerationAdvanceProposal into a new EvolutionRunState.
 *
 * Archives every bot in the current generation according to their proposal
 * decision (survivors → "reproduced"; retired according to retirementReason).
 * Sets the next active population from proposal.proposedPop. Updates champion
 * history from proposal.fitnessRecords.
 *
 * Validates that the proposal is consistent with the current run state before
 * writing anything. Throws StaleProposalError if the proposal is stale or
 * corrupted (wrong generation, wrong population size, mismatched IDs).
 *
 * @param state    - Current run state. Never mutated.
 * @param proposal - The approved proposal (with any overrides already applied).
 * @returns        A new EvolutionRunState for proposal.toGeneration.
 * @throws StaleProposalError if the proposal does not match state.
 */
export function commitProposal(
  state: EvolutionRunState,
  proposal: GenerationAdvanceProposal,
): EvolutionRunState {
  assertProposalMatchesState(state, proposal);

  const newArchiveEntries = buildArchiveEntries(proposal);
  const nextActivePop = proposal.proposedPop.map((p) => p.child);
  const nextChampionHistory = updateChampionHistory(state.championHistory, proposal.fitnessRecords);

  return {
    ...state,
    generation: proposal.toGeneration,
    activePop: nextActivePop,
    archive: [...state.archive, ...newArchiveEntries],
    championHistory: nextChampionHistory,
    updatedAt: proposal.advancedAt,
  };
}
