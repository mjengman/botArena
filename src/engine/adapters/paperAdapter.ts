import type { BrokerAdapter } from "../adapter.ts";
import type {
  ArenaEvent,
  ExecutionFill,
  OrderIntent,
  PortfolioSnapshot,
} from "../types.ts";
import type {
  AlpacaOrderRequest,
  AlpacaOrderResponse,
  BrokerEventEnvelope,
  BrokerReconciliationResult,
  EnablementGate,
  PaperAdapterConfig,
} from "../brokerTypes.ts";

/**
 * Paper trading adapter for the Alpaca Paper API.
 *
 * ──────────────────────────────────────────────────────────────────────────────
 * ARCHITECTURE SPIKE — Milestone 6/7. NOT YET IMPLEMENTED.
 * ──────────────────────────────────────────────────────────────────────────────
 *
 * This class implements `BrokerAdapter` (NOT `SimulationExecutionAdapter`).
 * It belongs to the async `PaperSessionRunner`, not to `createSimulation()`.
 *
 * Design rationale:
 *   The backtest simulation loop is synchronous and deterministic.
 *   The paper session runner is event-driven: orders are submitted to a broker
 *   and fills arrive asynchronously via WebSocket. These are fundamentally
 *   different orchestration models and must not share a loop.
 *
 * This class exists to:
 *   1. Satisfy `BrokerAdapter` at compile time — verified now.
 *   2. Document the async execution design at method level.
 *   3. Hold the reconciliation and event ingestion design until M7 implementation.
 *
 * Every method throws `NOT_IMPLEMENTED`. No broker calls are made.
 * Implementation begins in Milestone 7+ after:
 *   - The `PaperSessionRunner` orchestration loop is designed.
 *   - `EnablementGate` is implemented with precondition checks.
 *   - Secrets management is resolved (server-side proxy or Electron shell).
 *   - Reconciliation logic is tested.
 *   - WebSocket ingestion layer is wired up.
 */
export class PaperBrokerAdapter implements BrokerAdapter {
  readonly mode = "paper" as const;

  constructor(
    // Parameters will become `private readonly` fields once methods
    // are implemented in M7+. Underscore names avoid TS6138 in the stub.
    _config: PaperAdapterConfig,
    _gate: EnablementGate,
  ) {}

  /**
   * Submit an order to the Alpaca Paper API asynchronously.
   *
   * Implementation plan (Milestone 7+):
   *   1. Verify gate is ARMED — throws GateDisarmedError if not.
   *   2. Verify intent.symbol is in config.allowedSymbols.
   *   3. Call toAlpacaOrder(intent, portfolio) to build the request payload.
   *   4. POST to {baseUrl}/v2/orders with credentials from CredentialStore.
   *   5. Await the fill via WebSocket trade_updates stream (order ID match).
   *   6. Call fromAlpacaFill(response) to produce an ExecutionFill.
   *   7. Return the fill; caller applies it and advances the session clock.
   *   8. On broker error: disarm gate, emit WARNING event, surface to UI.
   */
  async executeAsync(
    _intent: OrderIntent,
    _portfolio: PortfolioSnapshot,
  ): Promise<ExecutionFill> {
    throw new Error("NOT_IMPLEMENTED: PaperBrokerAdapter.executeAsync — Milestone 7+");
  }

  /**
   * Translate a broker-neutral `OrderIntent` into an `AlpacaOrderRequest`.
   *
   * Size mapping:
   *   quantity         → { qty: String(quantity) }
   *   targetAllocation → { notional: (equity * fraction).toFixed(2) }
   *   sellPercent      → { qty: String(floor(position.qty * fraction)) }
   *   closePosition    → { qty: String(position.qty) }
   *
   * Order type is always "market"; time_in_force is "day".
   * A client_order_id (UUID) is generated for idempotency.
   */
  toAlpacaOrder(
    _intent: OrderIntent,
    _portfolio: PortfolioSnapshot,
  ): AlpacaOrderRequest {
    throw new Error("NOT_IMPLEMENTED: PaperBrokerAdapter.toAlpacaOrder — Milestone 7+");
  }

  /**
   * Convert an `AlpacaOrderResponse` into an `ExecutionFill`.
   *
   * A fill is valid only when status === "filled" and filled_qty === qty.
   * Partial fills are held until the order is complete or end-of-day.
   * Fee is computed from config.feeBps applied to the notional fill value.
   */
  fromAlpacaFill(_response: AlpacaOrderResponse): ExecutionFill {
    throw new Error("NOT_IMPLEMENTED: PaperBrokerAdapter.fromAlpacaFill — Milestone 7+");
  }

  /**
   * Fetch the Alpaca account snapshot and compare it to the engine's
   * internal portfolio state.
   *
   * Called: on session start, after any unexpected broker event, on user request.
   * On drift: disarm gate, emit RECONCILIATION_DRIFT ArenaEvent, block trading.
   */
  async reconcileAccount(
    _enginePortfolio: PortfolioSnapshot,
  ): Promise<BrokerReconciliationResult> {
    throw new Error("NOT_IMPLEMENTED: PaperBrokerAdapter.reconcileAccount — Milestone 7+");
  }

  /**
   * Translate a raw broker event into an `ArenaEvent` for the session log.
   *
   * Mappings:
   *   trade_updates   → ORDER_FILL | ORDER_REJECTED | WARNING
   *   account_updates → PORTFOLIO_UPDATE
   *   connection_error | auth_error → WARNING + gate.disarm()
   */
  ingestBrokerEvent(_envelope: BrokerEventEnvelope): ArenaEvent {
    throw new Error("NOT_IMPLEMENTED: PaperBrokerAdapter.ingestBrokerEvent — Milestone 7+");
  }
}
