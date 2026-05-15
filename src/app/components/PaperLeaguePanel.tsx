/**
 * PaperLeaguePanel — multi-bot paper league session UI.
 *
 * Displays a shared-account paper trading league where three bots
 * (Buy & Hold, Momentum, Mean Reversion) each run inside their own
 * capital sleeve under a single governance gate.
 *
 * Sections (top → bottom):
 *   1. Gate status badge + arm/disarm controls
 *   2. Demo access key entry (shown when DISARMED; cleared on disarm)
 *   3. Session controls (Start/Stop replay) + candle progress
 *   4. Unallocated cash balance
 *   5. Sleeve cards — one per bot:
 *        • Status badge (ACTIVE / PAUSED / NEEDS_REVIEW / ELIMINATED / RETIRED)
 *        • Equity progress bar (currentEquity / startingCapital)
 *        • Allocation bar (currentAllocation / startingCapital)
 *        • Action row: Pause/Resume, Clear, Eliminate, Retire, Refund, Withdraw
 *   6. Audit log tail (last 40 entries, auto-scrolled)
 *
 * Action availability by status:
 *   ACTIVE       → Pause · Eliminate · Retire · Withdraw
 *   PAUSED       → Resume · Eliminate · Retire · Withdraw
 *   NEEDS_REVIEW → Clear · Eliminate · Retire · Withdraw
 *   ELIMINATED   → Refund · Retire
 *   RETIRED      → (none — terminal)
 */

import { useState, useRef, useEffect } from "react";
import { usePaperLeague } from "../hooks/usePaperLeague.ts";
import { BOT_COLORS } from "../constants.ts";
import type { GateStatus } from "../../engine/brokerTypes.ts";
import type { BotAllocation, BotEligibilityStatus } from "../../engine/leagueTypes.ts";

interface PaperLeaguePanelProps {
  onClose: () => void;
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function gateLabel(status: GateStatus): string {
  switch (status) {
    case "ARMED":              return "ARMED";
    case "ARMING":             return "ARMING…";
    case "DISARMED_ON_ERROR":  return "DISARMED — ERROR";
    default:                   return "DISARMED";
  }
}

function gateClass(status: GateStatus): string {
  switch (status) {
    case "ARMED":             return "paper-badge--armed";
    case "ARMING":            return "paper-badge--arming";
    case "DISARMED_ON_ERROR": return "paper-badge--error";
    default:                  return "paper-badge--disarmed";
  }
}

function statusLabel(status: BotEligibilityStatus): string {
  switch (status) {
    case "ACTIVE":       return "ACTIVE";
    case "PAUSED":       return "PAUSED";
    case "NEEDS_REVIEW": return "NEEDS REVIEW";
    case "ELIMINATED":   return "ELIMINATED";
    case "RETIRED":      return "RETIRED";
  }
}

function statusClass(status: BotEligibilityStatus): string {
  switch (status) {
    case "ACTIVE":       return "league-status--active";
    case "PAUSED":       return "league-status--paused";
    case "NEEDS_REVIEW": return "league-status--review";
    case "ELIMINATED":   return "league-status--eliminated";
    case "RETIRED":      return "league-status--retired";
  }
}

function fmtUsd(n: number): string {
  return n.toLocaleString("en-US", {
    style: "currency",
    currency: "USD",
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
}

function fmtPct(n: number): string {
  const pct = (n - 1) * 100;
  return `${pct >= 0 ? "+" : ""}${pct.toFixed(1)}%`;
}

function fmtTime(ts: number): string {
  return new Date(ts).toLocaleTimeString("en-US", {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  });
}

const AUDIT_TYPE_CLASS: Record<string, string> = {
  GATE_ARMED:           "audit-type--armed",
  GATE_DISARMED:        "audit-type--disarmed",
  PRECONDITION_RESULT:  "audit-type--precond",
  ORDER_FILL:           "audit-type--fill",
  ORDER_REJECTED:       "audit-type--rejected",
  ORDER_SUBMITTED:      "audit-type--submitted",
  GOVERNANCE_CHECK:     "audit-type--gov",
  SESSION_START:        "audit-type--session",
  SESSION_END:          "audit-type--session",
  RECONCILIATION:       "audit-type--recon",
  RECONCILIATION_DRIFT: "audit-type--error",
  ERROR:                "audit-type--error",
};

/** Parse a USD amount string → number, returns NaN if invalid */
function parseAmount(s: string): number {
  const n = parseFloat(s.replace(/[$,]/g, "").trim());
  return Number.isFinite(n) && n > 0 ? n : NaN;
}

// ─── SleeveCard ───────────────────────────────────────────────────────────────

interface SleeveCardProps {
  alloc: BotAllocation;
  sessionRunning: boolean;
  unallocatedCash: number;
  onPause: () => void;
  onResume: () => void;
  onClear: () => void;
  onEliminate: () => void;
  onRetire: () => void;
  onRefund: (amount: number) => void;
  onWithdraw: (amount: number) => void;
}

function SleeveCard({
  alloc,
  sessionRunning,
  unallocatedCash,
  onPause,
  onResume,
  onClear,
  onEliminate,
  onRetire,
  onRefund,
  onWithdraw,
}: SleeveCardProps) {
  const [refundInput, setRefundInput] = useState("");
  const [withdrawInput, setWithdrawInput] = useState("");
  const [showRefund, setShowRefund] = useState(false);
  const [showWithdraw, setShowWithdraw] = useState(false);

  const color = BOT_COLORS[alloc.botId] ?? "#94a3b8";
  const { status } = alloc;
  const isTerminal = status === "RETIRED";
  const isActive = sessionRunning && !isTerminal;

  // Equity bar — clamp 0..1 for display, allow > 1 (gains past starting capital)
  const equityBarWidth = Math.min(Math.max(alloc.equityFraction, 0), 1) * 100;
  // Allocation bar
  const allocBarWidth = Math.min(Math.max(alloc.allocationFraction, 0), 1) * 100;
  const pnl = alloc.currentEquity - alloc.startingCapital;

  function handleRefund() {
    const amount = parseAmount(refundInput);
    // Pre-validate against the engine's constraint: amount must be finite, > 0,
    // and ≤ unallocatedCash. If validation fails, keep the form open so the user
    // can correct the input rather than silently dismissing.
    if (isNaN(amount) || amount > unallocatedCash) return;
    onRefund(amount);
    setRefundInput("");
    setShowRefund(false);
  }

  function handleWithdraw() {
    const amount = parseAmount(withdrawInput);
    // Pre-validate against withdrawableCapital (= Math.min(cash, currentAllocation))
    // — exactly the bound the engine enforces. Keeps the form open on bad input.
    if (isNaN(amount) || amount > alloc.withdrawableCapital) return;
    onWithdraw(amount);
    setWithdrawInput("");
    setShowWithdraw(false);
  }

  return (
    <div className={`league-card ${isTerminal ? "league-card--retired" : ""}`}>

      {/* ── Header row ──────────────────────────────────────────────────── */}
      <div className="league-card-header">
        <span className="league-card-dot" style={{ background: color }} />
        <span className="league-card-name">{alloc.botName}</span>
        <span className={`league-status ${statusClass(status)}`}>
          {statusLabel(status)}
        </span>
      </div>

      {/* ── Ineligibility reason ─────────────────────────────────────────── */}
      {alloc.ineligibilityReason && (
        <div className="league-card-reason">{alloc.ineligibilityReason}</div>
      )}

      {/* ── Equity bar ──────────────────────────────────────────────────── */}
      <div className="league-bar-row">
        <span className="league-bar-label">Equity</span>
        <div className="league-bar-track">
          <div
            className="league-bar-fill league-bar-fill--equity"
            style={{ width: `${equityBarWidth}%`, background: color }}
          />
        </div>
        <span className={`league-bar-value ${pnl >= 0 ? "positive" : "negative"}`}>
          {fmtUsd(alloc.currentEquity)}
          <span className="league-bar-pct">{fmtPct(alloc.equityFraction)}</span>
        </span>
      </div>

      {/* ── Allocation bar ──────────────────────────────────────────────── */}
      <div className="league-bar-row">
        <span className="league-bar-label">Alloc</span>
        <div className="league-bar-track">
          <div
            className="league-bar-fill league-bar-fill--alloc"
            style={{ width: `${allocBarWidth}%` }}
          />
        </div>
        <span className="league-bar-value">
          {fmtUsd(alloc.currentAllocation)}
        </span>
      </div>

      {/* ── Competition score (ELIMINATED bots only) ─────────────────────── */}
      {status === "ELIMINATED" && alloc.eliminatedAtEquity !== undefined && (
        <div className="league-card-score">
          Final score: {fmtUsd(alloc.eliminatedAtEquity)}
          {" "}
          <span className={alloc.eliminatedAtEquity >= alloc.startingCapital ? "positive" : "negative"}>
            {fmtPct(alloc.eliminatedAtEquity / alloc.startingCapital)}
          </span>
        </div>
      )}

      {/* ── Action row ──────────────────────────────────────────────────── */}
      {isActive && (
        <div className="league-card-actions">
          {status === "ACTIVE" && (
            <button className="cfg-btn cfg-btn--ghost league-action-btn" onClick={onPause}>
              ⏸ Pause
            </button>
          )}
          {status === "PAUSED" && (
            <button className="cfg-btn cfg-btn--ghost league-action-btn" onClick={onResume}>
              ▶ Resume
            </button>
          )}
          {status === "NEEDS_REVIEW" && (
            <button className="cfg-btn cfg-btn--primary league-action-btn" onClick={onClear}>
              ✓ Clear
            </button>
          )}
          {status !== "ELIMINATED" && (
            <button
              className="cfg-btn cfg-btn--ghost league-action-btn league-action-btn--danger"
              onClick={onEliminate}
            >
              ✕ Eliminate
            </button>
          )}
          {status === "ELIMINATED" && (
            <button
              className="cfg-btn cfg-btn--ghost league-action-btn"
              onClick={() => { setShowRefund((s) => !s); setShowWithdraw(false); }}
            >
              ↑ Refund
            </button>
          )}
          {status !== "ELIMINATED" && (
            <button
              className="cfg-btn cfg-btn--ghost league-action-btn"
              onClick={() => { setShowWithdraw((s) => !s); setShowRefund(false); }}
            >
              ↓ Withdraw
            </button>
          )}
          <button
            className="cfg-btn cfg-btn--ghost league-action-btn league-action-btn--danger"
            onClick={onRetire}
          >
            ⊗ Retire
          </button>
        </div>
      )}

      {/* ── Refund sub-form ─────────────────────────────────────────────── */}
      {showRefund && (
        <div className="league-amount-form">
          <span className="league-amount-label">
            Inject from unallocated ({fmtUsd(unallocatedCash)} available)
          </span>
          <input
            className="cfg-input league-amount-input"
            type="number"
            min="0.01"
            step="100"
            placeholder="e.g. 1000"
            value={refundInput}
            onChange={(e) => setRefundInput(e.target.value)}
            onKeyDown={(e) => { if (e.key === "Enter") handleRefund(); if (e.key === "Escape") setShowRefund(false); }}
            autoFocus
          />
          <button
            className="cfg-btn cfg-btn--primary"
            disabled={isNaN(parseAmount(refundInput)) || parseAmount(refundInput) > unallocatedCash}
            onClick={handleRefund}
          >
            Confirm
          </button>
          <button className="cfg-btn cfg-btn--ghost" onClick={() => setShowRefund(false)}>
            Cancel
          </button>
        </div>
      )}

      {/* ── Withdraw sub-form ───────────────────────────────────────────── */}
      {showWithdraw && (
        <div className="league-amount-form">
          <span className="league-amount-label">
            Withdraw to unallocated (max {fmtUsd(alloc.withdrawableCapital)})
          </span>
          <input
            className="cfg-input league-amount-input"
            type="number"
            min="0.01"
            step="100"
            placeholder="e.g. 500"
            value={withdrawInput}
            onChange={(e) => setWithdrawInput(e.target.value)}
            onKeyDown={(e) => { if (e.key === "Enter") handleWithdraw(); if (e.key === "Escape") setShowWithdraw(false); }}
            autoFocus
          />
          <button
            className="cfg-btn cfg-btn--primary"
            disabled={isNaN(parseAmount(withdrawInput)) || parseAmount(withdrawInput) > alloc.withdrawableCapital}
            onClick={handleWithdraw}
          >
            Confirm
          </button>
          <button className="cfg-btn cfg-btn--ghost" onClick={() => setShowWithdraw(false)}>
            Cancel
          </button>
        </div>
      )}
    </div>
  );
}

// ─── PaperLeaguePanel ─────────────────────────────────────────────────────────

export function PaperLeaguePanel({ onClose }: PaperLeaguePanelProps) {
  const {
    state,
    setCredentials,
    arm,
    disarm,
    startSession,
    stopSession,
    pauseBot,
    resumeBot,
    clearBot,
    eliminateBot,
    retireBot,
    refundBot,
    withdrawCapital,
    dismissError,
  } = usePaperLeague();

  const [demoKey, setDemoKey] = useState("");

  // Clear demo key when gate disarms
  useEffect(() => {
    if (state.gateStatus === "DISARMED" || state.gateStatus === "DISARMED_ON_ERROR") {
      setDemoKey("");
    }
  }, [state.gateStatus]);

  // Audit log auto-scroll
  const auditEndRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    auditEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [state.auditEntries.length]);

  // ── Derived values ────────────────────────────────────────────────────
  const isDisarmed =
    state.gateStatus === "DISARMED" || state.gateStatus === "DISARMED_ON_ERROR";
  const isArmed = state.gateStatus === "ARMED";
  const canArm = isDisarmed && state.hasCredentials && !state.isArming;
  const { leagueState } = state;
  const progress =
    state.candleTotal > 0
      ? Math.round((leagueState.candlesProcessed / state.candleTotal) * 100)
      : 0;

  function handleSetKey() {
    if (!demoKey.trim()) return;
    setCredentials({
      apiKey: demoKey.trim(),
      apiSecret: "simulated-secret",
      baseUrl: "https://paper-api.alpaca.markets",
    });
  }

  // Sort sleeve cards: active first, then paused/review, then eliminated, then retired
  const STATUS_ORDER: Record<string, number> = {
    ACTIVE: 0,
    NEEDS_REVIEW: 1,
    PAUSED: 2,
    ELIMINATED: 3,
    RETIRED: 4,
  };
  const sortedAllocations = [...leagueState.allocations].sort(
    (a, b) => (STATUS_ORDER[a.status] ?? 5) - (STATUS_ORDER[b.status] ?? 5),
  );

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal modal--wide paper-modal" onClick={(e) => e.stopPropagation()}>

        {/* ── Header ───────────────────────────────────────────────────── */}
        <div className="modal-header">
          <span className="modal-title">⚔ PAPER LEAGUE · 3-BOT SIMULATED</span>
          <button className="modal-close" onClick={onClose}>✕</button>
        </div>

        <div className="modal-body">

          {/* ── Gate status ─────────────────────────────────────────────── */}
          <div className="cfg-section">
            <div className="cfg-section-title">Gate Status</div>
            <div className="paper-status-row">
              <span className={`paper-badge ${gateClass(state.gateStatus)}`}>
                {gateLabel(state.gateStatus)}
              </span>
              <div className="paper-gate-actions">
                {isDisarmed && (
                  <button
                    className="cfg-btn cfg-btn--primary"
                    disabled={!canArm}
                    onClick={arm}
                  >
                    {state.isArming ? "Arming…" : "Arm Gate"}
                  </button>
                )}
                {isArmed && !leagueState.running && (
                  <button
                    className="cfg-btn cfg-btn--ghost paper-btn--danger"
                    onClick={() => { void disarm("user disarmed"); }}
                  >
                    Disarm Gate
                  </button>
                )}
              </div>
            </div>
            {state.error && (
              <div className="paper-error" onClick={dismissError} title="Click to dismiss">
                {state.error}
              </div>
            )}
          </div>

          {/* ── Demo access key ──────────────────────────────────────────── */}
          {isDisarmed && (
            <div className="cfg-section">
              <div className="cfg-section-title">
                Simulated Access Key
                <span className="cfg-section-note">stored in memory only — no API calls made</span>
              </div>
              <div className="paper-credentials">
                <label className="cfg-label">Demo Key</label>
                <input
                  className="cfg-input paper-cred-input"
                  type="text"
                  placeholder="enter any value  (e.g. league-key-1)"
                  value={demoKey}
                  onChange={(e) => setDemoKey(e.target.value)}
                  onKeyDown={(e) => { if (e.key === "Enter") handleSetKey(); }}
                  autoComplete="off"
                  spellCheck={false}
                />
              </div>
              <div className="paper-cred-actions">
                <button
                  className="cfg-btn cfg-btn--primary"
                  disabled={!demoKey.trim()}
                  onClick={handleSetKey}
                >
                  {state.hasCredentials ? "Update Key" : "Set Key"}
                </button>
                {state.hasCredentials && (
                  <span className="paper-cred-set">✓ key stored in memory</span>
                )}
              </div>
            </div>
          )}

          {/* ── Session controls ─────────────────────────────────────────── */}
          {isArmed && (
            <div className="cfg-section">
              <div className="cfg-section-title">Session</div>
              <div className="paper-session-row">
                {!leagueState.running ? (
                  <button
                    className="cfg-btn cfg-btn--primary"
                    onClick={startSession}
                  >
                    ▶ Start League Replay
                  </button>
                ) : (
                  <button
                    className="cfg-btn cfg-btn--ghost paper-btn--danger"
                    onClick={stopSession}
                  >
                    ■ Stop Session
                  </button>
                )}
                {state.isReplaying && (
                  <span className="paper-replaying">
                    replaying… {leagueState.candlesProcessed} / {state.candleTotal} ({progress}%)
                  </span>
                )}
                {leagueState.running && !state.isReplaying && (
                  <span className="paper-replaying paper-replaying--done">
                    replay complete — {leagueState.candlesProcessed} candles
                  </span>
                )}
              </div>
            </div>
          )}

          {/* ── Unallocated cash ─────────────────────────────────────────── */}
          {(isArmed || leagueState.candlesProcessed > 0) &&
            leagueState.unallocatedCash > 0 && (
            <div className="cfg-section">
              <div className="cfg-section-title">Unallocated Cash</div>
              <div className="league-unallocated">
                <span className="league-unallocated-value">
                  {fmtUsd(leagueState.unallocatedCash)}
                </span>
                <span className="league-unallocated-hint">
                  available to refund into a sleeve
                </span>
              </div>
            </div>
          )}

          {/* ── Sleeve cards ─────────────────────────────────────────────── */}
          {sortedAllocations.length > 0 && (
            <div className="cfg-section">
              <div className="cfg-section-title">
                Bots
                <span className="cfg-section-note">
                  {sortedAllocations.filter((a) => a.status === "ACTIVE").length} active
                  {" / "}
                  {sortedAllocations.length} total
                </span>
              </div>
              <div className="league-cards">
                {sortedAllocations.map((alloc) => (
                  <SleeveCard
                    key={alloc.botId}
                    alloc={alloc}
                    sessionRunning={leagueState.running}
                    unallocatedCash={leagueState.unallocatedCash}
                    onPause={() => pauseBot(alloc.botId)}
                    onResume={() => resumeBot(alloc.botId)}
                    onClear={() => clearBot(alloc.botId)}
                    onEliminate={() => eliminateBot(alloc.botId)}
                    onRetire={() => retireBot(alloc.botId)}
                    onRefund={(amt) => refundBot(alloc.botId, amt)}
                    onWithdraw={(amt) => withdrawCapital(alloc.botId, amt)}
                  />
                ))}
              </div>
            </div>
          )}

          {/* ── Audit log ────────────────────────────────────────────────── */}
          <div className="cfg-section">
            <div className="cfg-section-title">
              Audit Log
              <span className="cfg-section-note">{state.auditEntries.length} entries</span>
            </div>
            <div className="paper-audit-log">
              {state.auditEntries.length === 0 ? (
                <div className="paper-audit-empty">
                  No entries yet — set a key and arm the gate to begin.
                </div>
              ) : (
                [...state.auditEntries].slice(-40).map((entry) => (
                  <div key={entry.seq} className="paper-audit-entry">
                    <span className="paper-audit-time">{fmtTime(entry.timestamp)}</span>
                    <span
                      className={`paper-audit-type ${AUDIT_TYPE_CLASS[entry.type] ?? ""}`}
                    >
                      {entry.type}
                    </span>
                    <span className="paper-audit-msg">{entry.message}</span>
                  </div>
                ))
              )}
              <div ref={auditEndRef} />
            </div>
          </div>

        </div>

        {/* ── Footer ─────────────────────────────────────────────────────── */}
        <div className="modal-footer">
          <span className="paper-footer-note">
            Simulated mode · 3 bots · Shared account · Governance enforced per sleeve
          </span>
          <div className="modal-footer-right">
            <button className="cfg-btn cfg-btn--ghost" onClick={onClose}>
              Close
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
