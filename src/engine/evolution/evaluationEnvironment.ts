/**
 * M14 Slice 4E.1 — EvaluationEnvironment type.
 *
 * Engine-owned type only. Factory functions live in src/app/evolutionState.ts
 * because they depend on app types (MatchConfig, EvolutionRunContext).
 *
 * A bot is not "good" in the abstract — it is good in a specific environment.
 * Evolution runs must name their environment rather than silently inheriting
 * the active config state. EvaluationEnvironment is the single source of truth
 * for environment context in the evolution panel.
 */

export type EvaluationEnvironment = {
  /** Stable identifier derived from datasetFingerprint + symbol + windowCount. */
  id: string;
  /** Auto-derived human-readable name, e.g. "SPY · 2024-01-02 – 2024-12-31". */
  name: string;
  /** Where the candle data came from. */
  dataSource: "synthetic" | "csv" | "alpaca";
  symbol: string;
  dateRange: { start: string; end: string };
  windowCount: number;
  /** Always "1D" in M14 (daily candles). */
  timeframe: string;
  /** Alpaca feed qualifier, e.g. "iex" or "sip". Absent for CSV and synthetic data. */
  feed?: string;
  feeBps: number;
  slippageBps: number;
  startingCash: number;
  /**
   * Concise regime summary populated after a season runs.
   * E.g. "2 uptrend · 1 sideways · 1 downtrend".
   * Not stored in run state — derived from the most recent season's regime labels.
   */
  regimeSummary?: string;
  /** djb2 hash over OHLCV of the candle slice. Matches EvolutionRunContext.environment.datasetFingerprint. */
  datasetFingerprint: string;
};
