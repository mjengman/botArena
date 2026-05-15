/**
 * WelcomePanel — first-run onboarding modal and persistent help panel.
 *
 * Shown automatically on the first visit (localStorage flag "bot-arena:welcomed").
 * Also reopened by the "?" button in the header.
 *
 * Primary action: "▶ Start Match" — dismisses the panel and starts the simulation.
 * Secondary action: "Close" — dismisses without starting.
 *
 * Design goal: a new user who has never seen Bot Arena should understand
 * the primary flow and current limitations without needing external narration.
 */

interface WelcomePanelProps {
  onStart: () => void;
  onClose: () => void;
  /** When true the simulation is at FINAL — CTA label changes to "↺ Reset & Start". */
  isComplete?: boolean;
}

const STEPS = [
  {
    icon: "⚙",
    label: "Configure",
    detail: "Click ⚙ in the header to choose your bots, date range, starting cash, and fee/slippage settings.",
  },
  {
    icon: "▶",
    label: "Run the match",
    detail: "Hit ▶ Play. Five bots compete over 500+ synthetic candles. Adjust speed with 1× / 4× / 16× / Max.",
  },
  {
    icon: "⚔",
    label: "Inspect",
    detail: "Click any bot in the leaderboard to open its inspector: portfolio, trades, equity curve, and event log.",
  },
  {
    icon: "◉",
    label: "Season & History",
    detail: "Run a Season to rank bots across multiple time windows. Completed matches are auto-saved to History.",
  },
  {
    icon: "◎",
    label: "Paper mode",
    detail: "Click ◎ Paper to rehearse the trading governance stack (gate arming, safety rules, audit log) — no real broker calls.",
  },
];

const LIMITATIONS = [
  "Market data: synthetic 504-candle dataset only — real CSV import ships in the next release.",
  "Paper mode: fills are simulated in-process, no real Alpaca API calls yet.",
  "Long-only, market orders only — no shorts, limit orders, or margin.",
];

export function WelcomePanel({ onStart, onClose, isComplete = false }: WelcomePanelProps) {
  return (
    <div className="modal-overlay" onClick={onClose}>
      <div
        className="modal welcome-modal"
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        aria-modal="true"
        aria-labelledby="welcome-title"
      >
        {/* ── Header ──────────────────────────────────────────────── */}
        <div className="modal-header">
          <span className="modal-title" id="welcome-title">
            ⚔ BOT ARENA · WELCOME
          </span>
          <button className="modal-close" onClick={onClose} aria-label="Close">✕</button>
        </div>

        {/* ── Body ────────────────────────────────────────────────── */}
        <div className="modal-body">

          {/* Tagline */}
          <p className="welcome-tagline">
            A deterministic strategy league. Five bots. One dataset. Every decision inspectable.
          </p>

          {/* Flow steps */}
          <div className="welcome-section-label">HOW IT WORKS</div>
          <ol className="welcome-steps">
            {STEPS.map((s) => (
              <li key={s.label} className="welcome-step">
                <span className="welcome-step-icon">{s.icon}</span>
                <div className="welcome-step-body">
                  <span className="welcome-step-label">{s.label}</span>
                  <span className="welcome-step-detail">{s.detail}</span>
                </div>
              </li>
            ))}
          </ol>

          {/* Limitations */}
          <div className="welcome-section-label">CURRENT LIMITATIONS</div>
          <ul className="welcome-limitations">
            {LIMITATIONS.map((l) => (
              <li key={l}>{l}</li>
            ))}
          </ul>

          {/* Safety note */}
          <div className="welcome-safety">
            <span className="welcome-safety-icon">⚠</span>
            <span>
              Paper mode makes <strong>no real API calls</strong> — all fills are computed
              in-process. Real Alpaca Paper integration (with explicit arming, credential wipe
              on close, and full audit trail) is planned for a future release. No live-money
              trading path exists in this version.
            </span>
          </div>

        </div>

        {/* ── Footer ──────────────────────────────────────────────── */}
        <div className="modal-footer">
          <span className="welcome-footer-note muted">
            Reopen anytime with the <strong>?</strong> button in the header.
          </span>
          <div className="modal-footer-right">
            <button className="ctrl-btn" onClick={onClose}>Close</button>
            <button className="ctrl-btn ctrl-btn--primary" onClick={onStart}>
              {isComplete ? "↺ Reset & Start" : "▶ Start Match"}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
