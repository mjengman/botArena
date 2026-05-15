import { useMemo, useState } from "react";
import { useSimulation } from "./hooks/useSimulation.ts";
import { Controls } from "./components/Controls.tsx";
import { Leaderboard } from "./components/Leaderboard.tsx";
import { BotInspector } from "./components/BotInspector.tsx";
import { PriceChart } from "./components/PriceChart.tsx";
import { EquityCurves } from "./components/EquityCurves.tsx";
import { EventFeed } from "./components/EventFeed.tsx";
import { ConfigPanel } from "./components/ConfigPanel.tsx";
import { exportRun } from "./exportRun.ts";
import type { CurveView } from "./components/EquityCurves.tsx";

export function App() {
  const {
    state,
    isPlaying,
    speed,
    selectedBotId,
    matchConfig,
    configOpen,
    play,
    pause,
    step,
    reset,
    setSpeed,
    selectBot,
    openConfig,
    closeConfig,
    applyConfig,
    dataset,
  } = useSimulation();

  const botNames = useMemo(() => {
    const map: Record<string, string> = {};
    for (const b of state.botDetails) map[b.id] = b.name;
    return map;
  }, [state.botDetails]);

  const selectedBot = state.botDetails.find((b) => b.id === selectedBotId) ?? null;
  const selectedBotMetrics = state.standings.find((s) => s.botId === selectedBotId) ?? null;

  const [curveView, setCurveView] = useState<CurveView>("equity");

  const progress =
    state.candleTotal > 0
      ? Math.round((state.candleIndex / state.candleTotal) * 100)
      : 0;

  return (
    <div className="app">
      {/* ── Header ───────────────────────────────────────────────── */}
      <header className="header">
        <div className="brand">
          <span className="brand-icon">⚔</span>
          BOT ARENA
        </div>

        <div className="clock">
          <span className="clock-date">{state.candleIndex > 0 ? state.currentDate : dataset.manifest.startDate}</span>
          <span className="clock-sep">·</span>
          <span className="clock-progress">
            Candle {state.candleIndex} / {state.candleTotal}
          </span>
          <span className="clock-sep">·</span>
          <span className="clock-pct">{progress}%</span>
          {state.isComplete && <span className="badge badge--done">FINAL</span>}
        </div>

        <Controls
          isPlaying={isPlaying}
          isComplete={state.isComplete}
          speed={speed}
          onPlay={play}
          onPause={pause}
          onStep={step}
          onReset={reset}
          onSpeedChange={setSpeed}
        />

        <button className="ctrl-btn" onClick={openConfig} title="Configure match">
          ⚙
        </button>

        {state.isComplete && (
          <button
            className="ctrl-btn ctrl-btn--export"
            onClick={() => exportRun(state, matchConfig)}
            title="Export run as JSON"
          >
            ↓ JSON
          </button>
        )}
      </header>

      {/* ── Sidebar ──────────────────────────────────────────────── */}
      <aside className="sidebar">
        <Leaderboard
          standings={state.standings}
          selectedBotId={selectedBotId}
          onSelect={(id) => selectBot(selectedBotId === id ? null : id)}
        />
        <BotInspector bot={selectedBot} metrics={selectedBotMetrics} events={state.events} />
      </aside>

      {/* ── Charts ───────────────────────────────────────────────── */}
      <main className="charts">
        <div className="chart-panel">
          <div className="chart-header">
            <span className="chart-title">Price · {dataset.manifest.symbol}</span>
            {selectedBotId && (
              <span className="chart-subtitle muted">
                ▲ buy &nbsp; ▼ sell for {botNames[selectedBotId]}
              </span>
            )}
          </div>
          <div className="chart-body">
            <PriceChart
              dataset={dataset}
              candleIndex={state.candleIndex}
              events={state.events}
              selectedBotId={selectedBotId}
            />
          </div>
        </div>

        <div className="chart-panel">
          <div className="chart-header">
            <span className="chart-title">
              {curveView === "equity" ? "Equity Curves" : "Drawdown"}
            </span>
            <div className="curve-toggle">
              <button
                className={`curve-toggle-btn ${curveView === "equity" ? "curve-toggle-btn--active" : ""}`}
                onClick={() => setCurveView("equity")}
              >
                Equity
              </button>
              <button
                className={`curve-toggle-btn ${curveView === "drawdown" ? "curve-toggle-btn--active" : ""}`}
                onClick={() => setCurveView("drawdown")}
              >
                Drawdown
              </button>
            </div>
          </div>
          <div className="chart-body">
            <EquityCurves
              equityHistories={state.equityHistories}
              selectedBotId={selectedBotId}
              view={curveView}
              startingCash={matchConfig.startingCash}
            />
          </div>
        </div>
      </main>

      {/* ── Event Feed ───────────────────────────────────────────── */}
      <EventFeed
        events={state.events}
        selectedBotId={selectedBotId}
        botNames={botNames}
      />

      {/* ── Config Modal ─────────────────────────────────────────── */}
      {configOpen && (
        <ConfigPanel
          current={matchConfig}
          onApply={applyConfig}
          onClose={closeConfig}
        />
      )}
    </div>
  );
}
