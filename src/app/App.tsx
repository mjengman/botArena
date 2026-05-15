import { useMemo, useState, useEffect, useRef } from "react";
import { useSimulation } from "./hooks/useSimulation.ts";
import { Controls } from "./components/Controls.tsx";
import { Leaderboard } from "./components/Leaderboard.tsx";
import { BotInspector } from "./components/BotInspector.tsx";
import { PriceChart } from "./components/PriceChart.tsx";
import { EquityCurves } from "./components/EquityCurves.tsx";
import { EventFeed } from "./components/EventFeed.tsx";
import { ConfigPanel } from "./components/ConfigPanel.tsx";
import { HistoryPanel } from "./components/HistoryPanel.tsx";
import { SeasonPanel } from "./components/SeasonPanel.tsx";
import { PaperModePanel } from "./components/PaperModePanel.tsx";
import { WelcomePanel } from "./components/WelcomePanel.tsx";
import { exportRun } from "./exportRun.ts";

const WELCOMED_KEY = "bot-arena:welcomed";
import type { CurveView } from "./components/EquityCurves.tsx";
import { type StoredRun, saveRun, loadHistory } from "./history.ts";

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
  const [historyOpen, setHistoryOpen] = useState(false);
  const [seasonOpen, setSeasonOpen] = useState(false);
  const [paperOpen, setPaperOpen] = useState(false);
  const [welcomeOpen, setWelcomeOpen] = useState(
    () => !localStorage.getItem(WELCOMED_KEY),
  );
  const [history, setHistory] = useState<StoredRun[]>(() => loadHistory());

  function dismissWelcome() {
    localStorage.setItem(WELCOMED_KEY, "1");
    setWelcomeOpen(false);
  }

  function handleWelcomeStart() {
    dismissWelcome();
    if (state.isComplete) {
      reset();
      // reset() is synchronous — sim is back at candle 0; play() will start
      // immediately on the next render cycle via the useEffect in useSimulation.
      // We use a zero-delay setTimeout so the reset state flush lands first.
      setTimeout(play, 0);
    } else {
      play();
    }
  }

  const progress =
    state.candleTotal > 0
      ? Math.round((state.candleIndex / state.candleTotal) * 100)
      : 0;

  // Auto-save completed matches to history
  const wasCompleteRef = useRef(false);
  useEffect(() => {
    const justCompleted = state.isComplete && !wasCompleteRef.current && state.candleIndex > 1;
    if (justCompleted) {
      const run: StoredRun = {
        id: `run-${Date.now()}`,
        completedAt: new Date().toISOString(),
        config: {
          startingCash: matchConfig.startingCash,
          feeBps: matchConfig.feeBps,
          slippageBps: matchConfig.slippageBps,
          seed: matchConfig.seed,
        },
        dataset: {
          symbol: dataset.manifest.symbol,
          startDate: dataset.manifest.startDate,
          endDate: dataset.manifest.endDate,
          candleCount: dataset.manifest.candleCount,
        },
        activeBotIds: matchConfig.activeBotIds,
        standings: state.standings,
        eventCount: state.events.length,
      };
      saveRun(run);
      setHistory(loadHistory());
    }
    wasCompleteRef.current = state.isComplete;
  }, [state.isComplete]);

  function handleHistoryChange() {
    setHistory(loadHistory());
  }

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

        <div className="header-actions">
          <button
            className="ctrl-btn ctrl-btn--help"
            onClick={() => setWelcomeOpen(true)}
            title="Help / getting started"
          >?</button>
          <button className="ctrl-btn" onClick={openConfig} title="Configure match">⚙</button>
          <button
            className="ctrl-btn ctrl-btn--nav"
            onClick={() => setPaperOpen(true)}
            title="Paper trading session"
          >
            ◎ Paper
          </button>
          <button
            className="ctrl-btn ctrl-btn--nav"
            onClick={() => setSeasonOpen(true)}
            title="Run a season"
          >
            ◉ Season
          </button>
          <button
            className={`ctrl-btn ctrl-btn--nav ${history.length > 0 ? "ctrl-btn--nav-active" : ""}`}
            onClick={() => setHistoryOpen(true)}
            title="Browse match history"
          >
            ☰ History{history.length > 0 && <span className="history-count">{history.length}</span>}
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
        </div>
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

      {/* ── Modals ───────────────────────────────────────────────── */}
      {welcomeOpen && (
        <WelcomePanel
          onStart={handleWelcomeStart}
          onClose={dismissWelcome}
          isComplete={state.isComplete}
        />
      )}
      {configOpen && (
        <ConfigPanel current={matchConfig} onApply={applyConfig} onClose={closeConfig} />
      )}
      {historyOpen && (
        <HistoryPanel
          runs={history}
          onClose={() => setHistoryOpen(false)}
          onRunsChange={handleHistoryChange}
        />
      )}
      {seasonOpen && (
        <SeasonPanel matchConfig={matchConfig} onClose={() => setSeasonOpen(false)} />
      )}
      {paperOpen && (
        <PaperModePanel onClose={() => setPaperOpen(false)} />
      )}
    </div>
  );
}
