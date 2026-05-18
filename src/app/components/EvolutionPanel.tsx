/**
 * M14 Slice 3 — Evolution Panel.
 *
 * Self-contained panel for managing an evolution run:
 *   - No session: configure and start a new one
 *   - Session active: view current generation, run a season with evolved bots,
 *     advance the generation, inspect results
 *
 * Persistence ownership: this panel calls saveEvolutionSession() and
 * clearEvolutionSession() directly. App.tsx holds the React state and updates
 * it via onStateChange, but does not write to localStorage.
 *
 * Context enforcement: before each advancement the panel calls
 * contextMatchesCurrent() to ensure the active matchConfig and sourceDataset
 * match the context captured at run creation. Any mismatch blocks advancement
 * with a clear message — silently advancing on a different dataset or config
 * would corrupt the lineage's fitness history.
 */

import { useState } from "react";
import type { Dataset } from "../../engine/types.ts";
import type {
  EvolutionRunState,
  EvolvableBotSpec,
  ArchivedBotRecord,
  FitnessResult,
} from "../../engine/evolution/types.ts";
import { advanceGeneration } from "../../engine/evolution/lifecycle.ts";
import {
  DEFAULT_EVOLUTION_CONFIG,
  createEvolutionSession,
  adaptSeasonResult,
  saveEvolutionSession,
  clearEvolutionSession,
  contextMatchesCurrent,
  type EvolutionSessionData,
} from "../evolutionState.ts";
import { runEvolutionSeason } from "../season.ts";
import type { MatchConfig } from "../matchConfig.ts";

// ─── Props ────────────────────────────────────────────────────────────────────

interface EvolutionPanelProps {
  session: EvolutionSessionData | null;
  matchConfig: MatchConfig;
  sourceDataset: Dataset;
  onStateChange: (data: EvolutionSessionData | null) => void;
  onClose: () => void;
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function fmtScore(v: number): string {
  return v >= 0 ? `+${v.toFixed(4)}` : v.toFixed(4);
}

function shortId(id: string): string {
  return id.length > 16 ? `…${id.slice(-12)}` : id;
}

function paramSummary(params: Record<string, number | boolean | string>): string {
  const keys = Object.keys(params).sort();
  if (keys.length === 0) return "—";
  return keys.map((k) => {
    const v = params[k];
    return `${k}:${typeof v === "number" ? (Number.isInteger(v) ? v : v.toFixed(3)) : v}`;
  }).join("  ");
}

// ─── Sub-components ───────────────────────────────────────────────────────────

function ActivePopTable({ bots }: { bots: EvolvableBotSpec[] }) {
  return (
    <table className="hist-table">
      <thead>
        <tr>
          <th>Archetype</th>
          <th>ID</th>
          <th>Gen</th>
          <th>Params</th>
          <th className="num">Rate</th>
        </tr>
      </thead>
      <tbody>
        {bots.map((b) => (
          <tr key={b.id} className="hist-row">
            <td><span className="badge">{b.archetype}</span></td>
            <td className="muted" style={{ fontFamily: "monospace", fontSize: "0.78em" }}>{shortId(b.id)}</td>
            <td className="num muted">{b.generation}</td>
            <td className="muted" style={{ fontSize: "0.78em" }}>{paramSummary(b.params)}</td>
            <td className="num muted">{(b.mutationRate * 100).toFixed(0)}%</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

function ChampionTable({ champions }: { champions: EvolutionRunState["championHistory"] }) {
  const entries = Object.entries(champions).sort((a, b) => b[1].fitnessScore - a[1].fitnessScore);
  if (entries.length === 0) {
    return <div className="muted" style={{ padding: "8px 0" }}>No champions yet — advance a generation first.</div>;
  }
  return (
    <table className="hist-table">
      <thead>
        <tr>
          <th>Archetype</th>
          <th>Gen</th>
          <th>ID</th>
          <th className="num">Fitness</th>
        </tr>
      </thead>
      <tbody>
        {entries.map(([archetype, rec]) => (
          <tr key={archetype} className="hist-row">
            <td><span className="badge">{archetype}</span></td>
            <td className="num muted">{rec.generation}</td>
            <td className="muted" style={{ fontFamily: "monospace", fontSize: "0.78em" }}>{shortId(rec.botId)}</td>
            <td className={`num ${rec.fitnessScore >= 0 ? "positive" : "negative"}`}>{fmtScore(rec.fitnessScore)}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

function ArchiveBreakdown({ archive }: { archive: ArchivedBotRecord[] }) {
  const counts = archive.reduce<Record<string, number>>((acc, r) => {
    acc[r.retirementReason] = (acc[r.retirementReason] ?? 0) + 1;
    return acc;
  }, {});
  if (archive.length === 0) return <span className="muted">empty</span>;
  const labels: Record<string, string> = {
    reproduced: "reproduced",
    "non-survivor": "non-survivors",
    "gate-failure": "gate failures",
    "population-reset": "reset",
  };
  return (
    <span className="muted">
      {archive.length} archived — {Object.entries(counts).map(([k, v]) => `${v} ${labels[k] ?? k}`).join(", ")}
    </span>
  );
}

// ─── Advance result display ───────────────────────────────────────────────────

interface AdvanceResult {
  fromGeneration: number;
  toGeneration: number;
  fitnessRecords: Array<{ spec: EvolvableBotSpec; fitness: FitnessResult }>;
  survivorIds: Set<string>;
}

function AdvanceResultSection({ result }: { result: AdvanceResult }) {
  const gateFailures = result.fitnessRecords.filter((r) => r.fitness.kind === "gate-failure");
  const survivedIds = result.survivorIds;

  return (
    <div className="cfg-section">
      <div className="cfg-section-title">
        Generation {result.fromGeneration} → {result.toGeneration} Results
      </div>
      <table className="hist-table">
        <thead>
          <tr>
            <th>Archetype</th>
            <th>ID</th>
            <th className="num">Fitness</th>
            <th>Outcome</th>
          </tr>
        </thead>
        <tbody>
          {result.fitnessRecords.map((r) => {
            const isSurvivor = survivedIds.has(r.spec.id);
            const outcome = r.fitness.kind === "gate-failure"
              ? `❌ gate: ${r.fitness.gateFailureReason}`
              : isSurvivor ? "✓ survived" : "✗ eliminated";
            const score = r.fitness.kind === "scored" ? fmtScore(r.fitness.fitnessScore) : "—";
            const scoreClass = r.fitness.kind === "scored"
              ? r.fitness.fitnessScore >= 0 ? "positive" : "negative"
              : "muted";
            return (
              <tr key={r.spec.id} className="hist-row">
                <td><span className="badge">{r.spec.archetype}</span></td>
                <td className="muted" style={{ fontFamily: "monospace", fontSize: "0.78em" }}>{shortId(r.spec.id)}</td>
                <td className={`num ${scoreClass}`}>{score}</td>
                <td className="muted" style={{ fontSize: "0.85em" }}>{outcome}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
      {gateFailures.length > 0 && (
        <div className="cfg-errors" style={{ marginTop: 8 }}>
          <div className="cfg-error">
            {gateFailures.length} bot{gateFailures.length === 1 ? "" : "s"} failed fitness gates.
            {gateFailures.some((r) => r.fitness.kind === "gate-failure" && r.fitness.gateFailureReason === "activity") &&
              " Try lowering minTrades in a new run if bots routinely hit the activity gate."}
          </div>
        </div>
      )}
    </div>
  );
}

// ─── New Run Config ───────────────────────────────────────────────────────────

interface NewRunConfigProps {
  matchConfig: MatchConfig;
  sourceDataset: Dataset;
  onCreate: (session: EvolutionSessionData) => void;
}

function NewRunConfig({ matchConfig, sourceDataset, onCreate }: NewRunConfigProps) {
  const [windowCount, setWindowCount] = useState(4);
  const [mutationRate, setMutationRate] = useState(DEFAULT_EVOLUTION_CONFIG.mutationRate);
  const [minTrades, setMinTrades] = useState(DEFAULT_EVOLUTION_CONFIG.minTrades);
  const [survivorCount, setSurvivorCount] = useState(DEFAULT_EVOLUTION_CONFIG.survivorCount);
  const [wReturn, setWReturn] = useState(DEFAULT_EVOLUTION_CONFIG.fitnessWeights.return);
  const [wDrawdown, setWDrawdown] = useState(DEFAULT_EVOLUTION_CONFIG.fitnessWeights.drawdown);

  const wInconsistency = Math.max(0, parseFloat((1 - wReturn - wDrawdown).toFixed(2)));
  const totalCandles = matchConfig.dataEndIdx - matchConfig.dataStartIdx + 1;
  const windowSize = Math.floor(totalCandles / windowCount);

  function handleCreate() {
    const config = {
      ...DEFAULT_EVOLUTION_CONFIG,
      survivorCount,
      minTrades,
      mutationRate,
      fitnessWeights: { return: wReturn, drawdown: wDrawdown, inconsistency: wInconsistency },
    };
    const now = new Date().toISOString();
    const session = createEvolutionSession(config, matchConfig, sourceDataset, windowCount, now);
    saveEvolutionSession(session);
    onCreate(session);
  }

  return (
    <div className="cfg-section">
      <div className="cfg-section-title">New Evolution Run</div>

      <div className="cfg-range-row">
        <span className="cfg-range-label">Season windows</span>
        <input className="cfg-range" type="range" min={2} max={8} step={1} value={windowCount}
          onChange={(e) => setWindowCount(Number(e.target.value))} />
        <span className="cfg-range-val">{windowCount} · ~{windowSize} candles each</span>
      </div>
      <div className="cfg-range-row">
        <span className="cfg-range-label">Survivors / gen</span>
        <input className="cfg-range" type="range" min={1} max={4} step={1} value={survivorCount}
          onChange={(e) => setSurvivorCount(Number(e.target.value))} />
        <span className="cfg-range-val">{survivorCount} of 5</span>
      </div>
      <div className="cfg-range-row">
        <span className="cfg-range-label">Mutation rate</span>
        <input className="cfg-range" type="range" min={0.05} max={0.8} step={0.05} value={mutationRate}
          onChange={(e) => setMutationRate(Number(e.target.value))} />
        <span className="cfg-range-val">{(mutationRate * 100).toFixed(0)}%</span>
      </div>
      <div className="cfg-range-row">
        <span className="cfg-range-label">Min trades</span>
        <input className="cfg-range" type="range" min={0} max={20} step={1} value={minTrades}
          onChange={(e) => setMinTrades(Number(e.target.value))} />
        <span className="cfg-range-val">{minTrades}</span>
      </div>

      <div className="cfg-section-title" style={{ marginTop: 12 }}>
        Fitness weights
        <span className="cfg-section-note">
          return {(wReturn * 100).toFixed(0)}% · drawdown {(wDrawdown * 100).toFixed(0)}% · inconsistency {(wInconsistency * 100).toFixed(0)}%
        </span>
      </div>
      <div className="cfg-range-row">
        <span className="cfg-range-label">↑ Return</span>
        <input className="cfg-range" type="range" min={0} max={1} step={0.05} value={wReturn}
          onChange={(e) => { const v = Number(e.target.value); setWReturn(v); if (v + wDrawdown > 1) setWDrawdown(parseFloat((1 - v).toFixed(2))); }} />
        <span className="cfg-range-val">{(wReturn * 100).toFixed(0)}%</span>
      </div>
      <div className="cfg-range-row">
        <span className="cfg-range-label">↓ Drawdown</span>
        <input className="cfg-range" type="range" min={0} max={1} step={0.05} value={wDrawdown}
          onChange={(e) => { const v = Number(e.target.value); setWDrawdown(v); if (wReturn + v > 1) setWReturn(parseFloat((1 - v).toFixed(2))); }} />
        <span className="cfg-range-val">{(wDrawdown * 100).toFixed(0)}%</span>
      </div>
      <div className="cfg-range-row">
        <span className="cfg-range-label">↓ Inconsistency</span>
        <input className="cfg-range" type="range" min={0} max={1} step={0.05}
          value={wInconsistency} disabled />
        <span className="cfg-range-val muted">{(wInconsistency * 100).toFixed(0)}% (derived)</span>
      </div>

      {windowSize < 10 && (
        <div className="cfg-errors">
          <div className="cfg-error">Window size too small ({windowSize} candles). Reduce window count or expand the date range in Match Config.</div>
        </div>
      )}

      <div style={{ marginTop: 16 }}>
        <button className="cfg-btn cfg-btn--primary" onClick={handleCreate} disabled={windowSize < 10}>
          Start New Run
        </button>
      </div>
    </div>
  );
}

// ─── Main panel ───────────────────────────────────────────────────────────────

export function EvolutionPanel({
  session,
  matchConfig,
  sourceDataset,
  onStateChange,
  onClose,
}: EvolutionPanelProps) {
  const [running, setRunning] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [advanceResult, setAdvanceResult] = useState<AdvanceResult | null>(null);
  const [windowCount, setWindowCount] = useState(
    session?.runState.datasetManifest.windowCount ?? 4,
  );
  const [confirmReset, setConfirmReset] = useState(false);

  const runState = session?.runState ?? null;
  const totalCandles = matchConfig.dataEndIdx - matchConfig.dataStartIdx + 1;
  const windowSize = Math.floor(totalCandles / windowCount);

  // Context mismatch check — recomputed whenever matchConfig/sourceDataset change
  const contextMismatches = session
    ? contextMatchesCurrent(session.context, matchConfig, sourceDataset)
    : [];

  const canRun = windowSize >= 10 && !running && session !== null && contextMismatches.length === 0;

  function handleRunAndAdvance() {
    if (!session) return;
    setRunning(true);
    setError(null);
    setAdvanceResult(null);

    // Defer to next tick so the "Running…" UI renders before the synchronous
    // season computation blocks the main thread.
    setTimeout(() => {
      try {
        const seasonResult = runEvolutionSeason(
          session.runState.activePop,
          matchConfig,
          windowCount,
          sourceDataset,
        );
        const evolutionSeason = adaptSeasonResult(seasonResult);
        const advancedAt = new Date().toISOString();
        const newRunState = advanceGeneration(session.runState, evolutionSeason, advancedAt);

        // Reconstruct fitness records for display from the archive slice that
        // was just added (the last activePop.length entries).
        const archiveSlice = newRunState.archive.slice(-session.runState.activePop.length);
        const fitnessRecords = session.runState.activePop.map((spec) => {
          const archived = archiveSlice.find((a) => a.id === spec.id);
          return {
            spec,
            fitness: archived?.fitness ?? {
              kind: "gate-failure" as const,
              gateFailureReason: "activity" as const,
              windowMetricsSummary: {
                meanReturn: 0, worstWindowDrawdown: 0, returnStdDev: 0,
                totalTradeCount: 0, windowCount: 0,
              },
            },
          };
        });
        const survivorIds = new Set(
          archiveSlice
            .filter((a) => a.retirementReason === "reproduced")
            .map((a) => a.id),
        );

        setAdvanceResult({
          fromGeneration: session.runState.generation,
          toGeneration: newRunState.generation,
          fitnessRecords,
          survivorIds,
        });

        // Context is immutable across generations — carry it forward unchanged.
        const newSession: EvolutionSessionData = {
          runState: newRunState,
          context: session.context,
        };
        saveEvolutionSession(newSession);
        onStateChange(newSession);
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
      } finally {
        setRunning(false);
      }
    }, 0);
  }

  function handleReset() {
    clearEvolutionSession();
    onStateChange(null);
    setAdvanceResult(null);
    setError(null);
    setConfirmReset(false);
  }

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal modal--wide" onClick={(e) => e.stopPropagation()}>
        <div className="modal-header">
          <span className="modal-title">EVOLUTION</span>
          <button className="modal-close" onClick={onClose}>✕</button>
        </div>

        <div className="modal-body">

          {/* ── No run yet ── */}
          {!session && (
            <NewRunConfig
              matchConfig={matchConfig}
              sourceDataset={sourceDataset}
              onCreate={(s) => { onStateChange(s); setAdvanceResult(null); setError(null); }}
            />
          )}

          {/* ── Active run ── */}
          {session && runState && (
            <>
              {/* Run header */}
              <div className="cfg-section">
                <div className="cfg-section-title">
                  Run · Generation {runState.generation}
                  <span className="cfg-section-note">
                    {runState.activePop.length} bots ·
                    {" "}{runState.datasetManifest.symbol} ·
                    {" "}started {runState.createdAt.slice(0, 10)}
                  </span>
                </div>
                <ActivePopTable bots={runState.activePop} />
              </div>

              {/* Context mismatch warning — blocks advancement */}
              {contextMismatches.length > 0 && (
                <div className="cfg-section">
                  <div className="cfg-errors">
                    <div className="cfg-error" style={{ fontWeight: 600 }}>
                      Match context has changed since this run was created. Advancing would mix fitness data from different market environments. Reset the run or restore the original match config to continue.
                    </div>
                    <ul style={{ margin: "6px 0 0 16px", padding: 0, fontSize: "0.82em" }}>
                      {contextMismatches.map((m, i) => (
                        <li key={i} className="cfg-error" style={{ fontWeight: "normal" }}>{m}</li>
                      ))}
                    </ul>
                  </div>
                </div>
              )}

              {/* Season & advance */}
              <div className="cfg-section">
                <div className="cfg-section-title">
                  Run Season & Advance Generation
                </div>
                <div className="cfg-range-row">
                  <span className="cfg-range-label">Windows</span>
                  <input
                    className="cfg-range"
                    type="range"
                    min={2}
                    max={8}
                    step={1}
                    value={windowCount}
                    onChange={(e) => setWindowCount(Number(e.target.value))}
                    disabled={running}
                  />
                  <span className="cfg-range-val">
                    {windowCount} · ~{windowSize} candles each
                  </span>
                </div>

                {windowSize < 10 && (
                  <div className="cfg-errors">
                    <div className="cfg-error">
                      Window size too small ({windowSize} candles). Reduce window count or expand the date range.
                    </div>
                  </div>
                )}

                {error && (
                  <div className="cfg-errors" style={{ marginTop: 8 }}>
                    <div className="cfg-error">{error}</div>
                  </div>
                )}

                {running && (
                  <div className="hist-empty" style={{ padding: "16px 0" }}>
                    Running {windowCount} windows with {runState.activePop.length} bots…
                  </div>
                )}

                <div style={{ marginTop: 12 }}>
                  <button
                    className="cfg-btn cfg-btn--primary"
                    disabled={!canRun}
                    onClick={handleRunAndAdvance}
                  >
                    {running
                      ? "Running…"
                      : `Run Season & Advance to Gen ${runState.generation + 1}`}
                  </button>
                </div>
              </div>

              {/* Advance result */}
              {advanceResult && <AdvanceResultSection result={advanceResult} />}

              {/* Champion history */}
              <div className="cfg-section">
                <div className="cfg-section-title">
                  Champions
                  <span className="cfg-section-note">best fitness per archetype, all time</span>
                </div>
                <ChampionTable champions={runState.championHistory} />
              </div>

              {/* Archive summary */}
              <div className="cfg-section">
                <div className="cfg-section-title">Archive</div>
                <ArchiveBreakdown archive={runState.archive} />
              </div>
            </>
          )}
        </div>

        <div className="modal-footer">
          {session && (
            confirmReset ? (
              <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
                <span className="muted" style={{ fontSize: "0.85em" }}>Reset and discard this run?</span>
                <button className="cfg-btn cfg-btn--ghost" onClick={() => setConfirmReset(false)}>Cancel</button>
                <button className="cfg-btn" style={{ color: "var(--color-negative)" }} onClick={handleReset}>Confirm Reset</button>
              </div>
            ) : (
              <button className="cfg-btn cfg-btn--ghost" onClick={() => setConfirmReset(true)}>
                Reset Run
              </button>
            )
          )}
          <div className="modal-footer-right">
            <button className="cfg-btn cfg-btn--ghost" onClick={onClose}>Close</button>
          </div>
        </div>
      </div>
    </div>
  );
}
