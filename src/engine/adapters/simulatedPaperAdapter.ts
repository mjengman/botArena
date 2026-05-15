/**
 * SimulatedPaperAdapter — an in-process BrokerAdapter for UI integration
 * testing without a real Alpaca Paper API connection.
 *
 * Fills are computed using the same slippage + fee math as `executeOrder()`,
 * applied to a price injected via `setCurrentCandle()`. Reconciliation always
 * returns ok (no real broker state to drift from). Credential access is
 * exercised via the gate lifecycle, but the adapter never makes HTTP calls.
 *
 * Usage:
 *   const adapter = new SimulatedPaperAdapter("ARENA", 5, 5);
 *   adapter.setCurrentCandle(candle.close, candle.timestamp);
 *   const fill = await adapter.executeAsync(intent, portfolio);
 *
 * This adapter is intentionally NOT wired to production Alpaca endpoints.
 * All fills are simulated — suitable for local development and UI smoke tests.
 */

import type { BrokerAdapter, BrokerAdapterMode, OrderExecutionContext } from "../adapter.ts";
import type {
  AlpacaAccountSnapshot,
  BrokerEventEnvelope,
  BrokerReconciliationResult,
} from "../brokerTypes.ts";
import type {
  ArenaEvent,
  ExecutionFill,
  OrderIntent,
  PortfolioSnapshot,
} from "../types.ts";

export class SimulatedPaperAdapter implements BrokerAdapter {
  readonly mode: BrokerAdapterMode = "paper";

  private currentPrice = 0;
  private currentTimestamp = Date.now();

  constructor(
    private readonly feeBps: number,
    private readonly slippageBps: number,
  ) {}

  /**
   * Inject the current candle's price and timestamp before calling tick().
   * The session runner calls this once per candle before submitting any order.
   */
  setCurrentCandle(price: number, timestamp: number): void {
    this.currentPrice = price;
    this.currentTimestamp = timestamp;
  }

  /**
   * Simulate a fill using the injected price ± slippage and fee.
   * Mirrors the fill-price math in `executeOrder()`.
   *
   * Throws if:
   *   - Current price is zero (call setCurrentCandle first).
   *   - Resolved quantity is zero (intent results in a zero-share order).
   *   - Insufficient cash for a buy (portfolio.cash < order cost).
   */
  async executeAsync(
    intent: OrderIntent,
    portfolio: PortfolioSnapshot,
    _context: OrderExecutionContext,
  ): Promise<ExecutionFill> {
    const basePrice = this.currentPrice;
    if (basePrice <= 0) {
      throw new Error(
        "SimulatedPaperAdapter.executeAsync: currentPrice is zero — call setCurrentCandle() first",
      );
    }

    const slippageFraction = this.slippageBps / 10_000;
    const fillPrice =
      intent.side === "buy"
        ? basePrice * (1 + slippageFraction)
        : basePrice * (1 - slippageFraction);

    let quantity =
      intent.side === "buy"
        ? this._resolveBuyQty(intent, portfolio, fillPrice)
        : this._resolveSellQty(intent, portfolio);

    quantity = Math.floor(quantity);

    if (quantity <= 0) {
      throw new Error(
        `SimulatedPaperAdapter.executeAsync: zero quantity resolved for ${intent.side} ${intent.symbol}`,
      );
    }

    const feeFraction = this.feeBps / 10_000;

    if (intent.side === "buy") {
      const totalCost = quantity * fillPrice * (1 + feeFraction);
      if (totalCost > portfolio.cash) {
        quantity = Math.floor(portfolio.cash / (fillPrice * (1 + feeFraction)));
        if (quantity <= 0) {
          throw new Error(
            "SimulatedPaperAdapter.executeAsync: insufficient cash for buy order",
          );
        }
      }
    }

    const fee = quantity * fillPrice * feeFraction;

    return {
      side: intent.side,
      symbol: intent.symbol,
      quantity,
      price: fillPrice,
      fee,
      timestamp: this.currentTimestamp,
    };
  }

  /**
   * Reconciliation always returns ok — there is no real broker to drift from.
   * Constructs a synthetic AlpacaAccountSnapshot mirroring the engine state.
   */
  async reconcileAccount(
    enginePortfolio: PortfolioSnapshot,
  ): Promise<BrokerReconciliationResult> {
    const now = Date.now();

    const brokerSnapshot: AlpacaAccountSnapshot = {
      id: "simulated",
      account_number: "SIMULATED-PAPER",
      status: "ACTIVE",
      cash: String(enginePortfolio.cash.toFixed(2)),
      portfolio_value: String(enginePortfolio.equity.toFixed(2)),
      buying_power: String((enginePortfolio.cash * 2).toFixed(2)),
      positions: enginePortfolio.positions.map((p) => ({
        symbol: p.symbol,
        qty: String(p.quantity),
        avg_entry_price: String(p.avgCost.toFixed(4)),
        market_value: String((p.quantity * this.currentPrice).toFixed(2)),
        unrealized_pl: String(
          (p.quantity * (this.currentPrice - p.avgCost)).toFixed(2),
        ),
      })),
      orders_pending: [],
      fetched_at: now,
    };

    return {
      ok: true,
      drifts: [],
      engineSnapshot: enginePortfolio,
      brokerSnapshot,
      reconciledAt: now,
    };
  }

  /**
   * Convert a raw broker event envelope to an ArenaEvent.
   * The simulated adapter never emits real broker events, so this is a
   * passthrough that wraps the raw payload in a WARNING event.
   */
  ingestBrokerEvent(envelope: BrokerEventEnvelope): ArenaEvent {
    return {
      type: "WARNING",
      timestamp: envelope.receivedAt,
      candleIndex: 0,
      botId: null,
      payload: { brokerEventType: envelope.type, raw: envelope.raw },
    };
  }

  // ─── Private helpers ──────────────────────────────────────────────────────

  private _resolveBuyQty(
    intent: OrderIntent,
    portfolio: PortfolioSnapshot,
    fillPrice: number,
  ): number {
    const size = intent.size;
    if (size.type === "quantity") return size.quantity;
    if (size.type === "targetAllocation") {
      const fraction = Math.max(0, Math.min(1, size.fraction));
      return fillPrice > 0 ? (portfolio.equity * fraction) / fillPrice : 0;
    }
    return 0;
  }

  private _resolveSellQty(
    intent: OrderIntent,
    portfolio: PortfolioSnapshot,
  ): number {
    const pos = portfolio.positions.find((p) => p.symbol === intent.symbol);
    if (!pos || pos.quantity <= 0) return 0;

    const size = intent.size;
    if (size.type === "quantity") return Math.min(size.quantity, pos.quantity);
    if (size.type === "sellPercent") {
      const fraction = Math.max(0, Math.min(1, size.fraction));
      return pos.quantity * fraction;
    }
    if (size.type === "closePosition") return pos.quantity;
    return 0;
  }
}
