/**
 * AlpacaPaperAdapter — real Alpaca Paper API broker adapter.
 *
 * Implements `BrokerAdapter` using the Alpaca Paper REST API:
 *   Base URL:  https://paper-api.alpaca.markets
 *   Orders:    POST /v2/orders
 *   Fill poll: GET  /v2/orders/{id}   (polled until status = filled)
 *   Account:   GET  /v2/account
 *   Positions: GET  /v2/positions
 *
 * Credentials are retrieved from a ConcreteCredentialStore via `store.get()`,
 * which enforces that the EnablementGate is ARMED before any broker call is
 * made. This ensures the gate lifecycle subsumes credential access — no API
 * call can be made while the gate is DISARMED.
 *
 * Fill flow:
 *   executeAsync() → POST /v2/orders → poll GET /v2/orders/{id} until filled
 *   Market orders on Alpaca Paper typically fill within seconds. The adapter
 *   polls at fillPollIntervalMs intervals up to fillPollMaxRetries times before
 *   throwing a timeout error. On any broker error, the adapter re-throws so the
 *   PaperLeagueRunner can disarm the gate (fail-closed).
 *
 * Reconciliation:
 *   reconcileAccount() fetches /v2/account and /v2/positions, then compares
 *   the broker's cash and position quantities against the engine's portfolio.
 *   Drift beyond the configured tolerances returns ok: false, which the runner
 *   treats as a gate-disarm condition.
 *
 * Note on fill prices:
 *   The adapter submits market orders; Alpaca fills at current market price,
 *   which may differ from any historical candle price the strategy observed.
 *   This is expected and documented: v0.1 does not stream live candle data into
 *   strategies. Portfolio math uses the actual fill price returned by Alpaca.
 *
 * Note on commissions:
 *   Alpaca Paper charges $0 commission on US equity market orders. The fee
 *   field in ExecutionFill is set to 0. Slippage is implicitly captured by the
 *   difference between the strategy's observed close and the actual fill price.
 */

import type { BrokerAdapter, BrokerAdapterMode, OrderExecutionContext } from "../adapter.ts";
import type {
  AlpacaAccountSnapshot,
  AlpacaOrderRequest,
  AlpacaOrderResponse,
  BrokerEventEnvelope,
  BrokerReconciliationResult,
  ReconciliationDrift,
} from "../brokerTypes.ts";
import type {
  ArenaEvent,
  ExecutionFill,
  OrderIntent,
  PortfolioSnapshot,
} from "../types.ts";
import type { ConcreteCredentialStore } from "../governance/credentialStore.ts";

// ─── Config ───────────────────────────────────────────────────────────────────

export interface AlpacaPaperAdapterConfig {
  /** Alpaca Paper base URL. Default: https://paper-api.alpaca.markets */
  baseUrl: string;
  /**
   * Position quantity drift tolerance (whole shares) before reconciliation fails.
   * Differences ≤ this value are accepted as rounding noise.
   */
  driftToleranceShares: number;
  /**
   * Cash drift tolerance (USD) before reconciliation fails.
   * Differences ≤ this value are accepted as floating-point rounding noise.
   */
  driftToleranceCash: number;
  /**
   * Milliseconds between fill-status poll attempts.
   * Market orders on Alpaca Paper typically fill within 1–3 seconds.
   */
  fillPollIntervalMs: number;
  /**
   * Maximum number of poll attempts before declaring a fill timeout.
   * Total max wait = fillPollIntervalMs × fillPollMaxRetries.
   */
  fillPollMaxRetries: number;
}

export const DEFAULT_ALPACA_PAPER_ADAPTER_CONFIG: AlpacaPaperAdapterConfig = {
  baseUrl: "https://paper-api.alpaca.markets",
  driftToleranceShares: 1,
  driftToleranceCash: 10,
  fillPollIntervalMs: 1_000,
  fillPollMaxRetries: 15,
};

// ─── AlpacaPaperAdapter ───────────────────────────────────────────────────────

export class AlpacaPaperAdapter implements BrokerAdapter {
  readonly mode: BrokerAdapterMode = "paper";

  constructor(
    private readonly store: ConcreteCredentialStore,
    private readonly config: AlpacaPaperAdapterConfig = DEFAULT_ALPACA_PAPER_ADAPTER_CONFIG,
  ) {}

  // ─── BrokerAdapter implementation ────────────────────────────────────────

  /**
   * Submit a market order to Alpaca Paper and wait for confirmation.
   *
   * 1. Retrieve credentials (throws GateDisarmedError if not armed).
   * 2. Translate the broker-neutral OrderIntent → AlpacaOrderRequest.
   * 3. POST /v2/orders.
   * 4. Poll GET /v2/orders/{id} until status = "filled".
   * 5. Return an ExecutionFill built from the confirmed Alpaca response.
   *
   * Throws on: gate not armed, network error, HTTP error, fill timeout.
   * The caller (PaperLeagueRunner) disarms the gate on any throw.
   */
  async executeAsync(
    intent: OrderIntent,
    portfolio: PortfolioSnapshot,
    context: OrderExecutionContext,
  ): Promise<ExecutionFill> {
    const creds = this.store.get(); // throws GateDisarmedError if not armed

    const orderRequest = this.toAlpacaOrder(intent, portfolio, context);

    // POST order
    const submitResponse = await this._request<AlpacaOrderResponse>(
      "POST",
      "/v2/orders",
      creds,
      orderRequest,
    );

    // Poll for fill confirmation
    const filledOrder = await this._pollForFill(submitResponse.id, creds);
    return this.fromAlpacaFill(filledOrder);
  }

  /**
   * Fetch the Alpaca account snapshot and compare it to the engine's
   * internal portfolio state for cash and position drift.
   */
  async reconcileAccount(
    enginePortfolio: PortfolioSnapshot,
  ): Promise<BrokerReconciliationResult> {
    const creds = this.store.get();

    const [accountData, positionData] = await Promise.all([
      this._request<{
        id: string;
        account_number: string;
        status: string;
        cash: string;
        portfolio_value: string;
        buying_power: string;
      }>("GET", "/v2/account", creds),
      this._request<Array<{
        symbol: string;
        qty: string;
        avg_entry_price: string;
        market_value: string;
        unrealized_pl: string;
      }>>("GET", "/v2/positions", creds),
    ]);

    const brokerSnapshot: AlpacaAccountSnapshot = {
      id: accountData.id,
      account_number: accountData.account_number,
      status: accountData.status,
      cash: accountData.cash,
      portfolio_value: accountData.portfolio_value,
      buying_power: accountData.buying_power,
      positions: positionData.map((p) => ({
        symbol: p.symbol,
        qty: p.qty,
        avg_entry_price: p.avg_entry_price,
        market_value: p.market_value,
        unrealized_pl: p.unrealized_pl,
      })),
      orders_pending: [],
      fetched_at: Date.now(),
    };

    const drifts: ReconciliationDrift[] = [];

    // ── Cash drift check ──────────────────────────────────────────────────
    const brokerCash = parseFloat(brokerSnapshot.cash);
    const cashDelta = Math.abs(brokerCash - enginePortfolio.cash);
    if (cashDelta > this.config.driftToleranceCash) {
      drifts.push({
        engineValue: enginePortfolio.cash,
        brokerValue: brokerCash,
        delta: brokerCash - enginePortfolio.cash,
      });
    }

    // ── Position drift check (per symbol) ─────────────────────────────────
    const brokerQtyMap = new Map(
      brokerSnapshot.positions.map((p) => [p.symbol, parseFloat(p.qty)]),
    );
    const engineQtyMap = new Map(
      enginePortfolio.positions.map((p) => [p.symbol, p.quantity]),
    );
    const allSymbols = new Set([...brokerQtyMap.keys(), ...engineQtyMap.keys()]);
    for (const sym of allSymbols) {
      const brokerQty = brokerQtyMap.get(sym) ?? 0;
      const engineQty = engineQtyMap.get(sym) ?? 0;
      const delta = Math.abs(brokerQty - engineQty);
      if (delta > this.config.driftToleranceShares) {
        drifts.push({
          symbol: sym,
          engineValue: engineQty,
          brokerValue: brokerQty,
          delta: brokerQty - engineQty,
        });
      }
    }

    return {
      ok: drifts.length === 0,
      drifts,
      engineSnapshot: enginePortfolio,
      brokerSnapshot,
      reconciledAt: Date.now(),
    };
  }

  /**
   * Translate a raw broker event envelope to an ArenaEvent.
   *
   * Alpaca delivers order lifecycle events (fills, cancels, rejects) over
   * the WebSocket `trade_updates` stream; account balance changes over
   * `account_updates`. This method is called by the session runner when
   * events arrive so they are emitted to the event log.
   *
   * Mapping:
   *   trade_updates with event=fill     → ORDER_FILL
   *   trade_updates with event=rejected → ORDER_REJECTED
   *   account_updates                   → PORTFOLIO_UPDATE (WARNING placeholder)
   *   connection_error / auth_error     → WARNING
   */
  ingestBrokerEvent(envelope: BrokerEventEnvelope): ArenaEvent {
    const now = envelope.receivedAt;

    if (envelope.type === "trade_updates") {
      const raw = envelope.raw;
      const event = String(raw["event"] ?? "");
      if (event === "fill" || event === "partial_fill") {
        // clientOrderId format: "{botId}_league_{timestamp}_{seq}" (set by PaperLeagueRunner).
        // Extract botId by splitting on the first "_league_" separator.
        const rawClientId = String(raw["client_order_id"] ?? "");
        const leagueSep = rawClientId.indexOf("_league_");
        const botId: string | null = leagueSep > 0 ? rawClientId.slice(0, leagueSep) : null;
        return {
          type: "ORDER_FILL",
          timestamp: now,
          candleIndex: 0,
          botId,
          payload: { brokerEvent: event, raw: raw },
        };
      }
      if (event === "rejected" || event === "canceled") {
        return {
          type: "ORDER_REJECTED",
          timestamp: now,
          candleIndex: 0,
          botId: null,
          payload: { reason: `broker event: ${event}`, raw: raw },
        };
      }
    }

    // Default: surface as WARNING
    return {
      type: "WARNING",
      timestamp: now,
      candleIndex: 0,
      botId: null,
      payload: { brokerEventType: envelope.type, raw: envelope.raw },
    };
  }

  // ─── Public account helpers ───────────────────────────────────────────────

  /**
   * Fetch the current cash balance from the Alpaca Paper account.
   *
   * Called by `usePaperLeague.startSession()` in alpaca-paper mode to determine
   * `initialUnallocatedCash` before constructing `PaperLeagueRunner`. This ensures
   * the engine's total portfolio cash matches the broker account balance at session
   * start, so the first reconciliation does not produce a spurious drift.
   *
   * Requires the gate to be ARMED (credentials available via `store.get()`).
   * Throws on network error, HTTP error, or if the gate is not armed.
   */
  async fetchAccountCash(): Promise<number> {
    const creds = this.store.get(); // throws GateDisarmedError if not armed
    const account = await this._request<{ cash: string }>(
      "GET",
      "/v2/account",
      creds,
    );
    return parseFloat(account.cash);
  }

  // ─── Public conversion helpers (also called by executeAsync) ─────────────

  /**
   * Translate a broker-neutral OrderIntent into an AlpacaOrderRequest.
   *
   * Size mapping:
   *   quantity         → { qty: String(quantity) }
   *   targetAllocation → { notional: (equity × fraction).toFixed(2) }
   *   sellPercent      → { qty: String(floor(posQty × fraction)) }
   *   closePosition    → { qty: String(posQty) }
   *
   * `client_order_id` is taken from `context.clientOrderId` (generated by
   * PaperLeagueRunner before submission) so Alpaca can correlate fills back
   * to the correct bot sleeve via the trade_updates stream.
   */
  toAlpacaOrder(
    intent: OrderIntent,
    portfolio: PortfolioSnapshot,
    context: OrderExecutionContext,
  ): AlpacaOrderRequest {
    const base: AlpacaOrderRequest = {
      symbol: intent.symbol,
      side: intent.side,
      type: "market",
      time_in_force: "day",
      client_order_id: context.clientOrderId,
    };

    const size = intent.size;

    if (intent.side === "buy") {
      switch (size.type) {
        case "quantity":
          return { ...base, qty: String(size.quantity) };
        case "targetAllocation": {
          const fraction = Math.max(0, Math.min(1, size.fraction));
          const notional = (portfolio.equity * fraction).toFixed(2);
          return { ...base, notional };
        }
        default:
          // Sell-side sizes on a buy intent: treat as zero-quantity (will be
          // rejected by governance before reaching here, but guard defensively).
          return { ...base, qty: "0" };
      }
    } else {
      // sell
      const pos = portfolio.positions.find((p) => p.symbol === intent.symbol);
      const posQty = pos?.quantity ?? 0;

      switch (size.type) {
        case "quantity":
          return { ...base, qty: String(Math.min(size.quantity, posQty)) };
        case "sellPercent": {
          const fraction = Math.max(0, Math.min(1, size.fraction));
          return { ...base, qty: String(Math.floor(posQty * fraction)) };
        }
        case "closePosition":
          return { ...base, qty: String(posQty) };
        default:
          return { ...base, qty: String(posQty) };
      }
    }
  }

  /**
   * Convert a filled AlpacaOrderResponse into an ExecutionFill.
   * Throws if the order is not in "filled" status or filled_avg_price is missing.
   */
  fromAlpacaFill(response: AlpacaOrderResponse): ExecutionFill {
    if (response.status !== "filled") {
      throw new Error(
        `AlpacaPaperAdapter.fromAlpacaFill: order ${response.id} is ${response.status}, not filled`,
      );
    }
    if (response.filled_avg_price === null) {
      throw new Error(
        `AlpacaPaperAdapter.fromAlpacaFill: order ${response.id} has null filled_avg_price`,
      );
    }
    return {
      side: response.side,
      symbol: response.symbol,
      quantity: parseFloat(response.filled_qty),
      price: parseFloat(response.filled_avg_price),
      fee: 0, // Alpaca Paper charges $0 commission on US equity market orders
      timestamp: response.filled_at ? Date.parse(response.filled_at) : Date.now(),
    };
  }

  // ─── Private helpers ──────────────────────────────────────────────────────

  /**
   * Poll GET /v2/orders/{id} until the order reaches a terminal status.
   * Returns the order response when status === "filled".
   * Throws if the order is rejected/canceled/expired, or if the poll times out.
   */
  private async _pollForFill(
    orderId: string,
    creds: { apiKey: string; apiSecret: string },
  ): Promise<AlpacaOrderResponse> {
    const TERMINAL_FAIL = new Set([
      "canceled", "expired", "rejected", "done_for_day", "replaced",
    ]);

    for (let attempt = 0; attempt < this.config.fillPollMaxRetries; attempt++) {
      const order = await this._request<AlpacaOrderResponse>(
        "GET",
        `/v2/orders/${encodeURIComponent(orderId)}`,
        creds,
      );

      if (order.status === "filled") return order;

      if (TERMINAL_FAIL.has(order.status)) {
        throw new Error(
          `AlpacaPaperAdapter: order ${orderId} reached terminal status "${order.status}" without filling`,
        );
      }

      // Wait before next poll
      if (attempt < this.config.fillPollMaxRetries - 1) {
        await _sleep(this.config.fillPollIntervalMs);
      }
    }

    throw new Error(
      `AlpacaPaperAdapter: fill timeout for order ${orderId} after ` +
      `${this.config.fillPollMaxRetries} polls (${this.config.fillPollIntervalMs}ms interval)`,
    );
  }

  /**
   * Generic fetch helper — builds headers, checks HTTP status, parses JSON.
   * Throws a descriptive Error on HTTP errors or network failures.
   */
  private async _request<T>(
    method: "GET" | "POST",
    path: string,
    creds: { apiKey: string; apiSecret: string },
    body?: unknown,
  ): Promise<T> {
    const url = `${this.config.baseUrl}${path}`;
    const init: RequestInit = {
      method,
      headers: {
        "APCA-API-KEY-ID": creds.apiKey,
        "APCA-API-SECRET-KEY": creds.apiSecret,
        ...(body !== undefined ? { "Content-Type": "application/json" } : {}),
      },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    };

    let response: Response;
    try {
      response = await fetch(url, init);
    } catch (err) {
      throw new Error(
        `AlpacaPaperAdapter: network error on ${method} ${path}: ` +
        `${err instanceof Error ? err.message : String(err)}`,
      );
    }

    if (!response.ok) {
      let bodyText = "";
      try { bodyText = await response.text(); } catch { /* ignore */ }
      throw new Error(
        `AlpacaPaperAdapter: HTTP ${response.status} on ${method} ${path}` +
        `${bodyText ? ` — ${bodyText}` : ""}`,
      );
    }

    try {
      return (await response.json()) as T;
    } catch (err) {
      throw new Error(
        `AlpacaPaperAdapter: failed to parse JSON response from ${method} ${path}: ` +
        `${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function _sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
