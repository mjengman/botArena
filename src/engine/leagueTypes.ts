/**
 * Domain types for the PaperLeagueRunner — multi-bot, shared-account paper trading.
 *
 * The central abstraction is the "sleeve": each bot has a named capital
 * allocation within one shared broker account. The broker sees one account;
 * the league runner enforces sleeve boundaries in software via GovernanceEngine.
 */

// ─── Bot eligibility ──────────────────────────────────────────────────────────

/**
 * Per-bot eligibility status within the league.
 *
 * Allowed transitions:
 *   ACTIVE       → PAUSED        user pauses the bot
 *   PAUSED       → ACTIVE        user resumes the bot
 *   ACTIVE       → ELIMINATED    auto (equity < threshold) or user action
 *   PAUSED       → ELIMINATED    auto or user action
 *   ACTIVE       → NEEDS_REVIEW  governance safety-rule block (auto)
 *   NEEDS_REVIEW → ACTIVE        user clears via clearBot()
 *   NEEDS_REVIEW → ELIMINATED    user eliminates while in review
 *   any non-terminal → RETIRED   user retires (terminal)
 *   ELIMINATED → (terminal — no recovery)
 *   RETIRED    → (terminal — no recovery)
 *
 * Note: `refundBot(botId, amount)` is a capital ledger operation that does NOT
 * change eligibility status — it transfers capital from the sleeve to the
 * unallocated pool while the bot continues trading with its reduced allocation.
 */
export type BotEligibilityStatus =
  | "ACTIVE"
  | "PAUSED"
  | "ELIMINATED"
  | "NEEDS_REVIEW"
  | "RETIRED";

/** Returns true for terminal statuses that cannot be recovered from. */
export function isTerminalStatus(status: BotEligibilityStatus): boolean {
  return status === "RETIRED";
}

// ─── Sleeve / allocation ──────────────────────────────────────────────────────

/**
 * Public view of one bot's sleeve within the league account.
 * Returned by PaperLeagueRunner.getAllocations() for UI rendering.
 */
export interface BotAllocation {
  botId: string;
  botName: string;
  /** USD amount allocated to this bot at session start. */
  startingCapital: number;
  /** Current mark-to-market equity within the sleeve. */
  currentEquity: number;
  /** Fraction of starting capital remaining: currentEquity / startingCapital. */
  equityFraction: number;
  /** Sum of all closed-trade PnL for this bot in this session. */
  cumulativeRealisedPnl: number;
  status: BotEligibilityStatus;
  /** Human-readable reason; set when status !== "ACTIVE". */
  ineligibilityReason?: string;
}

// ─── League state ─────────────────────────────────────────────────────────────

/** Point-in-time snapshot of the entire league's state. */
export interface LeagueState {
  /** Whether the session is active (between start() and end()). */
  running: boolean;
  /** Unix ms when start() was called; null if not yet started. */
  startedAt: number | null;
  /** Number of candles processed since start(). */
  candlesProcessed: number;
  /** Per-bot sleeve state in insertion order. */
  allocations: BotAllocation[];
  /**
   * Cash not yet committed to any sleeve.
   * Always ≥ 0. Non-zero only when a bot is refunded mid-session.
   */
  unallocatedCash: number;
}

// ─── Constants ────────────────────────────────────────────────────────────────

/**
 * A bot is auto-eliminated when its equity falls below this fraction of its
 * starting capital (default 20%).  Set conservatively — the main protection
 * is governance daily-loss limits; auto-elimination is the last resort.
 */
export const AUTO_ELIMINATION_THRESHOLD = 0.2;
