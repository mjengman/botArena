/**
 * PaperSessionRunner — async event-driven orchestration loop for one bot/account.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * ARCHITECTURE NOTE (ADR — Option B, single-bot scope)
 * ─────────────────────────────────────────────────────────────────────────────
 * One runner = one bot = one BrokerAdapter = one Alpaca account.
 *
 * This is the correct boundary for live-money safety: each bot/account pair
 * has its own gate, its own governance engine, its own audit log, and its own
 * credential store. Running N bots means creating N runners.
 *
 * The backtest simulation (createSimulation) accepts multiple bot specs
 * because deterministic replay is side-effect-free. A paper/live runner
 * cannot share a broker account across bots without creating conflicting
 * orders, reconciliation ambiguity, and muddled audit trails.
 *
 * Execution model:
 *   start()               → session-start reconciliation (fail-closed)
 *   tick(candle, history) → strategy → GovernanceEngine.check() → executeAsync()
 *                           → applyFill() → update portfolio + governance stats
 *   end()                 → session-end reconciliation (fail-closed)
 *
 * Fail-closed policy:
 *   Any broker error, reconciliation exception, or reconciliation drift
 *   immediately disarms the gate. No further orders may be placed.
 *
 * Shared domain with createSimulation:
 *   BotSpec, StrategyFn, StrategyContext, OrderIntent, applyFill(),
 *   makePortfolioSnapshot(), ArenaEvent vocabulary, MetricSnapshot, rankBots().
 */

import type {
  BotInstance,
  BotSpec,
  Candle,
  SimulationConfig,
} from "./types.ts";
import { EventLog } from "./events.ts";
import type { BrokerAdapter } from "./adapter.ts";
import { applyFill, makePortfolioSnapshot } from "./portfolio.ts";
import type { GovernanceEngine } from "./governance/governanceEngine.ts";
import type { AuditLog } from "./governance/auditLog.ts";
import type { BrokerReconciliationResult, EnablementGate } from "./brokerTypes.ts";

// ─── PaperSessionState ────────────────────────────────────────────────────────

export interface PaperSessionState {
  /** Wall-clock timestamp (Unix ms) when start() was called. */
  startedAt: number | null;
  /** Whether the runner is currently active (between start() and end()). */
  running: boolean;
  /** Number of candles processed since start(). */
  candlesProcessed: number;
  /**
   * The single bot instance managed by this runner.
   * Typed the same as simulation BotInstance — shared domain.
   */
  bot: BotInstance;
}

// ─── PaperSessionRunner ───────────────────────────────────────────────────────

export class PaperSessionRunner {
  private readonly log = new EventLog();
  private readonly state: PaperSessionState;
  private readonly symbol: string;

  /**
   * @param config     Simulation config (startingCash, feeBps, slippageBps, seed).
   * @param botSpec    The single bot managed by this runner.
   * @param adapter    The broker adapter for this bot's Alpaca account.
   * @param governance GovernanceEngine configured for this bot/account.
   * @param auditLog   Append-only audit log for this session.
   * @param gate       EnablementGate for this bot/account.
   * @param symbol     The market symbol being traded (e.g. "AAPL").
   */
  constructor(
    private readonly config: SimulationConfig,
    private readonly botSpec: BotSpec,
    private readonly adapter: BrokerAdapter,
    private readonly governance: GovernanceEngine,
    private readonly auditLog: AuditLog,
    private readonly gate: EnablementGate,
    symbol: string,
  ) {
    this.symbol = symbol;
    this.state = {
      startedAt: null,
      running: false,
      candlesProcessed: 0,
      bot: this._makeBotInstance(),
    };
  }

  /**
   * Start the session. Gate must already be ARMED by the caller.
   *
   * Performs a session-start reconciliation before allowing any order.
   * Fails closed: if reconciliation throws or returns ok === false, the
   * gate is disarmed and this method throws.
   *
   * @throws GateDisarmedError  if gate is not ARMED.
   * @throws Error              if session-start reconciliation fails or drifts.
   */
  async start(): Promise<void> {
    this.gate.assertArmed();

    if (this.state.running) {
      throw new Error("PaperSessionRunner.start(): session already running");
    }

    const bot = this.state.bot;

    // ── Session-start reconciliation (fail-closed) ─────────────────────────
    let reconcileResult: Awaited<ReturnType<typeof this.adapter.reconcileAccount>>;
    try {
      reconcileResult = await this.adapter.reconcileAccount(bot.portfolio);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this.auditLog.record("ERROR", `Session-start reconciliation threw: ${msg}`, {
        botId: bot.spec.id,
        error: msg,
      });
      this.gate.disarm(`reconciliation error on session start: ${msg}`);
      throw new Error(`Session-start reconciliation failed: ${msg}`);
    }

    this.auditLog.record(
      "RECONCILIATION",
      `Session-start reconciliation: ${reconcileResult.ok ? "OK" : "DRIFT"}`,
      { botId: bot.spec.id, ok: reconcileResult.ok, driftCount: reconcileResult.drifts.length },
    );

    if (!reconcileResult.ok) {
      this.log.emit("RECONCILIATION_DRIFT", Date.now(), 0, bot.spec.id, {
        drifts: reconcileResult.drifts,
        mode: "paper",
        phase: "session-start",
      });
      this.auditLog.record("RECONCILIATION_DRIFT", `Drift on session start`, {
        botId: bot.spec.id,
        drifts: reconcileResult.drifts,
      });
      this.gate.disarm("reconciliation drift on session start");
      throw new Error(`Session-start reconciliation drift for ${bot.spec.id}`);
    }

    // ── Session is open ───────────────────────────────────────────────────
    this.state.running = true;
    this.state.startedAt = Date.now();

    this.auditLog.record("SESSION_START", "Paper session started", {
      symbol: this.symbol,
      botId: bot.spec.id,
      startedAt: this.state.startedAt,
    });

    this.log.emit("MATCH_START", this.state.startedAt, 0, null, {
      symbol: this.symbol,
      botId: bot.spec.id,
      mode: "paper",
    });

    this.log.emit("PAPER_MODE_ARMED", this.state.startedAt, 0, null, {
      message: "Paper trading gate ARMED — session started",
      botId: bot.spec.id,
    });
  }

  /**
   * Advance the session by one candle.
   *
   * 1. Build strategy context (identical shape to simulation context).
   * 2. Call strategy.fn(ctx) → OrderIntent | null.
   * 3. GovernanceEngine.check() — if blocked, emit ORDER_REJECTED and return.
   * 4. adapter.executeAsync() — await broker fill (fail-closed on error).
   * 5. applyFill() → update portfolio and governance stats.
   * 6. Emit ArenaEvents and AuditLog entries.
   */
  async tick(candle: Candle, candleHistory: readonly Candle[]): Promise<void> {
    if (!this.state.running) {
      throw new Error("PaperSessionRunner.tick(): call start() first");
    }

    const candleIndex = this.state.candlesProcessed;
    const bot = this.state.bot;

    this.log.emit("CANDLE_OPEN", candle.timestamp, candleIndex, null, {
      open: candle.open,
      high: candle.high,
      low: candle.low,
      close: candle.close,
      volume: candle.volume,
      mode: "paper",
    });

    // Mark-to-market at candle open
    const portfolio = makePortfolioSnapshot(bot, { [this.symbol]: candle.close });
    bot.portfolio = portfolio;

    // Build strategy context (identical shape to simulation)
    const ctx = {
      symbol: this.symbol,
      candle,
      candleIndex,
      allCandles: candleHistory,
      portfolio,
      botState: bot.state,
      config: this.config,
      seed: this.config.seed ^ _hashString(bot.spec.id),
    };

    // Run strategy
    let intent: ReturnType<typeof bot.spec.strategy.fn>;
    try {
      intent = bot.spec.strategy.fn(ctx);
    } catch (err) {
      const msg = String(err);
      this.log.emit("WARNING", candle.timestamp, candleIndex, bot.spec.id, {
        message: `Strategy threw: ${msg}`,
        mode: "paper",
      });
      this.auditLog.record("ERROR", `Strategy ${bot.spec.id} threw: ${msg}`, {
        botId: bot.spec.id,
        error: msg,
      });
      this._recordEquity(bot, candle);
      this.state.candlesProcessed++;
      return;
    }

    if (!intent) {
      this._recordEquity(bot, candle);
      this.state.candlesProcessed++;
      return;
    }

    this.log.emit("ORDER_INTENT", candle.timestamp, candleIndex, bot.spec.id, {
      side: intent.side,
      symbol: intent.symbol,
      size: intent.size,
      mode: "paper",
    });

    this.auditLog.record("ORDER_INTENT", `${bot.spec.id}: ${intent.side} ${intent.symbol}`, {
      botId: bot.spec.id,
      intent: { side: intent.side, symbol: intent.symbol, size: intent.size },
      candleIndex,
    });

    // ── Governance check ──────────────────────────────────────────────────
    const govResult = this.governance.check(intent, portfolio, candle.close, bot.spec.id);

    if (!govResult.ok) {
      this.log.emit("ORDER_REJECTED", candle.timestamp, candleIndex, bot.spec.id, {
        reason: `GOVERNANCE:${govResult.blockedBy} — ${govResult.reason}`,
        side: intent.side,
        symbol: intent.symbol,
        mode: "paper",
      });
      // Audit entry already recorded inside governance.check()
      this._recordEquity(bot, candle);
      this.state.candlesProcessed++;
      return;
    }

    // ── Submit to broker (fail-closed on any error) ───────────────────────
    this.governance.recordOrderSubmitted(bot.spec.id);
    this.auditLog.record("ORDER_SUBMITTED", `${bot.spec.id}: submitting ${intent.side} ${intent.symbol}`, {
      botId: bot.spec.id,
      intent: { side: intent.side, symbol: intent.symbol, size: intent.size },
      candleIndex,
    });

    let fill: Awaited<ReturnType<typeof this.adapter.executeAsync>>;
    try {
      fill = await this.adapter.executeAsync(intent, portfolio);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this.log.emit("ORDER_REJECTED", candle.timestamp, candleIndex, bot.spec.id, {
        reason: `BROKER_ERROR: ${msg}`,
        side: intent.side,
        symbol: intent.symbol,
        mode: "paper",
      });
      this.auditLog.record("ORDER_REJECTED", `Broker error: ${msg}`, {
        botId: bot.spec.id,
        error: msg,
        candleIndex,
      });
      // Fail closed
      this.gate.disarm(`broker error: ${msg}`);
      this.log.emit("WARNING", candle.timestamp, candleIndex, null, {
        message: `Gate DISARMED due to broker error: ${msg}`,
        mode: "paper",
      });
      this._recordEquity(bot, candle);
      this.state.candlesProcessed++;
      return;
    }

    // ── Apply fill ────────────────────────────────────────────────────────
    const pnlBefore = bot.portfolio.realizedPnl;
    applyFill(bot, fill);
    bot.portfolio = makePortfolioSnapshot(bot, { [this.symbol]: candle.close });

    const realisedPnl = bot.portfolio.realizedPnl - pnlBefore;
    this.governance.recordRealisedPnl(bot.spec.id, realisedPnl);

    const committedUsd = bot.portfolio.positions.reduce(
      (sum, p) => sum + p.quantity * candle.close,
      0,
    );
    this.governance.setCommittedCapital(bot.spec.id, committedUsd);

    this.log.emit("ORDER_FILL", candle.timestamp, candleIndex, bot.spec.id, {
      side: fill.side,
      symbol: fill.symbol,
      quantity: fill.quantity,
      price: fill.price,
      fee: fill.fee,
      cashAfter: bot.cash,
      equityAfter: bot.portfolio.equity,
      mode: "paper",
    });

    this.log.emit("PORTFOLIO_UPDATE", candle.timestamp, candleIndex, bot.spec.id, {
      cash: bot.portfolio.cash,
      equity: bot.portfolio.equity,
      exposure: bot.portfolio.exposure,
      mode: "paper",
    });

    this.auditLog.record("ORDER_FILL", `${bot.spec.id}: fill ${fill.side} ${fill.quantity}@${fill.price}`, {
      botId: bot.spec.id,
      fill: { side: fill.side, symbol: fill.symbol, quantity: fill.quantity, price: fill.price, fee: fill.fee },
      equityAfter: bot.portfolio.equity,
      candleIndex,
    });

    this._recordEquity(bot, candle);
    this.state.candlesProcessed++;
  }

  /**
   * Gracefully end the session.
   *
   * Performs a final reconciliation. Fails closed: if reconciliation throws
   * or returns ok === false, the gate is disarmed. Records SESSION_END regardless.
   */
  async end(): Promise<void> {
    if (!this.state.running) return;
    this.state.running = false;

    if (this.gate.status === "ARMED") {
      const bot = this.state.bot;
      let reconcileResult: BrokerReconciliationResult | null = null;
      try {
        reconcileResult = await this.adapter.reconcileAccount(bot.portfolio);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        this.auditLog.record("ERROR", `Session-end reconciliation threw: ${msg}`, {
          botId: bot.spec.id,
          error: msg,
        });
        this.gate.disarm(`reconciliation error at session end: ${msg}`);
        // reconcileResult stays null — fall through to SESSION_END
      }

      if (reconcileResult !== null) {
        this.auditLog.record(
          "RECONCILIATION",
          `Session-end reconciliation: ${reconcileResult.ok ? "OK" : "DRIFT"}`,
          { botId: bot.spec.id, ok: reconcileResult.ok, driftCount: reconcileResult.drifts.length },
        );

        if (!reconcileResult.ok) {
          this.log.emit("RECONCILIATION_DRIFT", Date.now(), this.state.candlesProcessed, bot.spec.id, {
            drifts: reconcileResult.drifts,
            mode: "paper",
            phase: "session-end",
          });
          this.auditLog.record("RECONCILIATION_DRIFT", `Drift on session end`, {
            botId: bot.spec.id,
            drifts: reconcileResult.drifts,
          });
          this.gate.disarm("reconciliation drift at session end");
        }
      }
    }

    this.auditLog.record("SESSION_END", "Paper session ended", {
      botId: this.state.bot.spec.id,
      candlesProcessed: this.state.candlesProcessed,
      endedAt: Date.now(),
    });

    this.log.emit("MATCH_END", Date.now(), this.state.candlesProcessed, null, {
      mode: "paper",
      botId: this.state.bot.spec.id,
      candlesProcessed: this.state.candlesProcessed,
    });
  }

  /** Read-only snapshot of current session state. */
  getState(): Readonly<PaperSessionState> {
    return { ...this.state };
  }

  /** Access the arena event log for this session. */
  getEvents(): ReturnType<EventLog["getAll"]> {
    return this.log.getAll();
  }

  // ─── Private ──────────────────────────────────────────────────────────────

  private _makeBotInstance(): BotInstance {
    const spec = this.botSpec;
    return {
      spec,
      cash: this.config.startingCash,
      positions: new Map(),
      realizedPnl: 0,
      state: { ...(spec.params ?? spec.strategy.defaultParams ?? {}) },
      trades: [],
      fillHistory: [],
      equityHistory: [],
      exposedCandles: 0,
      portfolio: {
        cash: this.config.startingCash,
        positions: [],
        equity: this.config.startingCash,
        realizedPnl: 0,
        unrealizedPnl: 0,
        exposure: 0,
      },
    };
  }

  /** Record mark-to-market equity and exposure at candle close. */
  private _recordEquity(bot: BotInstance, candle: Candle): void {
    const snap = makePortfolioSnapshot(bot, { [this.symbol]: candle.close });
    bot.equityHistory.push(snap.equity);
    bot.portfolio = snap;
    if (bot.positions.size > 0) bot.exposedCandles++;
  }
}

function _hashString(s: string): number {
  let h = 0;
  for (let i = 0; i < s.length; i++) {
    h = (Math.imul(31, h) + s.charCodeAt(i)) | 0;
  }
  return h >>> 0;
}
