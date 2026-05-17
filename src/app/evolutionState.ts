/**
 * M14 Slice 3 — Evolution Run persistence and helpers.
 *
 * Responsibilities:
 *   - DEFAULT_EVOLUTION_CONFIG  — sensible out-of-the-box settings
 *   - buildInitialPopulation()  — one EvolvableBotSpec per registry entry
 *   - buildEvolutionManifest()  — DatasetManifest from current match context
 *   - createEvolutionRun()      — construct a fresh generation-0 EvolutionRunState
 *   - adaptSeasonResult()       — thin SeasonResult → EvolutionSeasonResult adapter
 *   - load / save / clear       — localStorage persistence
 *
 * The storage key is separate from the match-history key so the two stores
 * never collide and can be cleared independently.
 */

import type { Dataset } from "../engine/types.ts";
import type {
  EvolutionConfig,
  EvolutionRunState,
  EvolutionSeasonResult,
  EvolvableBotSpec,
  DatasetManifest as EvolutionDatasetManifest,
} from "../engine/evolution/types.ts";
import { BOT_REGISTRY } from "./botRegistry.ts";
import type { SeasonResult } from "./season.ts";
import type { MatchConfig } from "./matchConfig.ts";

// ─── Constants ────────────────────────────────────────────────────────────────

const EVOLUTION_STORAGE_KEY = "bot-arena-evolution";

// ─── Default config ───────────────────────────────────────────────────────────

/**
 * Default EvolutionConfig.
 *
 * - populationSize: 5 — one per archetype at gen 0; manageable for exploration
 * - survivorCount: 2  — top-2 survive; each produces ~2–3 children
 * - minTrades: 1       — any trade passes the activity gate
 * - fitnessWeights     — balanced: reward return, penalise drawdown and inconsistency
 * - mutationRate: 0.3  — 30% of mutable params change per generation
 */
export const DEFAULT_EVOLUTION_CONFIG: EvolutionConfig = {
  populationSize: 5,
  survivorCount: 2,
  minTrades: 1,
  fitnessWeights: { return: 0.50, drawdown: 0.30, inconsistency: 0.20 },
  mutationRate: 0.3,
};

// ─── Helpers ──────────────────────────────────────────────────────────────────

/** djb2-style hash of an arbitrary string → uint32. */
function djb2(s: string): number {
  let h = 5381;
  for (let i = 0; i < s.length; i++) {
    h = ((h << 5) + h + s.charCodeAt(i)) >>> 0;
  }
  return h;
}

/**
 * djb2 hash of params map — identical to the one in mutate.ts.
 * Reproduced here so evolutionState.ts has no engine/evolution import cycle.
 */
function hashParams(params: Record<string, number | boolean | string>): string {
  const canonical = Object.keys(params)
    .sort()
    .map((k) => `${k}:${params[k]}`)
    .join(",");
  let h = 5381;
  for (let i = 0; i < canonical.length; i++) {
    h = ((h << 5) + h + canonical.charCodeAt(i)) >>> 0;
  }
  return h.toString(16).padStart(8, "0");
}

// ─── Initial population builder ───────────────────────────────────────────────

/**
 * Builds a generation-0 active population from the bot registry.
 *
 * One EvolvableBotSpec is created per BOT_REGISTRY entry using that entry's
 * default param values. lineageId is derived deterministically from runId and
 * the archetype index so it is stable but unique per run.
 */
export function buildInitialPopulation(
  runId: string,
  config: EvolutionConfig,
  startingCash: number,
  createdAt: string,
): EvolvableBotSpec[] {
  return BOT_REGISTRY.map((bot, idx) => {
    const params: Record<string, number | boolean | string> = {};
    for (const pd of bot.paramDefs) {
      params[pd.key] = pd.defaultValue;
    }

    // lineageId: stable per archetype-in-this-run, short enough to be readable
    const lineageId = `${bot.id}-${djb2(runId + String(idx)).toString(16).slice(-6)}`;
    // gen-0 IDs omit seed (no mutation) but include a params hash for uniqueness
    const id = `${lineageId}-g0-${hashParams(params)}`;

    return {
      id,
      name: bot.name,
      archetype: bot.id,
      params,
      generation: 0,
      parentIds: [],
      mutationRate: config.mutationRate,
      capital: startingCash,
      metadata: {
        lineageId,
        createdAt,
      },
    };
  });
}

// ─── Dataset manifest builder ─────────────────────────────────────────────────

/**
 * Builds the evolution DatasetManifest from the current match context.
 * windowLengthDays is approximate (assumes 1 candle ≈ 1 trading day).
 */
export function buildEvolutionManifest(
  sourceDataset: Dataset,
  mc: MatchConfig,
  windowCount: number,
): EvolutionDatasetManifest {
  const totalCandles = mc.dataEndIdx - mc.dataStartIdx + 1;
  return {
    symbol: sourceDataset.manifest.symbol,
    fromDate: sourceDataset.manifest.startDate,
    toDate: sourceDataset.manifest.endDate,
    windowCount,
    windowLengthDays: Math.floor(totalCandles / windowCount),
  };
}

// ─── Run factory ──────────────────────────────────────────────────────────────

/**
 * Creates a fresh EvolutionRunState at generation 0.
 *
 * @param config         - Evolution config (defaults available via DEFAULT_EVOLUTION_CONFIG).
 * @param datasetManifest - Captured from the current match context via buildEvolutionManifest().
 * @param startingCash   - Capital assigned to each initial bot (copied from matchConfig).
 * @param createdAt      - ISO 8601 timestamp (caller provides; no internal Date.now()).
 * @returns              A generation-0 run state ready to be saved and advanced.
 */
export function createEvolutionRun(
  config: EvolutionConfig,
  datasetManifest: EvolutionDatasetManifest,
  startingCash: number,
  createdAt: string,
): EvolutionRunState {
  const runId = `run-${djb2(createdAt + datasetManifest.symbol).toString(16)}`;
  const seed = djb2(runId) >>> 0;

  return {
    runId,
    generation: 0,
    activePop: buildInitialPopulation(runId, config, startingCash, createdAt),
    archive: [],
    championHistory: {},
    config,
    seed,
    datasetManifest,
    createdAt,
    updatedAt: createdAt,
  };
}

// ─── Season result adapter ────────────────────────────────────────────────────

/**
 * Adapts a SeasonResult (app layer) to EvolutionSeasonResult (engine layer).
 * Thin structural mapping — no data is transformed.
 *
 * The engine's EvolutionSeasonResult requires only { index, standings } per
 * window, which SeasonWindow already provides directly.
 */
export function adaptSeasonResult(result: SeasonResult): EvolutionSeasonResult {
  return {
    windows: result.windows.map((w) => ({
      index: w.index,
      standings: w.standings,
    })),
  };
}

// ─── Persistence ──────────────────────────────────────────────────────────────

export function loadEvolutionRunState(): EvolutionRunState | null {
  try {
    const raw = localStorage.getItem(EVOLUTION_STORAGE_KEY);
    return raw ? (JSON.parse(raw) as EvolutionRunState) : null;
  } catch {
    return null;
  }
}

export function saveEvolutionRunState(state: EvolutionRunState): void {
  try {
    localStorage.setItem(EVOLUTION_STORAGE_KEY, JSON.stringify(state));
  } catch {
    // localStorage unavailable or full — fail silently
  }
}

export function clearEvolutionRunState(): void {
  try {
    localStorage.removeItem(EVOLUTION_STORAGE_KEY);
  } catch {}
}
