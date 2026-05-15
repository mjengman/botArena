import type {
  BotInstance,
  Candle,
  OrderIntent,
  PortfolioSnapshot,
  SimulationConfig,
} from "./types.ts";
import type { ExecutionResult } from "./execution.ts";

// ─── Adapter Mode ─────────────────────────────────────────────────────────────

/**
 * Discriminant identifying the execution environment.
 * - "simulation" — deterministic in-process fill; no broker connectivity.
 * - "paper"      — live broker API using a paper trading account (no real money).
 * - "live"       — live broker API with real money (Milestone 7+ only).
 */
export type AdapterMode = "simulation" | "paper" | "live";

// ─── ExecutionAdapter Interface ───────────────────────────────────────────────

/**
 * Broker-neutral execution adapter.
 *
 * Strategies emit `OrderIntent` objects and never interact with this interface
 * directly. The simulation loop calls `adapter.execute()` once per intent.
 * Swapping adapters (simulation → paper → live) requires no changes to strategy
 * code.
 *
 * The interface is currently synchronous to match the simulation loop's design.
 * A future `executeAsync(): Promise<ExecutionResult>` variant will be introduced
 * when the paper adapter reaches implementation (Milestone 7+), allowing the
 * loop to await broker confirmation before proceeding.
 */
export interface ExecutionAdapter {
  /** Identifies which execution environment is active. */
  readonly mode: AdapterMode;

  /**
   * Attempt to execute an order intent.
   *
   * The simulated adapter fills synchronously and returns an `ExecutionResult`
   * immediately. Paper/live stubs in M6 throw `NOT_IMPLEMENTED`. Future live
   * adapters will return a result only after broker confirmation.
   */
  execute(
    intent: OrderIntent,
    bot: BotInstance,
    portfolio: PortfolioSnapshot,
    candle: Candle,
    config: SimulationConfig,
  ): ExecutionResult;
}
