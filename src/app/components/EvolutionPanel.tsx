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
  EvolutionSeasonResult,
} from "../../engine/evolution/types.ts";
import { explainFitness } from "../../engine/evolution/explain.ts";
import { scorePopulation } from "../../engine/evolution/fitness.ts";
import {
  computeConfidenceIndicators,
  computeEvidenceTier,
  computeRegimeCoverage,
  DEFERRED_TIERS,
  EVIDENCE_TIER_ORDER,
} from "../../engine/evolution/confidence.ts";
import type { EvidenceTier } from "../../engine/evolution/confidence.ts";
import type { EvaluationEnvironment } from "../../engine/evolution/evaluationEnvironment.ts";
import { NoEligibleSurvivorsError } from "../../engine/evolution/lifecycle.ts";
import { computeRegimeLabel } from "../../engine/evolution/regime.ts";
import type { RegimeLabel } from "../../engine/evolution/regime.ts";
import { computeAdvanceProposal } from "../../engine/evolution/proposal.ts";
import type { GenerationAdvanceProposal, AdvanceOverrides } from "../../engine/evolution/proposal.ts";
import { commitProposal } from "../../engine/evolution/commit.ts";
import {
  DEFAULT_EVOLUTION_CONFIG,
  createEvolutionSession,
  adaptSeasonResult,
  saveEvolutionSession,
  clearEvolutionSession,
  contextMatchesCurrent,
  deriveEvaluationEnvironment,
  type EvolutionSessionData,
} from "../evolutionState.ts";
import { runEvolutionSeason, buildWindowDefs } from "../season.ts";
import type { SeasonWindow } from "../season.ts";
import type { MatchConfig } from "../matchConfig.ts";
import { Tooltip } from "./Tooltip.tsx";
import { EvidenceBadge, TIER_INFO } from "./EvidenceBadge.tsx";
import { StrategyCard } from "./StrategyCard.tsx";

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


const REGIME_EMOJI: Record<RegimeLabel, string> = {
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

// ─── Confidence / Evidence Ladder tooltip copy ────────────────────────────────

const TOOLTIP_CONFIDENCE = "Confidence is not the same as fitness. A bot can score well in one season and still have low confidence — it may have found a lucky set of params that fit a narrow sample. Evidence accumulates over generations: more seasons survived, more windows evaluated, more regime types seen.";
const TOOLTIP_EVIDENCE_COLUMN = "Highest Evidence Ladder tier reached by this lineage. A Hatchling may outperform a Backtest Champion in the current season — but the Champion has shown durability across many more seasons and conditions.";
const TOOLTIP_REGIME_UPTREND = "Uptrend windows: price slope > +3% across the window. A bot that only scores well in Uptrend conditions may underperform in flat or falling markets.";
const TOOLTIP_REGIME_SIDEWAYS = "Sideways windows: price slope within ±3%. The most common real-world regime — bots that fail here often rely on trend-following assumptions.";
const TOOLTIP_REGIME_DOWNTREND = "Downtrend windows: price slope < −3%. Bots that survive drawdown in these windows show resilience to adverse conditions.";


// ─── Sub-components ───────────────────────────────────────────────────────────

function EvaluationEnvironmentHeader({ env }: { env: EvaluationEnvironment }) {
  const sourceLabel = env.dataSource === "alpaca"
    ? `Alpaca ${env.feed ?? "iex"}`
    : env.dataSource === "csv"
    ? "CSV"
    : "Synthetic";

  return (
    <div className="evol-env-header">
      <span className="evol-env-header__name">{env.name}</span>
      <span className="evol-env-header__chip">{env.symbol}</span>
      <span className="evol-env-header__chip">{sourceLabel}</span>
      <span className="evol-env-header__chip">{env.timeframe}</span>
      <span className="evol-env-header__chip">{env.dateRange.start.slice(0, 10)} → {env.dateRange.end.slice(0, 10)}</span>
      <span className="evol-env-header__chip">{env.windowCount} windows</span>
      <span className="evol-env-header__chip">${env.startingCash.toLocaleString()}</span>
      <span className="evol-env-header__chip">{env.feeBps}bps fee · {env.slippageBps}bps slip</span>
      {env.regimeSummary && <span className="evol-env-header__chip muted">{env.regimeSummary}</span>}
    </div>
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

/**
 * The full 8-tier Evidence Ladder plus regime coverage and tier distribution.
 * Shown once per season result, above the bot results table.
 */
function EvidenceLadderSection({
  fitnessRecords,
  archive,
  regimeLabels,
}: {
  fitnessRecords: Array<{ spec: EvolvableBotSpec; fitness: FitnessResult }>;
  archive: ArchivedBotRecord[];
  regimeLabels: RegimeLabel[];
}) {
  const windowCount = regimeLabels.length;
  const coverage = computeRegimeCoverage(regimeLabels);

  // Tally Evidence Ladder tiers for the current active population
  const tierCounts = new Map<EvidenceTier, number>();
  for (const record of fitnessRecords) {
    const indicators = computeConfidenceIndicators(record.spec, archive, windowCount, regimeLabels);
    const tier = computeEvidenceTier(indicators);
    tierCounts.set(tier, (tierCounts.get(tier) ?? 0) + 1);
  }

  const sortedTierCounts = [...tierCounts.entries()].sort(
    ([a], [b]) => EVIDENCE_TIER_ORDER.indexOf(a) - EVIDENCE_TIER_ORDER.indexOf(b),
  );

  return (
    <div style={{ marginBottom: 14 }}>
      {/* Section header */}
      <div style={{
        fontSize: "0.8em", fontWeight: 600, color: "var(--color-muted)",
        marginBottom: 6, textTransform: "uppercase", letterSpacing: "0.06em",
        display: "flex", alignItems: "center", gap: 6,
      }}>
        Evidence Ladder
        <Tooltip text={TOOLTIP_CONFIDENCE} />
      </div>

      {/* 8-tier ladder — deferred tiers are locked and faded */}
      <div style={{ display: "flex", gap: 2, flexWrap: "wrap", alignItems: "center", marginBottom: 8 }}>
        {EVIDENCE_TIER_ORDER.map((tier, i) => {
          const isDeferred = DEFERRED_TIERS.has(tier);
          const info = TIER_INFO[tier];
          return (
            <span key={tier} style={{ display: "inline-flex", alignItems: "center", gap: 2 }}>
              {i > 0 && (
                <span className="muted" style={{ fontSize: "0.68em", padding: "0 1px" }}>→</span>
              )}
              <span style={{
                display: "inline-flex", alignItems: "center", gap: 3,
                fontSize: "0.73em", padding: "2px 6px", borderRadius: 4,
                border: "1px solid var(--color-border, #444)",
                opacity: isDeferred ? 0.38 : 1,
                color: isDeferred ? "var(--color-muted)" : info.color,
                whiteSpace: "nowrap",
              }}>
                {isDeferred ? "🔒" : info.emoji} {info.label}
                <Tooltip text={info.tooltip} />
              </span>
            </span>
          );
        })}
      </div>

      {/* Regime coverage + tier distribution */}
      <div style={{ display: "flex", gap: 16, flexWrap: "wrap", fontSize: "0.82em", alignItems: "center" }}>
        <span className="muted" style={{ fontWeight: 600 }}>Season regimes:</span>
        <span style={{ opacity: coverage.uptrend === 0 ? 0.4 : 1 }}>
          📈 {coverage.uptrend} Uptrend <Tooltip text={TOOLTIP_REGIME_UPTREND} />
        </span>
        <span style={{ opacity: coverage.sideways === 0 ? 0.4 : 1 }}>
          ➡ {coverage.sideways} Sideways <Tooltip text={TOOLTIP_REGIME_SIDEWAYS} />
        </span>
        <span style={{ opacity: coverage.downtrend === 0 ? 0.4 : 1 }}>
          📉 {coverage.downtrend} Downtrend <Tooltip text={TOOLTIP_REGIME_DOWNTREND} />
        </span>

        {sortedTierCounts.length > 0 && (
          <span className="muted">·</span>
        )}

        {sortedTierCounts.map(([tier, count]) => (
          <span key={tier} style={{ color: TIER_INFO[tier].color }}>
            {TIER_INFO[tier].emoji} {count}× {TIER_INFO[tier].label}
          </span>
        ))}
      </div>
    </div>
  );
}

// ─── Season results view (Slice 4A) ──────────────────────────────────────────

interface SeasonResultData {
  fromGeneration: number;
  fitnessRecords: Array<{ spec: EvolvableBotSpec; fitness: FitnessResult }>;
  survivorIds: Set<string>;
  seasonWindows: SeasonWindow[];
  regimeLabels: RegimeLabel[];
  config: EvolutionConfig;
  /** True when NoEligibleSurvivorsError was thrown — no eligible survivors; proposal not generated. */
  advanceError?: true;
}

function WindowSummaryTable({
  windows,
  regimeLabels,
}: {
  windows: SeasonWindow[];
  regimeLabels: RegimeLabel[];
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
  seasonWindows,
}: {
  record: { spec: EvolvableBotSpec; fitness: FitnessResult };
  config: EvolutionConfig;
  seasonWindows: SeasonWindow[];
}) {
  const ex = explainFitness(record, config);

  // Per-window evidence table — shared by both gate-failure and scored paths
  const windowDetail = (
    <div style={{ marginTop: 8 }}>
      <table className="hist-table" style={{ fontSize: "0.78em" }}>
        <thead>
          <tr>
            <th style={{ textAlign: "left" }}>Win</th>
            <th className="num">Return</th>
            <th className="num">Max DD</th>
            <th className="num">Trades</th>
            <th className="num">Prof. Factor</th>
          </tr>
        </thead>
        <tbody>
          {seasonWindows.map((w, i) => {
            const snap = w.standings.find((s) => s.botId === record.spec.id);
            if (!snap) {
              return (
                <tr key={w.index}>
                  <td className="muted">W{i + 1}</td>
                  <td className="num muted" colSpan={4}>—</td>
                </tr>
              );
            }
            const hasPf = (snap.closedTradeCount ?? 0) > 0;
            const pfDisplay = !hasPf
              ? "—"
              : !isFinite(snap.profitFactor)
              ? "∞"
              : snap.profitFactor.toFixed(2);
            return (
              <tr key={w.index}>
                <td className="muted">W{i + 1}</td>
                <td className={`num ${snap.totalReturn >= 0 ? "positive" : "negative"}`}>
                  {fmtPct(snap.totalReturn)}
                </td>
                <td className={`num ${snap.maxDrawdown > 0.1 ? "negative" : "muted"}`}>
                  {fmtPct(snap.maxDrawdown)}
                </td>
                <td className="num muted">{snap.tradeCount}</td>
                <td className={`num ${hasPf && snap.profitFactor >= 1 ? "positive" : hasPf ? "negative" : "muted"}`}>
                  {pfDisplay}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );

  if (ex.kind === "gate-failure") {
    const isActivity = ex.gateFailureReason === "activity";
    return (
      <tr className="hist-row" style={{ background: "var(--color-panel-alt, rgba(255,100,80,0.04))" }}>
        <td colSpan={99} style={{ padding: "6px 12px 8px 28px" }}>
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
          {windowDetail}
        </td>
      </tr>
    );
  }

  // Scored bot — show component breakdown then per-window evidence
  const { returnComponent, drawdownPenalty, inconsistencyPenalty, score, weights, windowMetricsSummary: m } = ex;
  return (
    <tr className="hist-row" style={{ background: "var(--color-panel-alt, rgba(80,120,255,0.04))" }}>
      <td colSpan={99} style={{ padding: "6px 12px 8px 28px" }}>
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
        {windowDetail}
      </td>
    </tr>
  );
}

function BotResultsTable({
  result,
  archive,
}: {
  result: SeasonResultData;
  archive: ArchivedBotRecord[];
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

  const { fitnessRecords, survivorIds, seasonWindows, config, regimeLabels } = result;

  // Pre-compute confidence indicators per bot (pure, no side-effects)
  const windowCount = regimeLabels.length;
  const indicatorsById = new Map(
    fitnessRecords.map((r) => [
      r.spec.id,
      computeConfidenceIndicators(r.spec, archive, windowCount, regimeLabels),
    ]),
  );

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
            <th>Evidence <Tooltip text={TOOLTIP_EVIDENCE_COLUMN} /></th>
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
                <td style={{ whiteSpace: "nowrap" }}>
                  {(() => {
                    const ind = indicatorsById.get(r.spec.id);
                    return ind ? <EvidenceBadge indicators={ind} /> : null;
                  })()}
                </td>
              </tr>,
              expanded && (
                <FitnessBreakdownRow
                  key={`${r.spec.id}-breakdown`}
                  record={r}
                  config={config}
                  seasonWindows={seasonWindows}
                />
              ),
            ];
          })}
        </tbody>
      </table>
      <div className="muted" style={{ fontSize: "0.78em", marginTop: 4 }}>
        Click any row for fitness breakdown and per-window detail.
      </div>
    </div>
  );
}

function SeasonResultsSection({
  result,
  archive,
}: {
  result: SeasonResultData;
  archive: ArchivedBotRecord[];
}) {
  const gateFailCount = result.fitnessRecords.filter((r) => r.fitness.kind === "gate-failure").length;
  // Title always refers to fromGeneration — the advance is a separate step in 4B.
  const title = `Generation ${result.fromGeneration} Results`;

  return (
    <div className="cfg-section">
      <div className="cfg-section-title">
        {title}
        <span className="cfg-section-note">
          {result.seasonWindows.length} windows · {result.fitnessRecords.length} bots
          {result.advanceError && " · generation not advanced"}
        </span>
      </div>

      {/* All-gate-failure warning — shown when no bot could survive to advance */}
      {result.advanceError && (
        <div className="cfg-errors" style={{ marginBottom: 10 }}>
          <div className="cfg-error" style={{ fontWeight: 600, fontSize: "0.85em" }}>
            All {gateFailCount} bot{gateFailCount === 1 ? "" : "s"} failed fitness gates — this generation did not advance.
          </div>
          <div className="cfg-error" style={{ fontWeight: "normal", fontSize: "0.82em", marginTop: 4 }}>
            Review the per-bot breakdowns below. Lower minTrades if bots are failing the activity gate, or check max drawdown if they are failing the survival gate.
          </div>
        </div>
      )}

      <WindowSummaryTable
        windows={result.seasonWindows}
        regimeLabels={result.regimeLabels}
      />

      {/* Evidence Ladder — regime coverage, tier legend, and per-run distribution */}
      <EvidenceLadderSection
        fitnessRecords={result.fitnessRecords}
        archive={archive}
        regimeLabels={result.regimeLabels}
      />

      <BotResultsTable result={result} archive={archive} />

      {/* Gate failure count summary (only when not all failed — all-fail case already handled above) */}
      {!result.advanceError && gateFailCount > 0 && (
        <div className="cfg-errors" style={{ marginTop: 4 }}>
          <div className="cfg-error" style={{ fontSize: "0.82em" }}>
            {gateFailCount} bot(s) failed fitness gates and were retired. Click their row above for details.
          </div>
        </div>
      )}
    </div>
  );
}

// ─── Proposal preview (Slice 4B/4C) ──────────────────────────────────────────

function ProposalPreviewSection({
  proposal,
  onOverrideChange,
  onCommit,
  onCancel,
  committing,
  overrideError,
}: {
  proposal: GenerationAdvanceProposal;
  onOverrideChange: (overrides: AdvanceOverrides) => void;
  onCommit: () => void;
  onCancel: () => void;
  committing: boolean;
  overrideError?: string;
}) {
  const [expandedDeltaIds, setExpandedDeltaIds] = useState<Set<string>>(new Set());

  function toggleDelta(id: string) {
    setExpandedDeltaIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  }

  const ov = proposal.overrides;
  const pinned = ov.pinnedIds ?? new Set<string>();
  const vetoed = ov.vetoedIds ?? new Set<string>();
  const rerolls = ov.rerollCounts ?? new Map<number, number>();
  const pinReasons = ov.pinReasons ?? new Map<string, string>();
  const vetoReasons = ov.vetoReasons ?? new Map<string, string>();

  function toggleVeto(botId: string) {
    const newVetoed = new Set(vetoed);
    const newPinned = new Set(pinned);
    const newVetoReasons = new Map(vetoReasons);
    const newPinReasons = new Map(pinReasons);
    if (newVetoed.has(botId)) {
      newVetoed.delete(botId);
      newVetoReasons.delete(botId);
    } else {
      newVetoed.add(botId);
      newPinned.delete(botId); // can't be both
      newPinReasons.delete(botId);
    }
    onOverrideChange({
      ...ov,
      pinnedIds: newPinned, pinReasons: newPinReasons,
      vetoedIds: newVetoed, vetoReasons: newVetoReasons,
      rerollCounts: undefined,
    });
  }

  function togglePin(botId: string) {
    const newPinned = new Set(pinned);
    const newVetoed = new Set(vetoed);
    const newPinReasons = new Map(pinReasons);
    const newVetoReasons = new Map(vetoReasons);
    if (newPinned.has(botId)) {
      newPinned.delete(botId);
      newPinReasons.delete(botId);
    } else {
      newPinned.add(botId);
      newVetoed.delete(botId); // can't be both
      newVetoReasons.delete(botId);
    }
    onOverrideChange({
      ...ov,
      pinnedIds: newPinned, pinReasons: newPinReasons,
      vetoedIds: newVetoed, vetoReasons: newVetoReasons,
      rerollCounts: undefined,
    });
  }

  function setReason(botId: string, reason: string, kind: "pin" | "veto") {
    if (kind === "pin") {
      const newPinReasons = new Map(pinReasons);
      if (reason) newPinReasons.set(botId, reason);
      else newPinReasons.delete(botId);
      onOverrideChange({ ...ov, pinReasons: newPinReasons });
    } else {
      const newVetoReasons = new Map(vetoReasons);
      if (reason) newVetoReasons.set(botId, reason);
      else newVetoReasons.delete(botId);
      onOverrideChange({ ...ov, vetoReasons: newVetoReasons });
    }
  }

  function rerollSlot(slotIndex: number) {
    const newRerolls = new Map(rerolls);
    newRerolls.set(slotIndex, (newRerolls.get(slotIndex) ?? 0) + 1);
    onOverrideChange({ ...ov, rerollCounts: newRerolls });
  }

  const overrideActive =
    pinned.size > 0 || vetoed.size > 0 || rerolls.size > 0;

  return (
    <div className="cfg-section">
      <div className="cfg-section-title">
        Proposed Generation {proposal.toGeneration}
        <span className="cfg-section-note">
          {proposal.survivors.length} survivors · {proposal.proposedPop.length} new bots
          {overrideActive && " · overrides active"}
        </span>
      </div>

      {/* Override error — shown when a veto attempt leaves no eligible survivors.
          The proposal shown below is the PREVIOUS valid proposal, not the rejected one. */}
      {overrideError && (
        <div className="cfg-errors" style={{ marginBottom: 10 }}>
          <div className="cfg-error" style={{ fontSize: "0.85em" }}>
            {overrideError}
            <span className="muted" style={{ fontWeight: "normal", marginLeft: 6 }}>
              The proposal below is unchanged — unveto a bot to re-enable advance.
            </span>
          </div>
        </div>
      )}

      {/* Survivor decisions */}
      <div style={{ fontSize: "0.8em", fontWeight: 600, color: "var(--color-muted)", marginBottom: 4, textTransform: "uppercase", letterSpacing: "0.06em" }}>
        Survivors
      </div>
      <table className="hist-table" style={{ marginBottom: 10 }}>
        <thead>
          <tr>
            <th>Rank</th>
            <th>Archetype</th>
            <th>Name</th>
            <th className="num">Fitness</th>
            <th className="num">Gen</th>
            <th></th>
          </tr>
        </thead>
        <tbody>
          {proposal.survivors.map((s) => (
            <tr key={s.spec.id} className="hist-row">
              <td className="muted" style={{ fontSize: "0.82em" }}>
                {s.pinned ? <span title="Pinned override">📌</span> : `#${s.rank} of ${s.eligibleCount}`}
              </td>
              <td><span className="badge">{s.spec.archetype}</span></td>
              <td style={{ fontFamily: "monospace", fontSize: "0.82em" }}>{s.spec.name}</td>
              <td className={`num ${s.fitnessScore >= 0 ? "positive" : "negative"}`}>
                {fmtScore(s.fitnessScore)}
              </td>
              <td className="num muted">{s.spec.generation}</td>
              <td style={{ textAlign: "right", whiteSpace: "nowrap" }}>
                {s.pinned ? (
                  <>
                    <input
                      type="text"
                      placeholder="pin reason (optional)"
                      value={pinReasons.get(s.spec.id) ?? ""}
                      onChange={(e) => setReason(s.spec.id, e.target.value, "pin")}
                      disabled={committing}
                      style={{ fontSize: "0.72em", padding: "2px 4px", marginRight: 4, width: 140, borderRadius: 3, border: "1px solid var(--color-border, #444)" }}
                    />
                    <button
                      className="cfg-btn cfg-btn--ghost"
                      style={{ fontSize: "0.72em", padding: "2px 6px" }}
                      onClick={() => togglePin(s.spec.id)}
                      disabled={committing}
                      title="Remove pin — bot returns to normal selection"
                    >
                      Unpin
                    </button>
                  </>
                ) : (
                  <button
                    className="cfg-btn cfg-btn--ghost"
                    style={{ fontSize: "0.72em", padding: "2px 6px", color: "var(--color-negative)" }}
                    onClick={() => toggleVeto(s.spec.id)}
                    disabled={committing}
                    title="Exclude this bot from next generation"
                  >
                    Veto
                  </button>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>

      {/* Retired decisions */}
      {proposal.retired.length > 0 && (
        <>
          <div style={{ fontSize: "0.8em", fontWeight: 600, color: "var(--color-muted)", marginBottom: 4, textTransform: "uppercase", letterSpacing: "0.06em" }}>
            Retired
          </div>
          <table className="hist-table" style={{ marginBottom: 10 }}>
            <thead>
              <tr>
                <th>Archetype</th>
                <th>Name</th>
                <th>Reason</th>
                <th className="num">Fitness</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {proposal.retired.map((r) => {
                const canPin = r.retirementReason !== "gate-failure";
                const isVetoed = r.retirementReason === "vetoed";
                const reasonLabel = r.retirementReason === "gate-failure"
                  ? `❌ ${r.gateFailureReason} gate`
                  : isVetoed
                  ? "⊘ vetoed"
                  : `ranked #${r.rank} of ${r.eligibleCount}`;
                const reasonClass = r.retirementReason === "gate-failure" ? "muted" : isVetoed ? "negative" : "muted";
                return (
                  <tr key={r.spec.id} className="hist-row">
                    <td><span className="badge">{r.spec.archetype}</span></td>
                    <td style={{ fontFamily: "monospace", fontSize: "0.82em" }}>{r.spec.name}</td>
                    <td className={reasonClass} style={{ fontSize: "0.82em" }}>{reasonLabel}</td>
                    <td className={`num ${r.fitnessScore !== undefined ? (r.fitnessScore >= 0 ? "positive" : "negative") : "muted"}`}>
                      {r.fitnessScore !== undefined ? fmtScore(r.fitnessScore) : "—"}
                    </td>
                    <td style={{ textAlign: "right", whiteSpace: "nowrap" }}>
                      {canPin && (
                        isVetoed ? (
                          <>
                            <input
                              type="text"
                              placeholder="veto reason (optional)"
                              value={vetoReasons.get(r.spec.id) ?? ""}
                              onChange={(e) => setReason(r.spec.id, e.target.value, "veto")}
                              disabled={committing}
                              style={{ fontSize: "0.72em", padding: "2px 4px", marginRight: 4, width: 140, borderRadius: 3, border: "1px solid var(--color-border, #444)" }}
                            />
                            <button
                              className="cfg-btn cfg-btn--ghost"
                              style={{ fontSize: "0.72em", padding: "2px 6px" }}
                              onClick={() => toggleVeto(r.spec.id)}
                              disabled={committing}
                              title="Remove veto — bot returns to normal selection pool"
                            >
                              Unveto
                            </button>
                          </>
                        ) : (
                          <button
                            className="cfg-btn cfg-btn--ghost"
                            style={{ fontSize: "0.72em", padding: "2px 6px", color: "var(--color-positive)" }}
                            onClick={() => togglePin(r.spec.id)}
                            disabled={committing}
                            title="Force this bot into next generation regardless of rank"
                          >
                            Pin
                          </button>
                        )
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </>
      )}

      {/* Proposed next population */}
      <div style={{ fontSize: "0.8em", fontWeight: 600, color: "var(--color-muted)", marginBottom: 4, textTransform: "uppercase", letterSpacing: "0.06em" }}>
        Proposed Generation {proposal.toGeneration} Population
      </div>
      <table className="hist-table" style={{ marginBottom: 12 }}>
        <thead>
          <tr>
            <th style={{ width: 20 }}></th>
            <th>Archetype</th>
            <th>Name</th>
            <th className="num">Gen</th>
            <th>Parent</th>
            <th style={{ width: 68 }}></th>
          </tr>
        </thead>
        <tbody>
          {proposal.proposedPop.map(({ child, parent, rerollCount }, slotIndex) => {
            const delta = child.metadata.mutationDelta;
            const hasDelta = delta && delta.length > 0;
            const isDeltaExpanded = expandedDeltaIds.has(child.id);
            return [
              <tr key={child.id} className="hist-row">
                <td style={{ fontSize: "0.7em", color: "var(--color-muted)", textAlign: "center" }}>
                  {hasDelta && (
                    <span
                      style={{ cursor: "pointer", userSelect: "none" }}
                      onClick={() => toggleDelta(child.id)}
                    >
                      {isDeltaExpanded ? "▼" : "▶"}
                    </span>
                  )}
                </td>
                <td><span className="badge">{child.archetype}</span></td>
                <td style={{ fontFamily: "monospace", fontSize: "0.82em" }}>{child.name}</td>
                <td className="num muted">{child.generation}</td>
                <td className="muted" style={{ fontSize: "0.82em" }}>
                  ← {parent.name}
                </td>
                <td style={{ textAlign: "right" }}>
                  <button
                    className="cfg-btn cfg-btn--ghost"
                    style={{ fontSize: "0.72em", padding: "2px 6px" }}
                    onClick={() => rerollSlot(slotIndex)}
                    disabled={committing}
                    title="Resample this child's mutation (same parent, different params)"
                  >
                    ⟳{rerollCount > 0 ? ` ×${rerollCount}` : ""}
                  </button>
                </td>
              </tr>,
              hasDelta && isDeltaExpanded && (
                <tr key={`${child.id}-delta`} className="hist-row">
                  <td colSpan={99} style={{ padding: "4px 12px 8px 32px", background: "var(--color-panel-alt, rgba(80,120,255,0.04))" }}>
                    <div className="evol-delta-table">
                      {delta.map((d) => (
                        <div key={d.param} className="evol-delta-row">
                          <span className="evol-delta-param">{d.param}</span>
                          <span className="evol-delta-arrow muted">
                            {String(d.from)} → {String(d.to)}
                            {d.pctChange !== undefined && (
                              <span className={d.pctChange >= 0 ? "positive" : "negative"} style={{ marginLeft: 4 }}>
                                ({d.pctChange >= 0 ? "+" : ""}{(d.pctChange * 100).toFixed(0)}%)
                              </span>
                            )}
                          </span>
                          <span className="evol-delta-interpretation">{d.interpretation}</span>
                          {d.boundsLabel && (
                            <span className="evol-delta-bounds muted">[{d.boundsLabel}]</span>
                          )}
                        </div>
                      ))}
                    </div>
                  </td>
                </tr>
              ),
            ];
          })}
        </tbody>
      </table>

      {/* Commit / Cancel */}
      <div style={{ display: "flex", gap: 8, alignItems: "center", marginTop: 4 }}>
        <button
          className="cfg-btn cfg-btn--primary"
          onClick={onCommit}
          disabled={committing || !!overrideError}
        >
          {committing ? "Advancing…" : `Advance to Generation ${proposal.toGeneration}`}
        </button>
        <button
          className="cfg-btn cfg-btn--ghost"
          onClick={onCancel}
          disabled={committing}
        >
          Cancel — Return to Results
        </button>
      </div>
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
  const [committing, setCommitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [seasonResult, setSeasonResult] = useState<SeasonResultData | null>(null);
  const [pendingAdvance, setPendingAdvance] = useState<{
    proposal: GenerationAdvanceProposal;
    evolutionSeason: EvolutionSeasonResult;
    /** Set when a pin/veto override leaves zero eligible survivors. */
    overrideError?: string;
  } | null>(null);
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

  const canRun = windowSize >= 10 && !running && !committing && session !== null && contextMismatches.length === 0 && pendingAdvance === null;

  /**
   * Run the season and compute a GenerationAdvanceProposal for review.
   * Does NOT call advanceGeneration() — state is only written on explicit commit.
   */
  function handleRunSeason() {
    if (!session) return;
    setRunning(true);
    setError(null);
    setSeasonResult(null);
    setPendingAdvance(null);

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

        // Compute the advance proposal (scores + selects + plans reproduction).
        // NoEligibleSurvivorsError is handled gracefully — we still show the
        // season results; the proposal preview section is omitted.
        // Other errors bubble to the outer catch.
        let proposal: GenerationAdvanceProposal | undefined;
        let advanceError: true | undefined;
        try {
          proposal = computeAdvanceProposal(session.runState, evolutionSeason, advancedAt);
        } catch (err) {
          if (err instanceof NoEligibleSurvivorsError) {
            advanceError = true;
          } else {
            throw err;
          }
        }

        // Build survivor IDs from the proposal (empty when advance blocked).
        const survivorIds = proposal
          ? new Set(proposal.survivors.map((s) => s.spec.id))
          : new Set<string>();

        // Use fitness records from the proposal when available; fall back to
        // a separate scorePopulation call when the proposal failed (all gate-failed).
        const fitnessRecords = proposal?.fitnessRecords
          ?? scorePopulation(session.runState.activePop, evolutionSeason, session.runState.config);

        setSeasonResult({
          fromGeneration: session.runState.generation,
          fitnessRecords,
          survivorIds,
          seasonWindows: rawSeasonResult.windows,
          regimeLabels,
          config: session.runState.config,
          advanceError,
        });

        if (proposal) {
          setPendingAdvance({ proposal, evolutionSeason });
        }
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
      } finally {
        setRunning(false);
      }
    }, 0);
  }

  /**
   * Commit the pending advance: materialise the approved proposal into a new
   * EvolutionRunState (with any pin/veto/reroll overrides already baked in)
   * and persist the new session. State is written exactly once.
   */
  function handleCommitAdvance() {
    if (!session || !pendingAdvance) return;
    setCommitting(true);
    setError(null);

    setTimeout(() => {
      try {
        const { proposal } = pendingAdvance;
        const newRunState = commitProposal(session.runState, proposal);
        const newSession: EvolutionSessionData = {
          runState: newRunState,
          context: session.context,
        };
        saveEvolutionSession(newSession);
        onStateChange(newSession);
        setPendingAdvance(null);
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
      } finally {
        setCommitting(false);
      }
    }, 0);
  }

  /**
   * Recompute the advance proposal with updated human overrides (pin/veto/reroll).
   * Uses the same locked advancedAt timestamp so child specs are stable across
   * override adjustments. If the new overrides leave no eligible survivors, the
   * proposal is kept unchanged and an inline error is shown.
   */
  function handleOverrideChange(newOverrides: AdvanceOverrides) {
    if (!session || !pendingAdvance) return;
    try {
      const newProposal = computeAdvanceProposal(
        session.runState,
        pendingAdvance.evolutionSeason,
        pendingAdvance.proposal.advancedAt, // locked timestamp
        newOverrides,
      );
      setPendingAdvance((prev) =>
        prev ? { ...prev, proposal: newProposal, overrideError: undefined } : null,
      );
    } catch (err) {
      if (err instanceof NoEligibleSurvivorsError) {
        setPendingAdvance((prev) =>
          prev
            ? { ...prev, overrideError: "All survivors vetoed — unveto at least one bot to advance." }
            : null,
        );
      } else {
        setError(err instanceof Error ? err.message : String(err));
      }
    }
  }

  /** Cancel the pending advance — discard the proposal and return to results view. */
  function handleCancelAdvance() {
    setPendingAdvance(null);
  }

  function handleReset() {
    clearEvolutionSession();
    onStateChange(null);
    setSeasonResult(null);
    setPendingAdvance(null);
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
                    {runState.activePop.length} bots · started {runState.createdAt.slice(0, 10)}
                  </span>
                </div>
                <EvaluationEnvironmentHeader env={deriveEvaluationEnvironment(session.context)} />
                <div className="evol-roster">
                  {runState.activePop.map((bot) => (
                    <StrategyCard
                      key={bot.id}
                      spec={bot}
                      variant="full"
                      indicators={computeConfidenceIndicators(bot, runState.archive, windowCount, [])}
                    />
                  ))}
                </div>
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
                  Run Evolution Season
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
                    onClick={handleRunSeason}
                  >
                    {running
                      ? "Running…"
                      : pendingAdvance
                      ? "Season already run — review the proposal below"
                      : `Run Season (Gen ${runState.generation})`}
                  </button>
                </div>
              </div>

              {/* Season results (Slice 4A / 4D) */}
              {seasonResult && (
                <SeasonResultsSection
                  result={seasonResult}
                  archive={runState.archive}
                />
              )}

              {/* Proposal preview (Slice 4B/4C) — shown when eligible survivors exist */}
              {pendingAdvance && (
                <ProposalPreviewSection
                  proposal={pendingAdvance.proposal}
                  onOverrideChange={handleOverrideChange}
                  onCommit={handleCommitAdvance}
                  onCancel={handleCancelAdvance}
                  committing={committing}
                  overrideError={pendingAdvance.overrideError}
                />
              )}

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
