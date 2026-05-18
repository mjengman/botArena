/**
 * M14 Slice 3 + Slice 4A — Evolution Panel.
 *
 * Self-contained panel for managing an evolution run:
 *   - No session: configure and start a new one
 *   - Session active: view current generation, run a season with evolved bots,
 *     review the season results (fitness breakdown, per-window metrics, regime
 *     labels, survivor/retirement reasons), then advance the generation
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
 *
 * Slice 4A additions:
 *   - FitnessExplanation / explainFitness() renders component breakdown per bot
 *   - Per-window results table with regime labels (Uptrend/Sideways/Downtrend)
 *   - Survivor / retirement reason annotations
 *   - Tooltips on each fitness component label
 *   - Expandable per-bot fitness breakdown rows
 */

import { useState } from "react";
import type { Dataset } from "../../engine/types.ts";
import type {
  EvolutionRunState,
  EvolvableBotSpec,
  ArchivedBotRecord,
  FitnessResult,
  EvolutionConfig,
} from "../../engine/evolution/types.ts";
import { explainFitness } from "../../engine/evolution/explain.ts";
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
import { runEvolutionSeason, buildWindowDefs } from "../season.ts";
import type { SeasonWindow } from "../season.ts";
import type { MatchConfig } from "../matchConfig.ts";
import { Tooltip } from "./Tooltip.tsx";

// ─── Props ────────────────────────────────────────────────────────────────────

interface EvolutionPanelProps {
  session: EvolutionSessionData | null;
  matchConfig: MatchConfig;
  sourceDataset: Dataset;
  onStateChange: (data: EvolutionSessionData | null) => void;
  onClose: () => void;
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function fmtPct(v: number, decimals = 1): string {
  const s = (v * 100).toFixed(decimals);
  return v >= 0 ? `+${s}%` : `${s}%`;
}

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

/**
 * Compute a regime label for a price window based on first→last close slope.
 * Threshold: ±3% change classifies as trending; within that range is Sideways.
 */
function computeRegimeLabel(dataset: Dataset, startIdx: number, endIdx: number): "Uptrend" | "Sideways" | "Downtrend" {
  const first = dataset.candles[startIdx]?.close;
  const last = dataset.candles[endIdx]?.close;
  if (!first || !last || first <= 0) return "Sideways";
  const slope = (last - first) / first;
  if (slope > 0.03) return "Uptrend";
  if (slope < -0.03) return "Downtrend";
  return "Sideways";
}

const REGIME_EMOJI: Record<string, string> = {
  Uptrend: "📈",
  Sideways: "➡",
  Downtrend: "📉",
};

// ─── Tooltip copy ─────────────────────────────────────────────────────────────

const TOOLTIP_RETURN = "Reward for average return across all season windows. Higher is better. Weighted by the return fitness weight.";
const TOOLTIP_DRAWDOWN = "Penalty for the worst single-window max drawdown. A deeper loss in any one window costs more here. Weighted by the drawdown fitness weight.";
const TOOLTIP_INCONSISTENCY = "Penalty for variance in returns across windows. A bot that wins some windows by gambling and loses others badly scores worse here. Weighted by the inconsistency fitness weight.";
const TOOLTIP_ACTIVITY = "Activity gate: this bot did not meet the minimum trade count across all windows. It cannot be scored or selected. Lower minTrades in a new run if this is unexpected.";
const TOOLTIP_SURVIVAL = "Survival gate: this bot's equity reached zero or below in at least one window. It is disqualified from scoring. Review the bot's params or reduce position sizing.";

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

// ─── Season results view (Slice 4A) ──────────────────────────────────────────

interface SeasonResultData {
  fromGeneration: number;
  toGeneration: number;
  fitnessRecords: Array<{ spec: EvolvableBotSpec; fitness: FitnessResult }>;
  survivorIds: Set<string>;
  seasonWindows: SeasonWindow[];
  regimeLabels: Array<"Uptrend" | "Sideways" | "Downtrend">;
  config: EvolutionConfig;
}

function WindowSummaryTable({
  windows,
  regimeLabels,
}: {
  windows: SeasonWindow[];
  regimeLabels: Array<"Uptrend" | "Sideways" | "Downtrend">;
}) {
  return (
    <div style={{ marginBottom: 12 }}>
      <div style={{ fontSize: "0.8em", fontWeight: 600, color: "var(--color-muted)", marginBottom: 4, textTransform: "uppercase", letterSpacing: "0.06em" }}>
        Season Windows
      </div>
      <table className="hist-table">
        <thead>
          <tr>
            <th>Win</th>
            <th>Dates</th>
            <th>Regime</th>
            <th className="num">Avg Return</th>
          </tr>
        </thead>
        <tbody>
          {windows.map((w, i) => {
            const regime = regimeLabels[i] ?? "Sideways";
            const avgReturn = w.standings.length > 0
              ? w.standings.reduce((sum, s) => sum + s.totalReturn, 0) / w.standings.length
              : 0;
            return (
              <tr key={w.index} className="hist-row">
                <td className="num muted">{w.index + 1}</td>
                <td className="muted" style={{ fontSize: "0.82em" }}>
                  {w.startDate.slice(0, 10)} → {w.endDate.slice(0, 10)}
                </td>
                <td>
                  <span style={{ fontSize: "0.85em" }}>
                    {REGIME_EMOJI[regime]} {regime}
                  </span>
                </td>
                <td className={`num ${avgReturn >= 0 ? "positive" : "negative"}`} style={{ fontSize: "0.9em" }}>
                  {fmtPct(avgReturn)}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

function FitnessBreakdownRow({
  record,
  config,
}: {
  record: { spec: EvolvableBotSpec; fitness: FitnessResult };
  config: EvolutionConfig;
}) {
  const ex = explainFitness(record, config);

  if (ex.kind === "gate-failure") {
    const isActivity = ex.gateFailureReason === "activity";
    return (
      <tr className="hist-row" style={{ background: "var(--color-panel-alt, rgba(255,100,80,0.04))" }}>
        <td colSpan={99} style={{ padding: "6px 12px 6px 28px" }}>
          <div style={{ display: "flex", gap: 16, alignItems: "center", flexWrap: "wrap" }}>
            <span style={{ fontSize: "0.82em", fontWeight: 600, color: "var(--color-negative)" }}>
              ❌ {isActivity ? "Activity gate failed" : "Survival gate failed"}
              {" "}<Tooltip text={isActivity ? TOOLTIP_ACTIVITY : TOOLTIP_SURVIVAL} />
            </span>
            <span className="muted" style={{ fontSize: "0.78em" }}>
              {isActivity
                ? `${ex.windowMetricsSummary.totalTradeCount} total trades across ${ex.windowMetricsSummary.windowCount} windows (min: ${config.minTrades})`
                : `Bot lost all capital in at least one window`
              }
            </span>
          </div>
        </td>
      </tr>
    );
  }

  // Scored bot — show component breakdown
  const { returnComponent, drawdownPenalty, inconsistencyPenalty, score, weights, windowMetricsSummary: m } = ex;
  return (
    <tr className="hist-row" style={{ background: "var(--color-panel-alt, rgba(80,120,255,0.04))" }}>
      <td colSpan={99} style={{ padding: "6px 12px 6px 28px" }}>
        <div style={{ display: "flex", gap: 24, alignItems: "baseline", flexWrap: "wrap", fontSize: "0.82em" }}>
          {/* Return component */}
          <span>
            <span className="muted">
              ↑ Return <Tooltip text={TOOLTIP_RETURN} />
            </span>
            {" "}
            <span className={returnComponent >= 0 ? "positive" : "negative"}>
              {returnComponent >= 0 ? "+" : ""}{returnComponent.toFixed(4)}
            </span>
            {" "}
            <span className="muted">({fmtPct(m.meanReturn)} avg · {(weights.return * 100).toFixed(0)}% wt)</span>
          </span>

          {/* Drawdown penalty */}
          <span>
            <span className="muted">
              ↓ Drawdown <Tooltip text={TOOLTIP_DRAWDOWN} />
            </span>
            {" "}
            <span className="negative">
              -{drawdownPenalty.toFixed(4)}
            </span>
            {" "}
            <span className="muted">({fmtPct(m.worstWindowDrawdown, 1)} worst · {(weights.drawdown * 100).toFixed(0)}% wt)</span>
          </span>

          {/* Inconsistency penalty */}
          <span>
            <span className="muted">
              ↓ Inconsistency <Tooltip text={TOOLTIP_INCONSISTENCY} />
            </span>
            {" "}
            <span className="negative">
              -{inconsistencyPenalty.toFixed(4)}
            </span>
            {" "}
            <span className="muted">(σ {fmtPct(m.returnStdDev, 2)} · {(weights.inconsistency * 100).toFixed(0)}% wt)</span>
          </span>

          {/* Final score */}
          <span style={{ fontWeight: 600 }}>
            = <span className={score >= 0 ? "positive" : "negative"}>{fmtScore(score)}</span>
          </span>
        </div>
      </td>
    </tr>
  );
}

function BotResultsTable({
  result,
}: {
  result: SeasonResultData;
}) {
  const [expandedIds, setExpandedIds] = useState<Set<string>>(new Set());

  function toggle(id: string) {
    setExpandedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  const { fitnessRecords, survivorIds, seasonWindows, config } = result;

  // Sort: survivors first (by fitness desc), then gate-failures last
  const sorted = [...fitnessRecords].sort((a, b) => {
    const aScore = a.fitness.kind === "scored" ? a.fitness.fitnessScore : -Infinity;
    const bScore = b.fitness.kind === "scored" ? b.fitness.fitnessScore : -Infinity;
    return bScore - aScore;
  });

  return (
    <div style={{ marginBottom: 12 }}>
      <div style={{ fontSize: "0.8em", fontWeight: 600, color: "var(--color-muted)", marginBottom: 4, textTransform: "uppercase", letterSpacing: "0.06em" }}>
        Bot Results
      </div>
      <table className="hist-table">
        <thead>
          <tr>
            <th style={{ width: 20 }}></th>
            <th>Archetype</th>
            <th>ID</th>
            {seasonWindows.map((w, i) => (
              <th key={w.index} className="num" title={`Window ${i + 1}: ${w.startDate.slice(0, 10)} → ${w.endDate.slice(0, 10)}`}>
                W{i + 1}
              </th>
            ))}
            <th className="num">Fitness</th>
            <th>Outcome</th>
          </tr>
        </thead>
        <tbody>
          {sorted.map((r) => {
            const isSurvivor = survivorIds.has(r.spec.id);
            const isGateFail = r.fitness.kind === "gate-failure";
            const expanded = expandedIds.has(r.spec.id);

            const outcome = r.fitness.kind === "gate-failure"
              ? `❌ ${r.fitness.gateFailureReason} gate`
              : isSurvivor
              ? "✓ survived"
              : "✗ retired";
            const outcomeClass = isGateFail ? "muted" : isSurvivor ? "positive" : "negative";

            const score = r.fitness.kind === "scored" ? fmtScore(r.fitness.fitnessScore) : "—";
            const scoreClass = r.fitness.kind === "scored"
              ? r.fitness.fitnessScore >= 0 ? "positive" : "negative"
              : "muted";

            return [
              <tr key={r.spec.id} className="hist-row" style={{ cursor: "pointer" }} onClick={() => toggle(r.spec.id)}>
                {/* Expand toggle */}
                <td style={{ fontSize: "0.7em", color: "var(--color-muted)", textAlign: "center" }}>
                  {expanded ? "▼" : "▶"}
                </td>
                <td><span className="badge">{r.spec.archetype}</span></td>
                <td className="muted" style={{ fontFamily: "monospace", fontSize: "0.78em" }}>
                  {shortId(r.spec.id)}
                </td>
                {/* Per-window returns */}
                {seasonWindows.map((w) => {
                  const snap = w.standings.find((s) => s.botId === r.spec.id);
                  const ret = snap?.totalReturn ?? null;
                  return (
                    <td key={w.index} className={`num ${ret === null ? "muted" : ret >= 0 ? "positive" : "negative"}`} style={{ fontSize: "0.82em" }}>
                      {ret === null ? "—" : fmtPct(ret)}
                    </td>
                  );
                })}
                <td className={`num ${scoreClass}`}>{score}</td>
                <td className={`${outcomeClass}`} style={{ fontSize: "0.85em" }}>{outcome}</td>
              </tr>,
              expanded && (
                <FitnessBreakdownRow key={`${r.spec.id}-breakdown`} record={r} config={config} />
              ),
            ];
          })}
        </tbody>
      </table>
      <div className="muted" style={{ fontSize: "0.78em", marginTop: 4 }}>
        Click any row to expand the fitness breakdown.
      </div>
    </div>
  );
}

function SeasonResultsSection({ result }: { result: SeasonResultData }) {
  return (
    <div className="cfg-section">
      <div className="cfg-section-title">
        Generation {result.fromGeneration} → {result.toGeneration} Results
        <span className="cfg-section-note">
          {result.seasonWindows.length} windows · {result.fitnessRecords.length} bots
        </span>
      </div>

      <WindowSummaryTable
        windows={result.seasonWindows}
        regimeLabels={result.regimeLabels}
      />

      <BotResultsTable result={result} />

      {/* Gate failure summary if any */}
      {result.fitnessRecords.some((r) => r.fitness.kind === "gate-failure") && (
        <div className="cfg-errors" style={{ marginTop: 4 }}>
          <div className="cfg-error" style={{ fontSize: "0.82em" }}>
            {result.fitnessRecords.filter((r) => r.fitness.kind === "gate-failure").length} bot(s) failed fitness gates and were retired. Click their row above for details.
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
  const [seasonResult, setSeasonResult] = useState<SeasonResultData | null>(null);
  const [confirmReset, setConfirmReset] = useState(false);

  const runState = session?.runState ?? null;
  // Window count is fixed at run creation — read from context, never from UI state.
  const windowCount = session?.context.windowCount ?? 4;
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
    setSeasonResult(null);

    // Defer to next tick so the "Running…" UI renders before the synchronous
    // season computation blocks the main thread.
    setTimeout(() => {
      try {
        const rawSeasonResult = runEvolutionSeason(
          session.runState.activePop,
          matchConfig,
          windowCount,
          sourceDataset,
        );

        // Compute regime labels from price slope for each window.
        const windowDefs = buildWindowDefs(matchConfig, windowCount);
        const regimeLabels = windowDefs.map((def) =>
          computeRegimeLabel(sourceDataset, def.startIdx, def.endIdx),
        );

        const evolutionSeason = adaptSeasonResult(rawSeasonResult);
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

        setSeasonResult({
          fromGeneration: session.runState.generation,
          toGeneration: newRunState.generation,
          fitnessRecords,
          survivorIds,
          seasonWindows: rawSeasonResult.windows,
          regimeLabels,
          config: session.runState.config,
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
    setSeasonResult(null);
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
              onCreate={(s) => { onStateChange(s); setSeasonResult(null); setError(null); }}
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
                  <span className="cfg-range-val">
                    {windowCount} · ~{windowSize} candles each
                    <span className="muted" style={{ marginLeft: 8, fontSize: "0.82em" }}>(fixed at run creation)</span>
                  </span>
                </div>

                {windowSize < 10 && (
                  <div className="cfg-errors">
                    <div className="cfg-error">
                      Window size too small ({windowSize} candles) — the current date range is narrower than when this run was created. Restore the original date range in Match Config.
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

              {/* Season results (Slice 4A) */}
              {seasonResult && <SeasonResultsSection result={seasonResult} />}

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
