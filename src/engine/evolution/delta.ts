/**
 * M14 Slice 4E.1 — Evolution delta: what changed between a parent and child spec.
 *
 * Two entry points:
 *   computeEvolutionDelta()  — for callers with full EvolvableBotSpec objects
 *   computeDeltaFromParams() — for use inside mutateSpec, where the child spec
 *                             is not yet fully built when the delta is needed
 *
 * Interpretations are template-based. AI-generated rationale is deferred to M15.
 */

import type { EvolvableBotSpec, ArchetypeParamBounds } from "./types.ts";

// ─── Types ────────────────────────────────────────────────────────────────────

export type EvolutionDeltaEntry = {
  param: string;
  from: number | boolean;
  to: number | boolean;
  /** Fractional change relative to |from|. Undefined for boolean params. */
  pctChange?: number;
  /** Template-based interpretation. AI rationale deferred to M15. */
  interpretation: string;
  /** Human-readable bounds context, e.g. "range 5–50, step 1". */
  boundsLabel?: string;
};

/** Ordered list of per-param changes between a parent and child spec. Empty = clone (no mutation). */
export type EvolutionDelta = EvolutionDeltaEntry[];

// ─── Template interpretations ─────────────────────────────────────────────────
//
// Keyed by archetype → param → direction ("increase" | "decrease").
// Only numeric params have templates; booleans use a generic enabled/disabled label.
// Param keys must match ARCHETYPE_BOUNDS (bounds.ts) exactly.

const TEMPLATES: Record<string, Record<string, { increase: string; decrease: string }>> = {
  mac: {
    longPeriod:  { increase: "Slower trend filter",   decrease: "Faster trend filter" },
    shortPeriod: { increase: "Slower signal line",    decrease: "Faster signal line" },
  },
  mom: {
    period:    { increase: "More patient entries",    decrease: "More reactive entries" },
    threshold: { increase: "More selective signals",  decrease: "More permissive signals" },
  },
  mr: {
    period: { increase: "Longer mean window",         decrease: "Shorter mean window" },
    zBuy:   { increase: "Buys on deeper dips",        decrease: "Buys on shallower dips" },
    zSell:  { increase: "Holds longer for exit",      decrease: "Exits earlier" },
  },
  rnd: {
    buyProb:  { increase: "More frequent buys",       decrease: "Less frequent buys" },
    sellProb: { increase: "More frequent sells",      decrease: "Less frequent sells" },
  },
};

// ─── Helpers ──────────────────────────────────────────────────────────────────

function makeBoundsLabel(bound: ArchetypeParamBounds[string]): string | undefined {
  if (bound.type !== "number") return undefined;
  return bound.step !== undefined
    ? `range ${bound.min}–${bound.max}, step ${bound.step}`
    : `range ${bound.min}–${bound.max}`;
}

// ─── Core implementation ──────────────────────────────────────────────────────

/**
 * Shared implementation — operates on raw param maps so it can be called from
 * both the full-spec API and from inside mutateSpec (before the child spec exists).
 */
function buildDelta(
  archetype: string,
  parentParams: Record<string, number | boolean | string>,
  childParams: Record<string, number | boolean | string>,
  bounds: ArchetypeParamBounds,
): EvolutionDelta {
  const delta: EvolutionDelta = [];
  const archetypeTemplates = TEMPLATES[archetype] ?? {};

  for (const [param, bound] of Object.entries(bounds)) {
    if (bound.type === "string") continue;

    const fromRaw = parentParams[param];
    const toRaw   = childParams[param];

    if (fromRaw === undefined || toRaw === undefined) continue;
    if (fromRaw === toRaw) continue;

    if (bound.type === "boolean") {
      const from = fromRaw as boolean;
      const to   = toRaw   as boolean;
      delta.push({
        param,
        from,
        to,
        interpretation: to ? `${param} enabled` : `${param} disabled`,
        boundsLabel: "boolean",
      });
    } else {
      const from = fromRaw as number;
      const to   = toRaw   as number;
      const pctChange = from !== 0 ? (to - from) / Math.abs(from) : 0;
      const direction: "increase" | "decrease" = to > from ? "increase" : "decrease";
      const template = archetypeTemplates[param];
      const interpretation = template
        ? template[direction]
        : direction === "increase" ? "Increased" : "Decreased";

      delta.push({
        param,
        from,
        to,
        pctChange,
        interpretation,
        boundsLabel: makeBoundsLabel(bound),
      });
    }
  }

  return delta;
}

// ─── Public API ───────────────────────────────────────────────────────────────

/**
 * Compute the evolution delta between two fully-built specs.
 * Returns `[]` when no params changed (perfect clone).
 */
export function computeEvolutionDelta(
  parent: EvolvableBotSpec,
  child: EvolvableBotSpec,
  bounds: ArchetypeParamBounds,
): EvolutionDelta {
  return buildDelta(parent.archetype, parent.params, child.params, bounds);
}

/**
 * Variant for use inside `mutateSpec` before the child `EvolvableBotSpec` is assembled.
 * Accepts raw param maps and the archetype string directly.
 */
export function computeDeltaFromParams(
  archetype: string,
  parentParams: Record<string, number | boolean | string>,
  childParams: Record<string, number | boolean | string>,
  bounds: ArchetypeParamBounds,
): EvolutionDelta {
  return buildDelta(archetype, parentParams, childParams, bounds);
}
