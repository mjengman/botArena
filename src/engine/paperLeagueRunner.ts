/**
 * PaperLeagueRunner — multi-bot, shared-account paper trading orchestrator.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * ARCHITECTURE (from roadmap ADR, resolved M11)
 * ─────────────────────────────────────────────────────────────────────────────
 * One runner = one BrokerAdapter = one Alpaca Paper account = N bots.
 *
 * Each bot has a capital "sleeve" — an internal ledger entry tracking its
 * starting allocation, current equity, and eligibility status. The broker sees
 * one account; the league runner enforces sleeve boundaries via GovernanceEngine.
 *
 * PaperSessionRunner (M7/M8) is retained as the single-bot rehearsal primitive.
 * It is NOT used here. The league runner manages all per-bot state directly to
 * keep fill attribution and account-level reconciliation unambiguous.
 *
 * Session flow:
 *   start()  → gate.assertArmed() → account-level reconciliation (fail-closed)
 *   tick()   → per-bot: strategy → governance → executeAsync → applyFill
 *              → mark-to-market all sleeves → auto-elimination check
 *   end()    → account-level reconciliation → SESSION_END audit entry
 *
 * Reconciliation (account-level):
 *   The total account portfolio (sum of all sleeve portfolios) is reconciled
 *   against the broker. Any drift DISARMS THE GATE FOR ALL BOTS — not just
 *   the bot whose order preceded the drift.
 *
 * Bot eligibility lifecycle:
 *   pauseBot(id)             — ACTIVE → PAUSED (user-controlled)
 *   resumeBot(id)            — PAUSED → ACTIVE (user-controlled)
 *   eliminateBot(id)         — any non-terminal → ELIMINATED (auto or user)
 *   retireBot(id)            — any non-terminal → RETIRED (user; terminal)
 *   clearBot(id)             — NEEDS_REVIEW → ACTIVE (user clears a safety-rule flag)
 *   refundBot(id, amt)       — inject capital from unallocated pool; ELIMINATED → ACTIVE
 *   withdrawCapital(id, amt) — remove cash from sleeve to unallocated pool (no status change)
 *
 * NEEDS_REVIEW is set automatically when a governance safety-rule fires
 * (MAX_ORDERS_PER_DAY, MAX_REALIZED_DAILY_LOSS, MAX_ORDER_NOTIONAL,
 *  MAX_POSITION_SIZE, BOT_CAPITAL_ALLOC). The bot is halted until clearBot().
 *
 * Auto-elimination: if a bot's equity falls below AUTO_ELIMINATION_THRESHOLD ×
 * startingCapital at any candle close, it is eliminated automatically.
 */

import type { BotSpec, BotInstance, Candle, Position, PortfolioSnapshot, SimulationConfig } from "./types.ts";
import type { BrokerAdapter, OrderExecutionContext } from "./adapter.ts";
import type { GovernanceEngine } from "./governance/governanceEngine.ts";
import type { AuditLog } from "./governance/auditLog.ts";
import type { EnablementGate, BrokerReconciliationResult } from "./brokerTypes.ts";
import { EventLog } from "./events.ts";
import { applyFill, makePortfolioSnapshot } from "./portfolio.ts";
import type { BotAllocation, LeagueState } from "./leagueTypes.ts";
import { AUTO_ELIMINATION_THRESHOLD, isTerminalStatus } from "./leagueTypes.ts";

// ─── Internal sleeve ──────────────────────────────────────────────────────────

interface BotSleeve {
  spec: BotSpec;
  instance: BotInstance;
  /** USD amount allocated to this bot at construction (immutable). */
  startingCapital: number;
  /**
   * Current governance capital allocation for this bot (USD).
   * Starts equal to `startingCapital`; changes via withdrawCapital() and refundBot().
   * Kept in sync with governance.setBotCapitalAllocation() at all times.
   */
  currentAllocation: number;
  /**
   * Equity snapshot at the moment this bot was eliminated, captured for
   * competition/leaderboard display. Undefined for non-eliminated bots.
   *
   * After elimination the sleeve continues to be mark-to-market in tick() so
   * that `_buildTotalPortfolio()` stays accurate for account-level reconciliation
   * (open positions still move in the shared Alpaca account). Use `eliminatedAtEquity`
   * for competition standings; use `sleeve.instance.portfolio.equity` for accounting.
   */
  eliminatedAtEquity?: number;
}

// ─── PaperLeagueRunner ────────────────────────────────────────────────────────

export class PaperLeagueRunner {
  private readonly log = new EventLog();
  private readonly sleeves: Map<string, BotSleeve> = new Map();
  private running = false;
  private startedAt: number | null = null;
  private candlesProcessed = 0;
  /**
   * Cash that has been withdrawn from sleeves (via withdrawCapital) but not yet
   * assigned to any bot. Still sits in the broker account — included in
   * `_buildTotalPortfolio()` so reconciliation stays accurate.
   */
  private unallocatedCash = 0;

  /**
   * @param config                  Shared simulation config (feeBps, slippageBps, seed).
   * @param botSpecs                The bots competing in this league session.
   * @param allocations             Per-bot starting capital: botId → USD amount.
   *                                Bots not in the map fall back to config.startingCash.
   * @param adapter                 The single broker adapter for the shared account.
   * @param governance              GovernanceEngine — must outlive this runner.
   * @param auditLog                Append-only audit log — must outlive this runner.
   * @param gate                    EnablementGate — must outlive this runner.
   * @param symbol                  Market symbol being traded by all bots (e.g. "AAPL").
   * @param initialUnallocatedCash  Cash in the broker account that is not assigned to any
   *                                bot sleeve. Defaults to 0. Use this when the bot sleeves
   *                                do not consume the full account balance at session start —
   *                                including it here ensures `_buildTotalPortfolio()` matches
   *                                the broker account total so reconciliation does not drift.
   */
  constructor(
    private readonly config: SimulationConfig,
    botSpecs: BotSpec[],
    allocations: Record<string, number>,
    private readonly adapter: BrokerAdapter,
    private readonly governance: GovernanceEngine,
    private readonly auditLog: AuditLog,
    private readonly gate: EnablementGate,
    private readonly symbol: string,
    initialUnallocatedCash = 0,
  ) {
    if (!Number.isFinite(initialUnallocatedCash) || initialUnallocatedCash < 0) {
      throw new Error(
        `PaperLeagueRunner: initialUnallocatedCash must be a finite non-negative number, ` +
        `got ${initialUnallocatedCash}`,
      );
    }
    this.unallocatedCash = initialUnallocatedCash;
    for (const spec of botSpecs) {
      const rawAlloc = allocations[spec.id];
      // P2: validate any explicit allocation — fall back to config.startingCash
      // only when the bot has no entry in the map at all.
      if (rawAlloc !== undefined) {
        if (!Number.isFinite(rawAlloc) || rawAlloc < 0) {
          throw new Error(
            `PaperLeagueRunner: invalid capital allocation for bot "${spec.id}": ${rawAlloc} ` +
            `(must be a finite non-negative number)`,
          );
        }
      }
      const startingCapital = rawAlloc ?? config.startingCash;
      const instance = _makeBotInstance(spec, startingCapital);
      this.sleeves.set(spec.id, { spec, instance, startingCapital, currentAllocation: startingCapital });
      // Register per-bot capital allocation with governance so BOT_CAPITAL_ALLOC
      // enforces the sleeve limit rather than the global config default.
      governance.setBotCapitalAllocation(spec.id, startingCapital);
    }
  }

  // ─── Session lifecycle ────────────────────────────────────────────────────

  /**
   * Start the league session. Gate must already be ARMED by the caller.
   *
   * Performs an account-level session-start reconciliation (fail-closed):
   * if reconciliation throws or finds drift, the gate is disarmed and this
   * method throws. No tick() calls may be made until start() succeeds.
   *
   * @throws GateDisarmedError  if the gate is not ARMED.
   * @throws Error              if session-start reconciliation fails or drifts.
   */
  async start(): Promise<void> {
    this.gate.assertArmed();
    if (this.running) {
      throw new Error("PaperLeagueRunner.start(): session already running");
    }

    await this._reconcile("session-start");

    this.running = true;
    this.startedAt = Date.now();

    this.auditLog.record("SESSION_START", "League session started", {
      symbol: this.symbol,
      botCount: this.sleeves.size,
      startedAt: this.startedAt,
      allocations: Object.fromEntries(
        Array.from(this.sleeves.entries()).map(([id, s]) => [id, s.startingCapital]),
      ),
    });

    this.log.emit("MATCH_START", this.startedAt, 0, null, {
      symbol: this.symbol,
      mode: "paper-league",
      botCount: this.sleeves.size,
    });
  }

  /**
   * Advance the session by one candle.
   *
   * For each ACTIVE bot:
   *   1. Mark-to-market at this candle's close.
   *   2. Build strategy context and call strategy.fn().
   *   3. Run GovernanceEngine.check() — skip if rejected.
   *   4. Call adapter.executeAsync() — disarm gate on broker error.
   *   5. Apply fill; update governance stats.
   *
   * After all bots are processed, mark-to-market all remaining sleeves and
   * check for auto-elimination (equity < AUTO_ELIMINATION_THRESHOLD × currentAllocation).
   *
   * The caller is responsible for calling adapter.setCurrentCandle() (or
   * equivalent) before tick() if the adapter requires it.
   */
  async tick(candle: Candle, candleHistory: readonly Candle[]): Promise<void> {
    if (!this.running) {
      throw new Error("PaperLeagueRunner.tick(): call start() first");
    }

    const candleIndex = this.candlesProcessed;

    this.log.emit("CANDLE_OPEN", candle.timestamp, candleIndex, null, {
      open: candle.open, high: candle.high, low: candle.low,
      close: candle.close, volume: candle.volume, mode: "paper-league",
    });

    // ── Per-bot strategy + order submission ──────────────────────────────
    for (const [botId, sleeve] of this.sleeves) {
      const eligibility = this.governance.getEligibility(botId);
      if (eligibility.status !== "ACTIVE") continue;
      await this._tickBot(sleeve, candle, candleHistory, candleIndex);
    }

    // ── Mark-to-market all sleeves + auto-elimination ─────────────────────
    //
    // Mark-to-market runs for ALL non-RETIRED sleeves, including ELIMINATED ones.
    // In a shared Alpaca account, open positions keep moving regardless of the
    // bot's eligibility status. Updating their portfolio value here keeps
    // _buildTotalPortfolio() accurate so account-level reconciliation does not
    // produce false drift. Use `sleeve.eliminatedAtEquity` for competition display;
    // use `sleeve.instance.portfolio.equity` for accounting/reconciliation.
    for (const [botId, sleeve] of this.sleeves) {
      const { status } = this.governance.getEligibility(botId);
      if (isTerminalStatus(status)) continue; // RETIRED only — permanently frozen

      sleeve.instance.portfolio = makePortfolioSnapshot(
        sleeve.instance, { [this.symbol]: candle.close },
      );
      sleeve.instance.equityHistory.push(sleeve.instance.portfolio.equity);
      if (sleeve.instance.positions.size > 0) sleeve.instance.exposedCandles++;

      // Auto-elimination check only applies to bots that are not already eliminated.
      // Uses currentAllocation (not startingCapital) so that a withdrawCapital()
      // call never causes a false elimination — the threshold scales with the
      // bot's active budget, not its immutable original allocation.
      if (status === "ELIMINATED") continue;

      const threshold = AUTO_ELIMINATION_THRESHOLD * sleeve.currentAllocation;
      if (sleeve.instance.portfolio.equity < threshold) {
        this._eliminateBot(
          botId,
          sleeve,
          `auto-eliminated: equity $${sleeve.instance.portfolio.equity.toFixed(2)} is below ` +
          `${(AUTO_ELIMINATION_THRESHOLD * 100).toFixed(0)}% of current allocation ` +
          `$${sleeve.currentAllocation.toFixed(2)}`,
        );
      }
    }

    this.candlesProcessed++;
  }

  /**
   * Gracefully end the session.
   *
   * Performs an account-level session-end reconciliation (fail-closed) if the
   * gate is still ARMED. Records SESSION_END regardless of reconciliation outcome.
   * Safe to call when no session is running.
   */
  async end(): Promise<void> {
    if (!this.running) return;
    this.running = false;

    if (this.gate.status === "ARMED") {
      try {
        await this._reconcile("session-end");
      } catch {
        // _reconcile already disarms the gate and records audit entries.
      }
    }

    this.auditLog.record("SESSION_END", "League session ended", {
      candlesProcessed: this.candlesProcessed,
      endedAt: Date.now(),
    });

    this.log.emit("MATCH_END", Date.now(), this.candlesProcessed, null, {
      mode: "paper-league",
      candlesProcessed: this.candlesProcessed,
    });
  }

  // ─── Bot eligibility lifecycle ────────────────────────────────────────────

  /**
   * Pause a bot. The bot holds its open positions but may not submit new orders.
   * @throws Error if the bot is not currently ACTIVE.
   */
  pauseBot(botId: string): void {
    this._assertBotExists(botId);
    const { status } = this.governance.getEligibility(botId);
    if (status !== "ACTIVE") {
      throw new Error(`pauseBot: bot "${botId}" is ${status} (must be ACTIVE to pause)`);
    }
    this.governance.setEligibilityStatus(botId, "PAUSED", "paused by user");
    this.auditLog.record("GOVERNANCE_CHECK", `Bot "${botId}" paused by user`, {
      botId, status: "PAUSED",
    });
  }

  /**
   * Resume a paused bot.
   * @throws Error if the bot is not currently PAUSED.
   */
  resumeBot(botId: string): void {
    this._assertBotExists(botId);
    const { status } = this.governance.getEligibility(botId);
    if (status !== "PAUSED") {
      throw new Error(`resumeBot: bot "${botId}" is ${status} (must be PAUSED to resume)`);
    }
    this.governance.setEligibilityStatus(botId, "ACTIVE");
    this.auditLog.record("GOVERNANCE_CHECK", `Bot "${botId}" resumed by user`, {
      botId, status: "ACTIVE",
    });
  }

  /**
   * Eliminate a bot. The bot's positions are frozen; no further orders may be placed.
   * Idempotent if the bot is already RETIRED (terminal). ELIMINATED is not terminal
   * in the lifecycle — the user may still retire or clear the bot.
   */
  eliminateBot(botId: string, reason = "eliminated by user"): void {
    this._assertBotExists(botId);
    const { status } = this.governance.getEligibility(botId);
    if (isTerminalStatus(status)) return; // RETIRED is terminal — idempotent
    this._eliminateBot(botId, this.sleeves.get(botId)!, reason);
  }

  /**
   * Retire a bot (terminal — no recovery). No further orders or state changes
   * are possible. Use when permanently removing a bot from the league.
   * @throws Error if the bot is already RETIRED.
   */
  retireBot(botId: string, reason = "retired by user"): void {
    this._assertBotExists(botId);
    const { status } = this.governance.getEligibility(botId);
    if (isTerminalStatus(status)) {
      throw new Error(`retireBot: bot "${botId}" is already RETIRED (terminal)`);
    }
    const sleeve = this.sleeves.get(botId)!;
    this.governance.setEligibilityStatus(botId, "RETIRED", reason);
    this.auditLog.record("GOVERNANCE_CHECK", `Bot "${botId}" retired: ${reason}`, {
      botId, status: "RETIRED", reason,
      finalEquity: sleeve.instance.portfolio.equity,
    });
    this.log.emit("WARNING", Date.now(), this.candlesProcessed, botId, {
      message: `Bot "${botId}" RETIRED — ${reason}`, mode: "paper-league",
    });
  }

  /**
   * Clear a bot that was halted by a governance safety-rule (NEEDS_REVIEW → ACTIVE).
   * The user acknowledges the flag and re-enables trading.
   * @throws Error if the bot is not currently NEEDS_REVIEW.
   */
  clearBot(botId: string): void {
    this._assertBotExists(botId);
    const { status } = this.governance.getEligibility(botId);
    if (status !== "NEEDS_REVIEW") {
      throw new Error(`clearBot: bot "${botId}" is ${status} (must be NEEDS_REVIEW to clear)`);
    }
    this.governance.setEligibilityStatus(botId, "ACTIVE");
    this.auditLog.record("GOVERNANCE_CHECK", `Bot "${botId}" cleared by user — resuming ACTIVE`, {
      botId, status: "ACTIVE",
    });
  }

  /**
   * Capital injection: transfer `amount` USD from the unallocated pool into this
   * bot's sleeve. If the bot is ELIMINATED, it is re-activated (ELIMINATED → ACTIVE).
   *
   * This is the "revive" path: a user can inject fresh capital and re-enable a
   * bot that was auto-eliminated or manually eliminated. Bots in PAUSED or
   * NEEDS_REVIEW status keep their current status; use resumeBot() / clearBot()
   * to re-activate them separately.
   *
   * Invariant: the total account value (all sleeves + unallocatedCash) is unchanged.
   *
   * @throws Error if the bot is RETIRED (terminal — no capital changes allowed).
   * @throws Error if `amount` exceeds the current unallocated cash balance.
   */
  refundBot(botId: string, amount: number): void {
    this._assertBotExists(botId);
    _assertValidAmount(amount, "refundBot", botId);
    const { status } = this.governance.getEligibility(botId);
    if (isTerminalStatus(status)) {
      throw new Error(`refundBot: bot "${botId}" is RETIRED (terminal — cannot modify)`);
    }
    if (amount > this.unallocatedCash) {
      throw new Error(
        `refundBot: requested injection $${amount.toFixed(2)} exceeds ` +
        `unallocated cash $${this.unallocatedCash.toFixed(2)}`,
      );
    }
    const sleeve = this.sleeves.get(botId)!;
    // Inject into sleeve cash, increase governance allocation, shrink unallocated pool.
    sleeve.instance.cash += amount;
    sleeve.currentAllocation += amount;
    this.governance.setBotCapitalAllocation(botId, sleeve.currentAllocation);
    this.unallocatedCash -= amount;
    this._syncPortfolioAfterCashChange(sleeve);

    // Re-activate eliminated bots automatically — the capital injection IS the re-enable signal.
    const wasEliminated = status === "ELIMINATED";
    if (wasEliminated) {
      this.governance.setEligibilityStatus(botId, "ACTIVE");
      // Clear the competition snapshot so it is only set while status === ELIMINATED.
      sleeve.eliminatedAtEquity = undefined;
    }

    this.auditLog.record("GOVERNANCE_CHECK",
      `Bot "${botId}" refundBot: +$${amount.toFixed(2)} injected`, {
        botId, amount,
        newCash: sleeve.instance.cash,
        newAllocation: sleeve.currentAllocation,
        unallocatedCash: this.unallocatedCash,
        reactivated: wasEliminated,
      },
    );
    this.log.emit("WARNING", Date.now(), this.candlesProcessed, botId, {
      message: wasEliminated
        ? `Bot "${botId}" REACTIVATED via refund: +$${amount.toFixed(2)} cash`
        : `Bot "${botId}" refunded +$${amount.toFixed(2)} — cash now $${sleeve.instance.cash.toFixed(2)}`,
      mode: "paper-league",
    });
  }

  /**
   * Withdraw capital from a bot's sleeve into the unallocated pool.
   * The bot continues trading with a reduced cash balance and capital allocation.
   * This is a pure ledger operation — eligibility status is unchanged.
   *
   * Invariant: the total account value (all sleeves + unallocatedCash) is unchanged.
   *
   * @throws Error if the bot is RETIRED (terminal).
   * @throws Error if `amount` exceeds the bot's current cash balance.
   */
  withdrawCapital(botId: string, amount: number): void {
    this._assertBotExists(botId);
    _assertValidAmount(amount, "withdrawCapital", botId);
    const { status } = this.governance.getEligibility(botId);
    if (isTerminalStatus(status)) {
      throw new Error(`withdrawCapital: bot "${botId}" is RETIRED (terminal — cannot modify)`);
    }
    const sleeve = this.sleeves.get(botId)!;
    // Guard against both over-withdrawal from cash and driving currentAllocation
    // negative. The tighter of the two bounds is the effective withdrawal limit.
    // A bot with cash > currentAllocation (due to realised profits) must not be
    // allowed to withdraw the difference — that would produce negative allocation
    // and a negative auto-elimination threshold.
    const maxWithdrawal = Math.min(sleeve.instance.cash, sleeve.currentAllocation);
    if (amount > maxWithdrawal) {
      throw new Error(
        `withdrawCapital: requested withdrawal $${amount.toFixed(2)} exceeds ` +
        `the allowable limit $${maxWithdrawal.toFixed(2)} for bot "${botId}" ` +
        `(cash: $${sleeve.instance.cash.toFixed(2)}, ` +
        `currentAllocation: $${sleeve.currentAllocation.toFixed(2)})`,
      );
    }
    // Deduct from sleeve cash, reduce governance allocation, grow unallocated pool.
    sleeve.instance.cash -= amount;
    sleeve.currentAllocation -= amount;
    this.governance.setBotCapitalAllocation(botId, sleeve.currentAllocation);
    this.unallocatedCash += amount;
    this._syncPortfolioAfterCashChange(sleeve);

    this.auditLog.record("GOVERNANCE_CHECK",
      `Bot "${botId}" withdrawCapital: -$${amount.toFixed(2)}`, {
        botId, amount,
        newCash: sleeve.instance.cash,
        newAllocation: sleeve.currentAllocation,
        unallocatedCash: this.unallocatedCash,
      },
    );
    this.log.emit("WARNING", Date.now(), this.candlesProcessed, botId, {
      message: `Bot "${botId}" withdrew $${amount.toFixed(2)} — continuing with $${sleeve.instance.cash.toFixed(2)} cash`,
      mode: "paper-league",
    });
  }

  // ─── State accessors ──────────────────────────────────────────────────────

  /** Current per-bot allocation state, in insertion order. */
  getAllocations(): BotAllocation[] {
    return Array.from(this.sleeves.values()).map((sleeve) => {
      const { status, reason } = this.governance.getEligibility(sleeve.spec.id);
      const currentEquity = sleeve.instance.portfolio.equity;
      return {
        botId: sleeve.spec.id,
        botName: sleeve.spec.name,
        startingCapital: sleeve.startingCapital,
        currentAllocation: sleeve.currentAllocation,
        allocationFraction: sleeve.startingCapital > 0
          ? sleeve.currentAllocation / sleeve.startingCapital
          : 0,
        currentEquity,
        equityFraction: sleeve.startingCapital > 0
          ? currentEquity / sleeve.startingCapital
          : 0,
        cumulativeRealisedPnl: sleeve.instance.realizedPnl,
        withdrawableCapital: Math.min(sleeve.instance.cash, sleeve.currentAllocation),
        status,
        ineligibilityReason: reason,
        eliminatedAtEquity: sleeve.eliminatedAtEquity,
      };
    });
  }

  /** Point-in-time snapshot of the league's running state. */
  getState(): LeagueState {
    return {
      running: this.running,
      startedAt: this.startedAt,
      candlesProcessed: this.candlesProcessed,
      allocations: this.getAllocations(),
      unallocatedCash: this.unallocatedCash,
    };
  }

  /** Arena event log for this session. */
  getEvents() {
    return this.log.getAll();
  }

  // ─── Private helpers ──────────────────────────────────────────────────────

  /** Run one candle tick for a single ACTIVE bot. */
  private async _tickBot(
    sleeve: BotSleeve,
    candle: Candle,
    candleHistory: readonly Candle[],
    candleIndex: number,
  ): Promise<void> {
    const bot = sleeve.instance;
    const botId = sleeve.spec.id;

    // Mark-to-market at candle open
    bot.portfolio = makePortfolioSnapshot(bot, { [this.symbol]: candle.close });

    // Build strategy context (identical shape to simulation)
    const ctx = {
      symbol: this.symbol,
      candle,
      candleIndex,
      allCandles: candleHistory,
      portfolio: bot.portfolio,
      botState: bot.state,
      config: this.config,
      seed: this.config.seed ^ _hashString(botId),
    };

    // Run strategy
    let intent: ReturnType<typeof sleeve.spec.strategy.fn>;
    try {
      intent = sleeve.spec.strategy.fn(ctx);
    } catch (err) {
      const msg = String(err);
      this.log.emit("WARNING", candle.timestamp, candleIndex, botId, {
        message: `Strategy "${botId}" threw: ${msg}`, mode: "paper-league",
      });
      this.auditLog.record("ERROR", `Strategy "${botId}" threw: ${msg}`, {
        botId, error: msg, candleIndex,
      });
      return;
    }

    if (!intent) return;

    this.log.emit("ORDER_INTENT", candle.timestamp, candleIndex, botId, {
      side: intent.side, symbol: intent.symbol, size: intent.size, mode: "paper-league",
    });

    // ── Governance check (includes BOT_ELIGIBILITY as rule #2) ────────────
    const govResult = this.governance.check(intent, bot.portfolio, candle.close, botId);
    if (!govResult.ok) {
      this.log.emit("ORDER_REJECTED", candle.timestamp, candleIndex, botId, {
        reason: `GOVERNANCE:${govResult.blockedBy} — ${govResult.reason}`,
        side: intent.side, symbol: intent.symbol, mode: "paper-league",
      });
      // Safety-rule blocks (not gate/eligibility/allowlist) transition the bot
      // to NEEDS_REVIEW so it is halted until a human clears it via clearBot().
      const safetyRules = new Set([
        "MAX_ORDERS_PER_DAY",
        "MAX_REALIZED_DAILY_LOSS",
        "MAX_ORDER_NOTIONAL",
        "MAX_POSITION_SIZE",
        "BOT_CAPITAL_ALLOC",
      ]);
      if (govResult.blockedBy && safetyRules.has(govResult.blockedBy)) {
        this.governance.setEligibilityStatus(
          botId, "NEEDS_REVIEW",
          `safety rule ${govResult.blockedBy} fired: ${govResult.reason}`,
        );
        this.auditLog.record("GOVERNANCE_CHECK",
          `Bot "${botId}" → NEEDS_REVIEW: ${govResult.blockedBy}`, {
            botId, rule: govResult.blockedBy, reason: govResult.reason,
          },
        );
        this.log.emit("WARNING", candle.timestamp, candleIndex, botId, {
          message: `Bot "${botId}" halted (NEEDS_REVIEW) — ${govResult.blockedBy}: ${govResult.reason}`,
          mode: "paper-league",
        });
      }
      return;
    }

    // ── Submit to broker (fail-closed on any error) ───────────────────────
    this.governance.recordOrderSubmitted(botId);
    this.auditLog.record("ORDER_SUBMITTED",
      `"${botId}": submitting ${intent.side} ${intent.symbol}`, {
        botId,
        intent: { side: intent.side, symbol: intent.symbol, size: intent.size },
        candleIndex,
      },
    );

    const context: OrderExecutionContext = {
      botId,
      clientOrderId: _generateOrderId(),
    };
    let fill: Awaited<ReturnType<typeof this.adapter.executeAsync>>;
    try {
      fill = await this.adapter.executeAsync(intent, bot.portfolio, context);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this.log.emit("ORDER_REJECTED", candle.timestamp, candleIndex, botId, {
        reason: `BROKER_ERROR: ${msg}`, side: intent.side, symbol: intent.symbol,
        mode: "paper-league",
      });
      this.auditLog.record("ORDER_REJECTED", `Broker error for "${botId}": ${msg}`, {
        botId, error: msg, candleIndex,
      });
      // Fail-closed: disarm gate so all bots are halted.
      this.gate.disarm(`broker error for "${botId}": ${msg}`);
      this.log.emit("WARNING", candle.timestamp, candleIndex, null, {
        message: `Gate DISARMED due to broker error for "${botId}": ${msg}`,
        mode: "paper-league",
      });
      return;
    }

    // ── Apply fill to this bot's sleeve ───────────────────────────────────
    const pnlBefore = bot.portfolio.realizedPnl;
    applyFill(bot, fill);
    bot.portfolio = makePortfolioSnapshot(bot, { [this.symbol]: candle.close });

    const realisedPnl = bot.portfolio.realizedPnl - pnlBefore;
    this.governance.recordRealisedPnl(botId, realisedPnl);

    const committedUsd = bot.portfolio.positions.reduce(
      (sum, p) => sum + p.quantity * candle.close, 0,
    );
    this.governance.setCommittedCapital(botId, committedUsd);

    this.log.emit("ORDER_FILL", candle.timestamp, candleIndex, botId, {
      side: fill.side, symbol: fill.symbol,
      quantity: fill.quantity, price: fill.price, fee: fill.fee,
      cashAfter: bot.cash, equityAfter: bot.portfolio.equity,
      mode: "paper-league",
    });

    this.auditLog.record("ORDER_FILL",
      `"${botId}": fill ${fill.side} ${fill.quantity}@${fill.price}`, {
        botId,
        fill: { side: fill.side, symbol: fill.symbol,
          quantity: fill.quantity, price: fill.price, fee: fill.fee },
        equityAfter: bot.portfolio.equity, candleIndex,
      },
    );
  }

  /**
   * Account-level reconciliation.
   *
   * Builds a total account portfolio (sum of all sleeve portfolios) and passes
   * it to adapter.reconcileAccount(). Any drift disarms the gate for ALL bots.
   */
  private async _reconcile(phase: "session-start" | "session-end"): Promise<void> {
    const totalPortfolio = this._buildTotalPortfolio();

    let result: BrokerReconciliationResult;
    try {
      result = await this.adapter.reconcileAccount(totalPortfolio);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this.auditLog.record("ERROR",
        `League reconciliation threw at ${phase}: ${msg}`, { phase, error: msg },
      );
      this.gate.disarm(`reconciliation error at ${phase}: ${msg}`);
      throw new Error(`League reconciliation failed at ${phase}: ${msg}`);
    }

    this.auditLog.record(
      "RECONCILIATION",
      `League ${phase} reconciliation: ${result.ok ? "OK" : "DRIFT"}`,
      { phase, ok: result.ok, driftCount: result.drifts.length },
    );

    if (!result.ok) {
      this.log.emit("RECONCILIATION_DRIFT", Date.now(), this.candlesProcessed, null, {
        drifts: result.drifts, mode: "paper-league", phase,
      });
      this.auditLog.record("RECONCILIATION_DRIFT",
        `League drift at ${phase} — gate DISARMED for all bots`, {
          phase, drifts: result.drifts,
        },
      );
      // Disarm gate: halts ALL bots.
      this.gate.disarm(`reconciliation drift at ${phase}`);
      throw new Error(`League reconciliation drift at ${phase}`);
    }
  }

  /**
   * Merge all sleeve portfolios into a single account-level PortfolioSnapshot.
   * Positions with the same symbol are combined (quantity summed, cost averaged).
   * Equity is the sum of all sleeve equities.
   *
   * IMPORTANT: `unallocatedCash` is included in both totalCash and totalEquity.
   * In a one-account model, unallocated cash is still broker-account cash — it
   * just hasn't been assigned to a bot sleeve yet. Omitting it would cause
   * reconciliation drift whenever a withdrawCapital() call has been made.
   */
  private _buildTotalPortfolio(): PortfolioSnapshot {
    let totalCash = 0;
    let totalEquity = 0;
    let totalRealizedPnl = 0;
    let totalUnrealizedPnl = 0;
    const posMap = new Map<string, { quantity: number; totalCost: number }>();

    for (const sleeve of this.sleeves.values()) {
      const p = sleeve.instance.portfolio;
      totalCash += p.cash;
      totalEquity += p.equity;
      totalRealizedPnl += p.realizedPnl;
      totalUnrealizedPnl += p.unrealizedPnl;

      for (const pos of p.positions) {
        const existing = posMap.get(pos.symbol);
        if (existing) {
          existing.totalCost += pos.avgCost * pos.quantity;
          existing.quantity += pos.quantity;
        } else {
          posMap.set(pos.symbol, {
            quantity: pos.quantity,
            totalCost: pos.avgCost * pos.quantity,
          });
        }
      }
    }

    // Unallocated cash lives in the broker account — include it so reconciliation
    // reflects the true account total after any withdrawCapital() / refundBot() calls.
    totalCash += this.unallocatedCash;
    totalEquity += this.unallocatedCash;

    const positions: Position[] = Array.from(posMap.entries()).map(
      ([symbol, { quantity, totalCost }]) => ({
        symbol,
        quantity,
        avgCost: quantity > 0 ? totalCost / quantity : 0,
      }),
    );

    return {
      cash: totalCash,
      positions,
      equity: totalEquity,
      realizedPnl: totalRealizedPnl,
      unrealizedPnl: totalUnrealizedPnl,
      exposure: totalEquity > 0 ? (totalEquity - totalCash) / totalEquity : 0,
    };
  }

  /**
   * Rebuild a sleeve's portfolio snapshot after a direct mutation of
   * `sleeve.instance.cash` (i.e. withdrawCapital / refundBot).
   *
   * Position value = equity − cash is unchanged because no fills happened.
   * We keep unrealizedPnl, realizedPnl, and positions from the last
   * makePortfolioSnapshot call and only update cash + equity.
   */
  private _syncPortfolioAfterCashChange(sleeve: BotSleeve): void {
    const inst = sleeve.instance;
    const positionValue = inst.portfolio.equity - inst.portfolio.cash;
    inst.portfolio = {
      ...inst.portfolio,
      cash: inst.cash,
      equity: inst.cash + positionValue,
    };
  }

  /** Internal eliminate — shared by public eliminateBot() and auto-elimination. */
  private _eliminateBot(botId: string, sleeve: BotSleeve, reason: string): void {
    // Snapshot competition equity before transitioning status. After elimination,
    // sleeve.instance.portfolio.equity keeps updating (for reconciliation accuracy),
    // but `eliminatedAtEquity` preserves the "final score" for leaderboard display.
    sleeve.eliminatedAtEquity = sleeve.instance.portfolio.equity;
    this.governance.setEligibilityStatus(botId, "ELIMINATED", reason);
    this.auditLog.record("GOVERNANCE_CHECK", `Bot "${botId}" eliminated: ${reason}`, {
      botId, status: "ELIMINATED", reason,
      finalEquity: sleeve.instance.portfolio.equity,
    });
    this.log.emit("WARNING", Date.now(), this.candlesProcessed, botId, {
      message: `Bot "${botId}" ELIMINATED — ${reason}`, mode: "paper-league",
    });
  }

  private _assertBotExists(botId: string): void {
    if (!this.sleeves.has(botId)) {
      throw new Error(`PaperLeagueRunner: bot "${botId}" not found`);
    }
  }
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function _makeBotInstance(spec: BotSpec, startingCapital: number): BotInstance {
  return {
    spec,
    cash: startingCapital,
    positions: new Map(),
    realizedPnl: 0,
    state: { ...(spec.params ?? spec.strategy.defaultParams ?? {}) },
    trades: [],
    fillHistory: [],
    equityHistory: [],
    exposedCandles: 0,
    portfolio: {
      cash: startingCapital,
      positions: [],
      equity: startingCapital,
      realizedPnl: 0,
      unrealizedPnl: 0,
      exposure: 0,
    },
  };
}

/**
 * Guard that amount is a finite positive number.
 * Shared by withdrawCapital() and refundBot() to prevent NaN, negative,
 * zero, and infinite values from silently corrupting sleeve/allocation state.
 */
function _assertValidAmount(amount: number, methodName: string, botId: string): void {
  if (!Number.isFinite(amount) || amount <= 0) {
    throw new Error(
      `${methodName}: amount must be a finite positive number, got ${amount} for bot "${botId}"`,
    );
  }
}

/** Monotonic per-process order ID for fill attribution. See paperSessionRunner for rationale. */
let _leagueOrderSeq = 0;
function _generateOrderId(): string {
  return `league-order-${Date.now()}-${++_leagueOrderSeq}`;
}

function _hashString(s: string): number {
  let h = 0;
  for (let i = 0; i < s.length; i++) {
    h = (Math.imul(31, h) + s.charCodeAt(i)) | 0;
  }
  return h >>> 0;
}
