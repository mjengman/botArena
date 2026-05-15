/**
 * PaperModePanel — modal UI for the paper trading session.
 *
 * Sections (from top to bottom):
 *   1. Gate status badge + arm/disarm controls
 *   2. Credentials entry (shown when DISARMED — fields cleared on disarm)
 *   3. Session controls (Start/Stop — shown when ARMED)
 *   4. Live stats: equity, candle progress, governance counters
 *   5. Audit log tail (last 30 entries, auto-scrolled)
 *
 * Architecture: calls usePaperSession() internally so the hook lifecycle
 * matches the panel's mount/unmount. State is lost when the panel is closed.
 * In a future milestone this can be lifted to App.tsx if persistence is needed.
 */

import { useState, useRef, useEffect } from "react";
import { usePaperSession } from "../hooks/usePaperSession.ts";
import type { GateStatus } from "../../engine/brokerTypes.ts";

interface PaperModePanelProps {
  onClose: () => void;
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function statusLabel(status: GateStatus): string {
  switch (status) {
    case "ARMED": return "ARMED";
    case "ARMING": return "ARMING…";
    case "DISARMED_ON_ERROR": return "DISARMED — ERROR";
    default: return "DISARMED";
  }
}

function statusClass(status: GateStatus): string {
  switch (status) {
    case "ARMED": return "paper-badge--armed";
    case "ARMING": return "paper-badge--arming";
    case "DISARMED_ON_ERROR": return "paper-badge--error";
    default: return "paper-badge--disarmed";
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

// ─── Component ────────────────────────────────────────────────────────────────

export function PaperModePanel({ onClose }: PaperModePanelProps) {
  const { state, setCredentials, arm, disarm, startSession, stopSession } = usePaperSession();

  // ── Credential draft state (local — not sent to store until user submits) ─
  const [apiKey, setApiKey] = useState("");
  const [apiSecret, setApiSecret] = useState("");
  const [baseUrl, setBaseUrl] = useState("https://paper-api.alpaca.markets");

  // Clear credential fields when the gate disarms (credentials were wiped)
  useEffect(() => {
    if (state.gateStatus === "DISARMED" || state.gateStatus === "DISARMED_ON_ERROR") {
      setApiKey("");
      setApiSecret("");
    }
  }, [state.gateStatus]);

  // ── Audit log auto-scroll ─────────────────────────────────────────────
  const auditEndRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    auditEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [state.auditEntries.length]);

  // ── Derived display values ────────────────────────────────────────────
  const isDisarmed =
    state.gateStatus === "DISARMED" || state.gateStatus === "DISARMED_ON_ERROR";
  const isArmed = state.gateStatus === "ARMED";
  const canArm = isDisarmed && state.hasCredentials && !state.isArming;
  const startingEquity = 10_000;
  const pnl = state.equity - startingEquity;
  const pctReturn = ((state.equity - startingEquity) / startingEquity) * 100;
  const progress =
    state.candleTotal > 0
      ? Math.round((state.candleIndex / state.candleTotal) * 100)
      : 0;

  function handleSetCredentials() {
    if (!apiKey.trim()) return;
    setCredentials({
      apiKey: apiKey.trim(),
      apiSecret: apiSecret.trim(),
      baseUrl: baseUrl.trim() || "https://paper-api.alpaca.markets",
    });
  }

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal modal--wide paper-modal" onClick={(e) => e.stopPropagation()}>

        {/* ── Header ─────────────────────────────────────────────────── */}
        <div className="modal-header">
          <span className="modal-title">◎ PAPER TRADING</span>
          <button className="modal-close" onClick={onClose}>✕</button>
        </div>

        <div className="modal-body">

          {/* ── Gate status ──────────────────────────────────────────── */}
          <div className="cfg-section">
            <div className="cfg-section-title">Gate Status</div>
            <div className="paper-status-row">
              <span className={`paper-badge ${statusClass(state.gateStatus)}`}>
                {statusLabel(state.gateStatus)}
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
                {isArmed && (
                  <button
                    className="cfg-btn cfg-btn--ghost paper-btn--danger"
                    onClick={() => disarm("user disarmed")}
                  >
                    Disarm Gate
                  </button>
                )}
              </div>
            </div>
            {state.error && (
              <div className="paper-error">{state.error}</div>
            )}
          </div>

          {/* ── Credentials ───────────────────────────────────────────── */}
          {isDisarmed && (
            <div className="cfg-section">
              <div className="cfg-section-title">
                Alpaca Paper API Credentials
                <span className="cfg-section-note">stored in memory only — never persisted</span>
              </div>

              <div className="paper-credentials">
                <label className="cfg-label">API Key</label>
                <input
                  className="cfg-input paper-cred-input"
                  type="text"
                  placeholder="PKXXXXXXXXXXXXXXXXXXXXXXXX"
                  value={apiKey}
                  onChange={(e) => setApiKey(e.target.value)}
                  autoComplete="off"
                  spellCheck={false}
                />

                <label className="cfg-label">API Secret</label>
                <input
                  className="cfg-input paper-cred-input"
                  type="password"
                  placeholder="••••••••••••••••••••••••••••••••"
                  value={apiSecret}
                  onChange={(e) => setApiSecret(e.target.value)}
                  autoComplete="off"
                />

                <label className="cfg-label">Base URL</label>
                <input
                  className="cfg-input paper-cred-input"
                  type="text"
                  value={baseUrl}
                  onChange={(e) => setBaseUrl(e.target.value)}
                  spellCheck={false}
                />
              </div>

              <div className="paper-cred-actions">
                <button
                  className="cfg-btn cfg-btn--primary"
                  disabled={!apiKey.trim()}
                  onClick={handleSetCredentials}
                >
                  {state.hasCredentials ? "Update Credentials" : "Set Credentials"}
                </button>
                {state.hasCredentials && (
                  <span className="paper-cred-set">✓ credentials stored</span>
                )}
              </div>

              <p className="paper-note">
                In simulated mode (M8), credentials are verified to be present but no
                real API calls are made. Fills are computed in-process using the sample dataset.
              </p>
            </div>
          )}

          {/* ── Session controls ──────────────────────────────────────── */}
          {isArmed && (
            <div className="cfg-section">
              <div className="cfg-section-title">Session</div>
              <div className="paper-session-row">
                {!state.sessionRunning ? (
                  <button
                    className="cfg-btn cfg-btn--primary"
                    onClick={startSession}
                  >
                    ▶ Start Replay
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
                    replaying… {state.candleIndex} / {state.candleTotal} ({progress}%)
                  </span>
                )}
                {state.sessionRunning && !state.isReplaying && (
                  <span className="paper-replaying paper-replaying--done">
                    replay complete — {state.candleIndex} candles
                  </span>
                )}
              </div>
            </div>
          )}

          {/* ── Live stats ────────────────────────────────────────────── */}
          {(isArmed || state.candleIndex > 0) && (
            <div className="cfg-section">
              <div className="cfg-section-title">Portfolio</div>
              <div className="paper-stats-grid">
                <div className="paper-stat">
                  <span className="paper-stat-label">Equity</span>
                  <span className="paper-stat-value">{fmtUsd(state.equity)}</span>
                </div>
                <div className="paper-stat">
                  <span className="paper-stat-label">P&amp;L</span>
                  <span
                    className={`paper-stat-value ${pnl >= 0 ? "positive" : "negative"}`}
                  >
                    {pnl >= 0 ? "+" : ""}{fmtUsd(pnl)}
                  </span>
                </div>
                <div className="paper-stat">
                  <span className="paper-stat-label">Return</span>
                  <span
                    className={`paper-stat-value ${pctReturn >= 0 ? "positive" : "negative"}`}
                  >
                    {pctReturn >= 0 ? "+" : ""}{pctReturn.toFixed(2)}%
                  </span>
                </div>
                <div className="paper-stat">
                  <span className="paper-stat-label">Daily Orders</span>
                  <span className="paper-stat-value">{state.govStats.dailyOrderCount}</span>
                </div>
                <div className="paper-stat">
                  <span className="paper-stat-label">Realized Loss Today</span>
                  <span
                    className={`paper-stat-value ${state.govStats.realizedDailyLossUsd > 0 ? "negative" : ""}`}
                  >
                    {fmtUsd(state.govStats.realizedDailyLossUsd)}
                  </span>
                </div>
                <div className="paper-stat">
                  <span className="paper-stat-label">Committed Capital</span>
                  <span className="paper-stat-value">
                    {fmtUsd(state.govStats.committedCapitalUsd)}
                  </span>
                </div>
              </div>
            </div>
          )}

          {/* ── Audit log ─────────────────────────────────────────────── */}
          <div className="cfg-section">
            <div className="cfg-section-title">
              Audit Log
              <span className="cfg-section-note">{state.auditEntries.length} entries</span>
            </div>
            <div className="paper-audit-log">
              {state.auditEntries.length === 0 ? (
                <div className="paper-audit-empty">
                  No entries yet — arm the gate to begin.
                </div>
              ) : (
                [...state.auditEntries].slice(-30).map((entry) => (
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

        {/* ── Footer ─────────────────────────────────────────────────── */}
        <div className="modal-footer">
          <span className="paper-footer-note">
            Simulated paper mode · No real API calls · Fills computed in-process
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
