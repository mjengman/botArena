/**
 * liveSessionStorage — localStorage helpers for persisting live paper-trading sessions.
 *
 * Enables same-day recovery after a page reload:
 *   - Bar history is restored so strategies have candle context immediately.
 *   - Governance stats (daily order count, realized loss) are re-injected so
 *     daily limits are not reset mid-day by a reload.
 *
 * Storage key format: `arena-live-{symbol}-{date}` where date is YYYY-MM-DD UTC.
 * Only today's session is ever loaded; stale entries from prior days are ignored.
 *
 * Silent failure on quota errors — a live session can always continue without
 * persistence (it just loses recovery capability).
 */

import type { Candle } from "./types.ts";
import type { BotEligibilityStatus } from "./leagueTypes.ts";

// ─── Types ────────────────────────────────────────────────────────────────────

/** Serialisable per-bot governance stats for recovery. */
export interface PersistedBotStats {
  botId: string;
  dailyOrderCount: number;
  realizedDailyLossUsd: number;
  dayKey: string;
}

/**
 * Serialisable snapshot of a single bot's sleeve state for same-day recovery.
 *
 * Persisting sleeve state prevents the "fresh $10k sleeves" problem on reload:
 * without this, the new PaperLeagueRunner starts with full starting capital
 * while Alpaca may already hold paper positions from the prior run, causing
 * account-level reconciliation to drift immediately.
 */
export interface PersistedSleeveState {
  botId: string;
  /** Current sleeve cash (may differ from starting capital due to fills). */
  cash: number;
  /** Open positions held by this sleeve. */
  positions: Array<{ symbol: string; quantity: number; avgCost: number }>;
  /** Cumulative realized P&L for this sleeve. */
  realizedPnl: number;
  /** Current governance capital allocation for this bot (USD). */
  currentAllocation: number;
  /** Bot eligibility status at the time of the last save. */
  eligibilityStatus: BotEligibilityStatus;
  /** Human-readable reason for the current eligibility status (if any). */
  eligibilityReason?: string;
  /** Equity snapshot captured at the moment of elimination (ELIMINATED bots only). */
  eliminatedAtEquity?: number;
}

/**
 * The full persisted live session payload stored in localStorage.
 *
 * Version history:
 *   v1 — initial M13 schema (bar history + governance stats only; no sleeve state).
 *   v2 — adds `sleeves` (PersistedSleeveState[]) and `unallocatedCash` so that a
 *        page reload can reconstruct the exact portfolio rather than starting with
 *        fresh $startingCapital sleeves while Alpaca holds positions.
 *
 * v1 records are treated as stale on load (returns null) — the session will start
 * fresh and reconciliation will catch any position drift.
 */
export interface PersistedLiveSession {
  version: 2;
  symbol: string;
  sessionDate: string;     // YYYY-MM-DD UTC
  barHistory: Candle[];
  barsReceived: number;
  lastBarAt: number | null;
  botStats: PersistedBotStats[];
  /** Per-bot sleeve state snapshot (cash, positions, realizedPnl, allocation). */
  sleeves: PersistedSleeveState[];
  /** Unallocated cash in the broker account not assigned to any bot sleeve. */
  unallocatedCash: number;
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

/** Maximum number of bars to persist (older bars are dropped). */
const MAX_BAR_HISTORY = 500;

/** Return today's UTC date in YYYY-MM-DD format. */
export function utcDateKey(now?: number): string {
  const d = new Date(now ?? Date.now());
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, "0");
  const day = String(d.getUTCDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

function storageKey(symbol: string, date: string): string {
  return `arena-live-${symbol}-${date}`;
}

// ─── Public API ───────────────────────────────────────────────────────────────

/**
 * Persist the current live session to localStorage.
 * The `version` field is added automatically.
 * Bar history is capped at MAX_BAR_HISTORY (most-recent bars retained).
 * Quota errors are swallowed silently.
 */
export function saveLiveSession(session: Omit<PersistedLiveSession, "version">): void {
  try {
    const key = storageKey(session.symbol, session.sessionDate);
    const payload: PersistedLiveSession = {
      ...session,
      version: 2,
      // Cap bar history to the most recent MAX_BAR_HISTORY entries.
      barHistory: session.barHistory.slice(-MAX_BAR_HISTORY),
    };
    localStorage.setItem(key, JSON.stringify(payload));
  } catch {
    // Quota exceeded or localStorage unavailable — silent failure.
  }
}

/**
 * Load today's live session for `symbol` from localStorage.
 * Returns null if no same-day session exists or the stored data is invalid.
 */
export function loadLiveSession(symbol: string): PersistedLiveSession | null {
  try {
    const today = utcDateKey();
    const key = storageKey(symbol, today);
    const raw = localStorage.getItem(key);
    if (raw === null) return null;

    const parsed = JSON.parse(raw) as unknown;
    if (
      typeof parsed !== "object" ||
      parsed === null ||
      // Version 2 required — v1 records lack sleeve state and must be discarded.
      (parsed as Record<string, unknown>)["version"] !== 2 ||
      (parsed as Record<string, unknown>)["symbol"] !== symbol ||
      (parsed as Record<string, unknown>)["sessionDate"] !== today
    ) {
      return null;
    }
    return parsed as PersistedLiveSession;
  } catch {
    return null;
  }
}

/**
 * Remove the live session entry for `symbol` from localStorage.
 * Safe to call even if no entry exists.
 */
export function clearLiveSession(symbol: string): void {
  try {
    const today = utcDateKey();
    const key = storageKey(symbol, today);
    localStorage.removeItem(key);
  } catch {
    // localStorage unavailable — silent failure.
  }
}
