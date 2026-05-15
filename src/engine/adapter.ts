import type {
  BotInstance,
  Candle,
  OrderIntent,
  PortfolioSnapshot,
  SimulationConfig,
} from "./types.ts";
import type { ExecutionResult } from "./execution.ts";

// ─── Adapter Mode Discriminants ──────────────────────────────────────────────

/**
 * The backtest simulation loop only ever uses a synchronous simulation adapter.
 * Paper and live modes belong to separate async session runners, never to
 * `createSimulation()`.
 */
export type SimulationAdapterMode = "simulation";

/**
 * Broker-connected session runners use "paper" or "live" modes.
 * These never enter the synchronous replay loop.
 */
export type BrokerAdapterMode = "paper" | "live";

/** Union of all adapter modes — for logging and UI display only. */
export type AdapterMode = SimulationAdapterMode | BrokerAdapterMode;

// ─── SimulationExecutionAdapter ───────────────────────────────────────────────

/**
 * Synchronous execution adapter for the deterministic backtest simulation loop.
 *
 * Used exclusively by `createSimulation()`. Produces fills synchronously at
 * candle-close price ± slippage. Never connects to external services.
 *
 * Strategies remain completely unaware of which adapter is active — they emit
 * broker-neutral `OrderIntent` objects and never touch this interface.
 *
 * This is intentionally kept sync. Async complexity (partial fills, delayed
 * confirmations, reconnects) belongs in the broker session runners (M7+),
 * not here.
 */
export interface SimulationExecutionAdapter {
  readonly mode: SimulationAdapterMode;

  execute(
    intent: OrderIntent,
    bot: BotInstance,
    portfolio: PortfolioSnapshot,
    candle: Candle,
    config: SimulationConfig,
  ): ExecutionResult;
}

// ─── BrokerAdapter ────────────────────────────────────────────────────────────

/**
 * Async execution adapter for broker-connected paper and live session runners.
 *
 * NOT used by `createSimulation()` — this belongs to the separate
 * `PaperSessionRunner` / `LiveSessionRunner` (Milestone 7+).
 *
 * Design intent:
 *   - Orders are submitted to a broker and fills arrive asynchronously
 *     (Alpaca WebSocket stream or polling).
 *   - The session runner must await a fill (or timeout/cancel) before
 *     advancing to the next decision cycle.
 *   - Partial fills, reconnects, cancel/replace flows, and account drift
 *     are all concerns of this layer — not the simulation loop.
 *
 * The full async API (executeAsync, reconcile, ingestEvent, etc.) is defined
 * when the session runner is implemented in Milestone 7+.
 */
export interface BrokerAdapter {
  readonly mode: BrokerAdapterMode;
  // Full async API defined in Milestone 7+.
  // See PaperBrokerAdapter in adapters/paperAdapter.ts for the documented
  // method-level design.
}
