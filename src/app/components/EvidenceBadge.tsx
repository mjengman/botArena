/**
 * M14 Slice 4E.1 — Shared Evidence Ladder badge component.
 *
 * Extracted from EvolutionPanel so StrategyCard (and future components) can
 * render a tier badge without importing the full panel module.
 *
 * Exports:
 *   TIER_INFO       — display metadata (label, emoji, color, tooltip) per EvidenceTier
 *   EvidenceBadge   — compact inline badge showing tier + confidence indicators on hover
 */

import {
  computeEvidenceTier,
} from "../../engine/evolution/confidence.ts";
import type { ConfidenceIndicators, EvidenceTier } from "../../engine/evolution/confidence.ts";
import { Tooltip } from "./Tooltip.tsx";

// ─── Tier display metadata ────────────────────────────────────────────────────

export const TIER_INFO: Record<EvidenceTier, {
  label: string;
  emoji: string;
  color: string;
  tooltip: string;
}> = {
  "hatchling": {
    label: "Hatchling",
    emoji: "🥚",
    color: "var(--color-muted)",
    tooltip: "A newly spawned lineage that has never survived an advance. No cross-season evidence yet — high fitness here may reflect early-generation luck rather than a robust strategy.",
  },
  "arena-contender": {
    label: "Arena Contender",
    emoji: "⚔️",
    color: "var(--color-positive, #4caf50)",
    tooltip: "This lineage survived at least one season advance, outlasting weaker competitors. Early evidence of fitness durability — but a single survival may be noise.",
  },
  "backtest-champion": {
    label: "Backtest Champion",
    emoji: "🏆",
    color: "#ffb74d",
    tooltip: "Survived 3 or more generation advances. Sustained performance across multiple backtested seasons suggests a genuinely useful strategy, not just a lucky draw.",
  },
  "paper-candidate": {
    label: "Paper Candidate",
    emoji: "📋",
    color: "var(--color-muted)",
    tooltip: "🔒 Paper trading tier — not yet available in this version. Unlocks in a future milestone when live-market integration is added.",
  },
  "paper-active": {
    label: "Paper Active",
    emoji: "📊",
    color: "var(--color-muted)",
    tooltip: "🔒 Paper trading tier — not yet available in this version.",
  },
  "regime-specialist": {
    label: "Regime Specialist",
    emoji: "🌍",
    color: "var(--color-accent, #26c6da)",
    tooltip: "Survived 3+ advances AND was evaluated in 2 or more distinct market regimes (Uptrend, Sideways, Downtrend). Its performance is not limited to a single market type — a stronger signal of robustness.",
  },
  "live-eligible": {
    label: "Live Eligible",
    emoji: "🚀",
    color: "var(--color-muted)",
    tooltip: "🔒 Live trading tier — not yet available in this version.",
  },
  "live-active": {
    label: "Live Active",
    emoji: "⚡",
    color: "var(--color-muted)",
    tooltip: "🔒 Live trading tier — not yet available in this version.",
  },
};

// ─── Component ────────────────────────────────────────────────────────────────

interface EvidenceBadgeProps {
  indicators: ConfidenceIndicators;
}

export function EvidenceBadge({ indicators }: EvidenceBadgeProps) {
  const tier = computeEvidenceTier(indicators);
  const info = TIER_INFO[tier];
  const stabilityText = indicators.paramStabilityRate !== null
    ? `Param stability: ${(indicators.paramStabilityRate * 100).toFixed(0)}% unchanged. `
    : "";
  const tooltipText =
    `${info.tooltip} ` +
    `Generations survived: ${indicators.generationsSurvived}. ` +
    `Windows evaluated: ${indicators.windowsEvaluated}. ` +
    `Gate failures in lineage: ${indicators.gateFailureCount}. ` +
    stabilityText;

  return (
    <span
      style={{
        display: "inline-flex",
        alignItems: "center",
        gap: 3,
        fontSize: "0.73em",
        padding: "1px 5px",
        borderRadius: 3,
        border: "1px solid var(--color-border, #444)",
        color: info.color,
        whiteSpace: "nowrap",
      }}
    >
      {info.emoji} {info.label}
      <Tooltip text={tooltipText} />
    </span>
  );
}
