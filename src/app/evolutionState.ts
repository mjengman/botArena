/**
 * M14 Slice 3 — Evolution Run persistence and helpers.
 *
 * Responsibilities:
 *   - DEFAULT_EVOLUTION_CONFIG    — sensible out-of-the-box settings
 *   - EvolutionRunContext         — captures the match/dataset context at run creation
 *   - EvolutionSessionData        — pairs EvolutionRunState with its context
 *   - buildInitialPopulation()    — one EvolvableBotSpec per registry entry
 *   - buildEvolutionManifest()    — DatasetManifest from current match context
 *   - buildRunContext()           — captures the full run context for later validation
 *   - createEvolutionRun()        — construct a fresh generation-0 EvolutionRunState
 *   - createEvolutionSession()    — construct a fresh session (runState + context)
 *   - adaptSeasonResult()         — thin SeasonResult → EvolutionSeasonResult adapter
 *   - contextMatchesCurrent()     — returns a list of mismatches between stored and current context
 *   - load / save / clear         — versioned localStorage persistence
 *
 * Persistence design:
 *   The stored value is a versioned envelope `{ v, runState, context }`. Any
 *   schema version mismatch or missing required fields causes loadEvolutionSession()
 *   to return null — the UI then shows an empty slate rather than crashing on a
 *   stale or malformed object.
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

/**
 * Increment whenever the stored shape changes in a breaking way.
 * loadEvolutionSession() returns null for any stored record whose v ≠ this.
 */
const EVOLUTION_SCHEMA_VERSION = 1;

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

// ─── Run context ──────────────────────────────────────────────────────────────

/**
 * Captures the match config and dataset identity at the moment an evolution run
 * is created. Stored alongside the EvolutionRunState in the persistence envelope.
 *
 * Before each `advanceGeneration()` call, the panel compares the stored context
 * against the current matchConfig + sourceDataset via contextMatchesCurrent().
 * Any mismatch blocks advancement — advancing on a different dataset or config
 * would silently corrupt the lineage's fitness history.
 */
export interface EvolutionRunContext {
  // ── Dataset identity ──────────────────────────────────────────────────────
  symbol: string;
  /** ISO date of first candle in the selected match slice. */
  startDate: string;
  /** ISO date of last candle in the selected match slice. */
  endDate: string;
  /** Number of candles in the selected match slice. */
  candleCount: number;
  /** matchConfig.dataStartIdx at run creation. */
  dataStartIdx: number;
  /** matchConfig.dataEndIdx at run creation. */
  dataEndIdx: number;
  // ── Simulation config (fees, slippage, seed affect fitness scores) ────────
  startingCash: number;
  feeBps: number;
  slippageBps: number;
  seed: number;
}

// ─── Session data ─────────────────────────────────────────────────────────────

/**
 * The full evolution session: the engine state plus the app-layer context that
 * was active when the run was created. Both are persisted together so the app
 * can validate context on load.
 */
export interface EvolutionSessionData {
  runState: EvolutionRunState;
  context: EvolutionRunContext;
}

// ─── Storage envelope ─────────────────────────────────────────────────────────

/** Internal shape written to localStorage. Not exported — callers use EvolutionSessionData. */
interface EvolutionStorageEnvelope {
  v: number;
  runState: EvolutionRunState;
  context: EvolutionRunContext;
}

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
 * djb2 hash of a params map — identical to the algorithm in mutate.ts.
 * Reproduced here so evolutionState.ts has no import cycle with the engine.
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

/** ISO date string (YYYY-MM-DD) for a candle at dataset[idx], or fallback. */
function candleDate(dataset: Dataset, idx: number, fallback: string): string {
  const candle = dataset.candles[idx];
  return candle ? new Date(candle.timestamp).toISOString().slice(0, 10) : fallback;
}

// ─── Initial population builder ───────────────────────────────────────────────

/**
 * Builds a generation-0 active population from the bot registry.
 *
 * One EvolvableBotSpec is created per BOT_REGISTRY entry using that entry's
 * default param values. The lineageId is derived deterministically from runId
 * and the archetype index so it is stable but unique per run.
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

    // lineageId: stable per archetype-in-this-run, readable enough to trace
    const lineageId = `${bot.id}-${djb2(runId + String(idx)).toString(16).slice(-6)}`;
    // gen-0 IDs include a params hash (no mutation seed)
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
 *
 * Uses the actual candle timestamps at dataStartIdx/dataEndIdx — not the full
 * source dataset start/end — so the manifest reflects the selected slice.
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
    fromDate: candleDate(sourceDataset, mc.dataStartIdx, sourceDataset.manifest.startDate),
    toDate:   candleDate(sourceDataset, mc.dataEndIdx,   sourceDataset.manifest.endDate),
    windowCount,
    windowLengthDays: Math.floor(totalCandles / windowCount),
  };
}

// ─── Run context builder ──────────────────────────────────────────────────────

/**
 * Captures the identity fields needed to validate that a future advancement
 * is running under the same match context the run was created with.
 */
export function buildRunContext(mc: MatchConfig, sourceDataset: Dataset): EvolutionRunContext {
  const totalCandles = mc.dataEndIdx - mc.dataStartIdx + 1;
  return {
    symbol: sourceDataset.manifest.symbol,
    startDate: candleDate(sourceDataset, mc.dataStartIdx, sourceDataset.manifest.startDate),
    endDate:   candleDate(sourceDataset, mc.dataEndIdx,   sourceDataset.manifest.endDate),
    candleCount: totalCandles,
    dataStartIdx: mc.dataStartIdx,
    dataEndIdx:   mc.dataEndIdx,
    startingCash: mc.startingCash,
    feeBps:       mc.feeBps,
    slippageBps:  mc.slippageBps,
    seed:         mc.seed,
  };
}

// ─── Context validation ───────────────────────────────────────────────────────

/**
 * Compares the stored run context against the currently active match config and
 * dataset. Returns an array of human-readable mismatch descriptions.
 * An empty array means the contexts are compatible — advancement is safe.
 */
export function contextMatchesCurrent(
  stored: EvolutionRunContext,
  mc: MatchConfig,
  sourceDataset: Dataset,
): string[] {
  const current = buildRunContext(mc, sourceDataset);
  const mismatches: string[] = [];

  if (stored.symbol !== current.symbol) {
    mismatches.push(`symbol: run uses "${stored.symbol}", current dataset is "${current.symbol}"`);
  }
  if (stored.startDate !== current.startDate) {
    mismatches.push(`start date: run uses ${stored.startDate}, current slice starts ${current.startDate}`);
  }
  if (stored.endDate !== current.endDate) {
    mismatches.push(`end date: run uses ${stored.endDate}, current slice ends ${current.endDate}`);
  }
  if (stored.candleCount !== current.candleCount) {
    mismatches.push(`candle count: run has ${stored.candleCount}, current slice has ${current.candleCount}`);
  }
  if (stored.dataStartIdx !== current.dataStartIdx) {
    mismatches.push(`dataStartIdx: run has ${stored.dataStartIdx}, current is ${current.dataStartIdx}`);
  }
  if (stored.dataEndIdx !== current.dataEndIdx) {
    mismatches.push(`dataEndIdx: run has ${stored.dataEndIdx}, current is ${current.dataEndIdx}`);
  }
  if (stored.startingCash !== current.startingCash) {
    mismatches.push(`starting cash: run uses $${stored.startingCash}, current is $${current.startingCash}`);
  }
  if (stored.feeBps !== current.feeBps) {
    mismatches.push(`feeBps: run uses ${stored.feeBps}, current is ${current.feeBps}`);
  }
  if (stored.slippageBps !== current.slippageBps) {
    mismatches.push(`slippageBps: run uses ${stored.slippageBps}, current is ${current.slippageBps}`);
  }
  if (stored.seed !== current.seed) {
    mismatches.push(`seed: run uses ${stored.seed}, current is ${current.seed}`);
  }

  return mismatches;
}

// ─── Run factory ──────────────────────────────────────────────────────────────

/**
 * Creates a fresh EvolutionRunState at generation 0.
 * Exported so tests can construct engine state directly without app context.
 *
 * @param config         - Evolution config (use DEFAULT_EVOLUTION_CONFIG as a base).
 * @param datasetManifest - Built via buildEvolutionManifest().
 * @param startingCash   - Capital for each initial bot; copied from matchConfig.
 * @param createdAt      - ISO 8601 timestamp (caller-provided; no internal Date.now()).
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

/**
 * Creates a complete EvolutionSessionData (runState + context) from the current
 * match context. This is the primary factory for new runs in the UI.
 */
export function createEvolutionSession(
  config: EvolutionConfig,
  mc: MatchConfig,
  sourceDataset: Dataset,
  windowCount: number,
  createdAt: string,
): EvolutionSessionData {
  const manifest = buildEvolutionManifest(sourceDataset, mc, windowCount);
  const runState = createEvolutionRun(config, manifest, mc.startingCash, createdAt);
  const context = buildRunContext(mc, sourceDataset);
  return { runState, context };
}

// ─── Season result adapter ────────────────────────────────────────────────────

/**
 * Adapts a SeasonResult (app layer) to EvolutionSeasonResult (engine layer).
 * Thin structural mapping — no data is transformed.
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

/**
 * Load the stored evolution session.
 *
 * Returns null if:
 *   - localStorage is unavailable
 *   - No value is stored
 *   - The stored value has a different schema version (stale schema)
 *   - The stored value fails minimal shape validation (corrupt/truncated data)
 *
 * Never throws — callers receive a clean null and can start a fresh run.
 */
export function loadEvolutionSession(): EvolutionSessionData | null {
  try {
    const raw = localStorage.getItem(EVOLUTION_STORAGE_KEY);
    if (!raw) return null;

    const obj = JSON.parse(raw) as Partial<EvolutionStorageEnvelope>;

    // Reject stale schemas immediately — don't try to migrate unknown shapes.
    if (obj.v !== EVOLUTION_SCHEMA_VERSION) return null;

    // Validate the minimum required fields so the UI never receives a
    // partially-constructed object and tries to render it.
    const rs = obj.runState;
    if (
      !rs ||
      typeof rs.runId !== "string" ||
      typeof rs.generation !== "number" ||
      !Array.isArray(rs.activePop) ||
      !rs.config
    ) return null;

    const ctx = obj.context;
    if (
      !ctx ||
      typeof ctx.symbol !== "string" ||
      typeof ctx.startingCash !== "number" ||
      typeof ctx.dataStartIdx !== "number" ||
      typeof ctx.dataEndIdx !== "number"
    ) return null;

    return { runState: rs, context: ctx };
  } catch {
    return null;
  }
}

/**
 * Persist the evolution session under a versioned envelope.
 * Fails silently if localStorage is unavailable or quota is exceeded.
 */
export function saveEvolutionSession(data: EvolutionSessionData): void {
  try {
    const envelope: EvolutionStorageEnvelope = {
      v: EVOLUTION_SCHEMA_VERSION,
      runState: data.runState,
      context: data.context,
    };
    localStorage.setItem(EVOLUTION_STORAGE_KEY, JSON.stringify(envelope));
  } catch {
    // localStorage unavailable or full — fail silently
  }
}

/** Remove the stored evolution session from localStorage. */
export function clearEvolutionSession(): void {
  try {
    localStorage.removeItem(EVOLUTION_STORAGE_KEY);
  } catch {}
}
