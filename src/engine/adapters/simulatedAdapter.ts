import type { SimulationExecutionAdapter } from "../adapter.ts";
import { executeOrder } from "../execution.ts";

/**
 * The default execution adapter for simulation mode.
 *
 * Wraps the deterministic `executeOrder` function. All fills are computed
 * synchronously at candle close price ± slippage. No network calls are made.
 *
 * This is the adapter used by `createSimulation` when no adapter argument
 * is provided, preserving full backward compatibility with existing callers.
 */
export const simulatedAdapter: SimulationExecutionAdapter = {
  mode: "simulation",
  execute: executeOrder,
};
