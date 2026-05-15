import { useState, useRef } from "react";
import { type StoredRun, deleteRun, clearHistory, importRunFromJson } from "../history.ts";
import { BOT_COLORS } from "../constants.ts";

interface HistoryPanelProps {
  runs: StoredRun[];
  onClose: () => void;
  onRunsChange: () => void;
}

function formatDate(iso: string): string {
  return new Date(iso).toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

function RunDetail({ run }: { run: StoredRun }) {
  const sorted = [...run.standings].sort((a, b) => a.rank - b.rank);
  return (
    <div className="hist-detail">
      <div className="hist-detail-meta">
        <span>{run.dataset.symbol}</span>
        <span className="muted">{run.dataset.startDate} → {run.dataset.endDate}</span>
        <span className="muted">{run.dataset.candleCount} candles</span>
        <span className="muted">${run.config.startingCash.toLocaleString()} · fee {run.config.feeBps}bps · slip {run.config.slippageBps}bps</span>
      </div>
      <table className="hist-table">
        <thead>
          <tr>
            <th>#</th>
            <th>Bot</th>
            <th className="num">Return</th>
            <th className="num">Equity</th>
            <th className="num">MaxDD</th>
            <th className="num">Win%</th>
            <th className="num">PF</th>
          </tr>
        </thead>
        <tbody>
          {sorted.map((s) => {
            const color = BOT_COLORS[s.botId] ?? "#94a3b8";
            const pos = s.totalReturn >= 0;
            return (
              <tr key={s.botId} className="hist-row">
                <td className="lb-rank">{s.rank}</td>
                <td className="lb-name">
                  <span className="bot-dot" style={{ background: color }} />
                  {s.botName}
                </td>
                <td className={`num ${pos ? "positive" : "negative"}`}>
                  {pos ? "+" : ""}{(s.totalReturn * 100).toFixed(2)}%
                </td>
                <td className="num muted">
                  ${s.finalEquity.toLocaleString("en-US", { maximumFractionDigits: 0 })}
                </td>
                <td className="num muted">{(s.maxDrawdown * 100).toFixed(1)}%</td>
                <td className="num muted">{s.tradeCount > 0 ? `${(s.winRate * 100).toFixed(0)}%` : "—"}</td>
                <td className="num muted">
                  {s.tradeCount > 0
                    ? isFinite(s.profitFactor)
                      ? s.profitFactor.toFixed(2)
                      : "∞"
                    : "—"}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

export function HistoryPanel({ runs, onClose, onRunsChange }: HistoryPanelProps) {
  const [selectedId, setSelectedId] = useState<string | null>(runs[0]?.id ?? null);
  const [importError, setImportError] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const selected = runs.find((r) => r.id === selectedId) ?? null;

  function handleDelete(id: string) {
    deleteRun(id);
    if (selectedId === id) setSelectedId(runs.find((r) => r.id !== id)?.id ?? null);
    onRunsChange();
  }

  function handleClear() {
    clearHistory();
    setSelectedId(null);
    onRunsChange();
  }

  function handleImport(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = (ev) => {
      const text = ev.target?.result as string;
      const run = importRunFromJson(text);
      if (run) {
        setImportError(null);
        setSelectedId(run.id);
        onRunsChange();
      } else {
        setImportError("Invalid run file — expected a Bot Arena JSON export.");
      }
    };
    reader.readAsText(file);
    e.target.value = "";
  }

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal modal--wide" onClick={(e) => e.stopPropagation()}>
        <div className="modal-header">
          <span className="modal-title">MATCH HISTORY</span>
          <button className="modal-close" onClick={onClose}>✕</button>
        </div>

        <div className="hist-layout">
          {/* Run list */}
          <div className="hist-list">
            {runs.length === 0 ? (
              <div className="hist-empty">No saved runs yet. Complete a match to save it automatically.</div>
            ) : (
              runs.map((r) => (
                <div
                  key={r.id}
                  className={`hist-item ${selectedId === r.id ? "hist-item--selected" : ""}`}
                  onClick={() => setSelectedId(r.id)}
                >
                  <div className="hist-item-label">
                    {r.dataset.symbol} · {r.dataset.startDate}→{r.dataset.endDate}
                  </div>
                  <div className="hist-item-meta">
                    {formatDate(r.completedAt)} · ${r.config.startingCash.toLocaleString()} · {r.activeBotIds.length} bots
                  </div>
                  <div className="hist-item-winner">
                    {(() => {
                      const winner = r.standings.find((s) => s.rank === 1);
                      if (!winner) return null;
                      const pos = winner.totalReturn >= 0;
                      return (
                        <>
                          <span className="bot-dot" style={{ background: BOT_COLORS[winner.botId] ?? "#94a3b8" }} />
                          <span>{winner.botName}</span>
                          <span className={pos ? "positive" : "negative"}>
                            {pos ? "+" : ""}{(winner.totalReturn * 100).toFixed(1)}%
                          </span>
                        </>
                      );
                    })()}
                  </div>
                  <button
                    className="hist-delete"
                    onClick={(e) => { e.stopPropagation(); handleDelete(r.id); }}
                    title="Delete run"
                  >
                    ✕
                  </button>
                </div>
              ))
            )}
          </div>

          {/* Detail pane */}
          <div className="hist-detail-pane">
            {selected ? (
              <RunDetail run={selected} />
            ) : (
              <div className="hist-empty" style={{ padding: "24px" }}>
                Select a run to inspect its standings.
              </div>
            )}
          </div>
        </div>

        {importError && <div className="cfg-errors"><div className="cfg-error">{importError}</div></div>}

        <div className="modal-footer">
          <div style={{ display: "flex", gap: "8px" }}>
            <button className="cfg-btn cfg-btn--ghost" onClick={() => fileInputRef.current?.click()}>
              ↑ Import JSON
            </button>
            <input ref={fileInputRef} type="file" accept=".json" style={{ display: "none" }} onChange={handleImport} />
            {runs.length > 0 && (
              <button className="cfg-btn cfg-btn--ghost" onClick={handleClear} style={{ color: "var(--red)", borderColor: "var(--red)" }}>
                Clear All
              </button>
            )}
          </div>
          <div className="modal-footer-right">
            <button className="cfg-btn cfg-btn--ghost" onClick={onClose}>Close</button>
          </div>
        </div>
      </div>
    </div>
  );
}
