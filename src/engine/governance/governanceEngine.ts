/**
 * Governance engine — the safety rules applied before any order intent
 * is submitted to the broker adapter.
 *
 * Rules are applied in priority order. The first failing rule short-circuits
 * evaluation and its rejection reason is returned. All rules pass → ok.
 *
 * Rule registry (in priority order):
 *   1. GATE_ARMED           — gate must be ARMED (hard stop)
 *   2. SYMBOL_ALLOWLIST     — symbol must be in config.allowedSymbols
 *   3. MAX_ORDERS_PER_DAY   — daily order count must be below config.maxOrdersPerDay (per bot)
 *   4. MAX_REALIZED_DAILY_LOSS — cumulative daily realised loss below config.maxRealizedDailyLossUsd (per bot)
 *   5. MAX_ORDER_NOTIONAL   — single order notional ≤ config.maxOrderNotional
 *   6. MAX_POSITION_SIZE    — projected position ≤ config.maxPositionFractionOfEquity × equity
 *   7. BOT_CAPITAL_ALLOC    — order notional ≤ remaining bot capital allocation (per bot)
 *
 * All per-bot state (daily order count, daily loss, committed capital) is
 * tracked by botId. Each bot has independent counters so one bot's activity
 * does not affect another's limits.
 *
 * Callers must pass the bot's id to check(), recordOrderSubmitted(),
 * recordRealisedPnl(), and setCommittedCapital().
 */

import type { OrderIntent, PortfolioSnapshot } from "../types.ts";
import type { EnablementGate, PaperAdapterConfig } from "../brokerTypes.ts";
import type { AuditLog } from "./auditLog.ts";

// ─── Public types ─────────────────────────────────────────────────────────────

export interface GovernanceResult {
  ok: boolean;
  /** Rule name that blocked the intent; undefined when ok === true. */
  blockedBy?: GovernanceRuleName;
  /** Human-readable rejection reason; undefined when ok === true. */
  reason?: string;
}

export type GovernanceRuleName =
  | "GATE_ARMED"
  | "SYMBOL_ALLOWLIST"
  | "MAX_ORDERS_PER_DAY"
  | "MAX_REALIZED_DAILY_LOSS"
  | "MAX_ORDER_NOTIONAL"
  | "MAX_POSITION_SIZE"
  | "BOT_CAPITAL_ALLOC";

// ─── Per-bot session state ────────────────────────────────────────────────────

export interface GovernanceBotStats {
  /** Number of orders submitted today for this bot (resets on UTC day change). */
  dailyOrderCount: number;
  /**
   * Cumulative **realised** loss today for this bot, as a positive number (USD).
   * Unrealised losses are not included — see MAX_REALIZED_DAILY_LOSS rule comment.
   */
  realizedDailyLossUsd: number;
  /** Total capital committed to open positions for this bot (USD notional). */
  committedCapitalUsd: number;
  /** UTC calendar date (YYYY-MM-DD) when daily counters were last reset. */
  dayKey: string;
}

/** @deprecated Use getStats(botId) — this alias is kept for backwards compat in tests. */
export type GovernanceSessionStats = GovernanceBotStats;

function utcDayKey(now: number): string {
  const d = new Date(now);
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, "0");
  const day = String(d.getUTCDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

function makeEmptyBotStats(): GovernanceBotStats {
  return {
    dailyOrderCount: 0,
    realizedDailyLossUsd: 0,
    committedCapitalUsd: 0,
    dayKey: utcDayKey(Date.now()),
  };
}

// ─── GovernanceEngine ─────────────────────────────────────────────────────────

export class GovernanceEngine {
  /** Per-bot state keyed by botId. Lazily initialised on first access. */
  private readonly botStats: Map<string, GovernanceBotStats> = new Map();

  constructor(
    private readonly config: PaperAdapterConfig,
    private readonly gate: EnablementGate,
    private readonly auditLog: AuditLog,
  ) {}

  /**
   * Evaluate all governance rules against an incoming order intent.
   *
   * @param intent     The strategy's requested order.
   * @param portfolio  Current engine portfolio snapshot for this bot.
   * @param priceHint  Estimated fill price (latest close used in paper mode).
   * @param botId      The bot submitting the intent — used for per-bot stat tracking.
   */
  check(
    intent: OrderIntent,
    portfolio: PortfolioSnapshot,
    priceHint: number,
    botId: string,
  ): GovernanceResult {
    const stats = this._getOrCreate(botId);
    this._maybeResetDay(botId, stats);

    const rules: Array<() => GovernanceResult | null> = [
      () => this._checkGateArmed(),
      () => this._checkSymbolAllowlist(intent),
      () => this._checkMaxOrdersPerDay(botId, stats),
      () => this._checkMaxRealizedDailyLoss(botId, stats),
      () => this._checkMaxOrderNotional(intent, portfolio, priceHint),
      () => this._checkMaxPositionSize(intent, portfolio, priceHint),
      () => this._checkBotCapitalAlloc(intent, portfolio, priceHint, stats),
    ];

    for (const rule of rules) {
      const result = rule();
      if (result !== null) {
        this.auditLog.record(
          "GOVERNANCE_CHECK",
          `BLOCKED by ${result.blockedBy}: ${result.reason}`,
          {
            botId,
            blockedBy: result.blockedBy,
            reason: result.reason,
            intent: { side: intent.side, symbol: intent.symbol, size: intent.size },
          },
        );
        return result;
      }
    }

    this.auditLog.record("GOVERNANCE_CHECK", "All governance rules passed", {
      botId,
      intent: { side: intent.side, symbol: intent.symbol, size: intent.size },
      dailyOrderCount: stats.dailyOrderCount,
      realizedDailyLossUsd: stats.realizedDailyLossUsd,
    });
    return { ok: true };
  }

  /**
   * Record that an order was submitted for this bot.
   * Increments the per-bot daily order counter.
   */
  recordOrderSubmitted(botId: string): void {
    const stats = this._getOrCreate(botId);
    this._maybeResetDay(botId, stats);
    stats.dailyOrderCount += 1;
  }

  /**
   * Record realised PnL from a completed fill for this bot.
   * `realisedPnl` is signed: negative = loss, positive = profit.
   */
  recordRealisedPnl(botId: string, realisedPnl: number): void {
    const stats = this._getOrCreate(botId);
    if (realisedPnl < 0) {
      stats.realizedDailyLossUsd += Math.abs(realisedPnl);
    }
  }

  /**
   * Update committed capital (total notional of open positions) for this bot.
   * Called by the session runner after each fill settles.
   */
  setCommittedCapital(botId: string, usd: number): void {
    const stats = this._getOrCreate(botId);
    stats.committedCapitalUsd = Math.max(0, usd);
  }

  /** Read-only snapshot of current session stats for the given bot. */
  getStats(botId: string): Readonly<GovernanceBotStats> {
    return { ...this._getOrCreate(botId) };
  }

  // ─── Rule implementations ────────────────────────────────────────────────

  private _checkGateArmed(): GovernanceResult | null {
    if (this.gate.status !== "ARMED") {
      return {
        ok: false,
        blockedBy: "GATE_ARMED",
        reason: `gate is ${this.gate.status} — arm before trading`,
      };
    }
    return null;
  }

  private _checkSymbolAllowlist(intent: OrderIntent): GovernanceResult | null {
    if (!this.config.allowedSymbols.includes(intent.symbol)) {
      return {
        ok: false,
        blockedBy: "SYMBOL_ALLOWLIST",
        reason: `${intent.symbol} is not in the symbol allowlist`,
      };
    }
    return null;
  }

  private _checkMaxOrdersPerDay(
    _botId: string,
    stats: GovernanceBotStats,
  ): GovernanceResult | null {
    if (stats.dailyOrderCount >= this.config.maxOrdersPerDay) {
      return {
        ok: false,
        blockedBy: "MAX_ORDERS_PER_DAY",
        reason: `daily order limit reached (${stats.dailyOrderCount}/${this.config.maxOrdersPerDay})`,
      };
    }
    return null;
  }

  private _checkMaxRealizedDailyLoss(
    _botId: string,
    stats: GovernanceBotStats,
  ): GovernanceResult | null {
    if (stats.realizedDailyLossUsd >= this.config.maxRealizedDailyLossUsd) {
      return {
        ok: false,
        blockedBy: "MAX_REALIZED_DAILY_LOSS",
        reason: `realized daily loss limit reached ($${stats.realizedDailyLossUsd.toFixed(2)} / $${this.config.maxRealizedDailyLossUsd.toFixed(2)}) — unrealized losses not included`,
      };
    }
    return null;
  }

  private _checkMaxOrderNotional(
    intent: OrderIntent,
    portfolio: PortfolioSnapshot,
    priceHint: number,
  ): GovernanceResult | null {
    if (intent.side !== "buy") return null;
    const estimatedQty = this._estimateBuyQty(intent, portfolio, priceHint);
    const orderNotional = estimatedQty * priceHint;
    if (orderNotional > this.config.maxOrderNotional) {
      return {
        ok: false,
        blockedBy: "MAX_ORDER_NOTIONAL",
        reason: `order notional $${orderNotional.toFixed(2)} exceeds maxOrderNotional $${this.config.maxOrderNotional.toFixed(2)}`,
      };
    }
    return null;
  }

  private _checkMaxPositionSize(
    intent: OrderIntent,
    portfolio: PortfolioSnapshot,
    priceHint: number,
  ): GovernanceResult | null {
    if (intent.side !== "buy") return null;

    const estimatedQty = this._estimateBuyQty(intent, portfolio, priceHint);
    const existingPosition = portfolio.positions.find((p) => p.symbol === intent.symbol);
    const existingQty = existingPosition?.quantity ?? 0;
    const totalQty = existingQty + estimatedQty;
    const projectedPositionValue = totalQty * priceHint;
    const maxAllowed = portfolio.equity * this.config.maxPositionFractionOfEquity;

    if (projectedPositionValue > maxAllowed) {
      return {
        ok: false,
        blockedBy: "MAX_POSITION_SIZE",
        reason: `projected position $${projectedPositionValue.toFixed(2)} exceeds max allowed $${maxAllowed.toFixed(2)} (${(this.config.maxPositionFractionOfEquity * 100).toFixed(0)}% of equity)`,
      };
    }
    return null;
  }

  private _checkBotCapitalAlloc(
    intent: OrderIntent,
    portfolio: PortfolioSnapshot,
    priceHint: number,
    stats: GovernanceBotStats,
  ): GovernanceResult | null {
    if (intent.side !== "buy") return null;

    const estimatedQty = this._estimateBuyQty(intent, portfolio, priceHint);
    const orderNotional = estimatedQty * priceHint;
    const remainingAllocation = this.config.botCapitalAllocationUsd - stats.committedCapitalUsd;

    if (orderNotional > remainingAllocation) {
      return {
        ok: false,
        blockedBy: "BOT_CAPITAL_ALLOC",
        reason: `order notional $${orderNotional.toFixed(2)} exceeds remaining bot allocation $${remainingAllocation.toFixed(2)}`,
      };
    }
    return null;
  }

  // ─── Helpers ──────────────────────────────────────────────────────────────

  private _getOrCreate(botId: string): GovernanceBotStats {
    if (!this.botStats.has(botId)) {
      this.botStats.set(botId, makeEmptyBotStats());
    }
    return this.botStats.get(botId)!;
  }

  private _estimateBuyQty(
    intent: OrderIntent,
    portfolio: PortfolioSnapshot,
    priceHint: number,
  ): number {
    if (priceHint <= 0) return 0;
    const size = intent.size;
    switch (size.type) {
      case "quantity":
        return size.quantity;
      case "targetAllocation":
        return Math.floor((portfolio.equity * size.fraction) / priceHint);
      case "sellPercent":
      case "closePosition":
        return 0;
    }
  }

  /** Reset daily counters for this bot if the UTC calendar day has changed. */
  private _maybeResetDay(botId: string, stats: GovernanceBotStats): void {
    const today = utcDayKey(Date.now());
    if (today !== stats.dayKey) {
      stats.dailyOrderCount = 0;
      stats.realizedDailyLossUsd = 0;
      stats.dayKey = today;
      this.auditLog.record("SESSION_START", `Daily counters reset for ${botId} on ${today}`, {
        botId,
        dayKey: today,
      });
    }
  }
}
