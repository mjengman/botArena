import { useState } from "react";
import type { Dataset } from "../../engine/types.ts";
import { type MatchConfig } from "../matchConfig.ts";
import { type SeasonResult, type AggregateStanding, buildWindowDefs, runSeason } from "../season.ts";
import { BOT_COLORS } from "../constants.ts";

interface SeasonPanelProps {
  matchConfig: MatchConfig;
  /** The dataset currently active in the main match — used for season windows. */
  sourceDataset: Dataset;
  onClose: () => void;
}

function candleDate(dataset: Dataset, idx: number): string {
  const c = dataset.candles[idx];
  if (!c) return "—";
  return new Date(c.timestamp).toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
    timeZone: "UTC",
  });
}

function AggregateTable({ rows }: { rows: AggregateStanding[] }) {
  return (
    <table className="hist-table">
      <thead>
        <tr>
          <th>#</th>
          <th>Bot</th>
          <th className="num">Avg Return</th>
          <th className="num">Compounded</th>
          <th className="num">Wins</th>
          <th className="num">Avg DD</th>
          <th className="num">Avg PF</th>
        </tr>
      </thead>
      <tbody>
        {rows.map((s, i) => {
          const color = BOT_COLORS[s.botId] ?? "#94a3b8";
          const pos = s.avgReturn >= 0;
          return (
            <tr key={s.botId} className="hist-row">
              <td className="lb-rank">{i + 1}</td>
              <td className="lb-name">
                <span className="bot-dot" style={{ background: color }} />
                {s.botName}
              </td>
              <td className={`num ${pos ? "positive" : "negative"}`}>
                {pos ? "+" : ""}{(s.avgReturn * 100).toFixed(2)}%
              </td>
              <td className={`num ${s.totalReturn >= 0 ? "positive" : "negative"}`}>
                {s.totalReturn >= 0 ? "+" : ""}{(s.totalReturn * 100).toFixed(2)}%
              </td>
              <td className="num muted">{s.wins}/{s.matchCount}</td>
              <td className="num muted">{(s.avgMaxDrawdown * 100).toFixed(1)}%</td>
              <td className="num muted">{isNaN(s.avgProfitFactor) ? "—" : s.avgProfitFactor.toFixed(2)}</td>
            </tr>
          );
        })}
      </tbody>
    </table>
  );
}

export function SeasonPanel({ matchConfig, sourceDataset, onClose }: SeasonPanelProps) {
  const [windowCount, setWindowCount] = useState(4);
  const [result, setResult] = useState<SeasonResult | null>(null);
  const [selectedWindow, setSelectedWindow] = useState<number | null>(null);
  const [running, setRunning] = useState(false);

  const windowDefs = buildWindowDefs(matchConfig, windowCount);
  const activeBotCount = matchConfig.activeBotIds.length;
  const totalCandles = matchConfig.dataEndIdx - matchConfig.dataStartIdx + 1;
  const windowSize = Math.floor(totalCandles / windowCount);

  function handleRun() {
    setRunning(true);
    setResult(null);
    setSelectedWindow(null);
    // Run synchronously on next tick so the UI can re-render "Running…" first
    setTimeout(() => {
      const r = runSeason(matchConfig, windowCount, sourceDataset);
      setResult(r);
      setRunning(false);
    }, 0);
  }

  const canRun = activeBotCount > 0 && windowSize >= 10;

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal modal--wide" onClick={(e) => e.stopPropagation()}>
        <div className="modal-header">
          <span className="modal-title">SEASON RUNNER</span>
          <button className="modal-close" onClick={onClose}>✕</button>
        </div>

        <div className="modal-body">
          {/* Config */}
          {!result && (
            <div className="cfg-section">
              <div className="cfg-section-title">
                Windows
                <span className="cfg-section-note">
                  {windowCount} matches · ~{windowSize} candles each · {activeBotCount} bots
                </span>
              </div>
              <div className="cfg-range-row">
                <span className="cfg-range-label">Count</span>
                <input
                  className="cfg-range"
                  type="range"
                  min={2}
                  max={8}
                  step={1}
                  value={windowCount}
                  onChange={(e) => setWindowCount(Number(e.target.value))}
                />
                <span className="cfg-range-val">{windowCount} windows</span>
              </div>

              <div className="season-windows">
                {windowDefs.map((w, i) => (
                  <div key={i} className="season-window">
                    <span className="season-window-num">W{i + 1}</span>
                    <span className="season-window-range">
                      {candleDate(sourceDataset, w.startIdx)} – {candleDate(sourceDataset, w.endIdx)}
                    </span>
                    <span className="muted">{w.endIdx - w.startIdx + 1} candles</span>
                  </div>
                ))}
              </div>

              {!canRun && windowSize < 10 && (
                <div className="cfg-errors">
                  <div className="cfg-error">Window size too small ({windowSize} candles). Reduce window count or expand the date range in Match Config.</div>
                </div>
              )}
            </div>
          )}

          {/* Results */}
          {running && (
            <div className="hist-empty" style={{ padding: "32px", textAlign: "center" }}>
              Running {windowCount} matches…
            </div>
          )}

          {result && (
            <>
              <div className="cfg-section">
                <div className="cfg-section-title">Aggregate Standings</div>
                <AggregateTable rows={result.aggregate} />
              </div>

              <div className="cfg-section">
                <div className="cfg-section-title">Per-Window Results</div>
                <div className="season-window-tabs">
                  <button
                    className={`season-tab ${selectedWindow === null ? "season-tab--active" : ""}`}
                    onClick={() => setSelectedWindow(null)}
                  >
                    All
                  </button>
                  {result.windows.map((w) => (
                    <button
                      key={w.index}
                      className={`season-tab ${selectedWindow === w.index ? "season-tab--active" : ""}`}
                      onClick={() => setSelectedWindow(w.index)}
                    >
                      W{w.index + 1}
                    </button>
                  ))}
                </div>

                {(selectedWindow === null ? result.windows : result.windows.filter((w) => w.index === selectedWindow)).map((w) => (
                  <div key={w.index} className="season-window-result">
                    <div className="season-window-result-header">
                      W{w.index + 1} · {w.startDate} → {w.endDate} · {w.candleCount} candles
                    </div>
                    <table className="hist-table">
                      <thead>
                        <tr>
                          <th>#</th><th>Bot</th>
                          <th className="num">Return</th>
                          <th className="num">Equity</th>
                          <th className="num">MaxDD</th>
                        </tr>
                      </thead>
                      <tbody>
                        {[...w.standings].sort((a, b) => a.rank - b.rank).map((s) => {
                          const pos = s.totalReturn >= 0;
                          return (
                            <tr key={s.botId} className="hist-row">
                              <td className="lb-rank">{s.rank}</td>
                              <td className="lb-name">
                                <span className="bot-dot" style={{ background: BOT_COLORS[s.botId] ?? "#94a3b8" }} />
                                {s.botName}
                              </td>
                              <td className={`num ${pos ? "positive" : "negative"}`}>
                                {pos ? "+" : ""}{(s.totalReturn * 100).toFixed(2)}%
                              </td>
                              <td className="num muted">
                                ${s.finalEquity.toLocaleString("en-US", { maximumFractionDigits: 0 })}
                              </td>
                              <td className="num muted">{(s.maxDrawdown * 100).toFixed(1)}%</td>
                            </tr>
                          );
                        })}
                      </tbody>
                    </table>
                  </div>
                ))}
              </div>
            </>
          )}
        </div>

        <div className="modal-footer">
          {result && (
            <button className="cfg-btn cfg-btn--ghost" onClick={() => { setResult(null); setSelectedWindow(null); }}>
              ← Reconfigure
            </button>
          )}
          <div className="modal-footer-right">
            <button className="cfg-btn cfg-btn--ghost" onClick={onClose}>Close</button>
            {!result && (
              <button className="cfg-btn cfg-btn--primary" disabled={!canRun || running} onClick={handleRun}>
                {running ? "Running…" : `Run Season (${windowCount} matches)`}
              </button>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
