import type { ExecutionAdapter } from "../adapter.ts";
import type {
  ArenaEvent,
  BotInstance,
  Candle,
  ExecutionFill,
  OrderIntent,
  PortfolioSnapshot,
  SimulationConfig,
} from "../types.ts";
import type { ExecutionResult } from "../execution.ts";
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
 * ARCHITECTURE SPIKE — Milestone 6. NOT YET IMPLEMENTED.
 * ──────────────────────────────────────────────────────────────────────────────
 *
 * This class exists to:
 *   1. Prove the `ExecutionAdapter` interface is satisfiable with Alpaca-specific
 *      types — verified at compile time.
 *   2. Document the mapping from `OrderIntent` → `AlpacaOrderRequest`.
 *   3. Give the reconciliation and event ingestion design a concrete compile-time
 *      home with method-level documentation.
 *
 * Every method throws `NOT_IMPLEMENTED`. No broker calls are made anywhere in
 * this file. Implementation begins in Milestone 7+ after the enablement gate
 * and secrets management plan are approved and tested.
 *
 * Design prerequisites before implementation:
 *   - Server-side proxy or Electron shell to hold API secrets out of the browser
 *     bundle (see brokerTypes.ts § Secrets Management Plan).
 *   - EnablementGate implementation with precondition checks.
 *   - Reconciliation logic to verify broker ↔ engine state on session start.
 *   - WebSocket ingestion layer for Alpaca trade_updates stream.
 */
export class PaperBrokerAdapter implements ExecutionAdapter {
  readonly mode = "paper" as const;

  constructor(
    // These parameters will become `private readonly config` and `gate`
    // once the methods are implemented in Milestone 7+. Using underscore
    // params here (not class fields) avoids TS6138 in the stub.
    _config: PaperAdapterConfig,
    _gate: EnablementGate,
  ) {}

  /**
   * Submit an order to the Alpaca Paper API.
   *
   * Implementation plan (Milestone 7+):
   *   1. Call `this.gate.assertArmed()` — throws GateDisarmedError if not armed.
   *   2. Verify `intent.symbol` is in `this.config.allowedSymbols`.
   *   3. Call `this.toAlpacaOrder(intent, portfolio)` to build the request.
   *   4. POST to `{baseUrl}/v2/orders` with credentials from CredentialStore.
   *   5. Poll or await WebSocket fill event for the returned order ID.
   *   6. Call `this.fromAlpacaFill(response)` to produce an `ExecutionFill`.
   *   7. Return `{ ok: true, fill }`.
   *   8. On any broker error, call `this.gate.disarm(reason)` and return
   *      `{ ok: false, reason: "BROKER_ERROR" }` (requires extending RejectionReason).
   */
  execute(
    _intent: OrderIntent,
    _bot: BotInstance,
    _portfolio: PortfolioSnapshot,
    _candle: Candle,
    _config: SimulationConfig,
  ): ExecutionResult {
    throw new Error("NOT_IMPLEMENTED: PaperBrokerAdapter.execute — Milestone 7+");
  }

  /**
   * Translate a broker-neutral `OrderIntent` into an `AlpacaOrderRequest`.
   *
   * Size mapping:
   *   quantity         → { qty: String(quantity) }
   *   targetAllocation → { notional: String(equity * fraction).toFixed(2) }
   *   sellPercent      → { qty: String(Math.floor(position.qty * fraction)) }
   *   closePosition    → { qty: String(position.qty) }
   *
   * Order type is always "market"; time_in_force is "day".
   * A `client_order_id` (UUID) is generated for idempotency.
   */
  toAlpacaOrder(
    _intent: OrderIntent,
    _portfolio: PortfolioSnapshot,
  ): AlpacaOrderRequest {
    throw new Error("NOT_IMPLEMENTED: PaperBrokerAdapter.toAlpacaOrder — Milestone 7+");
  }

  /**
   * Convert an `AlpacaOrderResponse` to an `ExecutionFill`.
   *
   * A fill is only valid when `response.status === "filled"` and
   * `response.filled_qty === response.qty`. Partial fills (status
   * "partially_filled") are held until the order is fully filled or
   * until end-of-day reconciliation.
   *
   * Fee is not provided by Alpaca directly; it is computed from the engine's
   * `config.feeBps` applied to the notional fill value, consistent with the
   * simulated adapter.
   */
  fromAlpacaFill(_response: AlpacaOrderResponse): ExecutionFill {
    throw new Error("NOT_IMPLEMENTED: PaperBrokerAdapter.fromAlpacaFill — Milestone 7+");
  }

  /**
   * Fetch the Alpaca account snapshot and compare it to the engine's
   * `PortfolioSnapshot`.
   *
   * Returns a `BrokerReconciliationResult` describing any drift. If `ok` is
   * false, the caller must disarm the gate and emit a RECONCILIATION_DRIFT
   * ArenaEvent before proceeding.
   *
   * Called: on session start, after any unexpected broker event, on user request.
   */
  reconcileAccount(
    _enginePortfolio: PortfolioSnapshot,
  ): BrokerReconciliationResult {
    throw new Error("NOT_IMPLEMENTED: PaperBrokerAdapter.reconcileAccount — Milestone 7+");
  }

  /**
   * Translate a raw broker event into an `ArenaEvent` for the engine's EventLog.
   *
   * The caller is responsible for emitting the result; this method only
   * translates the envelope. Supported mappings:
   *   trade_updates  → ORDER_FILL | ORDER_REJECTED | WARNING
   *   account_updates → PORTFOLIO_UPDATE
   *   connection_error | auth_error → WARNING + gate.disarm()
   */
  ingestBrokerEvent(_envelope: BrokerEventEnvelope): ArenaEvent {
    throw new Error("NOT_IMPLEMENTED: PaperBrokerAdapter.ingestBrokerEvent — Milestone 7+");
  }
}
