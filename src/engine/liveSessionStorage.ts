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

// ─── Types ────────────────────────────────────────────────────────────────────

/** Serialisable per-bot governance stats for recovery. */
export interface PersistedBotStats {
  botId: string;
  dailyOrderCount: number;
  realizedDailyLossUsd: number;
  dayKey: string;
}

/** The full persisted live session payload stored in localStorage. */
export interface PersistedLiveSession {
  version: 1;
  symbol: string;
  sessionDate: string;     // YYYY-MM-DD UTC
  barHistory: Candle[];
  barsReceived: number;
  lastBarAt: number | null;
  botStats: PersistedBotStats[];
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
      version: 1,
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
      (parsed as Record<string, unknown>)["version"] !== 1 ||
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
