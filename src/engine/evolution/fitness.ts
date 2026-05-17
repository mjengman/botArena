/**
 * Fitness scoring for M14 Slice 2.
 *
 * scorePopulation() is the main entry point: takes the active population and
 * a completed season result, returns one BotFitnessRecord per bot.
 *
 * Two elimination gates are applied before scoring:
 *  1. Survival gate: bot's finalEquity must be > 0 in every window it appeared in.
 *  2. Activity gate: bot's total tradeCount across all windows must be >= minTrades.
 *     Uses tradeCount (not closedTradeCount) so Buy & Hold is not unfairly penalised.
 *
 * Gate failures produce FitnessResult { kind: "gate-failure", ... }.
 * No -Infinity values are stored; the discriminated union handles sorting/filtering.
 *
 * Fitness formula (for bots that pass both gates):
 *   fitness = w_return × meanWindowReturn
 *           − w_drawdown × worstWindowDrawdown
 *           − w_inconsistency × returnStdDev
 *
 * A bot that does not appear in any season window fails the activity gate
 * (totalTradeCount = 0 < minTrades ≥ 1).
 */

import type { MetricSnapshot } from "../types.ts";
import type {
  EvolvableBotSpec,
  EvolutionSeasonResult,
  BotFitnessRecord,
  FitnessResult,
  WindowMetricsSummary,
  EvolutionConfig,
} from "./types.ts";

// ─── Per-bot window stat collection ──────────────────────────────────────────

type CollectedStats = {
  stats: WindowMetricsSummary;
  snapshots: MetricSnapshot[];
};

/**
 * Collect the per-window MetricSnapshots for `botId` and aggregate them into
 * a WindowMetricsSummary. Returns null only if the bot has zero appearances
 * across all windows (treated as activity gate failure upstream).
 */
function collectWindowStats(
  botId: string,
  seasonResult: EvolutionSeasonResult,
): CollectedStats | null {
  const snapshots: MetricSnapshot[] = [];
  const returns: number[] = [];
  let totalTradeCount = 0;
  let worstWindowDrawdown = 0;

  for (const window of seasonResult.windows) {
    const snap = window.standings.find((s) => s.botId === botId);
    if (!snap) continue;
    snapshots.push(snap);
    returns.push(snap.totalReturn);
    totalTradeCount += snap.tradeCount;
    worstWindowDrawdown = Math.max(worstWindowDrawdown, snap.maxDrawdown);
  }

  if (snapshots.length === 0) return null;

  const windowCount = returns.length;
  const meanReturn = returns.reduce((a, b) => a + b, 0) / windowCount;
  // Population variance (not sample variance) — we have the full window set.
  const variance =
    returns.reduce((a, r) => a + (r - meanReturn) ** 2, 0) / windowCount;
  const returnStdDev = Math.sqrt(variance);

  return {
    stats: {
      meanReturn,
      worstWindowDrawdown,
      returnStdDev,
      totalTradeCount,
      windowCount,
    },
    snapshots,
  };
}

// ─── Per-bot fitness computation ──────────────────────────────────────────────

/** Empty summary for bots that appeared in no windows. */
const EMPTY_SUMMARY: WindowMetricsSummary = {
  meanReturn: 0,
  worstWindowDrawdown: 0,
  returnStdDev: 0,
  totalTradeCount: 0,
  windowCount: 0,
};

function scoreSingleBot(
  spec: EvolvableBotSpec,
  seasonResult: EvolutionSeasonResult,
  config: EvolutionConfig,
): FitnessResult {
  const collected = collectWindowStats(spec.id, seasonResult);
  const stats = collected?.stats ?? EMPTY_SUMMARY;

  // ── Survival gate ──────────────────────────────────────────────────────────
  // Any window where the bot's equity reached zero (or below) is a failure.
  if (collected) {
    for (const snap of collected.snapshots) {
      if (snap.finalEquity <= 0) {
        return { kind: "gate-failure", gateFailureReason: "survival", windowMetricsSummary: stats };
      }
    }
  }

  // ── Activity gate ──────────────────────────────────────────────────────────
  // Bots absent from all windows also fail here (totalTradeCount = 0).
  if (stats.totalTradeCount < config.minTrades) {
    return { kind: "gate-failure", gateFailureReason: "activity", windowMetricsSummary: stats };
  }

  // ── Fitness score ──────────────────────────────────────────────────────────
  const { return: wr, drawdown: wd, inconsistency: wi } = config.fitnessWeights;
  const fitnessScore =
    wr * stats.meanReturn -
    wd * stats.worstWindowDrawdown -
    wi * stats.returnStdDev;

  return { kind: "scored", fitnessScore, windowMetricsSummary: stats };
}

// ─── Public API ───────────────────────────────────────────────────────────────

/**
 * Score every bot in the active population against the completed season result.
 * Returns one BotFitnessRecord per bot, preserving input order.
 */
export function scorePopulation(
  activePop: EvolvableBotSpec[],
  seasonResult: EvolutionSeasonResult,
  config: EvolutionConfig,
): BotFitnessRecord[] {
  return activePop.map((spec) => ({
    spec,
    fitness: scoreSingleBot(spec, seasonResult, config),
  }));
}
