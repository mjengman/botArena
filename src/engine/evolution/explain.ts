/**
 * M14 Slice 4A — Fitness explanation helper.
 *
 * explainFitness() converts a BotFitnessRecord into a FitnessExplanation —
 * a UI-ready breakdown of how the score was computed. The UI renders this
 * object directly; it never re-derives component values from raw metrics.
 *
 * Invariant (tested):
 *   For kind:"scored", explanation.score === record.fitness.fitnessScore exactly.
 *   The score field is copied from the engine's output, not recomputed, so there
 *   is no floating-point divergence between what was used for selection and what
 *   is displayed.
 *
 * Component arithmetic:
 *   returnComponent      =  weights.return       × meanReturn          (reward)
 *   drawdownPenalty      =  weights.drawdown     × worstWindowDrawdown (penalty)
 *   inconsistencyPenalty =  weights.inconsistency × returnStdDev       (penalty)
 *   score                =  returnComponent − drawdownPenalty − inconsistencyPenalty
 *
 * Note: returnComponent − drawdownPenalty − inconsistencyPenalty may differ from
 * score by a floating-point epsilon due to the order of operations used by the
 * engine. The score field is authoritative; component fields are for display.
 */

import type { BotFitnessRecord, EvolutionConfig, WindowMetricsSummary } from "./types.ts";

// ─── FitnessExplanation ───────────────────────────────────────────────────────

export type FitnessExplanation =
  | {
      kind: "scored";
      /** Copied directly from record.fitness.fitnessScore — exact, not recomputed. */
      score: number;
      /** weights.return × meanReturn — a positive reward for average window return. */
      returnComponent: number;
      /** weights.drawdown × worstWindowDrawdown — subtracted; penalises large drawdowns. */
      drawdownPenalty: number;
      /** weights.inconsistency × returnStdDev — subtracted; penalises cross-window variance. */
      inconsistencyPenalty: number;
      /** Fitness weights used when this score was computed. */
      weights: {
        return: number;
        drawdown: number;
        inconsistency: number;
      };
      windowMetricsSummary: WindowMetricsSummary;
    }
  | {
      kind: "gate-failure";
      /** "activity" — total trade count < minTrades across all windows. */
      /** "survival" — bot's equity reached zero or below in at least one window. */
      gateFailureReason: "survival" | "activity";
      windowMetricsSummary: WindowMetricsSummary;
    };

// ─── explainFitness ───────────────────────────────────────────────────────────

/**
 * Produce a FitnessExplanation for the given record and config.
 *
 * Gate-failure records are passed through unchanged (no decomposition possible).
 * Scored records are decomposed into their three weighted components.
 *
 * @param record  - A BotFitnessRecord as produced by scorePopulation().
 * @param config  - The EvolutionConfig used when the season was scored.
 *                  Used to read fitnessWeights. Other fields are not accessed.
 */
export function explainFitness(
  record: BotFitnessRecord,
  config: EvolutionConfig,
): FitnessExplanation {
  const { fitness } = record;

  if (fitness.kind === "gate-failure") {
    return {
      kind: "gate-failure",
      gateFailureReason: fitness.gateFailureReason,
      windowMetricsSummary: fitness.windowMetricsSummary,
    };
  }

  // kind === "scored"
  const { return: wr, drawdown: wd, inconsistency: wi } = config.fitnessWeights;
  const { meanReturn, worstWindowDrawdown, returnStdDev } = fitness.windowMetricsSummary;

  return {
    kind: "scored",
    // Score is copied directly — not recomputed — to preserve exact equality.
    score: fitness.fitnessScore,
    returnComponent: wr * meanReturn,
    drawdownPenalty: wd * worstWindowDrawdown,
    inconsistencyPenalty: wi * returnStdDev,
    weights: {
      return: wr,
      drawdown: wd,
      inconsistency: wi,
    },
    windowMetricsSummary: fitness.windowMetricsSummary,
  };
}
