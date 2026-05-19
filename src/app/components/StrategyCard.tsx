/**
 * M14 Slice 4E.1 — Strategy Card component.
 *
 * The canonical display unit for a strategy across views.
 * Designed to be composable — same component used in roster, season results,
 * inspector, champion history, and archive with different props/variants.
 *
 * Full variant  — detailed card with params, delta summary, tier badge.
 * Compact variant — inline chip: name + archetype + gen + tier badge.
 *
 * Future: regime profile, season record, notable event tags.
 */

import type { EvolvableBotSpec } from "../../engine/evolution/types.ts";
import type { EvolutionDelta } from "../../engine/evolution/delta.ts";
import type { ConfidenceIndicators } from "../../engine/evolution/confidence.ts";
import { EvidenceBadge } from "./EvidenceBadge.tsx";

// ─── Helpers ──────────────────────────────────────────────────────────────────

function fmtParamValue(v: number | boolean | string): string {
  if (typeof v === "boolean") return v ? "true" : "false";
  if (typeof v === "number") return Number.isInteger(v) ? String(v) : v.toFixed(3);
  return v;
}

function fmtPct(ratio: number): string {
  const s = (ratio * 100).toFixed(0);
  return ratio >= 0 ? `+${s}%` : `${s}%`;
}

// ─── Props ────────────────────────────────────────────────────────────────────

export interface StrategyCardProps {
  spec: EvolvableBotSpec;
  /** When provided, renders the Evidence Ladder tier badge. */
  indicators?: ConfidenceIndicators;
  /**
   * Mutation delta to display. Defaults to spec.metadata.mutationDelta.
   * Pass `null` to suppress delta display even when metadata contains one.
   */
  delta?: EvolutionDelta | null;
  variant?: "full" | "compact";
}

// ─── Compact variant ──────────────────────────────────────────────────────────

function StrategyCardCompact({ spec, indicators }: StrategyCardProps) {
  return (
    <span className="strategy-card strategy-card--compact">
      <span className="strategy-card__name">{spec.name}</span>
      <span className="badge">{spec.archetype}</span>
      <span className="strategy-card__gen muted">G{spec.generation}</span>
      {indicators && <EvidenceBadge indicators={indicators} />}
    </span>
  );
}

// ─── Full variant ─────────────────────────────────────────────────────────────

function StrategyCardFull({ spec, indicators, delta }: StrategyCardProps) {
  // Resolve delta: explicit prop > metadata > nothing
  const resolvedDelta: EvolutionDelta | undefined =
    delta !== undefined
      ? (delta ?? undefined)
      : (spec.metadata.mutationDelta ?? undefined);

  const hasDelta = resolvedDelta && resolvedDelta.length > 0;
  const paramKeys = Object.keys(spec.params).sort();

  return (
    <div className="strategy-card strategy-card--full">
      {/* Header row: name, archetype, generation, tier badge */}
      <div className="strategy-card__header">
        <span className="strategy-card__name">{spec.name}</span>
        <span className="badge">{spec.archetype}</span>
        <span className="strategy-card__gen muted">G{spec.generation}</span>
        {indicators && <EvidenceBadge indicators={indicators} />}
      </div>

      {/* Params — changed params highlighted when delta is present */}
      {paramKeys.length > 0 ? (
        <div className="strategy-card__params">
          {paramKeys.map((k) => {
            const v = spec.params[k];
            const deltaEntry = hasDelta
              ? resolvedDelta.find((d) => d.param === k)
              : undefined;
            return (
              <span
                key={k}
                className={`strategy-card__param${deltaEntry ? " strategy-card__param--changed" : ""}`}
                title={deltaEntry ? deltaEntry.interpretation : undefined}
              >
                <span className="strategy-card__param-key">{k}</span>
                {deltaEntry ? (
                  <>
                    <span className="strategy-card__param-val muted">{fmtParamValue(deltaEntry.from as number | boolean | string)}</span>
                    <span className="strategy-card__param-arrow muted">→</span>
                    <span className="strategy-card__param-val">{fmtParamValue(v)}</span>
                    {deltaEntry.pctChange !== undefined && (
                      <span className="strategy-card__param-arrow muted">{fmtPct(deltaEntry.pctChange)}</span>
                    )}
                  </>
                ) : (
                  <span className="strategy-card__param-val">{fmtParamValue(v)}</span>
                )}
              </span>
            );
          })}
        </div>
      ) : (
        <div className="strategy-card__params">
          <span className="muted" style={{ fontStyle: "italic" }}>no tunable params</span>
        </div>
      )}

      {/* Delta summary line */}
      {hasDelta && (
        <div className="strategy-card__delta-summary">
          {resolvedDelta.length === 1
            ? `↑ ${resolvedDelta[0].interpretation}`
            : `${resolvedDelta.length} params changed · ${resolvedDelta.map((d) => d.param).join(", ")}`}
        </div>
      )}
    </div>
  );
}

// ─── Public component ─────────────────────────────────────────────────────────

export function StrategyCard(props: StrategyCardProps) {
  return props.variant === "compact"
    ? <StrategyCardCompact {...props} />
    : <StrategyCardFull {...props} />;
}
