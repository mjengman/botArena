/**
 * Fitness scoring for M14 Slice 2.
 *
 * scorePopulation() is the main entry point: takes the active population and
 * a completed season result, returns one BotFitnessRecord per bot.
 *
 * Window-count enforcement (throws InsufficientWindowsError):
 *   scorePopulation() requires at least MIN_EVOLUTION_WINDOWS windows.
 *   Single-match fitness is explicitly prohibited by the M14 roadmap — selection
 *   must be based on multi-window generalisation, not one period's luck.
 *   advanceGeneration() also checks this as a fast-fail, but enforcing it here
 *   means the rule is applied even when scorePopulation() is called directly.
 *
 * Pre-scoring validation (throws InvalidSeasonDataError):
 *   - Every active bot must appear in EVERY season window. Partial data
 *     undermines the generalization goal — a bot scored from a subset of
 *     windows could be selected on a lucky window, not real fitness.
 *   - Each snapshot's key metrics (totalReturn, finalEquity, maxDrawdown,
 *     tradeCount) must be finite and non-negative where applicable. NaN
 *     silently corrupts the fitness formula and must not reach selection.
 *
 * Two elimination gates (applied after data validation):
 *   1. Survival gate: bot's finalEquity must be > 0 in every window.
 *   2. Activity gate: total tradeCount across all windows >= minTrades.
 *      Uses tradeCount (not closedTradeCount) so Buy & Hold is not penalised.
 *
 * Gate failures produce FitnessResult { kind: "gate-failure", ... }.
 * No -Infinity values are stored; the discriminated union handles sorting/filtering.
 *
 * Fitness formula (for bots that pass both gates):
 *   fitness = w_return × meanWindowReturn
 *           − w_drawdown × worstWindowDrawdown
 *           − w_inconsistency × returnStdDev
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
import { validateEvolutionConfig } from "./config.ts";

// ─── Constants ───────────────────────────────────────────────────────────────

/**
 * Minimum number of season windows required by scorePopulation() and
 * advanceGeneration(). Evolution must select for multi-window generalisation;
 * single-match fitness is explicitly prohibited by the M14 roadmap.
 */
export const MIN_EVOLUTION_WINDOWS = 2;

// ─── Errors ───────────────────────────────────────────────────────────────────

/**
 * Thrown when scorePopulation() or advanceGeneration() receives a season result
 * with fewer than MIN_EVOLUTION_WINDOWS windows.
 */
export class InsufficientWindowsError extends Error {
  readonly windowCount: number;
  readonly minimumRequired: number;

  constructor(windowCount: number) {
    super(
      `Season result has ${windowCount} window${windowCount === 1 ? "" : "s"}; ` +
      `evolution requires at least ${MIN_EVOLUTION_WINDOWS}. ` +
      `Run a multi-window season before advancing the generation.`,
    );
    this.name = "InsufficientWindowsError";
    this.windowCount = windowCount;
    this.minimumRequired = MIN_EVOLUTION_WINDOWS;
  }
}

/**
 * Thrown by scorePopulation() when the season data is incomplete or contains
 * invalid metric values. This is a data quality error, not a fitness gate
 * failure — the scoring pipeline cannot proceed safely.
 *
 * Common causes:
 *   - A bot was not included in one or more season windows.
 *   - A metric value is NaN, Infinity, or otherwise invalid.
 */
export class InvalidSeasonDataError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InvalidSeasonDataError";
  }
}

// ─── Snapshot validation ──────────────────────────────────────────────────────

/**
 * Validate that a single MetricSnapshot has sensible values for the fields
 * used in fitness scoring. Throws InvalidSeasonDataError on the first violation.
 */
function validateSnapshot(
  snap: MetricSnapshot,
  botId: string,
  windowIndex: number,
): void {
  if (!Number.isFinite(snap.totalReturn)) {
    throw new InvalidSeasonDataError(
      `Bot "${botId}" window ${windowIndex}: totalReturn is not finite (${snap.totalReturn})`,
    );
  }
  if (!Number.isFinite(snap.finalEquity)) {
    throw new InvalidSeasonDataError(
      `Bot "${botId}" window ${windowIndex}: finalEquity is not finite (${snap.finalEquity})`,
    );
  }
  if (!Number.isFinite(snap.maxDrawdown) || snap.maxDrawdown < 0) {
    throw new InvalidSeasonDataError(
      `Bot "${botId}" window ${windowIndex}: maxDrawdown must be a finite non-negative number, ` +
      `got ${snap.maxDrawdown}`,
    );
  }
  if (!Number.isFinite(snap.tradeCount) || snap.tradeCount < 0) {
    throw new InvalidSeasonDataError(
      `Bot "${botId}" window ${windowIndex}: tradeCount must be a finite non-negative number, ` +
      `got ${snap.tradeCount}`,
    );
  }
}

/**
 * Verify that every active bot appears in every season window, and that each
 * appearing snapshot has valid metric values. Throws on the first violation.
 */
function validateSeasonCompleteness(
  activePop: EvolvableBotSpec[],
  seasonResult: EvolutionSeasonResult,
): void {
  for (const spec of activePop) {
    for (const window of seasonResult.windows) {
      const snap = window.standings.find((s) => s.botId === spec.id);
      if (snap === undefined) {
        throw new InvalidSeasonDataError(
          `Bot "${spec.id}" is missing from season window ${window.index}. ` +
          `All active bots must have a metric snapshot in every season window.`,
        );
      }
      validateSnapshot(snap, spec.id, window.index);
    }
  }
}

// ─── Per-bot window stat collection ──────────────────────────────────────────

type CollectedStats = {
  stats: WindowMetricsSummary;
  snapshots: MetricSnapshot[];
};

/**
 * Collect the per-window MetricSnapshots for `botId` and aggregate them into
 * a WindowMetricsSummary. After validateSeasonCompleteness(), every bot is
 * guaranteed to appear in every window, so the null path is unreachable in
 * normal operation — it remains as a defensive fallback.
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

/** Fallback summary for bots absent from all windows (defensive; unreachable post-validation). */
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
 *
 * @throws InvalidEvolutionConfigError if config is invalid (missing/bad weights, etc.).
 * @throws InsufficientWindowsError    if seasonResult has fewer than MIN_EVOLUTION_WINDOWS windows.
 * @throws InvalidSeasonDataError      if any active bot is missing from a season
 *         window, or if any snapshot contains a non-finite/invalid metric value.
 */
export function scorePopulation(
  activePop: EvolvableBotSpec[],
  seasonResult: EvolutionSeasonResult,
  config: EvolutionConfig,
): BotFitnessRecord[] {
  validateEvolutionConfig(config);
  if (seasonResult.windows.length < MIN_EVOLUTION_WINDOWS) {
    throw new InsufficientWindowsError(seasonResult.windows.length);
  }
  validateSeasonCompleteness(activePop, seasonResult);
  return activePop.map((spec) => ({
    spec,
    fitness: scoreSingleBot(spec, seasonResult, config),
  }));
}
