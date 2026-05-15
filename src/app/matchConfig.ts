import { sampleDataset } from "../data/sampleDataset.ts";
import type { Dataset, SimulationConfig } from "../engine/types.ts";
import { BOT_REGISTRY } from "./botRegistry.ts";

export interface MatchConfig {
  startingCash: number;
  feeBps: number;
  slippageBps: number;
  seed: number;
  activeBotIds: string[];
  botParams: Record<string, Record<string, number>>;
  dataStartIdx: number;
  dataEndIdx: number;
}

export function defaultMatchConfig(): MatchConfig {
  const defaultParams: Record<string, Record<string, number>> = {};
  for (const bot of BOT_REGISTRY) {
    const p: Record<string, number> = {};
    for (const pd of bot.paramDefs) {
      p[pd.key] = pd.defaultValue;
    }
    defaultParams[bot.id] = p;
  }

  return {
    startingCash: 10_000,
    feeBps: 5,
    slippageBps: 3,
    seed: 42,
    activeBotIds: BOT_REGISTRY.map((b) => b.id),
    botParams: defaultParams,
    dataStartIdx: 0,
    dataEndIdx: sampleDataset.candles.length - 1,
  };
}

export interface ConfigValidationError {
  field: string;
  message: string;
}

export function validateMatchConfig(
  mc: MatchConfig,
  sourceDataset: Dataset = sampleDataset,
): ConfigValidationError[] {
  const errors: ConfigValidationError[] = [];
  const totalCandles = sourceDataset.candles.length;

  if (!Number.isFinite(mc.startingCash) || mc.startingCash <= 0) {
    errors.push({ field: "startingCash", message: "Starting cash must be greater than 0" });
  }
  if (!Number.isFinite(mc.feeBps) || mc.feeBps < 0) {
    errors.push({ field: "feeBps", message: "Fee must be 0 or greater" });
  }
  if (!Number.isFinite(mc.slippageBps) || mc.slippageBps < 0) {
    errors.push({ field: "slippageBps", message: "Slippage must be 0 or greater" });
  }
  if (!Number.isFinite(mc.seed) || !Number.isInteger(mc.seed) || mc.seed < 0) {
    errors.push({ field: "seed", message: "Seed must be a non-negative integer" });
  }
  if (mc.activeBotIds.length === 0) {
    errors.push({ field: "activeBotIds", message: "At least one bot must be active" });
  }
  if (
    !Number.isInteger(mc.dataStartIdx) ||
    !Number.isInteger(mc.dataEndIdx) ||
    mc.dataStartIdx < 0 ||
    mc.dataEndIdx >= totalCandles ||
    mc.dataStartIdx >= mc.dataEndIdx
  ) {
    errors.push({ field: "dateRange", message: "Date range must span at least 2 candles within the dataset" });
  }

  return errors;
}

export function buildSimConfig(mc: MatchConfig): SimulationConfig {
  return {
    startingCash: mc.startingCash,
    feeBps: mc.feeBps,
    slippageBps: mc.slippageBps,
    seed: mc.seed,
  };
}

export function buildBotSpecs(mc: MatchConfig) {
  return BOT_REGISTRY.filter((b) => mc.activeBotIds.includes(b.id)).map((b) => ({
    id: b.id,
    name: b.name,
    strategy: b.strategy,
    params: mc.botParams[b.id] ?? {},
  }));
}

export function buildDataset(
  mc: MatchConfig,
  sourceDataset: Dataset = sampleDataset,
): Dataset {
  const sliced = sourceDataset.candles.slice(mc.dataStartIdx, mc.dataEndIdx + 1);
  const first = sliced[0]!;
  const last = sliced[sliced.length - 1]!;

  // Recompute gap metadata for this specific slice.
  // Spreading the source manifest's gapCount/gapDates would describe gaps
  // across the full source, not the narrowed date window.
  const DAY_MS = 86_400_000;
  const gapDates: string[] = [];
  for (let i = 1; i < sliced.length; i++) {
    if (sliced[i]!.timestamp - sliced[i - 1]!.timestamp > DAY_MS + 60_000) {
      gapDates.push(new Date(sliced[i - 1]!.timestamp).toISOString().slice(0, 10));
    }
  }

  return {
    manifest: {
      // Keep identity fields from source; derive date/count from slice.
      symbol: sourceDataset.manifest.symbol,
      timeframe: sourceDataset.manifest.timeframe,
      source: sourceDataset.manifest.source,
      startDate: new Date(first.timestamp).toISOString().slice(0, 10),
      endDate: new Date(last.timestamp).toISOString().slice(0, 10),
      candleCount: sliced.length,
      ...(gapDates.length > 0 && { gapCount: gapDates.length, gapDates }),
    },
    candles: sliced,
  };
}
