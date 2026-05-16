/**
 * Governance engine — the safety rules applied before any order intent
 * is submitted to the broker adapter.
 *
 * Rules are applied in priority order. The first failing rule short-circuits
 * evaluation and its rejection reason is returned. All rules pass → ok.
 *
 * Rule registry (in priority order):
 *   1. GATE_ARMED           — gate must be ARMED (hard stop)
 *   2. BOT_ELIGIBILITY      — bot must be ACTIVE; blocks PAUSED / ELIMINATED / NEEDS_REVIEW / RETIRED bots
 *   3. SYMBOL_ALLOWLIST     — symbol must be in config.allowedSymbols
 *   4. MAX_ORDERS_PER_DAY   — daily order count must be below config.maxOrdersPerDay (per bot)
 *   5. MAX_REALIZED_DAILY_LOSS — cumulative daily realised loss below config.maxRealizedDailyLossUsd (per bot)
 *   6. MAX_ORDER_NOTIONAL   — single order notional ≤ config.maxOrderNotional
 *   7. MAX_POSITION_SIZE    — projected position ≤ config.maxPositionFractionOfEquity × equity
 *   8. BOT_CAPITAL_ALLOC    — order notional ≤ remaining bot capital allocation (per bot)
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
import type { BotEligibilityStatus } from "../leagueTypes.ts";

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
  | "BOT_ELIGIBILITY"
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

/** Eligibility record stored per bot. */
export interface EligibilityRecord {
  status: BotEligibilityStatus;
  /** Human-readable reason; undefined when status is ACTIVE. */
  reason?: string;
}

export class GovernanceEngine {
  /** Per-bot governance stats keyed by botId. Lazily initialised on first access. */
  private readonly botStats: Map<string, GovernanceBotStats> = new Map();

  /**
   * Per-bot eligibility status. Bots not in this map are treated as ACTIVE
   * (backward-compatible with PaperSessionRunner, which never sets eligibility).
   */
  private readonly botEligibility: Map<string, EligibilityRecord> = new Map();

  /**
   * Per-bot capital allocation overrides (USD).
   * When set, overrides config.botCapitalAllocationUsd for BOT_CAPITAL_ALLOC checks.
   * Used by PaperLeagueRunner to enforce per-sleeve limits.
   */
  private readonly botCapitalOverrides: Map<string, number> = new Map();

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
      () => this._checkBotEligibility(botId),
      () => this._checkSymbolAllowlist(intent),
      () => this._checkMaxOrdersPerDay(botId, stats),
      () => this._checkMaxRealizedDailyLoss(botId, stats),
      () => this._checkMaxOrderNotional(intent, portfolio, priceHint),
      () => this._checkMaxPositionSize(intent, portfolio, priceHint),
      () => this._checkBotCapitalAlloc(intent, portfolio, priceHint, stats, botId),
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

  /**
   * Reset per-bot stats for the given bot.
   *
   * Call this at the start of each new paper session to prevent stale
   * counters (daily orders, realised loss, committed capital) from a
   * previous session bleeding into the next one. Without this, a bot
   * that held a position at the end of session N will still show
   * `committedCapitalUsd > 0` at the start of session N+1, causing
   * BOT_CAPITAL_ALLOC to block the first order of the fresh session.
   *
   * The GovernanceEngine is intentionally created once per panel mount
   * (not per session) so the gate and audit references stay stable;
   * resetStats() is the explicit reset point for session boundaries.
   *
   * @param botId      The bot whose stats should be reset.
   * @param forceReset When true (default): always clears all counters — the
   *   correct behaviour for simulated replay, tests, and any context where you
   *   want a guaranteed clean slate regardless of clock state.
   *   When false: daily order/loss counters are preserved if the current UTC
   *   calendar day has NOT changed since they were last recorded, preventing
   *   circumvention of daily limits by restarting a session intra-day. The
   *   committedCapitalUsd counter is always zeroed (it tracks open positions
   *   for a session, not a day). Use `false` for real Alpaca Paper sessions.
   */
  resetStats(botId: string, forceReset = true): void {
    if (forceReset) {
      this.botStats.set(botId, makeEmptyBotStats());
      return;
    }
    // Date-aware reset for real paper/live trading: preserve daily counters
    // if we are still within the same UTC calendar day.
    const existing = this.botStats.get(botId);
    const today = utcDayKey(Date.now());
    if (!existing || today !== existing.dayKey) {
      // New UTC day — a full reset is safe.
      this.botStats.set(botId, makeEmptyBotStats());
    } else {
      // Same day — preserve daily counters, only reset session-scoped tracking.
      this.botStats.set(botId, {
        ...existing,
        committedCapitalUsd: 0,
      });
    }
  }

  // ─── Eligibility & per-bot capital ───────────────────────────────────────

  /**
   * Set the eligibility status for a bot.
   * Called by PaperLeagueRunner when pausing, resuming, eliminating, or
   * refunding a bot. The GovernanceEngine enforces it as rule #2.
   */
  setEligibilityStatus(botId: string, status: BotEligibilityStatus, reason?: string): void {
    this.botEligibility.set(botId, reason !== undefined ? { status, reason } : { status });
  }

  /**
   * Read the current eligibility record for a bot.
   * Bots not in the eligibility map default to ACTIVE — this preserves
   * backward compatibility with PaperSessionRunner, which never sets eligibility.
   */
  getEligibility(botId: string): EligibilityRecord {
    return this.botEligibility.get(botId) ?? { status: "ACTIVE" };
  }

  /**
   * Override the per-bot capital allocation used by the BOT_CAPITAL_ALLOC rule.
   * When set, takes precedence over config.botCapitalAllocationUsd for this bot.
   * Used by PaperLeagueRunner to enforce individual sleeve limits.
   */
  setBotCapitalAllocation(botId: string, usd: number): void {
    this.botCapitalOverrides.set(botId, Math.max(0, usd));
  }

  // ─── Rule implementations ────────────────────────────────────────────────

  private _checkBotEligibility(botId: string): GovernanceResult | null {
    const record = this.botEligibility.get(botId);
    // Bots not in the map default to ACTIVE — backward-compatible.
    if (!record || record.status === "ACTIVE") return null;
    return {
      ok: false,
      blockedBy: "BOT_ELIGIBILITY",
      reason: `bot is ${record.status}${record.reason ? `: ${record.reason}` : ""}`,
    };
  }

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
    botId: string,
  ): GovernanceResult | null {
    if (intent.side !== "buy") return null;

    const estimatedQty = this._estimateBuyQty(intent, portfolio, priceHint);
    const orderNotional = estimatedQty * priceHint;
    // Per-bot override takes precedence over the global config value.
    const allocationUsd = this.botCapitalOverrides.get(botId) ?? this.config.botCapitalAllocationUsd;
    const remainingAllocation = allocationUsd - stats.committedCapitalUsd;

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
